// CSV building. Pure, so it can be unit-tested with plain Node.
//
// Cell text comes from third-party reports (domain names, reporter names,
// reverse-DNS hostnames), so a value such as =HYPERLINK(...) or @SUM(...) would
// run as a formula when the file is opened in Excel or Sheets. Any text cell
// starting with one of the formula characters is prefixed with a single quote,
// which spreadsheets show as text. Numbers are never altered.

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  s = String(value);
  if (FORMULA_START.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** One CSV record, terminated with CRLF as RFC 4180 specifies. */
export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",") + "\r\n";
}

/** Excel opens UTF-8 CSV correctly only when it starts with a byte order mark. */
export const CSV_BOM = "\uFEFF";

export function toCsv(columns: string[], rows: unknown[][]): string {
  let out = CSV_BOM + csvRow(columns);
  for (const r of rows) out += csvRow(r);
  return out;
}

export function toJsonRows(columns: string[], rows: unknown[][]): Array<Record<string, unknown>> {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
}

export function isoDate(epochSeconds: number | null | undefined): string {
  return epochSeconds ? new Date(epochSeconds * 1000).toISOString() : "";
}

/** A file name fragment that is safe on every platform. */
export function slug(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, max) || "all"
  );
}
