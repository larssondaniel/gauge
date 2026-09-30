/**
 * Oura rows per local day for get_daily: reads the tables, applies the
 * main-sleep and split-night rules (D-009), and exposes the UTC offset and
 * tz_change flag so travel days are visible.
 */
import { dateRange, addDays } from "../parsers/dates.js";
import type { Env } from "../env.js";
import type { Value } from "../mcp/format.js";

export interface OuraDay {
  day: string;
  readiness: number | null;
  temp_dev_c: number | null;
  temp_trend_dev_c: number | null;
  readiness_contributors: Record<string, number | null> | null;
  sleep_score: number | null;
  sleep_contributors: Record<string, number | null> | null;
  sleep_total_min: number | null;
  time_in_bed_min: number | null;
  sleep_efficiency_pct: number | null;
  sleep_latency_min: number | null;
  deep_min: number | null;
  rem_min: number | null;
  light_min: number | null;
  awake_min: number | null;
  bedtime_start: string | null;
  bedtime_end: string | null;
  hrv_ms: number | null;
  lowest_hr_bpm: number | null;
  avg_hr_bpm: number | null;
  breath_rate: number | null;
  split_night: boolean;
  utc_offset: string | null;
  naps_n: number;
  nap_min: number | null;
  steps: number | null;
  active_kcal: number | null;
  activity_score: number | null;
  high_act_min: number | null;
  med_act_min: number | null;
  sedentary_min: number | null;
  stress_high_min: number | null;
  recovery_high_min: number | null;
  resilience: string | null;
  spo2_avg_pct: number | null;
  breathing_disturbance_idx: number | null;
  vo2_max: number | null;
  vascular_age: number | null;
  rest_mode: boolean;
  has_sleep: boolean;
  has_readiness: boolean;
  has_activity: boolean;
}

interface SleepRow {
  id: string; day: string; type: string | null; bedtime_start: string | null; bedtime_end: string | null;
  total_sleep_s: number | null; time_in_bed_s: number | null; efficiency: number | null; latency_s: number | null;
  deep_s: number | null; rem_s: number | null; light_s: number | null; awake_s: number | null;
  average_hrv: number | null; lowest_hr: number | null; average_hr: number | null; average_breath: number | null;
}

const min = (s: number | null): number | null => (s === null ? null : Math.round((s / 60) * 10) / 10);
const hhmm = (ts: string | null): string | null => (ts && ts.length >= 16 ? ts.slice(11, 16) : null);
const offsetOf = (ts: string | null): string | null => {
  if (!ts) return null;
  const m = /([+-]\d{2}:\d{2}|Z)$/.exec(ts);
  return m ? (m[1] === "Z" ? "+00:00" : m[1]!) : null;
};
const parseJson = (s: string | null): Record<string, number | null> | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, number | null>;
  } catch {
    return null;
  }
};

function weighted(rows: SleepRow[], pick: (r: SleepRow) => number | null, weight: (r: SleepRow) => number | null): number | null {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const v = pick(r);
    const w = weight(r);
    if (v === null || w === null || w <= 0) continue;
    num += v * w;
    den += w;
  }
  return den > 0 ? Math.round((num / den) * 10) / 10 : null;
}
const sum = (rows: SleepRow[], pick: (r: SleepRow) => number | null): number | null => {
  const vals = rows.map(pick).filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
};

/** Load Oura days for [start, end] inclusive. Every day gets a row; absent data is null. */
export async function loadOuraDays(env: Env, start: string, end: string): Promise<Map<string, OuraDay>> {
  const b = [start, end] as const;
  const batch = await env.DB.batch([
    env.DB.prepare("SELECT day, score, temperature_deviation, temperature_trend_deviation, contributors, timestamp FROM oura_daily_readiness WHERE day BETWEEN ? AND ?").bind(...b),
    env.DB.prepare("SELECT day, score, contributors FROM oura_daily_sleep WHERE day BETWEEN ? AND ?").bind(...b),
    env.DB.prepare("SELECT id, day, type, bedtime_start, bedtime_end, total_sleep_s, time_in_bed_s, efficiency, latency_s, deep_s, rem_s, light_s, awake_s, average_hrv, lowest_hr, average_hr, average_breath FROM oura_sleep WHERE day BETWEEN ? AND ? AND type != 'deleted' ORDER BY bedtime_start").bind(...b),
    env.DB.prepare("SELECT day, steps, active_calories, score, high_s, medium_s, sedentary_s, timestamp FROM oura_daily_activity WHERE day BETWEEN ? AND ?").bind(...b),
    env.DB.prepare("SELECT day, stress_high_s, recovery_high_s FROM oura_daily_stress WHERE day BETWEEN ? AND ?").bind(...b),
    env.DB.prepare("SELECT day, level FROM oura_daily_resilience WHERE day BETWEEN ? AND ?").bind(...b),
    env.DB.prepare("SELECT day, spo2_average, breathing_disturbance_index FROM oura_daily_spo2 WHERE day BETWEEN ? AND ?").bind(...b),
    env.DB.prepare("SELECT day, vo2_max FROM oura_vo2_max WHERE day BETWEEN ? AND ?").bind(...b),
    env.DB.prepare("SELECT day, vascular_age FROM oura_cardio_age WHERE day BETWEEN ? AND ?").bind(...b),
    env.DB.prepare("SELECT start_day, end_day FROM oura_rest_mode WHERE start_day <= ? AND (end_day IS NULL OR end_day >= ?)").bind(end, start),
  ]);
  const res = (i: number) => (batch[i]?.results ?? []) as Record<string, unknown>[];
  const [readiness, dailySleep, sleep, activity, stress, resilience, spo2, vo2, cardio, rest] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ results: res(i) }));

  const days = new Map<string, OuraDay>();
  for (const d of dateRange(start, end)) days.set(d, emptyDay(d));
  const get = (d: string): OuraDay | undefined => days.get(d);

  for (const r of readiness!.results) {
    const d = get(r.day as string);
    if (!d) continue;
    d.readiness = r.score as number | null;
    d.temp_dev_c = r.temperature_deviation as number | null;
    d.temp_trend_dev_c = r.temperature_trend_deviation as number | null;
    d.readiness_contributors = parseJson(r.contributors as string | null);
    d.has_readiness = true;
  }
  for (const r of dailySleep!.results) {
    const d = get(r.day as string);
    if (!d) continue;
    d.sleep_score = r.score as number | null;
    d.sleep_contributors = parseJson(r.contributors as string | null);
  }
  const byDay = new Map<string, SleepRow[]>();
  for (const r of sleep!.results as unknown as SleepRow[]) {
    const list = byDay.get(r.day) ?? [];
    list.push(r);
    byDay.set(r.day, list);
  }
  for (const [day, rows] of byDay) {
    const d = get(day);
    if (!d) continue;
    const mains = rows.filter((r) => r.type === "long_sleep");
    const naps = rows.filter((r) => r.type !== "long_sleep");
    d.naps_n = naps.length;
    d.nap_min = naps.length ? min(sum(naps, (r) => r.total_sleep_s)) : null;
    if (mains.length === 0) continue;
    d.has_sleep = true;
    d.split_night = mains.length > 1;
    const first = mains[0]!;
    const last = mains[mains.length - 1]!;
    d.sleep_total_min = min(sum(mains, (r) => r.total_sleep_s));
    d.time_in_bed_min = min(sum(mains, (r) => r.time_in_bed_s));
    d.deep_min = min(sum(mains, (r) => r.deep_s));
    d.rem_min = min(sum(mains, (r) => r.rem_s));
    d.light_min = min(sum(mains, (r) => r.light_s));
    d.awake_min = min(sum(mains, (r) => r.awake_s));
    d.sleep_latency_min = min(first.latency_s);
    d.bedtime_start = hhmm(first.bedtime_start);
    d.bedtime_end = hhmm(last.bedtime_end);
    d.utc_offset = offsetOf(last.bedtime_end);
    d.sleep_efficiency_pct = mains.length === 1 ? first.efficiency : weighted(mains, (r) => r.efficiency, (r) => r.time_in_bed_s);
    d.hrv_ms = mains.length === 1 ? first.average_hrv : weighted(mains, (r) => r.average_hrv, (r) => r.total_sleep_s);
    d.avg_hr_bpm = mains.length === 1 ? first.average_hr : weighted(mains, (r) => r.average_hr, (r) => r.total_sleep_s);
    d.breath_rate = mains.length === 1 ? first.average_breath : weighted(mains, (r) => r.average_breath, (r) => r.total_sleep_s);
    const lows = mains.map((r) => r.lowest_hr).filter((v): v is number => v !== null);
    d.lowest_hr_bpm = lows.length ? Math.min(...lows) : null;
  }
  for (const r of activity!.results) {
    const d = get(r.day as string);
    if (!d) continue;
    d.steps = r.steps as number | null;
    d.active_kcal = r.active_calories as number | null;
    d.activity_score = r.score as number | null;
    d.high_act_min = min(r.high_s as number | null);
    d.med_act_min = min(r.medium_s as number | null);
    d.sedentary_min = min(r.sedentary_s as number | null);
    d.has_activity = true;
    if (!d.utc_offset) d.utc_offset = offsetOf(r.timestamp as string | null);
  }
  for (const r of stress!.results) {
    const d = get(r.day as string);
    if (!d) continue;
    d.stress_high_min = min(r.stress_high_s as number | null);
    d.recovery_high_min = min(r.recovery_high_s as number | null);
  }
  for (const r of resilience!.results) {
    const d = get(r.day as string);
    if (d) d.resilience = r.level as string | null;
  }
  for (const r of spo2!.results) {
    const d = get(r.day as string);
    if (!d) continue;
    d.spo2_avg_pct = r.spo2_average as number | null;
    d.breathing_disturbance_idx = r.breathing_disturbance_index as number | null;
  }
  for (const r of vo2!.results) {
    const d = get(r.day as string);
    if (d) d.vo2_max = r.vo2_max as number | null;
  }
  for (const r of cardio!.results) {
    const d = get(r.day as string);
    if (d) d.vascular_age = r.vascular_age as number | null;
  }
  for (const r of rest!.results) {
    const s = r.start_day as string;
    const e = (r.end_day as string | null) ?? end;
    for (const day of dateRange(s < start ? start : s, e > end ? end : e)) {
      const d = get(day);
      if (d) d.rest_mode = true;
    }
  }
  return days;
}

function emptyDay(day: string): OuraDay {
  return {
    day, readiness: null, temp_dev_c: null, temp_trend_dev_c: null, readiness_contributors: null, sleep_score: null, sleep_contributors: null,
    sleep_total_min: null, time_in_bed_min: null, sleep_efficiency_pct: null, sleep_latency_min: null, deep_min: null, rem_min: null, light_min: null, awake_min: null,
    bedtime_start: null, bedtime_end: null, hrv_ms: null, lowest_hr_bpm: null, avg_hr_bpm: null, breath_rate: null, split_night: false, utc_offset: null,
    naps_n: 0, nap_min: null, steps: null, active_kcal: null, activity_score: null, high_act_min: null, med_act_min: null, sedentary_min: null,
    stress_high_min: null, recovery_high_min: null, resilience: null, spo2_avg_pct: null, breathing_disturbance_idx: null, vo2_max: null, vascular_age: null,
    rest_mode: false, has_sleep: false, has_readiness: false, has_activity: false,
  };
}

/** Column groups for get_daily's `fields` parameter. */
export const OURA_GROUPS: Record<string, string[]> = {
  recovery: ["readiness", "temp_dev_c", "temp_trend_dev_c", "hrv_ms", "lowest_hr_bpm", "avg_hr_bpm", "breath_rate"],
  sleep: ["sleep_score", "sleep_total_min", "time_in_bed_min", "sleep_efficiency_pct", "sleep_latency_min", "deep_min", "rem_min", "light_min", "awake_min", "bedtime_start", "bedtime_end", "naps_n", "nap_min"],
  activity: ["steps", "active_kcal", "activity_score", "high_act_min", "med_act_min", "sedentary_min"],
  stress: ["stress_high_min", "recovery_high_min", "resilience"],
  flags: ["oura_utc_offset", "tz_change", "split_night", "rest_mode"],
  readiness_contributors: ["rc_hrv_balance", "rc_resting_heart_rate", "rc_body_temperature", "rc_recovery_index", "rc_sleep_balance", "rc_previous_night", "rc_previous_day_activity", "rc_activity_balance"],
  sleep_contributors: ["sc_deep_sleep", "sc_efficiency", "sc_latency", "sc_rem_sleep", "sc_restfulness", "sc_timing", "sc_total_sleep"],
  spo2: ["spo2_avg_pct", "breathing_disturbance_idx"],
  cardio: ["vo2_max", "vascular_age"],
};
export const OURA_DEFAULT_GROUPS = ["recovery", "sleep", "activity", "stress", "flags"];

/** Columns that describe the night (shift under align=intake_to_night). */
export const NIGHT_COLUMNS = new Set([...OURA_GROUPS.recovery!, ...OURA_GROUPS.sleep!, ...OURA_GROUPS.readiness_contributors!, ...OURA_GROUPS.sleep_contributors!, ...OURA_GROUPS.spo2!, "split_night"]);

/** Flatten an OuraDay into output columns. `night` supplies the night columns (same day, or D+1 under intake_to_night). */
export function ouraRow(day: OuraDay, night: OuraDay, prev: OuraDay | undefined): Record<string, Value> {
  const r: Record<string, Value> = {};
  for (const k of ["readiness", "temp_dev_c", "temp_trend_dev_c", "hrv_ms", "lowest_hr_bpm", "avg_hr_bpm", "breath_rate", "sleep_score", "sleep_total_min", "time_in_bed_min", "sleep_efficiency_pct", "sleep_latency_min", "deep_min", "rem_min", "light_min", "awake_min", "bedtime_start", "bedtime_end", "naps_n", "nap_min", "spo2_avg_pct", "breathing_disturbance_idx"] as const)
    r[k] = night[k];
  r.split_night = night.split_night;
  for (const k of ["steps", "active_kcal", "activity_score", "high_act_min", "med_act_min", "sedentary_min", "stress_high_min", "recovery_high_min", "resilience", "vo2_max", "vascular_age"] as const) r[k] = day[k];
  r.rest_mode = day.rest_mode;
  r.oura_utc_offset = day.utc_offset;
  r.tz_change = !!(prev && prev.utc_offset && day.utc_offset && prev.utc_offset !== day.utc_offset);
  const rc = night.readiness_contributors ?? {};
  for (const k of ["hrv_balance", "resting_heart_rate", "body_temperature", "recovery_index", "sleep_balance", "previous_night", "previous_day_activity", "activity_balance"]) r[`rc_${k}`] = rc[k] ?? null;
  const sc = night.sleep_contributors ?? {};
  for (const k of ["deep_sleep", "efficiency", "latency", "rem_sleep", "restfulness", "timing", "total_sleep"]) r[`sc_${k}`] = sc[k] ?? null;
  return r;
}

export { addDays };
