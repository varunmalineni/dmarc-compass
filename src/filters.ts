// Global filters (domains + time range). They live in the URL, so every page
// shares them, links preserve them, and a filtered view can be bookmarked or
// shared.

export const RANGE_OPTIONS = [7, 30, 90, 365] as const;
export const DEFAULT_RANGE = 90;
const DAY = 86400;
// D1 allows 100 bound parameters per query, so the domain list is passed to
// SQL as ONE json parameter (see domainFilter) and only its length is capped.
const MAX_DOMAINS = 500;

export interface Filters {
  /** Empty means "all domains". */
  domains: string[];
  /** Days to look back; null means all time. */
  range: number | null;
}

export function parseFilters(url: URL): Filters {
  const raw = url.searchParams.get("domains") ?? url.searchParams.get("domain") ?? "";
  const domains = [...new Set(raw.split(",").map((d) => d.trim()).filter(Boolean))].slice(0, MAX_DOMAINS);

  const r = url.searchParams.get("range");
  let range: number | null = DEFAULT_RANGE;
  if (r === "all") range = null;
  else if (r && (RANGE_OPTIONS as readonly number[]).includes(Number(r))) range = Number(r);

  return { domains, range };
}

/** Epoch seconds at the start of the window (0 for all time). */
export function sinceEpoch(range: number | null, now = Math.floor(Date.now() / 1000)): number {
  return range === null ? 0 : now - range * DAY;
}

export function rangeLabel(range: number | null): string {
  if (range === null) return "All time";
  return range === 365 ? "Last year" : `Last ${range} days`;
}

export function scopeLabel(f: Filters): string {
  if (f.domains.length === 0) return "All domains";
  if (f.domains.length === 1) return f.domains[0];
  return `${f.domains.length} domains`;
}

/** Builds a URL that keeps the current filters. `extra` params are added
 * (undefined values are dropped). */
export function withFilters(path: string, f: Filters, extra: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams();
  if (f.domains.length) p.set("domains", f.domains.join(","));
  if (f.range === null) p.set("range", "all");
  else if (f.range !== DEFAULT_RANGE) p.set("range", String(f.range));
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") p.set(k, v);
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
}

/** SQL fragment restricting `column` to the selected domains, or nothing for
 * "all domains". One bound parameter regardless of how many domains. */
export function domainFilter(column: string, f: Filters): { sql: string; params: string[] } {
  if (f.domains.length === 0) return { sql: "", params: [] };
  return { sql: ` AND ${column} IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(f.domains)] };
}

/** Pins windowed scans of dmarc_records to the date index for short windows over
 * all domains. Without it SQLite prefers idx_records_ip or idx_records_domain to
 * avoid a sort, and walks the whole history instead of the selected window (4x slower
 * for 90 days of a 2-year history). Not used when a domain filter narrows the scan
 * (the domain index is right then), nor for a year or all time (the window is most of
 * the table, and walking in source order is then faster). */
export function recordsByDate(f: Filters): string {
  return f.domains.length === 0 && f.range !== null && f.range <= 90 ? " INDEXED BY idx_records_date" : "";
}

/** Escapes a user search string for use in LIKE ... ESCAPE '\\'. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
}

export function parsePage(url: URL): number {
  const n = parseInt(url.searchParams.get("page") ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 1;
}

export interface ListState {
  q: string;
  sort: string;
  dir: "asc" | "desc";
  page: number;
}

/** Search / sort / page state for a table. Unknown sort keys fall back to the
 * default, so a hand-edited URL can never inject SQL. */
export function parseList(
  url: URL,
  sorts: readonly string[],
  defSort: string,
  defDir: "asc" | "desc",
): ListState {
  const s = url.searchParams.get("sort") ?? "";
  const d = url.searchParams.get("dir");
  return {
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 100),
    sort: sorts.includes(s) ? s : defSort,
    dir: d === "asc" || d === "desc" ? d : defDir,
    page: parsePage(url),
  };
}
