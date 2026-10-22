import { domainFilter, likePattern, sinceEpoch, type Filters, type ListState } from "./filters";
import { deriveIssues } from "./shared-ui";

export const REPORTS_PAGE_SIZE = 25;
export type ReportFilter = "all" | "dkim" | "spf" | "any";
export const REPORT_FILTERS: ReportFilter[] = ["all", "dkim", "spf", "any"];

const SORTS: Record<string, string> = {
  date: "rep.date_end",
  org: "rep.org_name COLLATE NOCASE",
  domain: "rep.domain COLLATE NOCASE",
  records: "records",
};
export const REPORT_SORT_KEYS = Object.keys(SORTS);

export interface ReportListItem {
  hash: string;
  reportId: string;
  org: string;
  domain: string;
  dateBegin: number;
  dateEnd: number;
  records: number;
  flaggedDkim: boolean;
  flaggedSpf: boolean;
}

export async function loadReportsList(
  db: D1Database,
  f: Filters,
  list: ListState,
  filter: ReportFilter,
): Promise<{ rows: ReportListItem[]; total: number }> {
  const since = sinceEpoch(f.range);
  const dc = domainFilter("rep.domain", f);
  const q = list.q ? likePattern(list.q) : null;
  const searchSql = q ? " AND (rep.report_id LIKE ? ESCAPE '\\' OR rep.org_name LIKE ? ESCAPE '\\')" : "";
  const having =
    filter === "dkim" ? " HAVING flagged_dkim = 1" : filter === "spf" ? " HAVING flagged_spf = 1" : filter === "any" ? " HAVING (flagged_dkim = 1 OR flagged_spf = 1)" : "";

  const base = `FROM dmarc_reports rep LEFT JOIN dmarc_records rec ON rec.report_hash = rep.hash
     WHERE rep.date_end >= ?${dc.sql}${searchSql}
     GROUP BY rep.hash${having}`;
  const params = [since, ...dc.params, ...(q ? [q, q] : [])];
  const order = SORTS[list.sort] ?? SORTS.date;
  const dir = list.dir === "asc" ? "ASC" : "DESC";

  const [rows, count] = await Promise.all([
    db
      .prepare(
        `SELECT rep.hash, rep.report_id, rep.org_name, rep.domain, rep.date_begin, rep.date_end,
                COUNT(rec.id) AS records,
                MAX(CASE WHEN rec.policy_dkim IS NOT NULL AND rec.policy_dkim != 'pass' THEN 1 ELSE 0 END) AS flagged_dkim,
                MAX(CASE WHEN rec.policy_spf IS NOT NULL AND rec.policy_spf != 'pass' THEN 1 ELSE 0 END) AS flagged_spf
           ${base} ORDER BY ${order} ${dir}, rep.hash LIMIT ? OFFSET ?`,
      )
      .bind(...params, REPORTS_PAGE_SIZE, (list.page - 1) * REPORTS_PAGE_SIZE)
      .all<{
        hash: string;
        report_id: string;
        org_name: string;
        domain: string;
        date_begin: number;
        date_end: number;
        records: number;
        flagged_dkim: number;
        flagged_spf: number;
      }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT rep.hash,
            MAX(CASE WHEN rec.policy_dkim IS NOT NULL AND rec.policy_dkim != 'pass' THEN 1 ELSE 0 END) AS flagged_dkim,
            MAX(CASE WHEN rec.policy_spf IS NOT NULL AND rec.policy_spf != 'pass' THEN 1 ELSE 0 END) AS flagged_spf
            ${base})`,
      )
      .bind(...params)
      .first<{ n: number }>(),
  ]);

  return {
    total: count?.n ?? 0,
    rows: rows.results.map((r) => ({
      hash: r.hash,
      reportId: r.report_id,
      org: r.org_name,
      domain: r.domain,
      dateBegin: r.date_begin,
      dateEnd: r.date_end,
      records: r.records,
      flaggedDkim: !!r.flagged_dkim,
      flaggedSpf: !!r.flagged_spf,
    })),
  };
}

export interface ReportDetailRecord {
  ip: string;
  esp: string;
  ptr: string | null;
  count: number;
  disposition: string;
  policyDkim: string | null;
  policySpf: string | null;
  authDkim: string | null;
  authSpf: string | null;
  headerFrom: string;
  issues: string[];
}

export interface ReportDetail {
  hash: string;
  reportId: string;
  org: string;
  domain: string;
  dateBegin: number;
  dateEnd: number;
  policy: string;
  pct: number | null;
  records: ReportDetailRecord[];
}

export async function loadReportDetail(db: D1Database, hash: string): Promise<ReportDetail | null> {
  const header = await db
    .prepare(`SELECT * FROM dmarc_reports WHERE hash = ?`)
    .bind(hash)
    .first<{
      hash: string;
      report_id: string;
      org_name: string;
      domain: string;
      date_begin: number;
      date_end: number;
      policy_p: string;
      policy_pct: number | null;
    }>();
  if (!header) return null;

  const recs = await db
    .prepare(
      `SELECT r.source_ip, r.count, r.disposition, r.policy_dkim, r.policy_spf, r.auth_dkim_result, r.auth_spf_result,
              r.header_from, COALESCE(e.esp_name, 'Unknown') AS esp_name, e.ptr_hostname
         FROM dmarc_records r LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
        WHERE r.report_hash = ? ORDER BY r.count DESC`,
    )
    .bind(hash)
    .all<{
      source_ip: string;
      count: number;
      disposition: string;
      policy_dkim: string | null;
      policy_spf: string | null;
      auth_dkim_result: string | null;
      auth_spf_result: string | null;
      header_from: string;
      esp_name: string;
      ptr_hostname: string | null;
    }>();

  return {
    hash: header.hash,
    reportId: header.report_id,
    org: header.org_name,
    domain: header.domain,
    dateBegin: header.date_begin,
    dateEnd: header.date_end,
    policy: header.policy_p,
    pct: header.policy_pct,
    records: recs.results.map((r) => ({
      ip: r.source_ip,
      esp: r.esp_name,
      ptr: r.ptr_hostname,
      count: r.count,
      disposition: r.disposition,
      policyDkim: r.policy_dkim,
      policySpf: r.policy_spf,
      authDkim: r.auth_dkim_result,
      authSpf: r.auth_spf_result,
      headerFrom: r.header_from,
      issues: deriveIssues(r),
    })),
  };
}
