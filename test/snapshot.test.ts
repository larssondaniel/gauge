import { describe, expect, it } from "vitest";
import { parseSnapshot } from "../src/parsers/snapshot.js";

describe("snapshot payload", () => {
  it("parses a nutrition-only post with an empty (no-goal) nutrient", () => {
    const p = parseSnapshot({
      date: "2026-09-30",
      tz_offset: "-05:00",
      calories_consumed: "2150.25",
      calories_remaining_goal: -50.25,
      protein_consumed: 160,
      protein_remaining_goal: -10,
      carbs_consumed: 250, carbs_remaining_goal: -20,
      fat_consumed: 65, fat_remaining_goal: 5,
      fiber_consumed: 28, fiber_remaining_goal: "",
      alcohol_consumed: "", alcohol_remaining_goal: "",
      sodium_consumed: 3100.5, sodium_remaining_goal: -800.5,
    });
    expect(p.date).toBe("2026-09-30");
    expect(p.tz_offset).toBe("-05:00");
    expect(p.health).toBeNull();
    expect(p.nutrition?.calories.consumed).toBeCloseTo(2150.25, 2);
    expect(p.nutrition?.calories.target).toBeCloseTo(2100, 1);
    expect(p.nutrition?.sodium.target).toBeCloseTo(2300, 1);
    expect(p.nutrition?.alcohol).toEqual({ consumed: null, remaining_goal: null, remaining_min: null, remaining_max: null, target: null });
    expect(p.nutrition?.fiber.target).toBeNull();
    expect(p.missing).toEqual(["fiber_remaining_goal", "alcohol_consumed", "alcohol_remaining_goal"]);
    expect(p.unknown_keys).toEqual([]);
  });
  it("parses a health-only post and reports partial fields", () => {
    const p = parseSnapshot({ date: "2026-09-30T07:10:00-05:00", weight_lb: 172.4, steps: "" });
    expect(p.date).toBe("2026-09-30");
    expect(p.nutrition).toBeNull();
    expect(p.health).toEqual({ weight_lb: 172.4, steps: null, steps_yesterday: null });
    expect(p.missing).toEqual(["steps"]);
  });
  it("rejects payloads without a date or without any fields", () => {
    expect(() => parseSnapshot({ calories_consumed: 1 })).toThrow(/date/);
    expect(() => parseSnapshot({ date: "2026-09-30" })).toThrow(/neither/);
    expect(() => parseSnapshot({ date: "2026-09-30", steps: "lots" })).toThrow(/must be a number/);
  });
  it("takes the offset from an ISO 8601 date when tz_offset is absent", () => {
    const p = parseSnapshot({ date: "2026-09-30T23:55:12-04:00", steps: 100 });
    expect(p.date).toBe("2026-09-30");
    expect(p.tz_offset).toBe("-04:00");
  });
  it("accepts steps_yesterday from the morning shortcut", () => {
    const p = parseSnapshot({ date: "2026-09-30", weight_lb: "172.4", steps_yesterday: 7000 });
    expect(p.health).toEqual({ weight_lb: 172.4, steps: null, steps_yesterday: 7000 });
    expect(p.missing).toEqual([]);
  });
  it("lists keys it did not use", () => {
    const p = parseSnapshot({ date: "2026-09-30", steps: 5000, water_ml: 2000 });
    expect(p.unknown_keys).toEqual(["water_ml"]);
  });
});
