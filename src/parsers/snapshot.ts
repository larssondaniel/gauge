/**
 * Daily snapshot payload parser (POST /ingest/daily).
 *
 * The phone's Shortcuts build a flat dictionary (D-018): one key per value
 * read from MacroFactor's "Get Nutrition State" action, plus optional Apple
 * Health fields. Any subset may be present (D-005); the server merges per
 * field, so a nutrition-only post at 23:55 and a health-only post the next
 * morning both land on the same date.
 *
 * Accepted keys (all optional except `date`):
 *   date                          "YYYY-MM-DD" local date the values describe
 *   <nutrient>_consumed           number
 *   <nutrient>_remaining_goal     number, may be negative (goal exceeded)
 *   <nutrient>_remaining_min      number
 *   <nutrient>_remaining_max      number
 *   weight_lb                     number (Apple Health, morning weigh-in)
 *   steps                         number (Apple Health, whole day)
 *   tz_offset                     "+02:00" style, informational
 * where <nutrient> is one of NUTRIENTS. A nutrient with no goal set makes the
 * Shortcut variable empty, which arrives as "" and becomes null. Targets are
 * derived as consumed + remaining_goal when both are present.
 */

export const NUTRIENTS = ["calories", "protein", "carbs", "fat", "fiber", "alcohol", "sodium"] as const;
export type Nutrient = (typeof NUTRIENTS)[number];
const CALCS = ["consumed", "remaining_goal", "remaining_min", "remaining_max"] as const;
type Calc = (typeof CALCS)[number];

export interface NutrientState {
  consumed: number | null;
  remaining_goal: number | null;
  remaining_min: number | null;
  remaining_max: number | null;
  /** consumed + remaining_goal, null unless both are present. */
  target: number | null;
}

export interface ParsedSnapshot {
  date: string;
  tz_offset: string | null;
  nutrition: Record<Nutrient, NutrientState> | null;
  health: { weight_lb: number | null; steps: number | null } | null;
  /** Keys that carried a value. */
  received: string[];
  /** Expected keys that were absent or empty. */
  missing: string[];
  /** Keys in the payload that nothing consumed. */
  unknown_keys: string[];
}

export class SnapshotError extends Error {
  override readonly name = "SnapshotError";
}

export function parseSnapshot(payload: unknown): ParsedSnapshot {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new SnapshotError("Payload must be a JSON object");
  const obj = payload as Record<string, unknown>;
  const date = normaliseDate(obj["date"]);
  if (!date) throw new SnapshotError('Payload needs "date" as YYYY-MM-DD');

  const received: string[] = [];
  const missing: string[] = [];
  const used = new Set(["date", "tz_offset"]);
  const num = (key: string): number | null => {
    used.add(key);
    const v = toNumber(obj[key], key);
    (v === null ? missing : received).push(key);
    return v;
  };

  let nutrition: ParsedSnapshot["nutrition"] = null;
  const anyNutrition = NUTRIENTS.some((n) => CALCS.some((c) => `${n}_${c}` in obj));
  if (anyNutrition) {
    nutrition = {} as Record<Nutrient, NutrientState>;
    for (const n of NUTRIENTS) {
      const s: Record<Calc, number | null> = { consumed: null, remaining_goal: null, remaining_min: null, remaining_max: null };
      for (const c of CALCS) {
        const key = `${n}_${c}`;
        // Only "consumed" and "remaining_goal" are expected; min/max are optional extras.
        if (c === "consumed" || c === "remaining_goal" || key in obj) s[c] = num(key);
        else used.add(key);
      }
      nutrition[n] = { ...s, target: s.consumed !== null && s.remaining_goal !== null ? round(s.consumed + s.remaining_goal, 3) : null };
    }
  }

  let health: ParsedSnapshot["health"] = null;
  if ("weight_lb" in obj || "steps" in obj) health = { weight_lb: num("weight_lb"), steps: num("steps") };

  if (!nutrition && !health) throw new SnapshotError("Payload has neither nutrition nor health fields");

  const tz = obj["tz_offset"];
  return {
    date,
    tz_offset: typeof tz === "string" && /^[+-]\d{2}:\d{2}$/.test(tz) ? tz : null,
    nutrition,
    health,
    received,
    missing,
    unknown_keys: Object.keys(obj).filter((k) => !used.has(k)),
  };
}

function normaliseDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function toNumber(v: unknown, key: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim().replace(",", ".");
    if (s === "") return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  }
  throw new SnapshotError(`"${key}" must be a number, got ${JSON.stringify(v)}`);
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
