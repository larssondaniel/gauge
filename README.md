# Gauge

A personal, single-user, read-only MCP server that lets Claude answer a fitness plan's recurring questions from one person's Oura and MacroFactor data. The spec is [SPEC.md](SPEC.md); every departure from it is logged in [DECISIONS.md](DECISIONS.md).

## Shape

- **Cloudflare Worker** (`src/index.ts`): Streamable HTTP MCP endpoint at `/mcp`, OAuth with Oura as the login, `/ingest/*` for the phone, `/admin/*` for the operator.
- **D1** holds the normalized tables (see `migrations/`); **KV** holds raw uploads, the encrypted Oura tokens, and OAuth state.
- **Oura** syncs every 2 hours and on demand; **MacroFactor** arrives from the phone: a weekly Quick Export, a nightly nutrition snapshot, and a morning Health snapshot (Shortcuts under `shortcuts/`).
- **Tools**: `get_status`, `get_daily`, `get_weekly`, `get_food_log`, `get_checkins`, `get_sleep_detail`, `get_events`, `query`. All read-only.

## Operate

```bash
npm install            # Node 22+
npm test               # synthetic tests; test/*.local.test.ts also runs against samples/ when present (both git-ignored)
npm run typecheck
npm run deploy         # wrangler deploy (needs `wrangler login`)
npm run shortcuts      # builds and signs the iOS Shortcuts from .dev.vars (macOS)
npm run wipe -- --yes  # deletes all stored data, tokens, and grants
```

Secrets (`wrangler secret put`): `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_USER_ID`, `CONSENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `ADMIN_TOKEN`, `UPLOAD_TOKEN`. Migrations: `wrangler d1 migrations apply gauge --remote`.

Nothing personal is committed: samples, exports, payloads, the tests that read them, generated Shortcuts (they embed the upload token), and `.dev.vars` are all git-ignored.
