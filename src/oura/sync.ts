/**
 * Oura sync: which endpoints, how records map to tables, incremental runs
 * (last 3 days, D-004) and the chunked backfill (D-017).
 */
import { addDays } from "../parsers/dates.js";
import type { Env } from "../env.js";
import { fetchCollection, OuraAuthError } from "./api.js";

type Rec = Record<string, unknown>;
type Row = Record<string, string | number | null>;

interface EndpointSpec {
  endpoint: string;
  table: string;
  key: "day" | "id";
  columns: string[];
  extract: (r: Rec) => Row;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

export const ENDPOINTS: EndpointSpec[] = [
  {
    endpoint: "daily_readiness", table: "oura_daily_readiness", key: "day",
    columns: ["day", "score", "temperature_deviation", "temperature_trend_deviation", "contributors", "timestamp"],
    extract: (r) => ({ day: str(r.day), score: num(r.score), temperature_deviation: num(r.temperature_deviation), temperature_trend_deviation: num(r.temperature_trend_deviation), contributors: json(r.contributors), timestamp: str(r.timestamp) }),
  },
  {
    endpoint: "daily_sleep", table: "oura_daily_sleep", key: "day",
    columns: ["day", "score", "contributors", "timestamp"],
    extract: (r) => ({ day: str(r.day), score: num(r.score), contributors: json(r.contributors), timestamp: str(r.timestamp) }),
  },
  {
    endpoint: "sleep", table: "oura_sleep", key: "id",
    columns: ["id", "day", "type", "bedtime_start", "bedtime_end", "total_sleep_s", "time_in_bed_s", "efficiency", "latency_s", "deep_s", "rem_s", "light_s", "awake_s", "average_hrv", "lowest_hr", "average_hr", "average_breath"],
    extract: (r) => ({
      id: str(r.id), day: str(r.day), type: str(r.type), bedtime_start: str(r.bedtime_start), bedtime_end: str(r.bedtime_end),
      total_sleep_s: num(r.total_sleep_duration), time_in_bed_s: num(r.time_in_bed), efficiency: num(r.efficiency), latency_s: num(r.latency),
      deep_s: num(r.deep_sleep_duration), rem_s: num(r.rem_sleep_duration), light_s: num(r.light_sleep_duration), awake_s: num(r.awake_time),
      average_hrv: num(r.average_hrv), lowest_hr: num(r.lowest_heart_rate), average_hr: num(r.average_heart_rate), average_breath: num(r.average_breath),
    }),
  },
  {
    endpoint: "daily_activity", table: "oura_daily_activity", key: "day",
    columns: ["day", "steps", "active_calories", "total_calories", "score", "high_s", "medium_s", "low_s", "sedentary_s", "non_wear_s", "timestamp"],
    extract: (r) => ({ day: str(r.day), steps: num(r.steps), active_calories: num(r.active_calories), total_calories: num(r.total_calories), score: num(r.score), high_s: num(r.high_activity_time), medium_s: num(r.medium_activity_time), low_s: num(r.low_activity_time), sedentary_s: num(r.sedentary_time), non_wear_s: num(r.non_wear_time), timestamp: str(r.timestamp) }),
  },
  {
    endpoint: "daily_stress", table: "oura_daily_stress", key: "day",
    columns: ["day", "stress_high_s", "recovery_high_s", "day_summary"],
    extract: (r) => ({ day: str(r.day), stress_high_s: num(r.stress_high), recovery_high_s: num(r.recovery_high), day_summary: str(r.day_summary) }),
  },
  {
    endpoint: "daily_resilience", table: "oura_daily_resilience", key: "day",
    columns: ["day", "level", "contributors"],
    extract: (r) => ({ day: str(r.day), level: str(r.level), contributors: json(r.contributors) }),
  },
  {
    endpoint: "daily_spo2", table: "oura_daily_spo2", key: "day",
    columns: ["day", "spo2_average", "breathing_disturbance_index"],
    extract: (r) => ({ day: str(r.day), spo2_average: num((r.spo2_percentage as Rec | null)?.average), breathing_disturbance_index: num(r.breathing_disturbance_index) }),
  },
  {
    endpoint: "vO2_max", table: "oura_vo2_max", key: "day",
    columns: ["day", "vo2_max"],
    extract: (r) => ({ day: str(r.day), vo2_max: num(r.vo2_max) }),
  },
  {
    endpoint: "daily_cardiovascular_age", table: "oura_cardio_age", key: "day",
    columns: ["day", "vascular_age"],
    extract: (r) => ({ day: str(r.day), vascular_age: num(r.vascular_age) }),
  },
  {
    endpoint: "rest_mode_period", table: "oura_rest_mode", key: "id",
    columns: ["id", "start_day", "end_day", "start_time", "end_time"],
    extract: (r) => ({ id: str(r.id), start_day: str(r.start_day), end_day: str(r.end_day), start_time: str(r.start_time), end_time: str(r.end_time) }),
  },
  {
    endpoint: "enhanced_tag", table: "oura_tags", key: "id",
    columns: ["id", "start_day", "end_day", "start_time", "end_time", "tag_type_code", "comment", "custom_name"],
    extract: (r) => ({ id: str(r.id), start_day: str(r.start_day), end_day: str(r.end_day), start_time: str(r.start_time), end_time: str(r.end_time), tag_type_code: str(r.tag_type_code), comment: str(r.comment), custom_name: str(r.custom_name) }),
  },
  {
    endpoint: "workout", table: "oura_workouts", key: "id",
    columns: ["id", "day", "activity", "calories", "distance", "start_datetime", "end_datetime", "intensity", "label", "source"],
    extract: (r) => ({ id: str(r.id), day: str(r.day), activity: str(r.activity), calories: num(r.calories), distance: num(r.distance), start_datetime: str(r.start_datetime), end_datetime: str(r.end_datetime), intensity: str(r.intensity), label: str(r.label), source: str(r.source) }),
  },
];

/** Endpoints whose absence on a day means "no data": these define data-through and missing days. */
export const CORE_ENDPOINTS = ["daily_readiness", "daily_sleep", "sleep", "daily_activity"];

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getState(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, value, new Date().toISOString())
    .run();
}

async function upsert(env: Env, spec: EndpointSpec, records: Rec[]): Promise<number> {
  if (records.length === 0) return 0;
  const now = new Date().toISOString();
  const cols = [...spec.columns, "raw", "synced_at"];
  const placeholders = cols.map(() => "?").join(", ");
  const updates = cols.filter((c) => c !== spec.key).map((c) => `${c} = excluded.${c}`).join(", ");
  const sql = `INSERT INTO ${spec.table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${spec.key}) DO UPDATE SET ${updates}`;
  const stmt = env.DB.prepare(sql);
  const stmts: D1PreparedStatement[] = [];
  let n = 0;
  for (const r of records) {
    const row = spec.extract(r);
    if (!row[spec.key]) continue;
    stmts.push(stmt.bind(...spec.columns.map((c) => row[c] ?? null), JSON.stringify(r), now));
    n++;
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return n;
}

export interface SyncResult {
  range: { start: string; end: string };
  records: Record<string, number>;
  errors: Record<string, string>;
}

/** Fetch and store every endpoint for [start, end] inclusive. */
export async function syncRange(env: Env, start: string, end: string, endpoints: EndpointSpec[] = ENDPOINTS): Promise<SyncResult> {
  const result: SyncResult = { range: { start, end }, records: {}, errors: {} };
  const endExclusive = addDays(end, 1);
  for (const spec of endpoints) {
    try {
      const recs = await fetchCollection(env, spec.endpoint, start, endExclusive);
      result.records[spec.endpoint] = await upsert(env, spec, recs);
    } catch (e) {
      if (e instanceof OuraAuthError) throw e;
      result.errors[spec.endpoint] = e instanceof Error ? e.message : String(e);
    }
  }
  return result;
}

async function logRun(env: Env, kind: string, range: { start: string; end: string }, startedAt: string, result: SyncResult | null, error?: string): Promise<void> {
  const records = result ? Object.values(result.records).reduce((a, b) => a + b, 0) : 0;
  const errs = result && Object.keys(result.errors).length ? JSON.stringify(result.errors) : null;
  await env.DB.prepare("INSERT INTO sync_runs (source, kind, range_start, range_end, started_at, finished_at, ok, records, error) VALUES ('oura', ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(kind, range.start, range.end, startedAt, new Date().toISOString(), error ? 0 : 1, records, error ?? errs)
    .run();
}

/** Re-fetch the last 3 days (Oura revises recent days) plus tomorrow, in case the phone is ahead of UTC. */
export async function incrementalSync(env: Env, reason: string): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const end = addDays(todayUtc(), 1);
  const start = addDays(todayUtc(), -3);
  try {
    const result = await syncRange(env, start, end);
    await logRun(env, `incremental:${reason}`, result.range, startedAt, result);
    await setState(env, "oura.last_sync_at", new Date().toISOString());
    return result;
  } catch (e) {
    await logRun(env, `incremental:${reason}`, { start, end }, startedAt, null, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export interface BackfillState {
  phase: "probe" | "chunks" | "done";
  probe_year: number;
  start?: string;
  cursor?: string;
  chunks_done: number;
  started_at: string;
  finished_at?: string;
}

const CHUNK_DAYS = 92;

/**
 * One step of the backfill (D-017). Probe phase: one year of daily_activity
 * per step until data appears. Chunk phase: one ~3-month window of every
 * endpoint per step. Each step is small enough for one Worker invocation.
 */
export async function backfillStep(env: Env): Promise<BackfillState> {
  const raw = await getState(env, "oura.backfill");
  const fromYear = Number(env.OURA_BACKFILL_FROM_YEAR || "2015");
  const state: BackfillState = raw ? (JSON.parse(raw) as BackfillState) : { phase: "probe", probe_year: fromYear, chunks_done: 0, started_at: new Date().toISOString() };
  if (state.phase === "done") return state;
  const startedAt = new Date().toISOString();
  const thisYear = Number(todayUtc().slice(0, 4));

  if (state.phase === "probe") {
    const y = state.probe_year;
    if (y > thisYear) {
      state.phase = "done";
      state.finished_at = new Date().toISOString();
      await setState(env, "oura.backfill", JSON.stringify(state));
      return state;
    }
    const recs = await fetchCollection(env, "daily_activity", `${y}-01-01`, `${y + 1}-01-01`, { maxRecords: 1 });
    await logRun(env, `backfill:probe:${y}`, { start: `${y}-01-01`, end: `${y}-12-31` }, startedAt, { range: { start: "", end: "" }, records: { daily_activity: recs.length }, errors: {} });
    if (recs.length > 0) {
      state.phase = "chunks";
      state.start = `${y}-01-01`;
      state.cursor = state.start;
    } else state.probe_year = y + 1;
    await setState(env, "oura.backfill", JSON.stringify(state));
    return state;
  }

  // chunks
  const start = state.cursor!;
  const today = todayUtc();
  const end = addDays(start, CHUNK_DAYS - 1) < today ? addDays(start, CHUNK_DAYS - 1) : addDays(today, 1);
  const result = await syncRange(env, start, end);
  await logRun(env, "backfill:chunk", result.range, startedAt, result);
  state.chunks_done++;
  if (end >= today) {
    state.phase = "done";
    state.finished_at = new Date().toISOString();
    await setState(env, "oura.last_sync_at", new Date().toISOString());
  } else state.cursor = addDays(end, 1);
  await setState(env, "oura.backfill", JSON.stringify(state));
  return state;
}

/** Summary used by get_status and the admin endpoint. */
export async function ouraSummary(env: Env): Promise<{
  coverage_start: string | null;
  data_through: string | null;
  last_sync_at: string | null;
  backfill: BackfillState | null;
  last_error: string | null;
  counts: Record<string, number>;
}> {
  const counts: Record<string, number> = {};
  const stmts = ENDPOINTS.map((s) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${s.table}`));
  const res = await env.DB.batch<{ n: number }>(stmts);
  ENDPOINTS.forEach((s, i) => (counts[s.endpoint] = res[i]?.results?.[0]?.n ?? 0));
  const range = await env.DB.prepare(
    "SELECT MIN(day) AS start, MAX(day) AS through FROM (SELECT day FROM oura_sleep WHERE type = 'long_sleep' UNION SELECT day FROM oura_daily_readiness)",
  ).first<{ start: string | null; through: string | null }>();
  const lastErr = await env.DB.prepare("SELECT error FROM sync_runs WHERE source = 'oura' AND ok = 0 ORDER BY id DESC LIMIT 1").first<{ error: string }>();
  const backfill = await getState(env, "oura.backfill");
  return {
    coverage_start: range?.start ?? null,
    data_through: range?.through ?? null,
    last_sync_at: await getState(env, "oura.last_sync_at"),
    backfill: backfill ? (JSON.parse(backfill) as BackfillState) : null,
    last_error: lastErr?.error ?? null,
    counts,
  };
}
