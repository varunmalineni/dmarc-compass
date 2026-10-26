// Overview page data. Every query takes the global Filters (domains + time
// range); the domain list is passed to SQL as a single JSON parameter so the
// number of selected domains never hits D1's bound-parameter limit.

import { domainFilter, likePattern, recordsByDate, sinceEpoch, type Filters, type ListState } from "./filters";

const DAY = 86400;
const ENFORCEMENT_DAYS = 30;
const MAX_ESP_SERIES = 6;
export const SOURCES_PAGE_SIZE = 15;

/** A record passed DMARC if either aligned mechanism passed. */
const PASS = "(r.policy_dkim = 'pass' OR r.policy_spf = 'pass')";
const PASSED = `SUM(CASE WHEN ${PASS} THEN r.count ELSE 0 END)`;
const FAILED = `SUM(CASE WHEN ${PASS} THEN 0 ELSE r.count END)`;

export interface WindowTotals {
  total: number;
  passed: number;
  sources: number;
  domains: number;
  firstAt: number | null;
}

export interface SourceRow {
  ip: string;
  esp: string;
  ptr: string | null;
  domains: number;
  total: number;
  passed: number;
  rate: number;
  lastSeen: number;
  issues: string[];
}

export interface EnforcementData {
  windowDays: number;
  domainsWithTraffic: number;
  ready: number;
  nearly: number;
  attention: number;
  totalMessages: number;
  failingMessages: number;
  policyMix: { none: number; quarantine: number; reject: number };
  blocking: Array<{ ip: string; esp: string; failing: number; total: number; domains: number }>;
}

export interface Overview {
  current: WindowTotals;
  previous: WindowTotals | null;
  failingSources: number;
  reports: { count: number; latest: number | null };
  trend: { days: string[]; passed: number[]; failed: number[] };
  esp: { days: string[]; names: string[]; series: Record<string, number[]>; totals: Record<string, number> };
  sources: { rows: SourceRow[]; total: number };
  enforcement: EnforcementData;
}

const SOURCE_SORTS: Record<string, string> = {
  risk: "(total_count - passed_count) DESC, total_count DESC",
  messages: "total_count",
  rate: "(passed_count * 1.0 / NULLIF(total_count, 0))",
  seen: "last_seen",
  sender: "esp_name COLLATE NOCASE",
  ip: "r.source_ip",
  domains: "domains",
};
export const SOURCE_SORT_KEYS = Object.keys(SOURCE_SORTS);

function dayStrings(startEpoch: number, endEpoch: number): string[] {
  const days: string[] = [];
  for (let t = Math.floor(startEpoch / DAY) * DAY; t <= endEpoch; t += DAY) {
    days.push(new Date(t * 1000).toISOString().slice(0, 10));
  }
  return days;
}

async function windowTotals(db: D1Database, f: Filters, from: number, to: number): Promise<WindowTotals> {
  const dc = domainFilter("r.domain", f);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(r.count), 0) AS total,
              COALESCE(${PASSED}, 0) AS passed,
              COUNT(DISTINCT r.source_ip) AS sources,
              COUNT(DISTINCT r.domain) AS domains,
              MIN(r.date_begin) AS first_at
         FROM dmarc_records r${recordsByDate(f)}
        WHERE r.date_begin >= ? AND r.date_begin < ?${dc.sql}`,
    )
    .bind(from, to, ...dc.params)
    .first<{ total: number; passed: number; sources: number; domains: number; first_at: number | null }>();
  return {
    total: row?.total ?? 0,
    passed: row?.passed ?? 0,
    sources: row?.sources ?? 0,
    domains: row?.domains ?? 0,
    firstAt: row?.first_at ?? null,
  };
}

function buildEsp(
  rows: Array<{ day: string; esp: string; total: number }>,
  days: string[],
): Overview["esp"] {
  const totals: Record<string, number> = {};
  for (const r of rows) totals[r.esp] = (totals[r.esp] ?? 0) + r.total;
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const top = new Set(ranked.slice(0, MAX_ESP_SERIES).map(([n]) => n));
  const names = [...top, ...(ranked.length > MAX_ESP_SERIES ? ["Other"] : [])];
  const series: Record<string, number[]> = {};
  for (const n of names) series[n] = days.map(() => 0);
  const index = new Map(days.map((d, i) => [d, i]));
  for (const r of rows) {
    const i = index.get(r.day);
    if (i !== undefined) series[top.has(r.esp) ? r.esp : "Other"][i] += r.total;
  }
  return { days, names, series, totals };
}

export async function loadOverview(
  db: D1Database,
  f: Filters,
  list: ListState,
): Promise<Overview> {
  const now = Math.floor(Date.now() / 1000);
  const since = sinceEpoch(f.range, now);
  const to = now + DAY;
  const dc = domainFilter("r.domain", f);

  const [current, previous] = await Promise.all([
    windowTotals(db, f, since, to),
    f.range === null ? Promise.resolve(null) : windowTotals(db, f, since - f.range * DAY, since),
  ]);

  const trendStart = f.range === null ? (current.firstAt ?? now) : since;
  const days = dayStrings(trendStart, now);

  // sources list: shared FROM/WHERE so the page query and the count agree
  const IDX = recordsByDate(f);
  const q = list.q ? likePattern(list.q) : null;
  const searchSql = q
    ? " AND (r.source_ip LIKE ? ESCAPE '\\' OR e.esp_name LIKE ? ESCAPE '\\' OR e.ptr_hostname LIKE ? ESCAPE '\\')"
    : "";
  const searchParams = q ? [q, q, q] : [];
  const sourcesFrom = `FROM dmarc_records r${IDX} LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
        WHERE r.date_begin >= ? AND r.date_begin < ?${dc.sql}${searchSql}`;
  const sourcesParams = [since, to, ...dc.params, ...searchParams];
  const orderBy = SOURCE_SORTS[list.sort] ?? SOURCE_SORTS.risk;
  const dirSql = list.sort === "risk" ? "" : list.dir === "asc" ? " ASC" : " DESC";

  const enfSince = now - ENFORCEMENT_DAYS * DAY;
  const enfDc = domainFilter("r.domain", f);
  const policyDc = domainFilter("rep.domain", f);

  const [failingSrc, reports, trendRows, espRows, sourceRows, sourceCount, perDomain, policies, blocking] =
    await Promise.all([
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT r.source_ip FROM dmarc_records r${IDX}
              WHERE r.date_begin >= ? AND r.date_begin < ?${dc.sql}
              GROUP BY r.source_ip HAVING ${FAILED} > 0)`,
        )
        .bind(since, to, ...dc.params)
        .first<{ n: number }>(),
      db
        .prepare(
          `SELECT COUNT(*) AS n, MAX(r.date_end) AS latest FROM dmarc_reports r
            WHERE r.date_begin >= ? AND r.date_begin < ?${dc.sql}`,
        )
        .bind(since, to, ...dc.params)
        .first<{ n: number; latest: number | null }>(),
      db
        .prepare(
          `SELECT date(r.date_begin, 'unixepoch') AS day, ${PASSED} AS passed, ${FAILED} AS failed
             FROM dmarc_records r${IDX} WHERE r.date_begin >= ? AND r.date_begin < ?${dc.sql} GROUP BY day`,
        )
        .bind(since, to, ...dc.params)
        .all<{ day: string; passed: number; failed: number }>(),
      db
        .prepare(
          `SELECT date(r.date_begin, 'unixepoch') AS day, COALESCE(e.esp_name, 'Unknown') AS esp, SUM(r.count) AS total
             FROM dmarc_records r${IDX} LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
            WHERE r.date_begin >= ? AND r.date_begin < ?${dc.sql} GROUP BY day, esp`,
        )
        .bind(since, to, ...dc.params)
        .all<{ day: string; esp: string; total: number }>(),
      db
        .prepare(
          `SELECT r.source_ip AS ip, COALESCE(e.esp_name, 'Unknown') AS esp_name, e.ptr_hostname AS ptr,
                  COUNT(DISTINCT r.domain) AS domains, SUM(r.count) AS total_count, ${PASSED} AS passed_count,
                  MAX(r.date_begin) AS last_seen,
                  MAX(CASE WHEN r.policy_dkim IS NOT NULL AND r.policy_dkim != 'pass' THEN 1 ELSE 0 END) AS i_dkim_policy,
                  MAX(CASE WHEN r.policy_spf IS NOT NULL AND r.policy_spf != 'pass' THEN 1 ELSE 0 END) AS i_spf_policy,
                  MAX(CASE WHEN r.auth_dkim_result IS NOT NULL AND r.auth_dkim_result != 'pass' THEN 1 ELSE 0 END) AS i_dkim_auth,
                  MAX(CASE WHEN r.auth_spf_result IS NOT NULL AND r.auth_spf_result != 'pass' THEN 1 ELSE 0 END) AS i_spf_auth
             ${sourcesFrom}
            GROUP BY r.source_ip
            ORDER BY ${orderBy}${dirSql}, r.source_ip
            LIMIT ? OFFSET ?`,
        )
        .bind(...sourcesParams, SOURCES_PAGE_SIZE, (list.page - 1) * SOURCES_PAGE_SIZE)
        .all<{
          ip: string;
          esp_name: string;
          ptr: string | null;
          domains: number;
          total_count: number;
          passed_count: number;
          last_seen: number;
          i_dkim_policy: number;
          i_spf_policy: number;
          i_dkim_auth: number;
          i_spf_auth: number;
        }>(),
      db
        .prepare(`SELECT COUNT(*) AS n FROM (SELECT r.source_ip ${sourcesFrom} GROUP BY r.source_ip)`)
        .bind(...sourcesParams)
        .first<{ n: number }>(),
      // enforcement: last 30 days regardless of the selected range
      db
        .prepare(
          `SELECT r.domain AS domain, SUM(r.count) AS total, ${FAILED} AS failing
             FROM dmarc_records r${IDX} WHERE r.date_begin >= ?${enfDc.sql} GROUP BY r.domain`,
        )
        .bind(enfSince, ...enfDc.params)
        .all<{ domain: string; total: number; failing: number }>(),
      db
        .prepare(
          `SELECT rep.domain AS domain, MAX(rep.policy_p) AS policy
             FROM dmarc_reports rep
             JOIN (SELECT domain, MAX(date_end) AS m FROM dmarc_reports GROUP BY domain) x
               ON x.domain = rep.domain AND x.m = rep.date_end
            WHERE 1 = 1${policyDc.sql}
            GROUP BY rep.domain`,
        )
        .bind(...policyDc.params)
        .all<{ domain: string; policy: string | null }>(),
      db
        .prepare(
          `SELECT r.source_ip AS ip, COALESCE(e.esp_name, 'Unknown') AS esp, ${FAILED} AS failing,
                  SUM(r.count) AS total, COUNT(DISTINCT r.domain) AS domains
             FROM dmarc_records r${IDX} LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
            WHERE r.date_begin >= ?${enfDc.sql}
            GROUP BY r.source_ip HAVING ${FAILED} > 0
            ORDER BY failing DESC LIMIT 6`,
        )
        .bind(enfSince, ...enfDc.params)
        .all<{ ip: string; esp: string; failing: number; total: number; domains: number }>(),
    ]);

  const byDay = new Map(trendRows.results.map((r) => [r.day, r]));

  let ready = 0;
  let nearly = 0;
  let attention = 0;
  let totalMessages = 0;
  let failingMessages = 0;
  for (const d of perDomain.results) {
    totalMessages += d.total;
    failingMessages += d.failing;
    if (d.failing === 0) ready++;
    else if (d.failing / d.total < 0.01) nearly++;
    else attention++;
  }
  const policyMix = { none: 0, quarantine: 0, reject: 0 };
  for (const p of policies.results) {
    if (p.policy === "reject") policyMix.reject++;
    else if (p.policy === "quarantine") policyMix.quarantine++;
    else policyMix.none++;
  }

  return {
    current,
    previous,
    failingSources: failingSrc?.n ?? 0,
    reports: { count: reports?.n ?? 0, latest: reports?.latest ?? null },
    trend: {
      days,
      passed: days.map((d) => byDay.get(d)?.passed ?? 0),
      failed: days.map((d) => byDay.get(d)?.failed ?? 0),
    },
    esp: buildEsp(espRows.results, days),
    sources: {
      total: sourceCount?.n ?? 0,
      rows: sourceRows.results.map((r) => ({
        ip: r.ip,
        esp: r.esp_name,
        ptr: r.ptr,
        domains: r.domains,
        total: r.total_count,
        passed: r.passed_count,
        rate: r.total_count > 0 ? (r.passed_count / r.total_count) * 100 : 0,
        lastSeen: r.last_seen,
        issues: [
          ...(r.i_dkim_policy ? ["DKIM policy"] : []),
          ...(r.i_spf_policy ? ["SPF policy"] : []),
          ...(r.i_dkim_auth ? ["DKIM auth"] : []),
          ...(r.i_spf_auth ? ["SPF auth"] : []),
        ],
      })),
    },
    enforcement: {
      windowDays: ENFORCEMENT_DAYS,
      domainsWithTraffic: perDomain.results.length,
      ready,
      nearly,
      attention,
      totalMessages,
      failingMessages,
      policyMix,
      blocking: blocking.results,
    },
  };
}
