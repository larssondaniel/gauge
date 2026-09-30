/**
 * Derived metrics (SPEC "Derived metrics", D-008): rolling means, baselines,
 * rates. Nulls are skipped, every aggregate reports its n, baselines exclude
 * rest-mode days and are null under `minBaselineDays` valid days. The recent
 * window is excluded from the baseline window.
 */
import { addDays } from "../parsers/dates.js";

export interface Series {
  /** date -> value (null when missing). */
  values: Map<string, number | null>;
  /** dates excluded from baselines (rest mode). */
  excluded: Set<string>;
}

export interface Windows {
  recentDays: number;
  baselineDays: number;
  minBaselineDays: number;
}

export const DEFAULT_WINDOWS: Windows = { recentDays: 7, baselineDays: 30, minBaselineDays: 14 };

export interface Rolling {
  recent_mean: number | null;
  recent_n: number;
  baseline_mean: number | null;
  baseline_n: number;
  /** (recent - baseline) / baseline * 100 */
  dev_pct: number | null;
}

function meanOver(s: Series, start: string, end: string, excludeRest: boolean): { mean: number | null; n: number } {
  let sum = 0;
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (excludeRest && s.excluded.has(d)) continue;
    const v = s.values.get(d);
    if (v === null || v === undefined) continue;
    sum += v;
    n++;
  }
  return { mean: n ? sum / n : null, n };
}

/** Rolling stats for day D. The recent window ends on D; the baseline ends the day before the recent window. */
export function rolling(s: Series, day: string, w: Windows): Rolling {
  const recentStart = addDays(day, -(w.recentDays - 1));
  const recent = meanOver(s, recentStart, day, true);
  const baseEnd = addDays(recentStart, -1);
  const base = meanOver(s, addDays(baseEnd, -(w.baselineDays - 1)), baseEnd, true);
  const baselineMean = base.n >= w.minBaselineDays ? base.mean : null;
  const dev = recent.mean !== null && baselineMean !== null && baselineMean !== 0 ? ((recent.mean - baselineMean) / baselineMean) * 100 : null;
  return { recent_mean: r1(recent.mean), recent_n: recent.n, baseline_mean: r1(baselineMean), baseline_n: base.n, dev_pct: r1(dev) };
}

/** Plain rolling mean without baseline (sleep 7-day mean). */
export function rollingMean(s: Series, day: string, days: number): { mean: number | null; n: number } {
  const m = meanOver(s, addDays(day, -(days - 1)), day, false);
  return { mean: r1(m.mean), n: m.n };
}

/** Trend rate %/week: (trend D - trend D-7) / trend D-7 * 100. */
export function trendRate(trend: Map<string, number | null>, day: string): number | null {
  const now = trend.get(day);
  const then = trend.get(addDays(day, -7));
  if (now === null || now === undefined || then === null || then === undefined || then === 0) return null;
  return r2(((now - then) / then) * 100);
}

export function r1(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}
export function r2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

export function mean(vals: (number | null | undefined)[]): { mean: number | null; n: number } {
  const v = vals.filter((x): x is number => typeof x === "number");
  return { mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null, n: v.length };
}
export function min(vals: (number | null | undefined)[]): number | null {
  const v = vals.filter((x): x is number => typeof x === "number");
  return v.length ? Math.min(...v) : null;
}
export function sum(vals: (number | null | undefined)[]): number | null {
  const v = vals.filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}
