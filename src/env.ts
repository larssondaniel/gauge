/** Bindings and secrets the Worker expects (see wrangler.jsonc). */
export interface Env {
  OAUTH_KV: KVNamespace;
  DATA_KV: KVNamespace;
  DB: D1Database;
  BASE_URL: string;
  WEEK_START: string;
  OURA_SCOPES: string;
  OURA_BACKFILL_FROM_YEAR: string;
  // Secrets
  OURA_CLIENT_ID: string;
  OURA_CLIENT_SECRET: string;
  OURA_USER_ID?: string;
  CONSENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  ADMIN_TOKEN?: string;
  UPLOAD_TOKEN?: string;
  // Provided by @cloudflare/workers-oauth-provider to the default handler.
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}

/** What completeAuthorization() stores per grant; handlers read it from ctx.props. */
export interface GrantProps {
  ouraUserId: string;
}
