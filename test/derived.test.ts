import { describe, expect, it } from "vitest";
import { rolling, rollingMean, trendRate, type Series } from "../src/mcp/derived.js";
import { guardSql, QueryError } from "../src/mcp/schema.js";
import { addDays } from "../src/parsers/dates.js";

function series(from: string, values: (number | null)[], excluded: string[] = []): Series {
  const m = new Map<string, number | null>();
  values.forEach((v, i) => m.set(addDays(from, i), v));
  return { values: m, excluded: new Set(excluded) };
}

describe("rolling windows (D-008)", () => {
  const w = { recentDays: 7, baselineDays: 30, minBaselineDays: 14 };
  it("keeps the recent window out of the baseline and reports n", () => {
    // 37 days: 30 baseline days at 50, then 7 recent days at 40
    const s = series("2026-01-01", [...Array(30).fill(50), ...Array(7).fill(40)]);
    const r = rolling(s, "2026-02-06", w);
    expect(r).toEqual({ recent_mean: 40, recent_n: 7, baseline_mean: 50, baseline_n: 30, dev_pct: -20 });
  });
  it("returns a null baseline under 14 valid days and skips nulls and rest-mode days", () => {
    const vals: (number | null)[] = [...Array(30).fill(null), ...Array(7).fill(40)];
    for (let i = 20; i < 30; i++) vals[i] = 60; // only 10 valid baseline days
    const s = series("2026-01-01", vals);
    const r = rolling(s, "2026-02-06", w);
    expect(r.baseline_mean).toBeNull();
    expect(r.baseline_n).toBe(10);
    expect(r.dev_pct).toBeNull();
    const s2 = series("2026-01-01", [...Array(30).fill(50), 40, 40, 40, 40, 40, 40, 100], ["2026-02-06"]);
    expect(rolling(s2, "2026-02-06", w).recent_mean).toBe(40);
  });
  it("computes 7-day means and trend rate", () => {
    const s = series("2026-01-01", [1, 2, 3, null, 5, 6, 7]);
    expect(rollingMean(s, "2026-01-07", 7)).toEqual({ mean: 4, n: 6 });
    const trend = new Map([["2026-01-01", 180], ["2026-01-08", 180.9]]);
    expect(trendRate(trend, "2026-01-08")).toBe(0.5);
    expect(trendRate(trend, "2026-01-09")).toBeNull();
  });
});

describe("query guard (D-010)", () => {
  it("wraps a SELECT with a cap and strips comments", () => {
    expect(guardSql("select 1 -- hi\n", 500)).toBe("SELECT * FROM (select 1) LIMIT 501");
    expect(guardSql("WITH x AS (SELECT 1 a) SELECT a FROM x;", 10)).toMatch(/^SELECT \* FROM \(WITH x/);
  });
  it("rejects writes, pragmas, and multiple statements", () => {
    for (const sql of ["DELETE FROM mf_daily", "PRAGMA table_info(x)", "SELECT 1; SELECT 2", "insert into x values (1)", "select * from x; drop table x", "attach database 'y' as z"]) {
      expect(() => guardSql(sql, 500)).toThrow(QueryError);
    }
    // column names containing forbidden words are fine
    expect(() => guardSql("SELECT updated_at, created FROM mf_daily", 5)).not.toThrow();
  });
});
