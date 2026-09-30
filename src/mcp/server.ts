/**
 * The MCP server: tool definitions. One McpServer per request (stateless,
 * D-001). Every tool is read-only and says so in its annotations.
 */
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Env, GrantProps } from "../env.js";
import { addDays, dateRange, isIsoDate } from "../parsers/dates.js";
import { loadOuraDays, NIGHT_COLUMNS, OURA_DEFAULT_GROUPS, OURA_GROUPS, ouraRow, type OuraDay } from "../oura/daily.js";
import { getAuthStatus } from "../oura/api.js";
import { getState, incrementalSync, ouraSummary, todayUtc } from "../oura/sync.js";
import { describeDays, render, type Column, type Value } from "./format.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const MAX_DAY_ROWS = 400;
const WEEKLY_THRESHOLD_DAYS = 120;
const ON_DEMAND_SYNC_MIN_GAP_MS = 10 * 60_000;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function buildServer(env: Env, _props: GrantProps): McpServer {
  const server = new McpServer({ name: "gauge", version: "0.1.0" });

  server.registerTool(
    "get_status",
    {
      title: "Data status",
      description:
        "Coverage and freshness of every source. Returns, per source: first and last day with data, data-through date, last sync or export time, backfill progress, last error, and missing days in the last 30. Call this first when data looks stale or a range comes back empty. No parameters.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => text(await statusText(env)),
  );

  server.registerTool(
    "get_daily",
    {
      title: "Daily table",
      description: [
        "One row per local calendar day, joined across sources. Default output is CSV with '#' note lines first (freshness, alignment, missing days); units are in the column names (min, ms, bpm, kcal, °C deviation).",
        "Date semantics (align=calendar): Oura sleep/HRV/lowest HR/readiness on row D describe the main sleep that ENDED on the morning of D (Oura's own day); steps/activity/stress are during D. align=intake_to_night shifts the night columns back one day so row D pairs D's daytime with the night that FOLLOWED it.",
        "Range: start and end (ISO dates, inclusive) or last_n_days (default 14). Over 120 days rows become weekly means unless granularity=day (max 400 day rows).",
        "fields: comma-separated column names and/or groups: recovery, sleep, activity, stress, flags (default set), readiness_contributors, sleep_contributors, spo2, cardio, all. Fewer fields means fewer tokens.",
        "Missing values are empty cells, never filled in. oura_utc_offset and tz_change show travel days; split_night marks two main sleeps merged into one row; rest_mode marks Oura rest-mode days.",
        "MacroFactor columns (trend weight, expenditure, intake, targets) join in once exports are ingested; until then sources=mf returns only the date column.",
      ].join(" "),
      inputSchema: DAILY_SCHEMA,
      annotations: READ_ONLY,
    },
    async (args) => text(await dailyTable(env, args)),
  );

  return server;
}

const DAILY_SCHEMA = z.object({
        start: z.string().optional().describe("First day, YYYY-MM-DD"),
        end: z.string().optional().describe("Last day, YYYY-MM-DD (default: today)"),
        last_n_days: z.number().int().min(1).max(MAX_DAY_ROWS).optional().describe("Alternative to start/end; ends today"),
        sources: z.enum(["oura", "mf", "both"]).default("both"),
        fields: z.string().optional().describe("Column names and/or groups, comma-separated"),
        align: z.enum(["calendar", "intake_to_night"]).default("calendar"),
        granularity: z.enum(["auto", "day", "week"]).default("auto"),
        format: z.enum(["csv", "json"]).default("csv"),
        include_derived: z.boolean().default(false).describe("Rolling means and baselines (available after build step 4)"),
});

/** Run a tool by name outside MCP (admin preview). */
export async function previewTool(env: Env, name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "get_status") return statusText(env);
  if (name === "get_daily") {
    const parsed = DAILY_SCHEMA.parse(args);
    return dailyTable(env, parsed);
  }
  throw new Error(`unknown tool ${name}`);
}

// ------------------------------------------------------------------ get_status

async function statusText(env: Env): Promise<string> {
  const now = new Date().toISOString();
  const auth = await getAuthStatus(env);
  const s = await ouraSummary(env);
  const lines: string[] = [`server_time_utc: ${now}`, `week_start: ${env.WEEK_START}`, ""];
  lines.push("[oura]");
  lines.push(`auth: ${auth.state}${auth.detail ? ` (${auth.detail})` : ""}`);
  lines.push(`coverage: ${s.coverage_start ?? "none"} .. ${s.data_through ?? "none"}`);
  lines.push(`data_through: ${s.data_through ?? "none"}`);
  lines.push(`last_sync_utc: ${s.last_sync_at ?? "never"}`);
  if (s.backfill) {
    const b = s.backfill;
    lines.push(`backfill: ${b.phase}${b.phase === "chunks" ? ` (cursor ${b.cursor}, ${b.chunks_done} chunks done)` : b.phase === "probe" ? ` (probing ${b.probe_year})` : ` (${b.chunks_done} chunks, finished ${b.finished_at})`}`);
  } else lines.push("backfill: not started");
  if (s.last_error) lines.push(`last_error: ${s.last_error.slice(0, 300)}`);
  const today = todayUtc();
  if (s.data_through) {
    const days = await loadOuraDays(env, addDays(today, -29), today);
    const missingSleep = [...days.values()].filter((d) => !d.has_sleep && d.day <= s.data_through!).map((d) => d.day);
    const missingReadiness = [...days.values()].filter((d) => !d.has_readiness && d.day <= s.data_through!).map((d) => d.day);
    lines.push(`missing_last_30_days: sleep ${describeDays(missingSleep)}; readiness ${describeDays(missingReadiness)}`);
  }
  lines.push(`records: ${Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push("");
  lines.push("[macrofactor]");
  lines.push("status: not ingested yet (export ingestion arrives in build step 2)");
  return lines.join("\n");
}

// ------------------------------------------------------------------- get_daily

interface DailyArgs {
  start?: string | undefined;
  end?: string | undefined;
  last_n_days?: number | undefined;
  sources: "oura" | "mf" | "both";
  fields?: string | undefined;
  align: "calendar" | "intake_to_night";
  granularity: "auto" | "day" | "week";
  format: "csv" | "json";
  include_derived: boolean;
}

function resolveRange(a: DailyArgs): { start: string; end: string } {
  const today = todayUtc();
  if (a.start || a.end) {
    const end = a.end ?? today;
    const start = a.start ?? addDays(end, -13);
    if (!isIsoDate(start) || !isIsoDate(end)) throw new Error("start and end must be YYYY-MM-DD");
    if (start > end) throw new Error("start is after end");
    return { start, end };
  }
  const n = a.last_n_days ?? 14;
  return { start: addDays(today, -(n - 1)), end: today };
}

function resolveFields(spec: string | undefined): string[] {
  const groups = spec ? spec.split(",").map((s) => s.trim()).filter(Boolean) : OURA_DEFAULT_GROUPS;
  const cols: string[] = [];
  const add = (c: string) => {
    if (!cols.includes(c)) cols.push(c);
  };
  const all = new Set(Object.values(OURA_GROUPS).flat());
  for (const g of groups) {
    if (g === "all") Object.values(OURA_GROUPS).flat().forEach(add);
    else if (OURA_GROUPS[g]) OURA_GROUPS[g]!.forEach(add);
    else if (all.has(g)) add(g);
    else throw new Error(`Unknown field or group "${g}". Groups: ${Object.keys(OURA_GROUPS).join(", ")}, all`);
  }
  return cols;
}

const DP: Record<string, number> = { hrv_ms: 1, avg_hr_bpm: 1, breath_rate: 1, temp_dev_c: 2, temp_trend_dev_c: 2, sleep_efficiency_pct: 0 };

async function ensureFresh(env: Env, end: string, notes: string[]): Promise<void> {
  const today = todayUtc();
  if (end < addDays(today, -3)) return;
  const last = await getState(env, "oura.last_sync_at");
  if (last && Date.now() - Date.parse(last) < ON_DEMAND_SYNC_MIN_GAP_MS) return;
  const auth = await getAuthStatus(env);
  if (auth.state !== "ok") {
    notes.push(`oura sync skipped: ${auth.state}${auth.detail ? ` (${auth.detail})` : ""}; reconnect the Gauge connector in Claude`);
    return;
  }
  try {
    await Promise.race([incrementalSync(env, "on_demand"), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 12_000))]);
  } catch (e) {
    notes.push(`oura on-demand sync failed (${e instanceof Error ? e.message : String(e)}); showing stored data`);
  }
}

async function dailyTable(env: Env, a: DailyArgs): Promise<string> {
  const { start, end } = resolveRange(a);
  const nDays = dateRange(start, end).length;
  const weekly = a.granularity === "week" || (a.granularity === "auto" && nDays > WEEKLY_THRESHOLD_DAYS);
  if (!weekly && nDays > MAX_DAY_ROWS) throw new Error(`Range is ${nDays} days; day granularity allows ${MAX_DAY_ROWS}. Narrow the range or use granularity=week.`);
  const notes: string[] = [];
  const fields = resolveFields(a.fields);
  const columns: Column[] = [{ name: weekly ? "week_start" : "date" }];
  if (weekly) columns.push({ name: "days_n" });

  const rows: Record<string, Value>[] = [];
  if (a.sources !== "mf") {
    await ensureFresh(env, end, notes);
    const s = await ouraSummary(env);
    const shift = a.align === "intake_to_night" ? 1 : 0;
    const days = await loadOuraDays(env, addDays(start, -1), addDays(end, shift));
    const inRange = dateRange(start, end).map((d) => days.get(d)!);
    const dataThrough = s.data_through ?? "none";
    const missingSleep = inRange.filter((d) => !d.has_sleep && d.day <= (s.data_through ?? "")).map((d) => d.day);
    const missingReadiness = inRange.filter((d) => !d.has_readiness && d.day <= (s.data_through ?? "")).map((d) => d.day);
    notes.push(`oura: data through ${dataThrough}; last sync ${s.last_sync_at ?? "never"} UTC${s.backfill && s.backfill.phase !== "done" ? `; backfill ${s.backfill.phase} (history before the cursor is incomplete)` : ""}`);
    notes.push(`oura missing days in range: main sleep ${describeDays(missingSleep)}; readiness ${describeDays(missingReadiness)}`);
    if (end > dataThrough && dataThrough !== "none") notes.push(`rows after ${dataThrough} have no Oura data yet`);
    notes.push(a.align === "intake_to_night" ? "align=intake_to_night: sleep, HRV, and readiness columns on row D are from the night after D (Oura day D+1)" : "align=calendar: sleep, HRV, and readiness on row D are the main sleep that ended the morning of D");
    for (const col of fields) columns.push(DP[col] !== undefined ? { name: col, dp: DP[col]! } : { name: col });
    let prev: OuraDay | undefined = days.get(addDays(start, -1));
    for (const day of inRange) {
      const night = shift ? days.get(addDays(day.day, 1))! : day;
      const full = ouraRow(day, night, prev);
      const r: Record<string, Value> = { date: day.day };
      for (const col of fields) r[col] = full[col] ?? null;
      rows.push(r);
      prev = day;
    }
  } else {
    notes.push("sources=mf: MacroFactor columns are not available until export ingestion (build step 2)");
    for (const d of dateRange(start, end)) rows.push({ date: d });
  }
  if (a.include_derived) notes.push("include_derived is not available until build step 4; returning base columns");

  const out = weekly ? toWeekly(rows, columns, env.WEEK_START) : rows;
  if (weekly) {
    notes.push(`weekly rows (means of numeric columns over days with data; week starts ${env.WEEK_START}); pass granularity=day for daily rows`);
  }
  const cols = weekly ? columns.filter((c) => !["bedtime_start", "bedtime_end", "oura_utc_offset", "resilience"].includes(c.name)) : columns;
  notes.unshift(`range ${start}..${end} (${nDays} days), ${out.length} rows, sources=${a.sources}`);
  return render(a.format, notes, cols, out);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function weekStartOf(date: string, weekStart: string): string {
  const target = WEEKDAYS.indexOf(weekStart.toLowerCase());
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const back = (dow - (target < 0 ? 1 : target) + 7) % 7;
  return addDays(date, -back);
}

function toWeekly(rows: Record<string, Value>[], columns: Column[], weekStart: string): Record<string, Value>[] {
  const groups = new Map<string, Record<string, Value>[]>();
  for (const r of rows) {
    const ws = weekStartOf(r.date as string, weekStart);
    const list = groups.get(ws) ?? [];
    list.push(r);
    groups.set(ws, list);
  }
  const out: Record<string, Value>[] = [];
  for (const [ws, list] of groups) {
    const w: Record<string, Value> = { week_start: ws, days_n: list.length };
    for (const c of columns) {
      if (c.name === "date" || c.name === "week_start" || c.name === "days_n") continue;
      const vals = list.map((r) => r[c.name]).filter((v): v is number => typeof v === "number");
      const bools = list.map((r) => r[c.name]).filter((v): v is boolean => typeof v === "boolean");
      const f = 10 ** (c.dp ?? 1);
      if (vals.length) w[c.name] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * f) / f;
      else if (bools.length) w[c.name] = bools.filter(Boolean).length;
      else w[c.name] = null;
    }
    out.push(w);
  }
  return out;
}

export { NIGHT_COLUMNS };
