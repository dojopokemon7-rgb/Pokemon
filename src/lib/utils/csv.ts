/**
 * Excel-compatible CSV helpers (pure). UTF-8 BOM + CRLF + RFC 4180 quoting, and
 * CSV/formula-injection neutralization: a cell starting with = + - @ TAB or CR
 * is prefixed with a single quote so Excel/Sheets treat it as text.
 */
export const CSV_BOM = "\uFEFF";

export function csvCell(value: unknown): string {
  let s = value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(",") + "\r\n";
