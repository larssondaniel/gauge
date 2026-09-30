/**
 * The MCP server: tool definitions. One McpServer per request (stateless,
 * D-001). Every tool is read-only and says so in its annotations.
 */
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Env, GrantProps } from "../env.js";
import { addDays, dateRange, isIsoDate } from "../parsers/dates.js";
import { loadOuraDays, OURA_DEFAULT_GROUPS, OURA_GROUPS, ouraRow, type OuraDay } from "../oura/daily.js";
import { getAuthStatus } from "../oura/api.js";
import { getState, incrementalSync, ouraSummary, todayUtc } from "../oura/sync.js";
import { loadCheckins, loadFoodLog, loadMfDays, loadWeightGoals, MF_DEFAULT_GROUPS, MF_GROUPS, mfRow, mfSummary } from "../mf/daily.js";
import { describeDays, render, renderCsv, type Column, type Value } from "./format.js";
import { snapshotSummary } from "../mf/snapshot.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const MAX_DAY_ROWS = 400;
const WEEKLY_THRESHOLD_DAYS = 120;
const ON_DEMAND_SYNC_MIN_GAP_MS = 10 * 60_000;
const FOOD_LOG_CAP = 500;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const RANGE_FIELDS = {
  start: z.string().optional().describe("First day, YYYY-MM-DD"),
  end: z.string().optional().describe("Last day, YYYY-MM-DD (default: today)"),
  last_n_days: z.number().int().min(1).max(MAX_DAY_ROWS).optional().describe("Alternative to start/end; ends today"),
  format: z.enum(["csv", "json"]).default("csv"),
};

const DAILY_SCHEMA = z.object({
  ...RANGE_FIELDS,
  sources: z.enum(["oura", "mf", "both"]).default("both"),
  fields: z.string().optional().describe("Column names and/or groups, comma-separated"),
  align: z.enum(["calendar", "intake_to_night"]).default("calendar"),
  granularity: z.enum(["auto", "day", "week"]).default("auto"),
  include_derived: z.boolean().default(false).describe("Rolling means and baselines (available after build step 4)"),
});
type DailyArgs = z.infer<typeof DAILY_SCHEMA>;

const FOOD_SCHEMA = z.object({
  ...RANGE_FIELDS,
  search: z.string().optional().describe("Case-insensitive substring of the food name"),
});
type FoodArgs = z.infer<typeof FOOD_SCHEMA>;

const CHECKIN_SCHEMA = z.object({ ...RANGE_FIELDS, include_goals: z.boolean().default(true) });
type CheckinArgs = z.infer<typeof CHECKIN_SCHEMA>;

export function buildServer(env: Env, _props: GrantProps): McpServer {
  const server = new McpServer({ name: "gauge", version: "0.2.0" });

  server.registerTool(
    "get_status",
    {
      title: "Data status",
      description:
        "Coverage and freshness of every source. Per source: first and last day with data, data-through date, last Oura sync or MacroFactor export time, backfill progress, last error, missing days in the last 30, recent uploads. Call this first when data looks stale or a range comes back empty. No parameters.",
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
        "One row per local calendar day, MacroFactor and Oura joined. Default output is CSV with '#' note lines first (freshness per source, alignment, missing days); units are in the column names (lb, kcal, g, mg, min, ms, bpm, °C deviation).",
        "Row D means: MacroFactor intake and targets = food logged on D; scale weight = weigh-in the morning of D; trend weight and expenditure = the app's values for D. Oura sleep/HRV/lowest HR/readiness = the main sleep that ENDED on the morning of D (Oura's own day); steps/activity/stress = during D.",
        "align=intake_to_night shifts the Oura night columns back one day so row D pairs D's intake with the night that FOLLOWED it (use for alcohol, late meals, sodium vs sleep/HRV).",
        "Range: start and end (ISO dates, inclusive) or last_n_days (default 14). Over 120 days rows become weekly means unless granularity=day (max 400 day rows).",
        "fields: comma-separated column names and/or groups. MacroFactor groups: weight (trend, scale, expenditure), intake (kcal, protein, carbs, fat, fiber, alcohol, sodium), targets, mf_extra (steps_mf, steps_health, water, caffeine, sugars, sat fat, potassium), mf_flags (fasting, partial_logging, provisional). Oura groups: recovery, sleep, activity, stress, flags, readiness_contributors, sleep_contributors, spo2, cardio. 'all' = everything. Default = weight, intake, targets, mf_flags, recovery, sleep, activity, stress, flags. Fewer fields = fewer tokens.",
        "Missing values are empty cells, never filled. targets_source=checkin means the day's targets came from MacroFactor's check-in history rather than the export. provisional=1 marks days known only from the phone's nightly snapshot. steps = Oura (the plan's source of truth); steps_mf = MacroFactor's import; steps_health = iPhone via the morning snapshot. oura_utc_offset and tz_change show travel days; split_night marks two main sleeps merged; rest_mode marks Oura rest-mode days.",
      ].join(" "),
      inputSchema: DAILY_SCHEMA,
      annotations: READ_ONLY,
    },
    async (args) => text(await dailyTable(env, args)),
  );

  server.registerTool(
    "get_food_log",
    {
      title: "Food log entries",
      description:
        "MacroFactor food entries: date, local time (HH:MM), name, serving, weight_g, kcal, protein_g, carbs_g, fat_g, fiber_g, alcohol_g, sodium_mg, caffeine_mg. Restaurant meals appear as 'Quick Add' with no food name. Range via start/end or last_n_days (default 7); search filters by name substring. Capped at 500 entries with a note; narrow the range or search to see more. Entries arrive with each export (weekly Quick Export covers the last 30 days), never from the nightly snapshot.",
      inputSchema: FOOD_SCHEMA,
      annotations: READ_ONLY,
    },
    async (args) => text(await foodLogTable(env, args)),
  );

  server.registerTool(
    "get_checkins",
    {
      title: "MacroFactor check-ins",
      description:
        "MacroFactor's program history from the Granular Export: one row per check-in date with expenditure_kcal, trend_weight_lb at the check-in, kcal_daily_avg, and the range of calorie/carb/fat targets across weekdays (kcal_min/kcal_max etc., since MacroFactor can vary targets by weekday), plus the weight-goal history (goal type, status, dates, goal weight, rate %/week). Range via start/end or last_n_days (default 90). Explains why calories moved and when.",
      inputSchema: CHECKIN_SCHEMA,
      annotations: READ_ONLY,
    },
    async (args) => text(await checkinsTable(env, args)),
  );

  return server;
}

/** Run a tool by name outside MCP (admin preview). */
export async function previewTool(env: Env, name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "get_status") return statusText(env);
  if (name === "get_daily") return dailyTable(env, DAILY_SCHEMA.parse(args));
  if (name === "get_food_log") return foodLogTable(env, FOOD_SCHEMA.parse(args));
  if (name === "get_checkins") return checkinsTable(env, CHECKIN_SCHEMA.parse(args));
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
  const m = await mfSummary(env);
  if (!m.uploads.length) lines.push("status: no exports ingested yet; share a Quick Export or Granular Export to the Upload to Gauge shortcut");
  else {
    lines.push(`coverage: ${m.coverage_start ?? "none"} .. ${m.data_through ?? "none"}`);
    lines.push(`data_through: ${m.data_through ?? "none"} (intake ${m.intake_through ?? "none"}, weigh-in ${m.weighin_through ?? "none"}, food log ${m.food_log_through ?? "none"})`);
    const lastOk = m.uploads.find((u) => u.ok);
    lines.push(`last_export_utc: ${lastOk ? `${lastOk.received_at} (${lastOk.layout}, ${lastOk.coverage_start}..${lastOk.coverage_end})` : "none"}`);
    const lag = m.data_through ? Math.round((Date.parse(today) - Date.parse(m.data_through)) / 86_400_000) : null;
    if (lag !== null && lag > 1) lines.push(`staleness: MacroFactor data ends ${m.data_through}, ${lag} days ago; export again for newer days`);
    const failed = m.uploads.filter((u) => !u.ok);
    if (failed.length) lines.push(`failed_uploads: ${failed.map((u) => `${u.received_at} ${u.filename ?? ""}: ${u.error}`).join(" | ")}`);
    lines.push(`checkins: ${m.checkins} (latest ${m.last_checkin ?? "none"})`);
    lines.push(`records: daily=${m.counts.daily}, food_entries=${m.counts.food}, snapshot_only_days=${m.counts.snapshot_days}`);
    const snap = await snapshotSummary(env);
    lines.push(`snapshot_feed: nutrition ${snap.latest_nutrition ? `${snap.latest_nutrition.date} (received ${snap.latest_nutrition.at})` : "never"}; health ${snap.latest_health ? `${snap.latest_health.date} (received ${snap.latest_health.at})` : "never"}`);
    if (m.data_through) {
      const mfDays = await loadMfDays(env, addDays(m.data_through, -29), m.data_through);
      const missingIntake = dateRange(addDays(m.data_through, -29), m.data_through).filter((d) => !mfDays.get(d)?.has_intake);
      const missingWeighin = dateRange(addDays(m.data_through, -29), m.data_through).filter((d) => !mfDays.get(d)?.has_weighin);
      lines.push(`missing_last_30_days: intake ${describeDays(missingIntake)}; weigh-ins ${describeDays(missingWeighin)}`);
    }
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------- get_daily

function resolveRange(a: { start?: string | undefined; end?: string | undefined; last_n_days?: number | undefined }, defaultDays: number): { start: string; end: string } {
  const today = todayUtc();
  if (a.start || a.end) {
    const end = a.end ?? today;
    const start = a.start ?? addDays(end, -(defaultDays - 1));
    if (!isIsoDate(start) || !isIsoDate(end)) throw new Error("start and end must be YYYY-MM-DD");
    if (start > end) throw new Error("start is after end");
    return { start, end };
  }
  const n = a.last_n_days ?? defaultDays;
  return { start: addDays(today, -(n - 1)), end: today };
}

const ALL_GROUPS: Record<string, string[]> = { ...MF_GROUPS, ...OURA_GROUPS };
const OURA_COLS = new Set(Object.values(OURA_GROUPS).flat());
const MF_COLS = new Set(Object.values(MF_GROUPS).flat());

function resolveFields(spec: string | undefined, sources: DailyArgs["sources"]): string[] {
  const defaults = [...(sources !== "oura" ? MF_DEFAULT_GROUPS : []), ...(sources !== "mf" ? OURA_DEFAULT_GROUPS : [])];
  const groups = spec ? spec.split(",").map((s) => s.trim()).filter(Boolean) : defaults;
  const cols: string[] = [];
  const add = (c: string) => {
    if (cols.includes(c)) return;
    if (sources === "oura" && MF_COLS.has(c)) return;
    if (sources === "mf" && OURA_COLS.has(c)) return;
    cols.push(c);
  };
  for (const g of groups) {
    if (g === "all") Object.values(ALL_GROUPS).flat().forEach(add);
    else if (ALL_GROUPS[g]) ALL_GROUPS[g]!.forEach(add);
    else if (OURA_COLS.has(g) || MF_COLS.has(g)) add(g);
    else throw new Error(`Unknown field or group "${g}". Groups: ${Object.keys(ALL_GROUPS).join(", ")}, all`);
  }
  return cols;
}

const DP: Record<string, number> = { hrv_ms: 1, avg_hr_bpm: 1, breath_rate: 1, temp_dev_c: 2, temp_trend_dev_c: 2, sleep_efficiency_pct: 0, trend_weight_lb: 2, scale_weight_lb: 1 };

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
  const { start, end } = resolveRange(a, 14);
  const allDays = dateRange(start, end);
  const nDays = allDays.length;
  const weekly = a.granularity === "week" || (a.granularity === "auto" && nDays > WEEKLY_THRESHOLD_DAYS);
  if (!weekly && nDays > MAX_DAY_ROWS) throw new Error(`Range is ${nDays} days; day granularity allows ${MAX_DAY_ROWS}. Narrow the range or use granularity=week.`);
  const notes: string[] = [];
  const fields = resolveFields(a.fields, a.sources);
  const columns: Column[] = [{ name: weekly ? "week_start" : "date" }];
  if (weekly) columns.push({ name: "days_n" });
  for (const col of fields) columns.push(DP[col] !== undefined ? { name: col, dp: DP[col]! } : { name: col });

  const rows: Record<string, Value>[] = allDays.map((d) => ({ date: d }));
  const byDate = new Map(rows.map((r) => [r.date as string, r]));

  if (a.sources !== "oura") {
    const m = await mfSummary(env);
    const mfDays = await loadMfDays(env, start, end);
    if (!m.uploads.length) notes.push("macrofactor: no exports ingested yet");
    else {
      const lag = m.data_through ? Math.round((Date.parse(todayUtc()) - Date.parse(m.data_through)) / 86_400_000) : null;
      const lastOk = m.uploads.find((u) => u.ok);
      notes.push(`macrofactor: data through ${m.data_through ?? "none"}; last export ${lastOk?.received_at ?? "none"} UTC${lag !== null && lag > 1 ? ` (${lag} days behind; export again for newer days)` : ""}`);
      const covered = allDays.filter((d) => d <= (m.data_through ?? ""));
      const missingIntake = covered.filter((d) => !mfDays.get(d)?.has_intake);
      const missingWeighin = covered.filter((d) => !mfDays.get(d)?.has_weighin);
      notes.push(`macrofactor missing days in range: intake ${describeDays(missingIntake)}; weigh-ins ${describeDays(missingWeighin)}`);
      const provisional = allDays.filter((d) => mfDays.get(d)?.provisional);
      if (provisional.length) notes.push(`provisional (snapshot-only) days: ${describeDays(provisional)}`);
    }
    for (const d of allDays) Object.assign(byDate.get(d)!, mfRow(mfDays.get(d)));
  }

  if (a.sources !== "mf") {
    await ensureFresh(env, end, notes);
    const s = await ouraSummary(env);
    const shift = a.align === "intake_to_night" ? 1 : 0;
    const days = await loadOuraDays(env, addDays(start, -1), addDays(end, shift));
    const inRange = allDays.map((d) => days.get(d)!);
    const dataThrough = s.data_through ?? "none";
    const missingSleep = inRange.filter((d) => !d.has_sleep && d.day <= (s.data_through ?? "")).map((d) => d.day);
    const missingReadiness = inRange.filter((d) => !d.has_readiness && d.day <= (s.data_through ?? "")).map((d) => d.day);
    notes.push(`oura: data through ${dataThrough}; last sync ${s.last_sync_at ?? "never"} UTC${s.backfill && s.backfill.phase !== "done" ? `; backfill ${s.backfill.phase} (history before the cursor is incomplete)` : ""}`);
    notes.push(`oura missing days in range: main sleep ${describeDays(missingSleep)}; readiness ${describeDays(missingReadiness)}`);
    if (end > dataThrough && dataThrough !== "none") notes.push(`rows after ${dataThrough} have no Oura data yet`);
    notes.push(a.align === "intake_to_night" ? "align=intake_to_night: sleep, HRV, and readiness columns on row D are from the night after D (Oura day D+1)" : "align=calendar: sleep, HRV, and readiness on row D are the main sleep that ended the morning of D");
    let prev: OuraDay | undefined = days.get(addDays(start, -1));
    for (const day of inRange) {
      const night = shift ? days.get(addDays(day.day, 1))! : day;
      Object.assign(byDate.get(day.day)!, ouraRow(day, night, prev));
      prev = day;
    }
  }
  if (a.include_derived) notes.push("include_derived is not available until build step 4; returning base columns");

  const projected = rows.map((r) => {
    const o: Record<string, Value> = { date: r.date as string };
    for (const c of fields) o[c] = r[c] ?? null;
    return o;
  });
  const out = weekly ? toWeekly(projected, columns, env.WEEK_START) : projected;
  if (weekly) notes.push(`weekly rows (means of numeric columns over days with data, counts for flags; week starts ${env.WEEK_START}); pass granularity=day for daily rows`);
  const cols = weekly ? columns.filter((c) => !["bedtime_start", "bedtime_end", "oura_utc_offset", "resilience", "targets_source"].includes(c.name)) : columns;
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

// ---------------------------------------------------------------- get_food_log

async function foodLogTable(env: Env, a: FoodArgs): Promise<string> {
  const { start, end } = resolveRange(a, 7);
  const m = await mfSummary(env);
  const { rows, total } = await loadFoodLog(env, start, end, a.search, FOOD_LOG_CAP);
  const notes = [`food log ${start}..${end}${a.search ? ` matching "${a.search}"` : ""}: ${rows.length} of ${total} entries`];
  notes.push(`macrofactor food log through ${m.food_log_through ?? "none"}; last export ${m.uploads.find((u) => u.ok)?.received_at ?? "none"} UTC`);
  if (total > rows.length) notes.push(`capped at ${FOOD_LOG_CAP} entries; narrow the range or add search`);
  if (end > (m.food_log_through ?? "")) notes.push(`entries after ${m.food_log_through ?? "none"} arrive with the next export`);
  const columns: Column[] = ["date", "time", "name", "serving", "weight_g", "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "alcohol_g", "sodium_mg", "caffeine_mg"].map((n) => ({ name: n, ...(["weight_g", "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "alcohol_g", "sodium_mg", "caffeine_mg"].includes(n) ? { dp: 1 } : {}) }));
  return render(a.format, notes, columns, rows);
}

// ---------------------------------------------------------------- get_checkins

async function checkinsTable(env: Env, a: CheckinArgs): Promise<string> {
  const { start, end } = resolveRange(a, 90);
  const m = await mfSummary(env);
  const rows = await loadCheckins(env, start, end);
  const notes = [`check-ins ${start}..${end}: ${rows.length}; source Granular Export (${m.checkins} check-ins on file, latest ${m.last_checkin ?? "none"})`];
  if (!m.checkins) notes.push("no check-in history yet: it arrives with a Granular Export (Nutrition Program Settings)");
  const columns: Column[] = [
    { name: "date" }, { name: "expenditure_kcal" }, { name: "trend_weight_lb", dp: 1 }, { name: "kcal_daily_avg" }, { name: "kcal_min" }, { name: "kcal_max" },
    { name: "protein_g" }, { name: "carbs_g_min" }, { name: "carbs_g_max" }, { name: "fat_g_min" }, { name: "fat_g_max" }, { name: "weekdays_n" }, { name: "mode" },
  ];
  if (a.format === "json") {
    const goals = a.include_goals ? await loadWeightGoals(env) : [];
    return JSON.stringify({ notes, checkins: rows, weight_goals: goals });
  }
  let out = renderCsv(notes, columns, rows);
  if (a.include_goals) {
    const goals = await loadWeightGoals(env);
    const gcols: Column[] = ["goal", "status", "start_date", "end_date", "goal_weight_lb", "rate_pct_per_week", "starting_scale_weight_lb", "starting_trend_weight_lb", "ending_trend_weight_lb", "ending_scale_weight_lb"].map((n) => ({ name: n }));
    out += `\n\n${renderCsv([`weight goals: ${goals.length} (all time)`], gcols, goals)}`;
  }
  return out;
}
