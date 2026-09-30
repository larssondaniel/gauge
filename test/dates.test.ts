import { describe, expect, it } from "vitest";
import { addDays, dateRange, excelSerialToIso, isoToExcelSerial, parseDateCell, parseTimeCell } from "../src/parsers/dates.js";

describe("dates", () => {
  it("converts Excel serials seen in real exports", () => {
    expect(excelSerialToIso(46294)).toBe("2026-09-29");
    expect(excelSerialToIso(45728)).toBe("2025-03-12");
    expect(excelSerialToIso(44583)).toBe("2022-01-22");
    expect(isoToExcelSerial("2026-09-29")).toBe(46294);
  });
  it("parses every date cell style MacroFactor writes", () => {
    expect(parseDateCell(46294)).toBe("2026-09-29");
    expect(parseDateCell("2026-08-31")).toBe("2026-08-31");
    expect(parseDateCell("3/11/2025")).toBe("2025-03-11");
    expect(parseDateCell("12/1/2025")).toBe("2025-12-01");
    expect(parseDateCell(null)).toBeNull();
    expect(parseDateCell("")).toBeNull();
    expect(() => parseDateCell("Tuesday")).toThrow(/Unrecognised/);
  });
  it("parses 12-hour times to HH:MM", () => {
    expect(parseTimeCell("07:00 AM")).toBe("07:00");
    expect(parseTimeCell("08:38 PM")).toBe("20:38");
    expect(parseTimeCell("12:05 AM")).toBe("00:05");
    expect(parseTimeCell("12:30 PM")).toBe("12:30");
    expect(parseTimeCell("23:59")).toBe("23:59");
    expect(parseTimeCell(0.5)).toBe("12:00");
    expect(parseTimeCell(null)).toBeNull();
  });
  it("does day arithmetic without time zones", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(dateRange("2026-09-28", "2026-09-30")).toEqual(["2026-09-28", "2026-09-29", "2026-09-30"]);
  });
});
