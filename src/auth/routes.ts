/**
 * Connector authorization with Oura as the login (D-002).
 *
 *   Claude -> GET /authorize   parse the OAuth request, show a one-click consent page
 *   Claude -> POST /authorize  consent approved: start the Oura sign-in (PKCE, bound state)
 *   Oura   -> GET /callback    exchange the code, check the Oura user ID, store the Oura
 *                              tokens for the sync, complete the Claude authorization
 *
 * Only the Oura account whose ID equals the OURA_USER_ID secret is accepted.
 * Until that secret exists, the callback shows the ID of whoever just signed
 * in (their own ID, nothing else) with the command to set it.
 */
import { AuthorizationError, CimdFetchError, authorizationErrorRedirect, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Env, GrantProps } from "../env.js";
import { randomToken, sha256base64url } from "../lib/crypto.js";
import { escapeHtml, page } from "../lib/html.js";
import { exchangeCode, OURA_AUTHORIZE_URL, personalInfo, saveTokens } from "../oura/api.js";

const DEFAULT_SCOPES = ["read"];

function consentPage(d: ConsentDescription, handle: string): string {
  const name = escapeHtml(d.clientName);
  const origin = d.clientDomain ? `Published by <strong>${escapeHtml(d.clientDomain)}</strong>.` : "This app registered itself, so its name is not verified.";
  const scopes = d.scope.length ? d.scope.map(escapeHtml).join(", ") : "read";
  return `<h1>Allow ${name} to read your Gauge data?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(d.redirectHost)}</strong>. Scope: <code>${scopes}</code>.</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>Allowing continues to Oura, where you sign in. Only the Oura account this server belongs to is accepted.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  ${d.scope.map((s) => `<input type="hidden" name="scope" value="${escapeHtml(s)}">`).join("")}
  <p><button class="primary" name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

function ouraAuthorizeUrl(env: Env, state: string, codeChallenge: string): string {
  const u = new URL(OURA_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", env.OURA_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${env.BASE_URL}/callback`);
  u.searchParams.set("scope", env.OURA_SCOPES);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

async function startUpstream(env: Env, request: import("@cloudflare/workers-oauth-provider").AuthRequest, headers?: Headers): Promise<Response> {
  const verifier = randomToken(48);
  const { state, headers: h } = await env.OAUTH_PROVIDER.beginUpstream(request, { data: { verifier }, ...(headers ? { headers } : {}) });
  h.set("Location", ouraAuthorizeUrl(env, state, await sha256base64url(verifier)));
  return new Response(null, { status: 302, headers: h });
}

export async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const remember = { secret: env.CONSENT_SECRET };
  try {
    if (req.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(req);
      if (await oauth.isConsentRemembered(req, authRequest, remember)) return startUpstream(env, authRequest);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page("Authorize Gauge", consentPage(details, consent.handle), 200, consent.headers);
    }
    if (req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const requested = form.getAll("scope").map(String).filter((s) => s === "read" || s === "offline_access");
      const scope = requested.length ? requested : DEFAULT_SCOPES;
      const approved = await oauth.approveConsent(req, handle, { scope, remember });
      return startUpstream(env, approved.request, approved.headers);
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    return authError(error);
  }
}

export async function handleCallback(req: Request, env: Env, ctx: ExecutionContext, afterConnect: (env: Env) => Promise<unknown>): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const url = new URL(req.url);
  try {
    const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (err || !code) {
      headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    }
    const tokens = await exchangeCode(env, code, `${env.BASE_URL}/callback`, data.verifier);
    const me = await personalInfo(tokens.access_token);
    if (!me.id) return page("Sign-in failed", "<h1>Oura returned no user ID</h1><p>Try connecting again.</p>", 502);

    if (!env.OURA_USER_ID) {
      return page(
        "Set the owner",
        `<h1>Almost there</h1><p>This server has no owner yet. Your Oura user ID is:</p><p><code>${escapeHtml(me.id)}</code></p><p>Set it as the <code>OURA_USER_ID</code> secret, then connect again:</p><pre>npx wrangler secret put OURA_USER_ID</pre>`,
        403,
      );
    }
    if (me.id !== env.OURA_USER_ID) {
      return page("Not allowed", "<h1>This Oura account cannot use this server</h1><p>Only the owner's Oura account is accepted.</p>", 403);
    }

    tokens.user_id = me.id;
    await saveTokens(env, tokens);
    const props: GrantProps = { ouraUserId: me.id };
    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: me.id,
      metadata: { connected_at: new Date().toISOString() },
      scope: original.scope.length ? original.scope : DEFAULT_SCOPES,
      props,
      // D-020: a second Claude account connecting must not revoke the first one's grant.
      revokeExistingGrants: false,
    });
    ctx.waitUntil(afterConnect(env).catch(() => undefined));
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return authError(error);
  }
}

function authError(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
    return page("Authorization error", `<h1>Authorization error</h1><p>${escapeHtml(message)}</p><p>Go back to Claude and connect again.</p>`, 400);
  }
  throw error;
}
