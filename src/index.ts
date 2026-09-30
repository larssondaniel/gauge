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
import { ingestExport, IngestError } from "./mf/ingest.js";
import { ingestSnapshot } from "./mf/snapshot.js";
import { SnapshotError } from "./parsers/snapshot.js";

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
    if (path === "/ingest/export") return ingestExportRoute(request, env);
    if (path === "/ingest/daily") return ingestDailyRoute(request, env);
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

/**
 * POST /ingest/export: the phone's share-sheet Shortcut posts the raw file.
 * Bearer UPLOAD_TOKEN (write-only endpoint, SPEC "Upload auth"). The body is
 * the file itself, or a multipart form with one file field. Replies with one
 * plain-text line for the Shortcut's notification.
 */
async function ingestExportRoute(request: Request, env: Env): Promise<Response> {
  const line = (t: string, status = 200) => new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (request.method !== "POST") return line("POST a MacroFactor export file", 405);
  const auth = request.headers.get("Authorization") ?? "";
  if (!env.UPLOAD_TOKEN || !auth.startsWith("Bearer ") || !timingSafeEqual(auth.slice(7), env.UPLOAD_TOKEN)) return line("Unauthorized", 401);
  const ct = request.headers.get("Content-Type") ?? "";
  let bytes: Uint8Array;
  let filename: string | null = new URL(request.url).searchParams.get("name") ?? request.headers.get("X-Filename");
  if (ct.startsWith("multipart/form-data")) {
    const form = await request.formData();
    const file = [...form.values()].find((v): v is File => v instanceof File);
    if (!file) return line("No file in form", 400);
    bytes = new Uint8Array(await file.arrayBuffer());
    filename = filename ?? file.name;
  } else {
    bytes = new Uint8Array(await request.arrayBuffer());
  }
  if (bytes.length === 0) return line("Empty upload", 400);
  if (bytes.length > 40 * 1024 * 1024) return line("File too large (40 MB max)", 413);
  try {
    const r = await ingestExport(env, bytes, filename);
    return line(r.message);
  } catch (e) {
    if (e instanceof IngestError) return line(`Not ingested: ${e.message}`, 422);
    return line(`Not ingested: server error (${e instanceof Error ? e.message : String(e)})`, 500);
  }
}

/** POST /ingest/daily: JSON snapshot from the phone (D-018). Same bearer token; one-line reply. */
async function ingestDailyRoute(request: Request, env: Env): Promise<Response> {
  const line = (t: string, status = 200) => new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (request.method !== "POST") return line("POST a JSON snapshot", 405);
  const auth = request.headers.get("Authorization") ?? "";
  if (!env.UPLOAD_TOKEN || !auth.startsWith("Bearer ") || !timingSafeEqual(auth.slice(7), env.UPLOAD_TOKEN)) return line("Unauthorized", 401);
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return line("Not ingested: body is not JSON", 400);
  }
  try {
    const r = await ingestSnapshot(env, payload);
    return line(r.message);
  } catch (e) {
    if (e instanceof SnapshotError) return line(`Not ingested: ${e.message}`, 422);
    return line(`Not ingested: server error (${e instanceof Error ? e.message : String(e)})`, 500);
  }
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
    if (path === "/admin/tools" && request.method === "GET") {
      // What tools/list would return: proves the deployed server advertises every tool.
      const h = createMcpHandler(() => buildServer(env, { ouraUserId: "admin" }), { legacy: "stateless" });
      const init = await h.fetch(new Request(`${env.BASE_URL}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "admin", version: "0" } } }) }));
      const sid = init.headers.get("Mcp-Session-Id");
      const list = await h.fetch(new Request(`${env.BASE_URL}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) }));
      return new Response(await list.text(), { headers: { "Content-Type": list.headers.get("Content-Type") ?? "text/plain" } });
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
