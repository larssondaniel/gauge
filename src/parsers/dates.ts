/**
 * Date and time helpers shared by every parser.
 *
 * All dates are local calendar days as ISO strings (YYYY-MM-DD). No time zone
 * conversion happens anywhere in the parsers: a date read from a file is the
 * date the app wrote, and it stays that way.
 */

const MS_PER_DAY = 86_400_000;
/** Excel's day 0 is 1899-12-30 (the 1900 leap-year bug is already folded in). */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Excel serial day number to ISO date. Fractions (time of day) are dropped. */
export function excelSerialToIso(serial: number): string {
  const ms = EXCEL_EPOCH_UTC + Math.floor(serial) * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO date to Excel serial (used by tests and coverage math). */
export function isoToExcelSerial(iso: string): number {
  return Math.round((Date.UTC(...isoParts(iso)) - EXCEL_EPOCH_UTC) / MS_PER_DAY);
}

function isoParts(iso: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`Not an ISO date: ${iso}`);
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.UTC(...isoParts(s)));
}

/** Add n days to an ISO date. */
export function addDays(iso: string, n: number): string {
  return new Date(Date.UTC(...isoParts(iso)) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Every ISO date from start to end inclusive. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Parse a date cell as MacroFactor writes it. Seen in real exports:
 *  - Excel serial numbers (most Granular sheets, Quick Export daily sheet)
 *  - "YYYY-MM-DD" strings (Food Log)
 *  - "M/D/YYYY" strings (Nutrition Program Settings, Weight Goals, Fasting, Partial Logging)
 * Returns null for empty cells; throws for anything unrecognised so a new
 * layout fails loudly instead of misparsing.
 */
export function parseDateCell(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    if (v < 20_000 || v > 80_000) throw new Error(`Date serial out of range: ${v}`);
    return excelSerialToIso(v);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") {
    const s = v.trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return `${m[3]}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`;
  }
  throw new Error(`Unrecognised date cell: ${JSON.stringify(v)}`);
}

/**
 * Parse a time-of-day cell to "HH:MM" (24h). Seen: "07:00 AM", "08:38 PM".
 * Also accepts "HH:MM", "HH:MM:SS", and Excel day fractions.
 */
export function parseTimeCell(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    const minutes = Math.round((v - Math.floor(v)) * 24 * 60);
    return `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}`;
  }
  if (typeof v === "string") {
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(v.trim());
    if (m) {
      let h = Number(m[1]);
      const min = m[2];
      const ampm = m[3]?.toUpperCase();
      if (ampm === "AM" && h === 12) h = 0;
      else if (ampm === "PM" && h !== 12) h += 12;
      if (h > 23) throw new Error(`Unrecognised time cell: ${JSON.stringify(v)}`);
      return `${pad2(h)}:${min}`;
    }
  }
  throw new Error(`Unrecognised time cell: ${JSON.stringify(v)}`);
}
