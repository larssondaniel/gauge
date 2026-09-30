/** Compact CSV output with `#` header lines (D-007). */

export type Value = string | number | boolean | null;

export interface Column {
  name: string;
  /** Rounding for numbers, in decimal places. */
  dp?: number;
}

function cell(v: Value, dp?: number): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return dp === undefined ? String(v) : String(Number(v.toFixed(dp)));
  const s = v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(headerLines: string[], columns: Column[], rows: Record<string, Value>[]): string {
  const out: string[] = headerLines.map((l) => `# ${l}`);
  out.push(columns.map((c) => c.name).join(","));
  for (const r of rows) out.push(columns.map((c) => cell(r[c.name] ?? null, c.dp)).join(","));
  return out.join("\n");
}

export function renderJson(headerLines: string[], columns: Column[], rows: Record<string, Value>[]): string {
  const data = rows.map((r) => {
    const o: Record<string, Value> = {};
    for (const c of columns) {
      const v = r[c.name] ?? null;
      o[c.name] = typeof v === "number" && c.dp !== undefined ? Number(v.toFixed(c.dp)) : v;
    }
    return o;
  });
  return JSON.stringify({ notes: headerLines, rows: data });
}

export function render(format: "csv" | "json", headerLines: string[], columns: Column[], rows: Record<string, Value>[]): string {
  return format === "json" ? renderJson(headerLines, columns, rows) : renderCsv(headerLines, columns, rows);
}

/** "3 days: 2026-09-01, 2026-09-04, 2026-09-05" or a compressed form for long lists. */
export function describeDays(days: string[]): string {
  if (days.length === 0) return "none";
  if (days.length <= 8) return `${days.length}: ${days.join(", ")}`;
  return `${days.length} (first ${days[0]}, last ${days[days.length - 1]})`;
}
