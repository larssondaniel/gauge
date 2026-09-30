/**
 * Oura API v2 client: token storage and refresh (D-002), pagination, rate limits.
 *
 * Tokens live in DATA_KV under `oura:tokens`, AES-GCM encrypted with
 * TOKEN_ENCRYPTION_KEY, so the scheduled sync can use them without a Claude
 * session. Oura refresh tokens are single-use, so refreshes take a short KV
 * lock and never run concurrently on purpose.
 */
import type { Env } from "../env.js";
import { decryptJson, encryptJson } from "../lib/crypto.js";

export const OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
export const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
export const OURA_API = "https://api.ouraring.com/v2";

const TOKENS_KEY = "oura:tokens";
const LOCK_KEY = "oura:refresh_lock";
const STATUS_KEY = "oura:auth_status";

export interface OuraTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch ms when the access token expires. */
  expires_at: number;
  obtained_at: string;
  user_id: string;
}

export interface OuraAuthStatus {
  state: "ok" | "needs_reconnect" | "never_connected";
  detail?: string;
  at: string;
}

export class OuraAuthError extends Error {
  override readonly name = "OuraAuthError";
}
export class OuraApiError extends Error {
  override readonly name = "OuraApiError";
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function loadTokens(env: Env): Promise<OuraTokens | null> {
  const blob = await env.DATA_KV.get(TOKENS_KEY);
  return blob ? decryptJson<OuraTokens>(env.TOKEN_ENCRYPTION_KEY, blob) : null;
}

export async function saveTokens(env: Env, t: OuraTokens): Promise<void> {
  await env.DATA_KV.put(TOKENS_KEY, await encryptJson(env.TOKEN_ENCRYPTION_KEY, t));
  await setAuthStatus(env, { state: "ok", at: new Date().toISOString() });
}

export async function deleteTokens(env: Env): Promise<void> {
  await env.DATA_KV.delete(TOKENS_KEY);
}

export async function getAuthStatus(env: Env): Promise<OuraAuthStatus> {
  const s = await env.DATA_KV.get<OuraAuthStatus>(STATUS_KEY, "json");
  return s ?? { state: "never_connected", at: "" };
}

async function setAuthStatus(env: Env, s: OuraAuthStatus): Promise<void> {
  await env.DATA_KV.put(STATUS_KEY, JSON.stringify(s));
}

/** Exchange an authorization code (with PKCE verifier) for tokens. */
export async function exchangeCode(env: Env, code: string, redirectUri: string, verifier: string): Promise<OuraTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: env.OURA_CLIENT_ID,
    client_secret: env.OURA_CLIENT_SECRET,
    code_verifier: verifier,
  });
  return tokenRequest(body, "");
}

async function tokenRequest(body: URLSearchParams, keepRefresh: string): Promise<OuraTokens> {
  const res = await fetch(OURA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    let code = "";
    try {
      code = String((JSON.parse(text) as { error?: string }).error ?? "");
    } catch {
      /* not JSON */
    }
    if (res.status === 400 || res.status === 401) throw new OuraAuthError(`Oura token endpoint refused: ${code || res.status}`);
    throw new OuraApiError(`Oura token endpoint error ${res.status}`, res.status);
  }
  const j = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in: number };
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? keepRefresh,
    expires_at: Date.now() + Math.max(60, j.expires_in) * 1000,
    obtained_at: new Date().toISOString(),
    user_id: "",
  };
}

/** Returns a valid access token, refreshing under a lock when it is within 5 minutes of expiry. */
export async function getAccessToken(env: Env): Promise<string> {
  let t = await loadTokens(env);
  if (!t) throw new OuraAuthError("Oura is not connected. Connect the Gauge connector in Claude to sign in with Oura.");
  if (t.expires_at - Date.now() > 5 * 60_000) return t.access_token;

  // Single-flight refresh: take a short lock; if someone else holds it, wait and re-read.
  const lockId = crypto.randomUUID();
  const existing = await env.DATA_KV.get(LOCK_KEY);
  if (existing) {
    await sleep(1500);
    t = await loadTokens(env);
    if (t && t.expires_at - Date.now() > 60_000) return t.access_token;
  }
  await env.DATA_KV.put(LOCK_KEY, lockId, { expirationTtl: 60 });
  try {
    const fresh = await loadTokens(env);
    if (fresh && fresh.expires_at - Date.now() > 5 * 60_000) return fresh.access_token;
    const current = fresh ?? t;
    if (!current) throw new OuraAuthError("Oura is not connected.");
    let refreshed: OuraTokens;
    try {
      refreshed = await tokenRequest(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refresh_token,
          client_id: env.OURA_CLIENT_ID,
          client_secret: env.OURA_CLIENT_SECRET,
        }),
        current.refresh_token,
      );
    } catch (e) {
      if (e instanceof OuraAuthError) {
        await setAuthStatus(env, { state: "needs_reconnect", detail: e.message, at: new Date().toISOString() });
      }
      throw e;
    }
    refreshed.user_id = current.user_id;
    await saveTokens(env, refreshed);
    return refreshed.access_token;
  } finally {
    await env.DATA_KV.delete(LOCK_KEY);
  }
}

export async function personalInfo(accessToken: string): Promise<{ id: string; email?: string }> {
  const res = await fetch(`${OURA_API}/usercollection/personal_info`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new OuraApiError(`personal_info failed: ${res.status}`, res.status);
  return (await res.json()) as { id: string; email?: string };
}

export interface FetchOptions {
  /** Total records cap as a safety net. */
  maxRecords?: number;
}

/**
 * Fetch every record of a collection endpoint between two dates, following
 * `next_token`. Oura's end_date behaved as exclusive in the sandbox, so callers
 * pass the day after the last day they want.
 */
export async function fetchCollection(env: Env, endpoint: string, startDate: string, endDate: string, opts: FetchOptions = {}): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let nextToken: string | undefined;
  let token = await getAccessToken(env);
  let retried401 = false;
  for (let page = 0; page < 200; page++) {
    const url = new URL(`${OURA_API}/usercollection/${endpoint}`);
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);
    if (nextToken) url.searchParams.set("next_token", nextToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.status === 401 && !retried401) {
      retried401 = true;
      await forceExpire(env);
      token = await getAccessToken(env);
      page--;
      continue;
    }
    if (res.status === 429) {
      const wait = Math.min(10, Number(res.headers.get("Retry-After") ?? "5")) * 1000;
      await sleep(wait);
      page--;
      continue;
    }
    if (!res.ok) throw new OuraApiError(`${endpoint} ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    const j = (await res.json()) as { data?: Record<string, unknown>[]; next_token?: string | null };
    out.push(...(j.data ?? []));
    if (opts.maxRecords && out.length >= opts.maxRecords) break;
    if (!j.next_token) break;
    nextToken = j.next_token;
  }
  return out;
}

async function forceExpire(env: Env): Promise<void> {
  const t = await loadTokens(env);
  if (t) await env.DATA_KV.put(TOKENS_KEY, await encryptJson(env.TOKEN_ENCRYPTION_KEY, { ...t, expires_at: 0 }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
