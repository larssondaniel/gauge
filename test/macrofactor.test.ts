/**
 * Synthetic parser tests. Tests against real exports live in the git-ignored
 * test/samples.local.test.ts, next to the samples/ they read.
 */
import { describe, expect, it } from "vitest";
import { parseMacroFactor, UnknownLayoutError } from "../src/parsers/macrofactor.js";
import { readCsv } from "../src/parsers/tabular.js";

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
