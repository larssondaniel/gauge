/**
 * Gauge: read-only MCP server over Oura and MacroFactor data.
 *
 * Routes
 *   /mcp                 MCP endpoint (Streamable HTTP), OAuth-protected
 *   /authorize /token /register /callback   connector OAuth, Oura as the login
 *   /.well-known/*       OAuth discovery (served by the library)
 *   /admin/*             operator endpoints, ADMIN_TOKEN bearer (sync, backfill, status)
 *   /privacy /terms /    static pages
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Env, GrantProps } from "./env.js";
import { handleAuthorize, handleCallback } from "./auth/routes.js";
import { timingSafeEqual } from "./lib/crypto.js";
import { page } from "./lib/html.js";
import { buildServer, previewTool } from "./mcp/server.js";
import { getAuthStatus } from "./oura/api.js";
import { backfillStep, getState, incrementalSync, ouraSummary } from "./oura/sync.js";

const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: GrantProps }): Promise<Response> {
    const handler = createMcpHandler(() => buildServer(env, ctx.props), { legacy: "stateless" });
    return handler.fetch(request);
  },
};

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/authorize") return handleAuthorize(request, env);
    if (path === "/callback") return handleCallback(request, env, ctx, (e) => kickoff(e));
    if (path.startsWith("/admin/")) return admin(request, env, ctx, path);
    if (path === "/privacy") return page("Privacy", PRIVACY);
    if (path === "/terms") return page("Terms", TERMS);
    if (path === "/" || path === "") return page("Gauge", HOME);
    return new Response("Not found", { status: 404 });
  },
};

/** After a successful connect: sync recent days, and start the backfill if it never ran. */
async function kickoff(env: Env): Promise<void> {
  await incrementalSync(env, "connect");
  if (!(await getState(env, "oura.backfill"))) await backfillStep(env);
}

async function admin(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!env.ADMIN_TOKEN || !auth.startsWith("Bearer ") || !timingSafeEqual(auth.slice(7), env.ADMIN_TOKEN)) return new Response("Unauthorized", { status: 401 });
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  try {
    if (path === "/admin/status" && request.method === "GET") return json({ oura: await ouraSummary(env), auth: await getAuthStatus(env) });
    if (path === "/admin/sync" && request.method === "POST") return json(await incrementalSync(env, "admin"));
    if (path === "/admin/backfill" && request.method === "POST") {
      const steps = Math.min(20, Math.max(1, Number(new URL(request.url).searchParams.get("steps") ?? "1")));
      let state = await backfillStep(env);
      for (let i = 1; i < steps && state.phase !== "done"; i++) state = await backfillStep(env);
      return json(state);
    }
    if (path.startsWith("/admin/tool/") && request.method === "GET") {
      // Operator preview of a tool's output, for verification without a Claude session.
      const name = path.slice("/admin/tool/".length);
      const args: Record<string, unknown> = {};
      for (const [k, v] of new URL(request.url).searchParams) args[k] = v === "true" ? true : v === "false" ? false : /^\d+$/.test(v) ? Number(v) : v;
      const out = await previewTool(env, name, args);
      return new Response(out, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (path === "/admin/sleep-day-rule" && request.method === "GET") {
      // D-009: how does Oura assign a sleep record's day? Compare with the local date of bedtime_end.
      const r = await env.DB.prepare(
        "SELECT COUNT(*) AS n, SUM(day = substr(bedtime_end, 1, 10)) AS same_as_end, SUM(day = substr(bedtime_start, 1, 10)) AS same_as_start FROM oura_sleep WHERE type = 'long_sleep'",
      ).first();
      return json(r);
    }
    return json({ error: "unknown admin route" }, 404);
  } catch (e) {
    ctx.waitUntil(Promise.resolve());
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

let provider: OAuthProvider<Env> | undefined;
let providerBase = "";

function getProvider(env: Env): OAuthProvider<Env> {
  if (provider && providerBase === env.BASE_URL) return provider;
  providerBase = env.BASE_URL;
  provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler as unknown as NonNullable<ConstructorParameters<typeof OAuthProvider<Env>>[0]["apiHandler"]>,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: ["read", "offline_access"],
    requiredScopes: ["read"],
    resourceMetadata: {
      resource: `${env.BASE_URL}/mcp`,
      authorization_servers: [env.BASE_URL],
      resource_name: "Gauge",
    },
    clientIdMetadataDocumentEnabled: true,
    // Grants live while Claude keeps refreshing (90 days idle), so a connector that is used stays connected.
    refreshTokenIdleTTL: 90 * 24 * 3600,
  });
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(env).fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const auth = await getAuthStatus(env);
        if (auth.state !== "ok") return;
        await incrementalSync(env, "cron");
        const bf = await getState(env, "oura.backfill");
        if (!bf || (JSON.parse(bf) as { phase: string }).phase !== "done") await backfillStep(env);
      })(),
    );
  },
};

const HOME = `<h1>Gauge</h1><p>A private, read-only data connector for one person's Oura and MacroFactor data. There is nothing to see here without an authorised client.</p><p><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>`;
const PRIVACY = `<h1>Privacy</h1><p>Gauge is a single-user service. It stores one person's health data (Oura ring metrics and MacroFactor nutrition exports) on Cloudflare, for that person's own use through Claude. No one else's data is collected. Request and response bodies are not logged. OAuth tokens are stored encrypted. All stored data can be deleted by the owner with a single command.</p>`;
const TERMS = `<h1>Terms</h1><p>Gauge is operated by its owner for personal use only. It is not offered to the public and provides no warranty. Access is limited to the owner's Oura account.</p>`;
