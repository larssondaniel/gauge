/**
 * POST /ingest/daily: the phone's snapshot feed. Parts are merged per date
 * (nutrition from the 23:55 run, health from the morning run) and projected
 * into mf_daily as provisional values that any export overwrites.
 */
import type { Env } from "../env.js";
import { addDays } from "../parsers/dates.js";
import { NUTRIENTS, parseSnapshot, type ParsedSnapshot } from "../parsers/snapshot.js";

export interface SnapshotResult {
  date: string;
  message: string;
  parsed: ParsedSnapshot;
}

export async function ingestSnapshot(env: Env, payload: unknown): Promise<SnapshotResult> {
  const p = parseSnapshot(payload);
  const now = new Date().toISOString();
  const existing = await env.DB.prepare("SELECT nutrition_json, health_json, missing_json FROM mf_snapshots WHERE date = ?").bind(p.date).first<{ nutrition_json: string | null; health_json: string | null; missing_json: string | null }>();
  const prevMissing: string[] = existing?.missing_json ? (JSON.parse(existing.missing_json) as string[]) : [];
  const missing = [...new Set([...prevMissing.filter((m) => !p.received.includes(m)), ...p.missing])];

  const stmts: D1PreparedStatement[] = [];
  stmts.push(
    env.DB.prepare(
      "INSERT INTO mf_snapshots (date, nutrition_json, nutrition_at, health_json, health_at, missing_json, tz_offset) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET nutrition_json = COALESCE(excluded.nutrition_json, mf_snapshots.nutrition_json), nutrition_at = COALESCE(excluded.nutrition_at, mf_snapshots.nutrition_at), health_json = COALESCE(excluded.health_json, mf_snapshots.health_json), health_at = COALESCE(excluded.health_at, mf_snapshots.health_at), missing_json = excluded.missing_json, tz_offset = COALESCE(excluded.tz_offset, mf_snapshots.tz_offset)",
    ).bind(p.date, p.nutrition ? JSON.stringify(p.nutrition) : null, p.nutrition ? now : null, p.health ? JSON.stringify(p.health) : null, p.health ? now : null, JSON.stringify(missing), p.tz_offset),
  );

  const parts: string[] = [];
  if (p.nutrition) {
    const n = p.nutrition;
    const got = NUTRIENTS.filter((k) => n[k].consumed !== null).length;
    // Provisional intake and targets: only where no export row exists (exports are authoritative).
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mf_daily (date, calories, protein_g, carbs_g, fat_g, fiber_g, alcohol_g, sodium_mg, target_calories, target_protein_g, target_carbs_g, target_fat_g, targets_source, micros, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'snapshot', '{}', 'snapshot', ?)
         ON CONFLICT(date) DO UPDATE SET
           calories = CASE WHEN mf_daily.source = 'export' THEN mf_daily.calories ELSE excluded.calories END,
           protein_g = CASE WHEN mf_daily.source = 'export' THEN mf_daily.protein_g ELSE excluded.protein_g END,
           carbs_g = CASE WHEN mf_daily.source = 'export' THEN mf_daily.carbs_g ELSE excluded.carbs_g END,
           fat_g = CASE WHEN mf_daily.source = 'export' THEN mf_daily.fat_g ELSE excluded.fat_g END,
           fiber_g = CASE WHEN mf_daily.source = 'export' THEN mf_daily.fiber_g ELSE excluded.fiber_g END,
           alcohol_g = CASE WHEN mf_daily.source = 'export' THEN mf_daily.alcohol_g ELSE excluded.alcohol_g END,
           sodium_mg = CASE WHEN mf_daily.source = 'export' THEN mf_daily.sodium_mg ELSE excluded.sodium_mg END,
           target_calories = CASE WHEN mf_daily.source = 'export' THEN mf_daily.target_calories ELSE excluded.target_calories END,
           target_protein_g = CASE WHEN mf_daily.source = 'export' THEN mf_daily.target_protein_g ELSE excluded.target_protein_g END,
           target_carbs_g = CASE WHEN mf_daily.source = 'export' THEN mf_daily.target_carbs_g ELSE excluded.target_carbs_g END,
           target_fat_g = CASE WHEN mf_daily.source = 'export' THEN mf_daily.target_fat_g ELSE excluded.target_fat_g END,
           targets_source = CASE WHEN mf_daily.source = 'export' THEN mf_daily.targets_source ELSE 'snapshot' END,
           updated_at = CASE WHEN mf_daily.source = 'export' THEN mf_daily.updated_at ELSE excluded.updated_at END`,
      ).bind(p.date, n.calories.consumed, n.protein.consumed, n.carbs.consumed, n.fat.consumed, n.fiber.consumed, n.alcohol.consumed, n.sodium.consumed, n.calories.target, n.protein.target, n.carbs.target, n.fat.target, now),
    );
    parts.push(`nutrition ${got}/${NUTRIENTS.length} nutrients${n.calories.consumed !== null ? ` (${Math.round(n.calories.consumed)} kcal)` : ""}`);
  }
  if (p.health) {
    const h = p.health;
    if (h.weight_lb !== null) {
      h.weight_lb = Math.round(h.weight_lb * 100) / 100;
      stmts.push(
        env.DB.prepare(
          "INSERT INTO mf_daily (date, scale_weight_lb, micros, source, updated_at) VALUES (?, ?, '{}', 'snapshot', ?) ON CONFLICT(date) DO UPDATE SET scale_weight_lb = CASE WHEN mf_daily.source = 'export' THEN mf_daily.scale_weight_lb ELSE excluded.scale_weight_lb END, updated_at = CASE WHEN mf_daily.source = 'export' THEN mf_daily.updated_at ELSE excluded.updated_at END",
        ).bind(p.date, h.weight_lb, now),
      );
      parts.push(`weight ${h.weight_lb} lb`);
    }
    // Health steps are their own column and not in any export, so they always land.
    const stepRows: [string, number][] = [];
    if (h.steps !== null) stepRows.push([p.date, h.steps]);
    if (h.steps_yesterday !== null) stepRows.push([addDays(p.date, -1), h.steps_yesterday]);
    for (const [d, steps] of stepRows) {
      stmts.push(env.DB.prepare("INSERT INTO mf_daily (date, steps_health, micros, source, updated_at) VALUES (?, ?, '{}', 'snapshot', ?) ON CONFLICT(date) DO UPDATE SET steps_health = excluded.steps_health").bind(d, steps, now));
      parts.push(`steps ${steps} (${d === p.date ? "today" : "yesterday"})`);
    }
  }
  await env.DB.batch(stmts);
  const missingNote = missing.length ? `; missing: ${missing.join(", ")}` : "";
  const message = `Snapshot ${p.date}: ${parts.join(", ")}${missingNote}. Provisional until the next export.`;
  return { date: p.date, message, parsed: p };
}

export async function snapshotSummary(env: Env): Promise<{ latest_nutrition: { date: string; at: string } | null; latest_health: { date: string; at: string } | null }> {
  const n = await env.DB.prepare("SELECT date, nutrition_at AS at FROM mf_snapshots WHERE nutrition_at IS NOT NULL ORDER BY date DESC LIMIT 1").first<{ date: string; at: string }>();
  const h = await env.DB.prepare("SELECT date, health_at AS at FROM mf_snapshots WHERE health_at IS NOT NULL ORDER BY date DESC LIMIT 1").first<{ date: string; at: string }>();
  return { latest_nutrition: n ?? null, latest_health: h ?? null };
}
