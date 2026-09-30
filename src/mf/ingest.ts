/**
 * POST /ingest/export: parse a MacroFactor file, keep the raw bytes in KV,
 * and write the normalised tables. Exports are authoritative for every date
 * they carry (SPEC "Precedence"); rows absent from a file are left alone.
 */
import type { Env } from "../env.js";
import { parseMacroFactor, UnknownLayoutError, type MfDaily, type MfImport } from "../parsers/macrofactor.js";

export interface IngestResult {
  upload_id: number;
  layout: string;
  coverage: { start: string; end: string } | null;
  daily_rows: number;
  food_rows: number;
  checkin_rows: number;
  targets_filled: number;
  message: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DAILY_COLS: (keyof MfDaily)[] = [
  "expenditure", "trend_weight_lb", "scale_weight_lb", "fat_percent", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "alcohol_g",
  "sodium_mg", "caffeine_mg", "water_g", "sugars_g", "saturated_fat_g", "potassium_mg", "steps",
];
const TARGET_COLS: (keyof MfDaily)[] = ["target_calories", "target_protein_g", "target_carbs_g", "target_fat_g"];

export async function ingestExport(env: Env, bytes: Uint8Array, filename: string | null): Promise<IngestResult> {
  const receivedAt = new Date().toISOString();
  const kvKey = `mf:upload:${receivedAt}:${(filename ?? "export").replace(/[^A-Za-z0-9._-]/g, "_")}`;
  // Keep the raw file first, so a parse failure can still be reprocessed later.
  await env.DATA_KV.put(kvKey, bytes, { metadata: { filename, receivedAt, bytes: bytes.length } });

  let imp: MfImport;
  try {
    imp = parseMacroFactor({ bytes, ...(filename ? { filename } : {}) });
  } catch (e) {
    const msg = e instanceof UnknownLayoutError ? `Unknown layout: ${e.message}` : `Parse error: ${e instanceof Error ? e.message : String(e)}`;
    await env.DB.prepare("INSERT INTO mf_uploads (received_at, filename, bytes, kv_key, ok, error) VALUES (?, ?, ?, ?, 0, ?)").bind(receivedAt, filename, bytes.length, kvKey, msg).run();
    throw new IngestError(msg);
  }

  const ins = await env.DB.prepare(
    "INSERT INTO mf_uploads (received_at, filename, bytes, layout, coverage_start, coverage_end, daily_rows, food_rows, checkin_rows, kv_key, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) RETURNING id",
  )
    .bind(receivedAt, filename, bytes.length, imp.layout, imp.coverage?.start ?? null, imp.coverage?.end ?? null, imp.daily.length, imp.food_log.length, imp.checkins.length, kvKey)
    .first<{ id: number }>();
  const uploadId = ins!.id;
  const now = receivedAt;

  // Daily rows: upsert the columns this layout carries. Quick Export carries targets; Granular does not.
  const hasTargets = imp.layout === "quick_export";
  const cols = [...DAILY_COLS, ...(hasTargets ? TARGET_COLS : [])];
  const allCols = ["date", ...cols, ...(hasTargets ? ["targets_source"] : []), "fasting", "partial_logging", "micros", "source", "upload_id", "updated_at"];
  const updates = allCols.filter((c) => c !== "date").map((c) => `${c} = excluded.${c}`).join(", ");
  const sql = `INSERT INTO mf_daily (${allCols.join(", ")}) VALUES (${allCols.map(() => "?").join(", ")}) ON CONFLICT(date) DO UPDATE SET ${updates}`;
  const stmt = env.DB.prepare(sql);
  const dailyStmts = imp.daily.map((d) =>
    stmt.bind(
      d.date,
      ...cols.map((c) => d[c] as number | null),
      ...(hasTargets ? ["export"] : []),
      d.fasting === null ? null : d.fasting ? 1 : 0,
      d.partial_logging === null ? null : d.partial_logging ? 1 : 0,
      JSON.stringify(d.micros),
      "export",
      uploadId,
      now,
    ),
  );
  await runBatches(env, dailyStmts);

  // Food log: the file is authoritative for its window, so replace entries in it.
  if (imp.food_log.length && imp.coverage) {
    await env.DB.prepare("DELETE FROM mf_food_log WHERE date BETWEEN ? AND ?").bind(imp.coverage.start, imp.coverage.end).run();
    const fs = env.DB.prepare(
      "INSERT INTO mf_food_log (date, time, name, serving_size, serving_qty, serving_weight_g, calories, protein_g, carbs_g, fat_g, fiber_g, alcohol_g, sodium_mg, caffeine_mg, micros, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    await runBatches(
      env,
      imp.food_log.map((e) => fs.bind(e.date, e.time, e.name, e.serving_size, e.serving_qty, e.serving_weight_g, e.calories, e.protein_g, e.carbs_g, e.fat_g, e.fiber_g, e.alcohol_g, e.sodium_mg, e.caffeine_mg, JSON.stringify(e.micros), uploadId)),
    );
  }

  // Check-ins, goals, body metrics: an all-time list each time, so replace wholesale.
  if (imp.checkins.length) {
    await env.DB.prepare("DELETE FROM mf_checkins").run();
    const cs = env.DB.prepare("INSERT INTO mf_checkins (update_date, weekday, calories, protein_g, carbs_g, fat_g, expenditure, daily_average_calories, weight_lb, expenditure_mode, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    await runBatches(env, imp.checkins.map((c) => cs.bind(c.update_date, c.weekday, c.calories, c.protein_g, c.carbs_g, c.fat_g, c.expenditure, c.daily_average_calories, c.weight_lb, c.expenditure_mode, uploadId)));
  }
  if (imp.weight_goals.length) {
    await env.DB.prepare("DELETE FROM mf_weight_goals").run();
    const gs = env.DB.prepare("INSERT INTO mf_weight_goals (goal, status, start_date, end_date, goal_weight_lb, rate_pct_per_week, starting_scale_weight_lb, starting_trend_weight_lb, original_eta_days, checkpoint_date, checkpoint_weight_lb, ending_scale_weight_lb, ending_trend_weight_lb, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    await runBatches(env, imp.weight_goals.map((g) => gs.bind(g.goal, g.status, g.start_date, g.end_date, g.goal_weight_lb, g.rate_pct_per_week, g.starting_scale_weight_lb, g.starting_trend_weight_lb, g.original_eta_days, g.checkpoint_date, g.checkpoint_weight_lb, g.ending_scale_weight_lb, g.ending_trend_weight_lb, uploadId)));
  }
  if (imp.body_metrics.length) {
    const bs = env.DB.prepare("INSERT INTO mf_body_metrics (date, waist_in, chest_in, hips_in, neck_in, shoulders_in, visual_body_fat, all_json, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET waist_in = excluded.waist_in, chest_in = excluded.chest_in, hips_in = excluded.hips_in, neck_in = excluded.neck_in, shoulders_in = excluded.shoulders_in, visual_body_fat = excluded.visual_body_fat, all_json = excluded.all_json, upload_id = excluded.upload_id");
    await runBatches(env, imp.body_metrics.map((b) => bs.bind(b.date, b.waist_in, b.chest_in, b.hips_in, b.neck_in, b.shoulders_in, b.visual_body_fat, JSON.stringify(b.all), uploadId)));
  }

  const targetsFilled = await fillTargetsFromCheckins(env);

  const cov = imp.coverage;
  const covText = cov ? `${fmt(cov.start)}–${fmt(cov.end)}` : "no dates";
  const layoutName = { quick_export: "Quick Export", granular_export: "Granular Export", food_log_csv: "Food Log" }[imp.layout];
  const parts = [`Ingested ${covText} (${layoutName})`];
  if (imp.daily.length) parts.push(`${imp.daily.length} days`);
  if (imp.food_log.length) parts.push(`${imp.food_log.length} food entries`);
  if (imp.checkins.length) parts.push(`${new Set(imp.checkins.map((c) => c.update_date)).size} check-ins`);
  const through = await env.DB.prepare("SELECT MAX(date) AS d FROM mf_daily WHERE calories IS NOT NULL OR trend_weight_lb IS NOT NULL").first<{ d: string | null }>();
  const message = `${parts.join(", ")}; data through ${through?.d ? fmt(through.d) : "none"}.`;
  return { upload_id: uploadId, layout: imp.layout, coverage: cov, daily_rows: imp.daily.length, food_rows: imp.food_log.length, checkin_rows: imp.checkins.length, targets_filled: targetsFilled, message };
}

/**
 * D-019: for days whose targets did not come from an export, use the check-in
 * (Nutrition Program Settings) active on that day for that weekday. Never
 * touches a row whose targets_source is 'export'.
 */
export async function fillTargetsFromCheckins(env: Env): Promise<number> {
  const checkins = (await env.DB.prepare("SELECT update_date, weekday, calories, protein_g, carbs_g, fat_g FROM mf_checkins ORDER BY update_date").all<{ update_date: string; weekday: string; calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null }>()).results;
  if (!checkins.length) return 0;
  const days = (await env.DB.prepare("SELECT date FROM mf_daily WHERE targets_source IS NULL OR targets_source = 'checkin' ORDER BY date").all<{ date: string }>()).results.map((r) => r.date);
  if (!days.length) return 0;
  const byWeekday = new Map<string, typeof checkins>();
  for (const c of checkins) {
    const list = byWeekday.get(c.weekday) ?? [];
    list.push(c);
    byWeekday.set(c.weekday, list);
  }
  const stmt = env.DB.prepare("UPDATE mf_daily SET target_calories = ?, target_protein_g = ?, target_carbs_g = ?, target_fat_g = ?, targets_source = 'checkin' WHERE date = ?");
  const stmts: D1PreparedStatement[] = [];
  for (const date of days) {
    const wd = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
    const list = byWeekday.get(wd) ?? [];
    let active: (typeof checkins)[number] | undefined;
    for (const c of list) if (c.update_date <= date) active = c;
    if (!active) continue;
    stmts.push(stmt.bind(active.calories, active.protein_g, active.carbs_g, active.fat_g, date));
  }
  await runBatches(env, stmts);
  return stmts.length;
}

async function runBatches(env: Env, stmts: D1PreparedStatement[], size = 400): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) await env.DB.batch(stmts.slice(i, i + size));
}

export class IngestError extends Error {
  override readonly name = "IngestError";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmt(iso: string): string {
  const short = `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
  return iso.slice(0, 4) === new Date().toISOString().slice(0, 4) ? short : `${short} ${iso.slice(0, 4)}`;
}
