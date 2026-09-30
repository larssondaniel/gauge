/** MacroFactor rows per local day for get_daily, plus the food log and check-in readers. */
import type { Env } from "../env.js";
import type { Value } from "../mcp/format.js";

export interface MfDayRow {
  date: string;
  trend_weight_lb: number | null;
  scale_weight_lb: number | null;
  expenditure_kcal: number | null;
  calories_kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  alcohol_g: number | null;
  sodium_mg: number | null;
  target_kcal: number | null;
  target_protein_g: number | null;
  target_carbs_g: number | null;
  target_fat_g: number | null;
  targets_source: string | null;
  steps_mf: number | null;
  water_g: number | null;
  caffeine_mg: number | null;
  sugars_g: number | null;
  sat_fat_g: number | null;
  potassium_mg: number | null;
  fasting: boolean | null;
  partial_logging: boolean | null;
  provisional: boolean;
  has_intake: boolean;
  has_weighin: boolean;
}

export const MF_GROUPS: Record<string, string[]> = {
  weight: ["trend_weight_lb", "scale_weight_lb", "expenditure_kcal"],
  intake: ["calories_kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "alcohol_g", "sodium_mg"],
  targets: ["target_kcal", "target_protein_g", "target_carbs_g", "target_fat_g", "targets_source"],
  mf_extra: ["steps_mf", "water_g", "caffeine_mg", "sugars_g", "sat_fat_g", "potassium_mg"],
  mf_flags: ["fasting", "partial_logging", "provisional"],
};
export const MF_DEFAULT_GROUPS = ["weight", "intake", "targets", "mf_flags"];

export async function loadMfDays(env: Env, start: string, end: string): Promise<Map<string, MfDayRow>> {
  const res = await env.DB.prepare(
    "SELECT date, trend_weight_lb, scale_weight_lb, expenditure, calories, protein_g, carbs_g, fat_g, fiber_g, alcohol_g, sodium_mg, target_calories, target_protein_g, target_carbs_g, target_fat_g, targets_source, steps, water_g, caffeine_mg, sugars_g, saturated_fat_g, potassium_mg, fasting, partial_logging, source FROM mf_daily WHERE date BETWEEN ? AND ?",
  )
    .bind(start, end)
    .all<Record<string, number | string | null>>();
  const out = new Map<string, MfDayRow>();
  for (const r of res.results) {
    const n = (k: string): number | null => (typeof r[k] === "number" ? (r[k] as number) : null);
    const b = (k: string): boolean | null => (r[k] === null || r[k] === undefined ? null : r[k] === 1);
    out.set(r.date as string, {
      date: r.date as string,
      trend_weight_lb: n("trend_weight_lb"), scale_weight_lb: n("scale_weight_lb"), expenditure_kcal: n("expenditure"),
      calories_kcal: n("calories"), protein_g: n("protein_g"), carbs_g: n("carbs_g"), fat_g: n("fat_g"), fiber_g: n("fiber_g"), alcohol_g: n("alcohol_g"), sodium_mg: n("sodium_mg"),
      target_kcal: n("target_calories"), target_protein_g: n("target_protein_g"), target_carbs_g: n("target_carbs_g"), target_fat_g: n("target_fat_g"), targets_source: (r.targets_source as string | null) ?? null,
      steps_mf: n("steps"), water_g: n("water_g"), caffeine_mg: n("caffeine_mg"), sugars_g: n("sugars_g"), sat_fat_g: n("saturated_fat_g"), potassium_mg: n("potassium_mg"),
      fasting: b("fasting"), partial_logging: b("partial_logging"), provisional: r.source === "snapshot",
      has_intake: typeof r.calories === "number", has_weighin: typeof r.scale_weight_lb === "number",
    });
  }
  return out;
}

export function mfRow(d: MfDayRow | undefined): Record<string, Value> {
  const r: Record<string, Value> = {};
  for (const col of Object.values(MF_GROUPS).flat()) r[col] = d ? ((d as unknown as Record<string, Value>)[col] ?? null) : null;
  return r;
}

export interface MfSummary {
  uploads: { layout: string; received_at: string; coverage_start: string | null; coverage_end: string | null; ok: number; error: string | null; filename: string | null }[];
  coverage_start: string | null;
  data_through: string | null;
  intake_through: string | null;
  weighin_through: string | null;
  food_log_through: string | null;
  checkins: number;
  last_checkin: string | null;
  counts: { daily: number; food: number; snapshot_days: number };
}

export async function mfSummary(env: Env): Promise<MfSummary> {
  const [uploads, daily, food, checkins] = await env.DB.batch([
    env.DB.prepare("SELECT layout, received_at, coverage_start, coverage_end, ok, error, filename FROM mf_uploads ORDER BY id DESC LIMIT 6"),
    env.DB.prepare("SELECT MIN(date) AS start, MAX(CASE WHEN calories IS NOT NULL OR trend_weight_lb IS NOT NULL THEN date END) AS through, MAX(CASE WHEN calories IS NOT NULL THEN date END) AS intake_through, MAX(CASE WHEN scale_weight_lb IS NOT NULL THEN date END) AS weighin_through, COUNT(*) AS n, SUM(source = 'snapshot') AS snap FROM mf_daily"),
    env.DB.prepare("SELECT MAX(date) AS through, COUNT(*) AS n FROM mf_food_log"),
    env.DB.prepare("SELECT COUNT(DISTINCT update_date) AS n, MAX(update_date) AS last FROM mf_checkins"),
  ]);
  const d = (daily?.results?.[0] ?? {}) as Record<string, string | number | null>;
  const f = (food?.results?.[0] ?? {}) as Record<string, string | number | null>;
  const c = (checkins?.results?.[0] ?? {}) as Record<string, string | number | null>;
  return {
    uploads: (uploads?.results ?? []) as MfSummary["uploads"],
    coverage_start: (d.start as string | null) ?? null,
    data_through: (d.through as string | null) ?? null,
    intake_through: (d.intake_through as string | null) ?? null,
    weighin_through: (d.weighin_through as string | null) ?? null,
    food_log_through: (f.through as string | null) ?? null,
    checkins: Number(c.n ?? 0),
    last_checkin: (c.last as string | null) ?? null,
    counts: { daily: Number(d.n ?? 0), food: Number(f.n ?? 0), snapshot_days: Number(d.snap ?? 0) },
  };
}

export interface FoodEntryRow extends Record<string, Value> {
  date: string; time: string | null; name: string | null; serving: string | null; weight_g: number | null; kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null; fiber_g: number | null; alcohol_g: number | null; sodium_mg: number | null; caffeine_mg: number | null;
}

export async function loadFoodLog(env: Env, start: string, end: string, search: string | undefined, limit: number): Promise<{ rows: FoodEntryRow[]; total: number }> {
  const where = ["date BETWEEN ? AND ?"];
  const params: (string | number)[] = [start, end];
  if (search) {
    where.push("name LIKE ? ESCAPE '\\'");
    params.push(`%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  }
  const w = where.join(" AND ");
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mf_food_log WHERE ${w}`).bind(...params).first<{ n: number }>();
  const res = await env.DB.prepare(`SELECT date, time, name, serving_size, serving_qty, serving_weight_g, calories, protein_g, carbs_g, fat_g, fiber_g, alcohol_g, sodium_mg, caffeine_mg FROM mf_food_log WHERE ${w} ORDER BY date, time, id LIMIT ?`)
    .bind(...params, limit)
    .all<Record<string, string | number | null>>();
  const rows: FoodEntryRow[] = res.results.map((r) => ({
    date: r.date as string,
    time: (r.time as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    serving: r.serving_qty === null && r.serving_size === null ? null : `${r.serving_qty ?? ""} ${r.serving_size ?? ""}`.trim(),
    weight_g: r.serving_weight_g as number | null,
    kcal: r.calories as number | null,
    protein_g: r.protein_g as number | null,
    carbs_g: r.carbs_g as number | null,
    fat_g: r.fat_g as number | null,
    fiber_g: r.fiber_g as number | null,
    alcohol_g: r.alcohol_g as number | null,
    sodium_mg: r.sodium_mg as number | null,
    caffeine_mg: r.caffeine_mg as number | null,
  }));
  return { rows, total: total?.n ?? rows.length };
}

export interface CheckinRow extends Record<string, Value> {
  date: string; expenditure_kcal: number | null; trend_weight_lb: number | null; kcal_daily_avg: number | null; kcal_min: number | null; kcal_max: number | null; protein_g: number | null; carbs_g_min: number | null; carbs_g_max: number | null; fat_g_min: number | null; fat_g_max: number | null; weekdays_n: number; mode: string | null;
}

export async function loadCheckins(env: Env, start: string, end: string): Promise<CheckinRow[]> {
  const res = await env.DB.prepare("SELECT update_date, weekday, calories, protein_g, carbs_g, fat_g, expenditure, daily_average_calories, weight_lb, expenditure_mode FROM mf_checkins WHERE update_date BETWEEN ? AND ? ORDER BY update_date")
    .bind(start, end)
    .all<Record<string, string | number | null>>();
  const by = new Map<string, Record<string, string | number | null>[]>();
  for (const r of res.results) {
    const list = by.get(r.update_date as string) ?? [];
    list.push(r);
    by.set(r.update_date as string, list);
  }
  const out: CheckinRow[] = [];
  for (const [date, rows] of by) {
    const nums = (k: string) => rows.map((r) => r[k]).filter((v): v is number => typeof v === "number");
    const mm = (k: string): [number | null, number | null] => {
      const v = nums(k);
      return v.length ? [Math.min(...v), Math.max(...v)] : [null, null];
    };
    const [kmin, kmax] = mm("calories");
    const [cmin, cmax] = mm("carbs_g");
    const [fmin, fmax] = mm("fat_g");
    const first = rows[0]!;
    out.push({
      date, expenditure_kcal: first.expenditure as number | null, trend_weight_lb: first.weight_lb as number | null, kcal_daily_avg: first.daily_average_calories as number | null,
      kcal_min: kmin, kcal_max: kmax, protein_g: mm("protein_g")[1], carbs_g_min: cmin, carbs_g_max: cmax, fat_g_min: fmin, fat_g_max: fmax, weekdays_n: rows.length, mode: first.expenditure_mode as string | null,
    });
  }
  return out;
}

export async function loadWeightGoals(env: Env): Promise<Record<string, Value>[]> {
  const res = await env.DB.prepare("SELECT goal, status, start_date, end_date, goal_weight_lb, rate_pct_per_week, starting_scale_weight_lb, starting_trend_weight_lb, ending_trend_weight_lb, ending_scale_weight_lb FROM mf_weight_goals ORDER BY start_date").all<Record<string, Value>>();
  return res.results;
}
