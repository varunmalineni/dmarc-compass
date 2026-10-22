// Query layer for the custom "Insights" dashboard - all reads against D1,
// completely independent of the dmarc-report-viewer container. Every
// query accepts an optional domain filter, since production will have
// 1500+ domains sharing this one pipeline.

export interface TrendPoint {
  day: string;
  passed: number;
  failed: number;
}

export interface SourceRow {
  source_ip: string;
  esp_name: string;
  ptr_hostname: string | null;
  domain: string;
  total_count: number;
  passed_count: number;
  pass_rate: number;
  first_seen: number;
  last_seen: number;
  issues: string[];
}

export interface EnforcementStatus {
  currentPolicy: string | null;
  domain: string | null;
  windowDays: number;
  ready: boolean;
  blockingSources: SourceRow[];
  totalMessages: number;
  failingMessages: number;
}

export interface EspVolumeTrend {
  days: string[];
  espNames: string[]; // ordered by total volume desc, capped with "Other" bucket
  series: Record<string, number[]>; // espName -> values aligned with `days`
}

export interface DashboardData {
  trend: TrendPoint[];
  espVolume: EspVolumeTrend;
  sources: SourceRow[];
  enforcement: EnforcementStatus;
  totals: { reports: number; records: number; messages: number; domains: number };
  rangeLabel: string;
  rangeDays: number | null;
  domainFilter: string[] | null;
}

const DAY_SECONDS = 86400;

// Fixed lookback for the enforcement verdict - this should always reflect
// *recent* behavior regardless of what range the user is browsing.
const ENFORCEMENT_WINDOW_DAYS = 30;

export const RANGE_OPTIONS = [7, 30, 90, 365] as const;

type SourceQueryRow = {
  source_ip: string;
  esp_name: string | null;
  ptr_hostname: string | null;
  domain: string;
  total_count: number;
  passed_count: number;
  first_seen: number;
  last_seen: number;
  has_dkim_policy_issue?: number;
  has_spf_policy_issue?: number;
  has_dkim_auth_issue?: number;
  has_spf_auth_issue?: number;
};

function toSourceRows(results: SourceQueryRow[]): SourceRow[] {
  return results.map((r) => {
    const issues: string[] = [];
    if (r.has_dkim_policy_issue) issues.push("DKIM Policy");
    if (r.has_spf_policy_issue) issues.push("SPF Policy");
    if (r.has_dkim_auth_issue) issues.push("DKIM Auth");
    if (r.has_spf_auth_issue) issues.push("SPF Auth");
    return {
      source_ip: r.source_ip,
      esp_name: r.esp_name ?? "Unknown",
      ptr_hostname: r.ptr_hostname,
      domain: r.domain,
      total_count: r.total_count,
      passed_count: r.passed_count,
      pass_rate: r.total_count > 0 ? (r.passed_count / r.total_count) * 100 : 0,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      issues,
    };
  });
}

/** Fills in every day in [startDay, endDay] with 0s, so gaps render as
 * genuine zero-activity days instead of Chart.js silently connecting a
 * line across days that have no data at all. */
function zeroFillTrend(rows: TrendPoint[], startEpoch: number, endEpoch: number): TrendPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: TrendPoint[] = [];
  for (let t = startEpoch; t <= endEpoch; t += DAY_SECONDS) {
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    const existing = byDay.get(day);
    out.push(existing ?? { day, passed: 0, failed: 0 });
  }
  return out;
}

// Cap the number of distinct ESP series drawn on the volume chart - lots of
// one-off unrecognized senders would otherwise produce dozens of thin
// slivers. Anything outside the top N gets folded into "Other".
const MAX_ESP_SERIES = 6;

function buildEspVolumeTrend(
  rows: Array<{ day: string; esp_name: string; total: number }>,
  startEpoch: number,
  endEpoch: number,
): EspVolumeTrend {
  const days: string[] = [];
  for (let t = startEpoch; t <= endEpoch; t += DAY_SECONDS) {
    days.push(new Date(t * 1000).toISOString().slice(0, 10));
  }

  const totalsByEsp = new Map<string, number>();
  for (const r of rows) {
    totalsByEsp.set(r.esp_name, (totalsByEsp.get(r.esp_name) ?? 0) + r.total);
  }
  const ranked = [...totalsByEsp.entries()].sort((a, b) => b[1] - a[1]);
  const topEsps = new Set(ranked.slice(0, MAX_ESP_SERIES).map(([name]) => name));
  const hasOther = ranked.length > MAX_ESP_SERIES;
  const espNames = [...topEsps, ...(hasOther ? ["Other"] : [])];

  const series: Record<string, number[]> = {};
  for (const name of espNames) series[name] = days.map(() => 0);

  const dayIndex = new Map(days.map((d, i) => [d, i]));
  for (const r of rows) {
    const idx = dayIndex.get(r.day);
    if (idx === undefined) continue;
    const bucket = topEsps.has(r.esp_name) ? r.esp_name : "Other";
    series[bucket][idx] += r.total;
  }

  return { days, espNames, series };
}

/** `AND domain IN (?, ?, ...)` when a filter is set, with matching bind
 * params - every query below splices this in consistently. Empty/null
 * filter means "all domains". */
function domainClause(domainFilter: string[] | null): { sql: string; params: string[] } {
  if (!domainFilter || domainFilter.length === 0) return { sql: "", params: [] };
  const placeholders = domainFilter.map(() => "?").join(",");
  return { sql: `AND domain IN (${placeholders})`, params: domainFilter };
}

export async function loadDashboardData(
  db: D1Database,
  rangeDays: number | null,
  domainFilter: string[] | null,
): Promise<DashboardData> {
  const now = Math.floor(Date.now() / 1000);
  const enforcementSince = now - ENFORCEMENT_WINDOW_DAYS * DAY_SECONDS;
  const dc = domainClause(domainFilter);
  const dcPrefixed = dc.sql ? dc.sql.replace("domain", "r.domain") : "";

  const earliestRow = await db
    .prepare(`SELECT MIN(date_begin) as earliest FROM dmarc_records WHERE 1=1 ${dc.sql}`)
    .bind(...dc.params)
    .first<{ earliest: number | null }>();
  const earliest = earliestRow?.earliest ?? now;

  const rangeSince = rangeDays === null ? earliest : Math.max(earliest, now - rangeDays * DAY_SECONDS);

  const sourceColumns = `
           r.source_ip,
           COALESCE(e.esp_name, 'Unknown') as esp_name,
           e.ptr_hostname,
           r.domain,
           SUM(r.count) as total_count,
           SUM(CASE WHEN r.policy_dkim='pass' OR r.policy_spf='pass' THEN r.count ELSE 0 END) as passed_count,
           MIN(r.date_begin) as first_seen,
           MAX(r.date_begin) as last_seen,
           MAX(CASE WHEN r.policy_dkim IS NOT NULL AND r.policy_dkim != 'pass' THEN 1 ELSE 0 END) as has_dkim_policy_issue,
           MAX(CASE WHEN r.policy_spf IS NOT NULL AND r.policy_spf != 'pass' THEN 1 ELSE 0 END) as has_spf_policy_issue,
           MAX(CASE WHEN r.auth_dkim_result IS NOT NULL AND r.auth_dkim_result != 'pass' THEN 1 ELSE 0 END) as has_dkim_auth_issue,
           MAX(CASE WHEN r.auth_spf_result IS NOT NULL AND r.auth_spf_result != 'pass' THEN 1 ELSE 0 END) as has_spf_auth_issue`;

  const [trendRes, espVolumeRes, sourcesRes, policyRes, enforcementRes, totalsRes] = await Promise.all([
    db
      .prepare(
        `SELECT
           date(date_begin, 'unixepoch') as day,
           SUM(CASE WHEN policy_dkim='pass' OR policy_spf='pass' THEN count ELSE 0 END) as passed,
           SUM(CASE WHEN NOT (policy_dkim='pass' OR policy_spf='pass') THEN count ELSE 0 END) as failed
         FROM dmarc_records
         WHERE date_begin >= ? ${dc.sql}
         GROUP BY day
         ORDER BY day ASC`,
      )
      .bind(rangeSince, ...dc.params)
      .all<{ day: string; passed: number; failed: number }>(),

    db
      .prepare(
        `SELECT
           date(r.date_begin, 'unixepoch') as day,
           COALESCE(e.esp_name, 'Unknown') as esp_name,
           SUM(r.count) as total
         FROM dmarc_records r
         LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
         WHERE r.date_begin >= ? ${dcPrefixed}
         GROUP BY day, esp_name
         ORDER BY day ASC`,
      )
      .bind(rangeSince, ...dc.params)
      .all<{ day: string; esp_name: string; total: number }>(),

    db
      .prepare(
        `SELECT ${sourceColumns}
         FROM dmarc_records r
         LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
         WHERE r.date_begin >= ? ${dcPrefixed}
         GROUP BY r.source_ip, r.domain
         ORDER BY total_count DESC`,
      )
      .bind(rangeSince, ...dc.params)
      .all<SourceQueryRow>(),

    db
      .prepare(
        `SELECT policy_p, domain FROM dmarc_reports WHERE 1=1 ${dc.sql} ORDER BY date_end DESC LIMIT 1`,
      )
      .bind(...dc.params)
      .first<{ policy_p: string; domain: string }>(),

    db
      .prepare(
        `SELECT ${sourceColumns}
         FROM dmarc_records r
         LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
         WHERE r.date_begin >= ? ${dcPrefixed}
         GROUP BY r.source_ip, r.domain`,
      )
      .bind(enforcementSince, ...dc.params)
      .all<SourceQueryRow>(),

    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM dmarc_reports WHERE 1=1 ${dc.sql}) as reports,
           (SELECT COUNT(*) FROM dmarc_records WHERE 1=1 ${dc.sql}) as records,
           (SELECT COALESCE(SUM(count), 0) FROM dmarc_records WHERE 1=1 ${dc.sql}) as messages,
           (SELECT COUNT(DISTINCT domain) FROM dmarc_records WHERE 1=1 ${dc.sql}) as domains`,
      )
      .bind(...dc.params, ...dc.params, ...dc.params, ...dc.params)
      .first<{ reports: number; records: number; messages: number; domains: number }>(),
  ]);

  const windowRows = toSourceRows(enforcementRes.results);
  const blockingSources = windowRows.filter((r) => r.pass_rate < 100);
  const totalMessages = windowRows.reduce((sum, r) => sum + r.total_count, 0);
  const failingMessages = windowRows.reduce((sum, r) => sum + (r.total_count - r.passed_count), 0);

  return {
    trend: zeroFillTrend(trendRes.results, rangeSince, now),
    espVolume: buildEspVolumeTrend(espVolumeRes.results, rangeSince, now),
    sources: toSourceRows(sourcesRes.results),
    enforcement: {
      currentPolicy: policyRes?.policy_p ?? null,
      domain: policyRes?.domain ?? (domainFilter?.length === 1 ? domainFilter[0] : null),
      windowDays: ENFORCEMENT_WINDOW_DAYS,
      ready: windowRows.length > 0 && blockingSources.length === 0,
      blockingSources,
      totalMessages,
      failingMessages,
    },
    totals: totalsRes ?? { reports: 0, records: 0, messages: 0, domains: 0 },
    rangeLabel: rangeDays === null ? "All time" : `Last ${rangeDays} days`,
    rangeDays,
    domainFilter,
  };
}
