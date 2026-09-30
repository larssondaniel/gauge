/**
 * MacroFactor export parser.
 *
 * Accepts the three layouts MacroFactor produces and normalises them into one
 * shape keyed by local date. Columns are mapped by header name, never by
 * position. Anything unrecognised fails loudly (UnknownLayoutError) rather
 * than misparsing, per SPEC "MacroFactor ingestion / Parsing".
 *
 * Layouts (seen in real files, 2026-09-29):
 *  - Quick Export workbook: sheet "Quick Export" (one row per day, 64 columns
 *    incl. expenditure, trend/scale weight, intake, targets, steps, micros) and
 *    sheet "Food Log". Also carries empty workout sheets, which are ignored.
 *  - Granular Export workbook: one sheet per box ("Calories & Macros",
 *    "Micronutrients", "Scale Weight", "Weight Trend", "Expenditure", "Steps",
 *    "Body Metrics", "Nutrition Program Settings", "Weight Goals", "Fasting",
 *    "Partial Logging", ...). Workout and settings sheets are ignored, and the
 *    "User Profile" sheet (name, email, birthday) is never read.
 *  - Food Log CSV: the standalone food-log export (same columns as the sheet).
 */
import { parseDateCell, parseTimeCell } from "./dates.js";
import { Columns, readCsv, readWorkbook, slugHeader, type Cell, type Table } from "./tabular.js";

export type MfLayout = "quick_export" | "granular_export" | "food_log_csv";

export class UnknownLayoutError extends Error {
  override readonly name = "UnknownLayoutError";
}

/** One local day of MacroFactor data. Units are in the field names. */
export interface MfDaily {
  date: string;
  expenditure: number | null;
  trend_weight_lb: number | null;
  scale_weight_lb: number | null;
  fat_percent: number | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  alcohol_g: number | null;
  sodium_mg: number | null;
  caffeine_mg: number | null;
  water_g: number | null;
  sugars_g: number | null;
  saturated_fat_g: number | null;
  potassium_mg: number | null;
  target_calories: number | null;
  target_protein_g: number | null;
  target_carbs_g: number | null;
  target_fat_g: number | null;
  steps: number | null;
  fasting: boolean | null;
  partial_logging: boolean | null;
  /** Every other nutrient column, keyed by slug of the header ("vitamin_d_mcg"). */
  micros: Record<string, number | null>;
}

export interface MfFoodEntry {
  date: string;
  time: string | null;
  name: string | null;
  serving_size: string | null;
  serving_qty: number | null;
  serving_weight_g: number | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  alcohol_g: number | null;
  sodium_mg: number | null;
  caffeine_mg: number | null;
  micros: Record<string, number | null>;
}

/** One row of "Nutrition Program Settings": a check-in's targets for one weekday. */
export interface MfCheckin {
  update_date: string;
  weekday: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  expenditure: number | null;
  daily_average_calories: number | null;
  weight_lb: number | null;
  expenditure_mode: string | null;
}

export interface MfWeightGoal {
  goal: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  goal_weight_lb: number | null;
  rate_pct_per_week: number | null;
  starting_scale_weight_lb: number | null;
  starting_trend_weight_lb: number | null;
  original_eta_days: number | null;
  checkpoint_date: string | null;
  checkpoint_weight_lb: number | null;
  ending_scale_weight_lb: number | null;
  ending_trend_weight_lb: number | null;
}

export interface MfBodyMetrics {
  date: string;
  waist_in: number | null;
  chest_in: number | null;
  hips_in: number | null;
  neck_in: number | null;
  shoulders_in: number | null;
  visual_body_fat: string | null;
  /** Every measurement column by slug, including the ones above. */
  all: Record<string, number | string | null>;
}

export interface MfImport {
  layout: MfLayout;
  /**
   * The date window this file is authoritative for. Rows inside it that are
   * absent from the file mean "no data that day", so the importer may null
   * them out. For the food-log CSV the window is only the span of entries.
   */
  coverage: { start: string; end: string } | null;
  daily: MfDaily[];
  food_log: MfFoodEntry[];
  checkins: MfCheckin[];
  weight_goals: MfWeightGoal[];
  body_metrics: MfBodyMetrics[];
  sheets_seen: string[];
  sheets_ignored: string[];
  /** Spec fields this layout could not supply. */
  missing_fields: string[];
  warnings: string[];
}

/** Header -> MfDaily field, for the daily sheets (Quick Export and Granular). */
const DAILY_COLUMNS: Record<string, keyof Omit<MfDaily, "date" | "micros" | "fasting" | "partial_logging">> = {
  Expenditure: "expenditure",
  "Trend Weight (lb)": "trend_weight_lb",
  "Weight (lb)": "scale_weight_lb",
  "Fat Percent": "fat_percent",
  "Calories (kcal)": "calories",
  "Protein (g)": "protein_g",
  "Carbs (g)": "carbs_g",
  "Fat (g)": "fat_g",
  "Fiber (g)": "fiber_g",
  "Alcohol (g)": "alcohol_g",
  "Sodium (mg)": "sodium_mg",
  "Caffeine (mg)": "caffeine_mg",
  "Water (g)": "water_g",
  "Sugars (g)": "sugars_g",
  "Saturated Fat (g)": "saturated_fat_g",
  "Potassium (mg)": "potassium_mg",
  "Target Calories (kcal)": "target_calories",
  "Target Protein (g)": "target_protein_g",
  "Target Carbs (g)": "target_carbs_g",
  "Target Fat (g)": "target_fat_g",
  Steps: "steps",
};

/** Headers that carry weight in kilograms if the app is set to metric. Converted to lb with a warning. */
const KG_HEADERS: Record<string, keyof MfDaily> = {
  "Trend Weight (kg)": "trend_weight_lb",
  "Weight (kg)": "scale_weight_lb",
};
const LB_PER_KG = 2.2046226218;

const FOOD_COLUMNS: Record<string, keyof Omit<MfFoodEntry, "date" | "time" | "micros">> = {
  "Food Name": "name",
  "Serving Size": "serving_size",
  "Serving Qty": "serving_qty",
  "Serving Weight (g)": "serving_weight_g",
  "Calories (kcal)": "calories",
  "Protein (g)": "protein_g",
  "Carbs (g)": "carbs_g",
  "Fat (g)": "fat_g",
  "Fiber (g)": "fiber_g",
  "Alcohol (g)": "alcohol_g",
  "Sodium (mg)": "sodium_mg",
  "Caffeine (mg)": "caffeine_mg",
};

/** Spec must/should fields per layout, used to report what a file lacks. */
const SPEC_FIELDS: (keyof MfDaily)[] = [
  "trend_weight_lb", "scale_weight_lb", "expenditure", "calories", "protein_g", "carbs_g", "fat_g",
  "fiber_g", "alcohol_g", "sodium_mg", "target_calories", "target_protein_g", "target_carbs_g", "target_fat_g", "steps",
];

/** Sheets that are read. Everything else is ignored (and "User Profile" is never touched). */
const GRANULAR_DAILY_SHEETS = ["Calories & Macros", "Micronutrients", "Scale Weight", "Weight Trend", "Expenditure", "Steps"];
const GRANULAR_FLAG_SHEETS: Record<string, "fasting" | "partial_logging"> = { Fasting: "fasting", "Partial Logging": "partial_logging" };
const OTHER_SHEETS = ["Food Log", "Body Metrics", "Nutrition Program Settings", "Weight Goals"];

export interface ParseInput {
  /** Workbook bytes, or CSV bytes. */
  bytes?: Uint8Array | ArrayBuffer;
  /** CSV text (alternative to bytes). */
  text?: string;
  filename?: string;
}

export function parseMacroFactor(input: ParseInput): MfImport {
  const bytes = input.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : input.bytes;
  if (bytes && isZip(bytes)) return parseWorkbook(readWorkbook(bytes));
  const text = input.text ?? (bytes ? new TextDecoder("utf-8").decode(bytes) : undefined);
  if (text === undefined) throw new UnknownLayoutError("No content");
  const table = readCsv(text, input.filename ?? "csv");
  if (isFoodLogTable(table)) return parseFoodLogCsv(table);
  throw new UnknownLayoutError(`CSV headers not recognised as a MacroFactor food log: ${table.headers.slice(0, 6).join(" | ")}`);
}

function isZip(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7);
}

function isFoodLogTable(t: Table): boolean {
  const c = new Columns(t);
  return c.has("Date") && c.has("Time") && c.has("Food Name") && c.has("Calories (kcal)");
}

function parseWorkbook(tables: Table[]): MfImport {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const names = tables.map((t) => t.name);
  if (byName.has("Quick Export")) return parseQuickExport(byName, names);
  if (GRANULAR_DAILY_SHEETS.some((s) => byName.has(s)) || OTHER_SHEETS.some((s) => byName.has(s))) return parseGranular(byName, names);
  throw new UnknownLayoutError(`Workbook sheets not recognised: ${names.join(", ")}`);
}

// ---------------------------------------------------------------- Quick Export

function parseQuickExport(byName: Map<string, Table>, names: string[]): MfImport {
  const warnings: string[] = [];
  const daily = readDailyTable(byName.get("Quick Export")!, warnings);
  const food = byName.has("Food Log") ? readFoodLogTable(byName.get("Food Log")!) : [];
  const seen = ["Quick Export", ...(byName.has("Food Log") ? ["Food Log"] : [])];
  const dates = daily.map((d) => d.date);
  const coverage = dates.length ? { start: min(dates), end: max(dates) } : null;
  return {
    layout: "quick_export",
    coverage,
    daily,
    food_log: food,
    checkins: [],
    weight_goals: [],
    body_metrics: [],
    sheets_seen: seen,
    sheets_ignored: names.filter((n) => !seen.includes(n)),
    missing_fields: missingDailyFields(daily, ["checkins (Granular Export only)", "body_metrics (Granular Export only)"]),
    warnings,
  };
}

/** A sheet with one row per day and headers from DAILY_COLUMNS. */
function readDailyTable(t: Table, warnings: string[]): MfDaily[] {
  const c = new Columns(t);
  if (!c.has("Date")) throw new UnknownLayoutError(`Sheet "${t.name}" has no Date column`);
  const known = new Set(["Date", ...Object.keys(DAILY_COLUMNS), ...Object.keys(KG_HEADERS)]);
  const microHeaders = c.headersExcept(known).filter((h) => /\((g|mg|mcg|kcal)\)$/i.test(h));
  const rows = new Map<string, MfDaily>();
  for (const row of t.rows) {
    const date = parseDateCell(c.get(row, "Date"));
    if (!date) continue;
    const d = rows.get(date) ?? emptyDaily(date);
    for (const [header, field] of Object.entries(DAILY_COLUMNS)) if (c.has(header)) d[field] = c.num(row, header);
    for (const [header, field] of Object.entries(KG_HEADERS)) {
      if (c.has(header)) {
        const kg = c.num(row, header);
        (d as unknown as Record<string, unknown>)[field] = kg === null ? null : round(kg * LB_PER_KG, 2);
        if (!warnings.includes(`${header} converted to lb`)) warnings.push(`${header} converted to lb`);
      }
    }
    for (const h of microHeaders) d.micros[slugHeader(h)] = c.num(row, h);
    rows.set(date, d);
  }
  return [...rows.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function readFoodLogTable(t: Table): MfFoodEntry[] {
  const c = new Columns(t);
  const known = new Set(["Date", "Time", ...Object.keys(FOOD_COLUMNS)]);
  const microHeaders = c.headersExcept(known).filter((h) => /\((g|mg|mcg|kcal)\)$/i.test(h));
  const out: MfFoodEntry[] = [];
  for (const row of t.rows) {
    const date = parseDateCell(c.get(row, "Date"));
    if (!date) continue;
    const e: MfFoodEntry = {
      date,
      time: parseTimeCell(c.get(row, "Time")),
      name: c.str(row, "Food Name"),
      serving_size: c.str(row, "Serving Size"),
      serving_qty: c.num(row, "Serving Qty"),
      serving_weight_g: c.num(row, "Serving Weight (g)"),
      calories: c.num(row, "Calories (kcal)"),
      protein_g: c.num(row, "Protein (g)"),
      carbs_g: c.num(row, "Carbs (g)"),
      fat_g: c.num(row, "Fat (g)"),
      fiber_g: c.num(row, "Fiber (g)"),
      alcohol_g: c.num(row, "Alcohol (g)"),
      sodium_mg: c.num(row, "Sodium (mg)"),
      caffeine_mg: c.num(row, "Caffeine (mg)"),
      micros: {},
    };
    for (const h of microHeaders) e.micros[slugHeader(h)] = c.num(row, h);
    out.push(e);
  }
  return out;
}

function parseFoodLogCsv(t: Table): MfImport {
  const food = readFoodLogTable(t);
  const dates = food.map((f) => f.date);
  return {
    layout: "food_log_csv",
    coverage: dates.length ? { start: min(dates), end: max(dates) } : null,
    daily: [],
    food_log: food,
    checkins: [],
    weight_goals: [],
    body_metrics: [],
    sheets_seen: [t.name],
    sheets_ignored: [],
    missing_fields: ["daily fields (food entries only)"],
    warnings: [],
  };
}

// ------------------------------------------------------------ Granular Export

function parseGranular(byName: Map<string, Table>, names: string[]): MfImport {
  const warnings: string[] = [];
  const seen: string[] = [];
  const days = new Map<string, MfDaily>();
  const merge = (list: MfDaily[]) => {
    for (const d of list) {
      const cur = days.get(d.date);
      if (!cur) {
        days.set(d.date, d);
        continue;
      }
      for (const [k, v] of Object.entries(d)) {
        if (k === "date") continue;
        if (k === "micros") Object.assign(cur.micros, d.micros);
        else if (v !== null) (cur as unknown as Record<string, unknown>)[k] = v;
      }
    }
  };
  for (const sheet of GRANULAR_DAILY_SHEETS) {
    const t = byName.get(sheet);
    if (!t) continue;
    seen.push(sheet);
    merge(readDailyTable(t, warnings));
  }
  for (const [sheet, field] of Object.entries(GRANULAR_FLAG_SHEETS)) {
    const t = byName.get(sheet);
    if (!t) continue;
    seen.push(sheet);
    const c = new Columns(t);
    const list: MfDaily[] = [];
    for (const row of t.rows) {
      const date = parseDateCell(c.get(row, "Date"));
      if (!date) continue;
      const d = emptyDaily(date);
      d[field] = yesNo(c.str(row, sheet));
      list.push(d);
    }
    merge(list);
  }
  const food = byName.has("Food Log") ? (seen.push("Food Log"), readFoodLogTable(byName.get("Food Log")!)) : [];
  const checkins = byName.has("Nutrition Program Settings") ? (seen.push("Nutrition Program Settings"), readCheckins(byName.get("Nutrition Program Settings")!)) : [];
  const goals = byName.has("Weight Goals") ? (seen.push("Weight Goals"), readWeightGoals(byName.get("Weight Goals")!)) : [];
  const body = byName.has("Body Metrics") ? (seen.push("Body Metrics"), readBodyMetrics(byName.get("Body Metrics")!)) : [];

  const daily = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const dates = daily.map((d) => d.date);
  const missing = missingDailyFields(daily, []);
  if (missing.some((m) => m.startsWith("target_")))
    warnings.push("Daily targets are not in the Granular Export; use Quick Export targets or check-ins (Nutrition Program Settings) instead");
  return {
    layout: "granular_export",
    coverage: dates.length ? { start: min(dates), end: max(dates) } : null,
    daily,
    food_log: food,
    checkins,
    weight_goals: goals,
    body_metrics: body,
    sheets_seen: seen,
    sheets_ignored: names.filter((n) => !seen.includes(n)),
    missing_fields: missing,
    warnings,
  };
}

function readCheckins(t: Table): MfCheckin[] {
  const c = new Columns(t);
  for (const h of ["Program Update Date", "Program Weekday", "Calories (kcal)"]) {
    if (!c.has(h)) throw new UnknownLayoutError(`Sheet "${t.name}" lacks column "${h}"`);
  }
  const out: MfCheckin[] = [];
  for (const row of t.rows) {
    const update_date = parseDateCell(c.get(row, "Program Update Date"));
    const weekday = c.str(row, "Program Weekday");
    if (!update_date || !weekday) continue;
    out.push({
      update_date,
      weekday,
      calories: c.num(row, "Calories (kcal)"),
      protein_g: c.num(row, "Protein (g)"),
      carbs_g: c.num(row, "Carbs (g)"),
      fat_g: c.num(row, "Fat (g)"),
      expenditure: c.num(row, "Expenditure (kcal)"),
      daily_average_calories: c.num(row, "Daily Average (kcal)"),
      weight_lb: c.num(row, "Weight (lb)"),
      expenditure_mode: c.str(row, "Expenditure Calculation Mode"),
    });
  }
  return out;
}

function readWeightGoals(t: Table): MfWeightGoal[] {
  const c = new Columns(t);
  return t.rows.map((row) => ({
    goal: c.str(row, "Goal"),
    status: c.str(row, "Status"),
    start_date: parseDateCell(c.get(row, "Start Date")),
    end_date: parseDateCell(c.get(row, "End Date")),
    goal_weight_lb: c.num(row, "Goal Weight (lb)"),
    rate_pct_per_week: c.num(row, "Goal Rate per Week (%)"),
    starting_scale_weight_lb: c.num(row, "Starting Scale Weight (lb)"),
    starting_trend_weight_lb: c.num(row, "Starting Trend Weight (lb)"),
    original_eta_days: c.num(row, "Original ETA (days)"),
    checkpoint_date: parseDateCell(c.get(row, "Trend Weight Goal Checkpoint Date")),
    checkpoint_weight_lb: c.num(row, "Trend Weight Goal Checkpoint Weight (lb)"),
    ending_scale_weight_lb: c.num(row, "Ending Scale Weight (lb)"),
    ending_trend_weight_lb: c.num(row, "Ending Trend Weight (lb)"),
  }));
}

function readBodyMetrics(t: Table): MfBodyMetrics[] {
  const c = new Columns(t);
  const measurementHeaders = c.headersExcept(["Date"]);
  const out: MfBodyMetrics[] = [];
  for (const row of t.rows) {
    const date = parseDateCell(c.get(row, "Date"));
    if (!date) continue;
    const all: Record<string, number | string | null> = {};
    for (const h of measurementHeaders) {
      const v = c.get(row, h);
      all[slugHeader(h)] = v === null ? null : typeof v === "number" ? v : String(v);
    }
    out.push({
      date,
      waist_in: c.num(row, "Waist (in)"),
      chest_in: c.num(row, "Chest (in)"),
      hips_in: c.num(row, "Hips (in)"),
      neck_in: c.num(row, "Neck (in)"),
      shoulders_in: c.num(row, "Shoulders (in)"),
      visual_body_fat: c.str(row, "Visual Body Fat Assessment"),
      all,
    });
  }
  return out;
}

// ------------------------------------------------------------------- helpers

function emptyDaily(date: string): MfDaily {
  return {
    date,
    expenditure: null, trend_weight_lb: null, scale_weight_lb: null, fat_percent: null,
    calories: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null, alcohol_g: null,
    sodium_mg: null, caffeine_mg: null, water_g: null, sugars_g: null, saturated_fat_g: null, potassium_mg: null,
    target_calories: null, target_protein_g: null, target_carbs_g: null, target_fat_g: null,
    steps: null, fasting: null, partial_logging: null, micros: {},
  };
}

/** Fields that no row in the file carries at all. */
function missingDailyFields(daily: MfDaily[], extra: string[]): string[] {
  const present = new Set<string>();
  for (const d of daily) for (const f of SPEC_FIELDS) if (d[f] !== null) present.add(f);
  return [...SPEC_FIELDS.filter((f) => !present.has(f)), ...extra];
}

function yesNo(s: string | null): boolean | null {
  if (s === null) return null;
  const v = s.toLowerCase();
  if (v === "yes" || v === "true") return true;
  if (v === "no" || v === "false") return false;
  throw new Error(`Expected Yes/No, got ${JSON.stringify(s)}`);
}

function min(a: string[]): string {
  return a.reduce((m, x) => (x < m ? x : m));
}
function max(a: string[]): string {
  return a.reduce((m, x) => (x > m ? x : m));
}
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export type { Cell };
