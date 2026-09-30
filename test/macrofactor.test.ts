/**
 * Runs against the real samples in samples/ (git-ignored). Skipped when they
 * are absent, so CI without the files still passes the synthetic tests.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMacroFactor, UnknownLayoutError, type MfImport } from "../src/parsers/macrofactor.js";
import { readCsv } from "../src/parsers/tabular.js";

const SAMPLES = join(process.cwd(), "samples");
const have = existsSync(SAMPLES);
const files = have ? readdirSync(SAMPLES) : [];

function load(name: string): MfImport {
  const bytes = new Uint8Array(readFileSync(join(SAMPLES, name)));
  return parseMacroFactor({ bytes, filename: name });
}

function classify(): Record<string, string | undefined> {
  const out: Record<string, string> = {};
  for (const f of files) {
    if (!/\.(xlsx|csv)$/.test(f)) continue;
    try {
      out[load(f).layout] = f;
    } catch {
      /* not a MacroFactor file */
    }
  }
  return out;
}
const byLayout = have ? classify() : {};

describe("layout detection", () => {
  it("rejects unknown CSV and workbooks loudly", () => {
    expect(() => parseMacroFactor({ text: "a,b\n1,2\n" })).toThrow(UnknownLayoutError);
    expect(() => parseMacroFactor({ text: "" })).toThrow(UnknownLayoutError);
  });
  it("reads a synthetic food-log CSV with quoted names", () => {
    const csv = '﻿"Date","Time","Food Name","Calories (kcal)","Sodium (mg)"\n"2026-01-01","08:38 PM","Cheese, ""aged""",100,250\n';
    const r = parseMacroFactor({ text: csv, filename: "x.csv" });
    expect(r.layout).toBe("food_log_csv");
    expect(r.food_log[0]).toMatchObject({ date: "2026-01-01", time: "20:38", name: 'Cheese, "aged"', calories: 100, sodium_mg: 250 });
    expect(r.coverage).toEqual({ start: "2026-01-01", end: "2026-01-01" });
  });
  it("readCsv handles CRLF and empty trailing lines", () => {
    const t = readCsv("a,b\r\n1,\r\n\r\n");
    expect(t.headers).toEqual(["a", "b"]);
    expect(t.rows).toEqual([[1, null]]);
  });
});

describe.skipIf(!byLayout["quick_export"])("Quick Export sample", () => {
  const r = byLayout["quick_export"] ? load(byLayout["quick_export"]) : (null as never);
  it("covers 30 days with one row per day", () => {
    expect(r.coverage).toEqual({ start: "2026-08-31", end: "2026-09-29" });
    expect(r.daily).toHaveLength(30);
    expect(r.sheets_seen).toEqual(["Quick Export", "Food Log"]);
  });
  it("maps every must-have field on the first and last day", () => {
    expect(r.daily[0]).toMatchObject({
      date: "2026-08-31", expenditure: 2182, trend_weight_lb: 183.6, scale_weight_lb: 180.6,
      calories: 2299, protein_g: 184, fat_g: 86, carbs_g: 104,
      target_calories: 1641, target_protein_g: 179, target_fat_g: 54, target_carbs_g: 107,
      steps: 8387, alcohol_g: 54,
    });
    expect(r.daily[29]).toMatchObject({ date: "2026-09-29", expenditure: 2330, trend_weight_lb: 181.06, calories: 2592, steps: 5404, alcohol_g: null });
    expect(typeof r.daily[0]!.sodium_mg).toBe("number");
    expect(typeof r.daily[0]!.fiber_g).toBe("number");
    expect(Object.keys(r.daily[0]!.micros)).toContain("vitamin_d_mcg");
    expect(r.daily[0]!.micros).not.toHaveProperty("sodium_mg");
  });
  it("carries the 30-day food log", () => {
    expect(r.food_log).toHaveLength(509);
    expect(r.food_log[0]).toMatchObject({ date: "2026-08-31", time: "11:03", serving_qty: 1, serving_weight_g: 414, calories: 230, protein_g: 42 });
    expect(r.food_log.at(-1)).toMatchObject({ date: "2026-09-29", time: "20:38" });
  });
  it("lacks only what the layout cannot carry", () => {
    expect(r.missing_fields).toEqual(["checkins (Granular Export only)", "body_metrics (Granular Export only)"]);
    expect(r.warnings).toEqual([]);
  });
});

describe.skipIf(!byLayout["granular_export"])("Granular Export sample", () => {
  const r = byLayout["granular_export"] ? load(byLayout["granular_export"]) : (null as never);
  it("merges the daily sheets by date and never reads User Profile", () => {
    expect(r.sheets_seen).toEqual(expect.arrayContaining(["Calories & Macros", "Micronutrients", "Scale Weight", "Weight Trend", "Expenditure", "Steps", "Fasting", "Partial Logging"]));
    expect(r.sheets_seen).not.toContain("User Profile");
    expect(r.sheets_ignored).toContain("User Profile");
    expect(r.coverage).toEqual({ start: "2022-01-22", end: "2026-09-29" });
    const last = r.daily.at(-1)!;
    expect(last).toMatchObject({ date: "2026-09-29", calories: 2592, fat_g: 70, carbs_g: 314, protein_g: 199, trend_weight_lb: 181.06, expenditure: 2330, steps: 5404, scale_weight_lb: 180.8 });
    const first = r.daily[0]!;
    expect(first).toMatchObject({ date: "2022-01-22", scale_weight_lb: 185, trend_weight_lb: 185, calories: null, expenditure: null });
    const trendDays = r.daily.filter((d) => d.trend_weight_lb !== null).length;
    expect(trendDays).toBe(1712);
    expect(r.daily.filter((d) => d.calories !== null)).toHaveLength(447);
    expect(r.daily.filter((d) => d.steps !== null)).toHaveLength(598);
  });
  it("carries alcohol from the Micronutrients sheet", () => {
    const d = r.daily.find((x) => x.date === "2025-03-13")!;
    expect(d.alcohol_g).toBe(18);
  });
  it("carries the Fasting and Partial Logging flags", () => {
    const d = r.daily.find((x) => x.date === "2025-03-17")!;
    expect(d.partial_logging).toBe(true);
    expect(d.fasting).toBe(false);
  });
  it("reads check-ins, weight goals, and body metrics", () => {
    expect(r.checkins).toHaveLength(441);
    expect(r.checkins[0]).toMatchObject({ update_date: "2025-03-11", weekday: "Tuesday", calories: 3406, fat_g: 113, protein_g: 155, carbs_g: 440, expenditure: 3041, daily_average_calories: 3406, weight_lb: 194.8, expenditure_mode: "Dynamic" });
    expect(r.checkins.at(-1)).toMatchObject({ update_date: "2026-09-26", weekday: "Friday", calories: 2536 });
    expect(r.weight_goals).toHaveLength(15);
    expect(r.weight_goals[0]).toMatchObject({ goal: "Weight Gain", status: "Completed", start_date: "2025-03-11", end_date: "2025-03-31", goal_weight_lb: 200.03, rate_pct_per_week: 0.83 });
    expect(r.weight_goals.at(-1)).toMatchObject({ status: "In Progress", start_date: "2026-09-22", end_date: null });
    expect(r.body_metrics).toHaveLength(1);
    expect(r.body_metrics[0]!.date).toBe("2025-08-06");
    expect(r.body_metrics[0]!.chest_in).toBe(42.2);
  });
  it("reports targets as the one daily field this layout lacks", () => {
    expect(r.missing_fields).toEqual(["target_calories", "target_protein_g", "target_carbs_g", "target_fat_g"]);
    expect(r.warnings.some((w) => /targets/.test(w))).toBe(true);
  });
});

describe.skipIf(!byLayout["food_log_csv"])("Food Log CSV sample", () => {
  const r = byLayout["food_log_csv"] ? load(byLayout["food_log_csv"]) : (null as never);
  it("parses every entry with quick-adds kept as-is", () => {
    expect(r.food_log).toHaveLength(5325);
    expect(r.coverage).toEqual({ start: "2025-03-12", end: "2026-09-29" });
    expect(r.food_log[0]!.time).toBe("07:00");
    expect(r.food_log.filter((e) => e.name === "Quick Add")).toHaveLength(34);
    expect(r.food_log.every((e) => e.time !== null)).toBe(true);
  });
});

describe.skipIf(!have)("sample summary (informational)", () => {
  it("prints what each file provides", () => {
    for (const [layout, f] of Object.entries(byLayout)) {
      if (!f) continue;
      const r = load(f);
      console.log(`${layout}: coverage ${r.coverage?.start}..${r.coverage?.end}, daily=${r.daily.length}, food=${r.food_log.length}, checkins=${r.checkins.length}, goals=${r.weight_goals.length}, body=${r.body_metrics.length}\n  missing: ${r.missing_fields.join(", ") || "none"}\n  ignored sheets: ${r.sheets_ignored.join(", ") || "none"}`);
    }
  });
});
