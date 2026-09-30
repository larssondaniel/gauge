/**
 * Step 4 tools: get_weekly, get_sleep_detail, get_events, query, and the
 * derived columns for get_daily.
 */
import type { Env } from "../env.js";
import { addDays, dateRange } from "../parsers/dates.js";
import { loadOuraDays, type OuraDay } from "../oura/daily.js";
import { loadMfDays, type MfDayRow } from "../mf/daily.js";
import { DEFAULT_WINDOWS, mean, min, r1, r2, rolling, rollingMean, sum, trendRate, type Series, type Windows } from "./derived.js";
import { renderCsv, type Column, type Value } from "./format.js";
import { guardSql } from "./schema.js";

// ------------------------------------------------------------- derived (daily)

export const DERIVED_COLUMNS = [
  "energy_balance_kcal", "trend_rate_pct_wk",
  "hrv_7d_mean", "hrv_7d_n", "hrv_30d_baseline", "hrv_base_n", "hrv_dev_pct",
  "lowhr_7d_mean", "lowhr_7d_n", "lowhr_30d_baseline", "lowhr_base_n", "lowhr_dev_pct",
  "sleep_7d_mean_min", "sleep_7d_n",
];

/** Derived columns for every day in [start, end]. Loads the history it needs itself. */
export async function derivedRows(env: Env, start: string, end: string, w: Windows = DEFAULT_WINDOWS): Promise<Map<string, Record<string, Value>>> {
  const back = w.recentDays + w.baselineDays;
  const oura = await loadOuraDays(env, addDays(start, -back), end);
  const mf = await loadMfDays(env, addDays(start, -7), end);
  const excluded = new Set([...oura.values()].filter((d) => d.rest_mode).map((d) => d.day));
  const series = (pick: (d: OuraDay) => number | null): Series => ({ values: new Map([...oura.values()].map((d) => [d.day, pick(d)])), excluded });
  const hrv = series((d) => d.hrv_ms);
  const lowhr = series((d) => d.lowest_hr_bpm);
  const sleep = series((d) => d.sleep_total_min);
  const trend = new Map([...mf.values()].map((d) => [d.date, d.trend_weight_lb]));
  const out = new Map<string, Record<string, Value>>();
  for (const day of dateRange(start, end)) {
    const m = mf.get(day);
    const h = rolling(hrv, day, w);
    const l = rolling(lowhr, day, w);
    const s = rollingMean(sleep, day, w.recentDays);
    out.set(day, {
      energy_balance_kcal: m && m.calories_kcal !== null && m.expenditure_kcal !== null ? Math.round(m.calories_kcal - m.expenditure_kcal) : null,
      trend_rate_pct_wk: trendRate(trend, day),
      hrv_7d_mean: h.recent_mean, hrv_7d_n: h.recent_n, hrv_30d_baseline: h.baseline_mean, hrv_base_n: h.baseline_n, hrv_dev_pct: h.dev_pct,
      lowhr_7d_mean: l.recent_mean, lowhr_7d_n: l.recent_n, lowhr_30d_baseline: l.baseline_mean, lowhr_base_n: l.baseline_n, lowhr_dev_pct: l.dev_pct,
      sleep_7d_mean_min: s.mean, sleep_7d_n: s.n,
    });
  }
  return out;
}

// ------------------------------------------------------------------ get_weekly

export interface WeeklyArgs {
  start: string;
  end: string;
  weekStart: string;
  sources: "oura" | "mf" | "both";
  stepsThreshold?: number | undefined;
  stepsSource: "oura" | "health";
  windows: Windows;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export function weekStartOf(date: string, weekStart: string): string {
  const target = WEEKDAYS.indexOf(weekStart.toLowerCase());
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((dow - (target < 0 ? 1 : target) + 7) % 7));
}

export async function weeklyRows(env: Env, a: WeeklyArgs): Promise<{ columns: Column[]; rows: Record<string, Value>[] }> {
  const wantMf = a.sources !== "oura";
  const wantOura = a.sources !== "mf";
  const mf = wantMf ? await loadMfDays(env, addDays(a.start, -7), a.end) : new Map<string, MfDayRow>();
  const back = a.windows.recentDays + a.windows.baselineDays;
  const oura = wantOura ? await loadOuraDays(env, addDays(a.start, -back), a.end) : new Map<string, OuraDay>();
  const excluded = new Set([...oura.values()].filter((d) => d.rest_mode).map((d) => d.day));
  const hrvSeries: Series = { values: new Map([...oura.values()].map((d) => [d.day, d.hrv_ms])), excluded };
  const lowhrSeries: Series = { values: new Map([...oura.values()].map((d) => [d.day, d.lowest_hr_bpm])), excluded };

  const weeks = new Map<string, string[]>();
  for (const d of dateRange(a.start, a.end)) {
    const ws = weekStartOf(d, a.weekStart);
    weeks.set(ws, [...(weeks.get(ws) ?? []), d]);
  }
  const columns: Column[] = [{ name: "week_start" }, { name: "days_n" }];
  const rows: Record<string, Value>[] = [];
  const first = true;
  for (const [ws, days] of weeks) {
    const r: Record<string, Value> = { week_start: ws, days_n: days.length };
    const last = days[days.length - 1]!;
    if (wantMf) {
      const md = days.map((d) => mf.get(d)).filter((x): x is MfDayRow => !!x);
      const logged = md.filter((d) => d.has_intake);
      const kcal = mean(logged.map((d) => d.calories_kcal));
      Object.assign(r, {
        days_logged: logged.length,
        weighins_n: md.filter((d) => d.has_weighin).length,
        kcal_mean: r1(kcal.mean),
        protein_g_mean: r1(mean(logged.map((d) => d.protein_g)).mean),
        carbs_g_mean: r1(mean(logged.map((d) => d.carbs_g)).mean),
        fat_g_mean: r1(mean(logged.map((d) => d.fat_g)).mean),
        fiber_g_mean: r1(mean(logged.map((d) => d.fiber_g)).mean),
        sodium_mg_mean: r1(mean(logged.map((d) => d.sodium_mg)).mean),
        alcohol_g_total: r1(sum(logged.map((d) => d.alcohol_g ?? 0))),
        drinking_days: logged.filter((d) => (d.alcohol_g ?? 0) > 0).length,
        expenditure_mean: r1(mean(md.map((d) => d.expenditure_kcal)).mean),
        energy_balance_mean: r1(mean(logged.map((d) => (d.calories_kcal !== null && d.expenditure_kcal !== null ? d.calories_kcal - d.expenditure_kcal : null))).mean),
        target_kcal_mean: r1(mean(logged.map((d) => d.target_kcal)).mean),
        dev_kcal_mean: r1(mean(logged.map((d) => (d.calories_kcal !== null && d.target_kcal !== null ? d.calories_kcal - d.target_kcal : null))).mean),
        dev_pct_mean: r1(mean(logged.map((d) => (d.calories_kcal !== null && d.target_kcal ? ((d.calories_kcal - d.target_kcal) / d.target_kcal) * 100 : null))).mean),
        days_over_target: logged.filter((d) => d.calories_kcal !== null && d.target_kcal !== null && d.calories_kcal > d.target_kcal).length,
        days_under_target: logged.filter((d) => d.calories_kcal !== null && d.target_kcal !== null && d.calories_kcal < d.target_kcal).length,
        partial_logging_days: md.filter((d) => d.partial_logging).length,
        provisional_days: md.filter((d) => d.provisional).length,
      });
      const trendStart = mf.get(days[0]!)?.trend_weight_lb ?? null;
      const trendEnd = mf.get(last)?.trend_weight_lb ?? null;
      const change = trendStart !== null && trendEnd !== null ? trendEnd - trendStart : null;
      Object.assign(r, {
        trend_start_lb: r2(trendStart),
        trend_end_lb: r2(trendEnd),
        trend_change_lb: r2(change),
        trend_change_pct_wk: change !== null && trendStart ? r2(((change / trendStart) * 100 * 7) / days.length) : null,
        scale_mean_lb: r1(mean(md.map((d) => d.scale_weight_lb)).mean),
      });
    }
    if (wantOura) {
      const od = days.map((d) => oura.get(d)).filter((x): x is OuraDay => !!x);
      const nights = od.filter((d) => d.has_sleep);
      const hrvR = rolling(hrvSeries, last, a.windows);
      const lowR = rolling(lowhrSeries, last, a.windows);
      const steps = od.map((d) => (a.stepsSource === "health" ? (mf.get(d.day)?.steps_health ?? null) : d.steps));
      Object.assign(r, {
        nights_n: nights.length,
        readiness_mean: r1(mean(od.map((d) => d.readiness)).mean),
        readiness_min: min(od.map((d) => d.readiness)),
        hrv_mean: r1(mean(nights.map((d) => d.hrv_ms)).mean),
        hrv_dev_pct: hrvR.dev_pct,
        hrv_base_n: hrvR.baseline_n,
        lowhr_mean: r1(mean(nights.map((d) => d.lowest_hr_bpm)).mean),
        lowhr_dev_pct: lowR.dev_pct,
        sleep_mean_min: r1(mean(nights.map((d) => d.sleep_total_min)).mean),
        sleep_efficiency_mean: r1(mean(nights.map((d) => d.sleep_efficiency_pct)).mean),
        temp_dev_mean_c: r2(mean(od.map((d) => d.temp_dev_c)).mean),
        steps_mean: r1(mean(steps).mean),
        steps_min: min(steps),
        ...(a.stepsThreshold !== undefined ? { [`days_steps_ge_${a.stepsThreshold}`]: steps.filter((s) => s !== null && s >= a.stepsThreshold!).length } : {}),
        rest_mode_days: od.filter((d) => d.rest_mode).length,
        tz_changes: od.filter((d, i) => i > 0 && od[i - 1]!.utc_offset && d.utc_offset && od[i - 1]!.utc_offset !== d.utc_offset).length,
      });
    }
    if (first && rows.length === 0) for (const k of Object.keys(r)) if (k !== "week_start" && k !== "days_n") columns.push({ name: k });
    rows.push(r);
  }
  return { columns, rows };
}

// ------------------------------------------------------------ get_sleep_detail

export async function sleepDetail(env: Env, start: string, end: string, includeSeries: boolean): Promise<string> {
  const res = await env.DB.prepare(
    "SELECT id, day, type, bedtime_start, bedtime_end, total_sleep_s, time_in_bed_s, efficiency, latency_s, deep_s, rem_s, light_s, awake_s, average_hrv, lowest_hr, average_hr, average_breath, raw FROM oura_sleep WHERE day BETWEEN ? AND ? AND type != 'deleted' ORDER BY day, bedtime_start",
  )
    .bind(start, end)
    .all<Record<string, string | number | null>>();
  const m = (s: number | null) => (s === null ? null : Math.round((s / 60) * 10) / 10);
  const columns: Column[] = ["day", "type", "bedtime_start", "bedtime_end", "total_min", "in_bed_min", "efficiency_pct", "latency_min", "deep_min", "rem_min", "light_min", "awake_min", "hrv_ms", "lowest_hr_bpm", "avg_hr_bpm", "breath_rate", "restless_periods", "readiness_delta", "sleep_score_delta", "utc_offset"].map((n) => ({ name: n }));
  const rows = res.results.map((r) => {
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(r.raw as string) as Record<string, unknown>;
    } catch {
      /* keep empty */
    }
    const off = /([+-]\d{2}:\d{2}|Z)$/.exec((r.bedtime_end as string) ?? "")?.[1] ?? null;
    return {
      day: r.day, type: r.type === "long_sleep" ? "main" : (r.type as string), bedtime_start: (r.bedtime_start as string)?.slice(0, 16), bedtime_end: (r.bedtime_end as string)?.slice(0, 16),
      total_min: m(r.total_sleep_s as number | null), in_bed_min: m(r.time_in_bed_s as number | null), efficiency_pct: r.efficiency, latency_min: m(r.latency_s as number | null),
      deep_min: m(r.deep_s as number | null), rem_min: m(r.rem_s as number | null), light_min: m(r.light_s as number | null), awake_min: m(r.awake_s as number | null),
      hrv_ms: r.average_hrv, lowest_hr_bpm: r.lowest_hr, avg_hr_bpm: r.average_hr, breath_rate: r.average_breath,
      restless_periods: (raw.restless_periods as number | null) ?? null, readiness_delta: (raw.readiness_score_delta as number | null) ?? null, sleep_score_delta: (raw.sleep_score_delta as number | null) ?? null,
      utc_offset: off === "Z" ? "+00:00" : off,
    } as Record<string, Value>;
  });
  const notes = [`sleep periods ${start}..${end}: ${rows.length} (type main = Oura long_sleep; others are naps/rest). Times are local clock, minutes unless noted.`];
  let out = renderCsv(notes, columns, rows);
  if (includeSeries) {
    const mains = res.results.filter((r) => r.type === "long_sleep");
    if (start !== end || mains.length !== 1) out += `\n\n# include_series needs a single day with one main sleep (got ${mains.length} main sleep periods in ${start}..${end})`;
    else {
      const raw = JSON.parse(mains[0]!.raw as string) as { hrv?: { interval: number; items: (number | null)[]; timestamp: string }; heart_rate?: { interval: number; items: (number | null)[]; timestamp: string } };
      const hrv = raw.hrv;
      const hr = raw.heart_rate;
      const n = Math.max(hrv?.items.length ?? 0, hr?.items.length ?? 0);
      const interval = hrv?.interval ?? hr?.interval ?? 300;
      const t0 = Date.parse(hrv?.timestamp ?? hr?.timestamp ?? "");
      const offMin = offsetMinutes(hrv?.timestamp ?? hr?.timestamp ?? "");
      const srows: Record<string, Value>[] = [];
      for (let i = 0; i < n; i++) {
        const local = new Date(t0 + i * interval * 1000 + offMin * 60_000);
        srows.push({ time: `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`, hrv_ms: hrv?.items[i] ?? null, hr_bpm: hr?.items[i] ?? null });
      }
      out += `\n\n${renderCsv([`series for ${start} main sleep: ${n} samples every ${interval} s, local clock`], [{ name: "time" }, { name: "hrv_ms" }, { name: "hr_bpm" }], srows)}`;
    }
  }
  return out;
}

function offsetMinutes(ts: string): number {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(ts);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// ----------------------------------------------------------------- get_events

export async function events(env: Env, start: string, end: string): Promise<string> {
  const [tags, rest, workouts] = await env.DB.batch([
    env.DB.prepare("SELECT start_day, end_day, start_time, end_time, tag_type_code, custom_name, comment FROM oura_tags WHERE start_day <= ? AND COALESCE(end_day, start_day) >= ? ORDER BY start_day").bind(end, start),
    env.DB.prepare("SELECT start_day, end_day, start_time, end_time FROM oura_rest_mode WHERE start_day <= ? AND COALESCE(end_day, ?) >= ? ORDER BY start_day").bind(end, end, start),
    env.DB.prepare("SELECT day, activity, start_datetime, end_datetime, calories, distance, intensity, label, source FROM oura_workouts WHERE day BETWEEN ? AND ? ORDER BY start_datetime").bind(start, end),
  ]);
  type Rec = Record<string, Value | undefined>;
  const g = (o: Rec, k: string): Value => o[k] ?? null;
  const t = (tags?.results ?? []) as Rec[];
  const r = (rest?.results ?? []) as Rec[];
  const w = (workouts?.results ?? []) as Rec[];
  const rows: Record<string, Value>[] = [
    ...t.map((x) => ({ kind: "tag", day: g(x, "start_day"), end_day: g(x, "end_day"), start: hhmm(g(x, "start_time")), end: hhmm(g(x, "end_time")), name: (g(x, "custom_name") as string | null) || (g(x, "tag_type_code") as string | null), detail: g(x, "comment"), kcal: null, minutes: null, source: null })),
    ...r.map((x) => ({ kind: "rest_mode", day: g(x, "start_day"), end_day: g(x, "end_day"), start: hhmm(g(x, "start_time")), end: hhmm(g(x, "end_time")), name: "rest mode", detail: null, kcal: null, minutes: null, source: null })),
    ...w.map((x) => ({ kind: "workout", day: g(x, "day"), end_day: null, start: hhmm(g(x, "start_datetime")), end: hhmm(g(x, "end_datetime")), name: g(x, "activity"), detail: [g(x, "intensity"), g(x, "label")].filter(Boolean).join(" ") || null, kcal: typeof g(x, "calories") === "number" ? Math.round(g(x, "calories") as number) : null, minutes: minutesBetween(g(x, "start_datetime") as string | null, g(x, "end_datetime") as string | null), source: g(x, "source") })),
  ].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const columns: Column[] = ["kind", "day", "end_day", "start", "end", "name", "detail", "kcal", "minutes", "source"].map((n) => ({ name: n }));
  return renderCsv([`events ${start}..${end}: ${t.length} tags, ${r.length} rest-mode periods, ${w.length} Oura-detected workouts (Dial is the training record; these are Oura's copy)`], columns, rows);
}

function hhmm(v: Value): string | null {
  return typeof v === "string" && v.length >= 16 ? v.slice(11, 16) : null;
}
function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) ? Math.round(ms / 60_000) : null;
}

// ---------------------------------------------------------------------- query

export async function runQuery(env: Env, sql: string, cap = 500): Promise<string> {
  const guarded = guardSql(sql, cap);
  const started = Date.now();
  const res = await env.DB.prepare(guarded).all<Record<string, Value>>();
  const rows = res.results.slice(0, cap);
  const columns: Column[] = rows.length ? Object.keys(rows[0]!).map((n) => ({ name: n })) : [];
  const notes = [`query: ${rows.length} rows${res.results.length > cap ? ` (capped at ${cap})` : ""}, ${Date.now() - started} ms`];
  return rows.length ? renderCsv(notes, columns, rows) : `# ${notes[0]}\n# no rows`;
}
