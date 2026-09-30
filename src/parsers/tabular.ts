/**
 * Reads workbooks (xlsx) and CSV text into a uniform Table shape so the
 * MacroFactor parser can map columns by header name regardless of source.
 * Runtime-agnostic: works in Node (tests) and in Cloudflare Workers.
 */
import * as XLSX from "xlsx";

export type Cell = string | number | boolean | null;

export interface Table {
  name: string;
  headers: string[];
  rows: Cell[][];
}

/** Read every sheet of a workbook. Numbers stay numbers (dates as serials). */
export function readWorkbook(bytes: Uint8Array | ArrayBuffer): Table[] {
  const wb = XLSX.read(bytes, { type: bytes instanceof Uint8Array ? "array" : "array", cellDates: false, raw: true });
  const tables: Table[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const grid = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, defval: null, raw: true, blankrows: false });
    const headerRow = grid[0] ?? [];
    const headers = headerRow.map((h) => (h === null ? "" : String(h).trim()));
    const rows = grid.slice(1).filter((r) => r.some((c) => c !== null && c !== ""));
    tables.push({ name, headers, rows: rows.map((r) => normaliseRow(r, headers.length)) });
  }
  return tables;
}

/**
 * Minimal RFC 4180 CSV reader: quoted fields, doubled quotes, CR/LF line ends,
 * UTF-8 BOM. Numeric-looking fields become numbers; empty fields become null.
 */
export function readCsv(text: string, name = "csv"): Table {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      field = "";
      record = [];
    } else field += ch;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => r.some((f) => f !== ""));
  const headers = (nonEmpty[0] ?? []).map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => normaliseRow(r.map(coerceCsvField), headers.length));
  return { name, headers, rows };
}

function coerceCsvField(f: string): Cell {
  if (f === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(f)) return Number(f);
  return f;
}

function normaliseRow(r: Cell[], width: number): Cell[] {
  const out: Cell[] = new Array(width).fill(null);
  for (let i = 0; i < width; i++) {
    const v = r[i];
    out[i] = v === undefined || v === "" ? null : (v as Cell);
  }
  return out;
}

/** Column accessor by header name, tolerant of case and surrounding spaces. */
export class Columns {
  private readonly index = new Map<string, number>();
  constructor(readonly table: Table) {
    table.headers.forEach((h, i) => {
      if (h) this.index.set(normaliseHeader(h), i);
    });
  }
  has(header: string): boolean {
    return this.index.has(normaliseHeader(header));
  }
  /** Index of a header, or -1. */
  col(header: string): number {
    return this.index.get(normaliseHeader(header)) ?? -1;
  }
  get(row: Cell[], header: string): Cell {
    const i = this.col(header);
    return i < 0 ? null : (row[i] ?? null);
  }
  num(row: Cell[], header: string): number | null {
    const v = this.get(row, header);
    if (v === null || v === "") return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
    throw new Error(`Expected a number in column "${header}", got ${JSON.stringify(v)}`);
  }
  str(row: Cell[], header: string): string | null {
    const v = this.get(row, header);
    if (v === null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  }
  /** Headers of the table not in the given set, in sheet order. */
  headersExcept(known: Iterable<string>): string[] {
    const skip = new Set([...known].map(normaliseHeader));
    return this.table.headers.filter((h) => h && !skip.has(normaliseHeader(h)));
  }
}

export function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

/** "Vitamin D (mcg)" -> "vitamin_d_mcg"; "B12, Cobalamin (mcg)" -> "b12_cobalamin_mcg". */
export function slugHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
