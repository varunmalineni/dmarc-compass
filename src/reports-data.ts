import { deriveIssues } from "./shared-ui";

export interface ReportListItem {
  hash: string;
  report_id: string;
  org_name: string;
  domain: string;
  date_begin: number;
  date_end: number;
  records: number;
  flagged_dkim: boolean;
  flagged_spf: boolean;
}

export async function loadReportsList(
  db: D1Database,
  filter: "all" | "dkim" | "spf" | "dmarc",
  domainFilter: string | null,
): Promise<ReportListItem[]> {
  const dc = domainFilter ? "AND rep.domain = ?" : "";
  const res = await db
    .prepare(
      `SELECT
         rep.hash, rep.report_id, rep.org_name, rep.domain, rep.date_begin, rep.date_end,
         COUNT(rec.id) as records,
         MAX(CASE WHEN rec.policy_dkim IS NOT NULL AND rec.policy_dkim != 'pass' THEN 1 ELSE 0 END) as flagged_dkim,
         MAX(CASE WHEN rec.policy_spf IS NOT NULL AND rec.policy_spf != 'pass' THEN 1 ELSE 0 END) as flagged_spf
       FROM dmarc_reports rep
       LEFT JOIN dmarc_records rec ON rec.report_hash = rep.hash
       WHERE 1=1 ${dc}
       GROUP BY rep.hash
       ORDER BY rep.date_end DESC`,
    )
    .bind(...(domainFilter ? [domainFilter] : []))
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
    }>();

  const rows = res.results.map((r) => ({
    hash: r.hash,
    report_id: r.report_id,
    org_name: r.org_name,
    domain: r.domain,
    date_begin: r.date_begin,
    date_end: r.date_end,
    records: r.records,
    flagged_dkim: !!r.flagged_dkim,
    flagged_spf: !!r.flagged_spf,
  }));

  if (filter === "dkim") return rows.filter((r) => r.flagged_dkim);
  if (filter === "spf") return rows.filter((r) => r.flagged_spf);
  if (filter === "dmarc") return rows.filter((r) => r.flagged_dkim || r.flagged_spf);
  return rows;
}

export interface ReportDetailRecord {
  source_ip: string;
  esp_name: string;
  ptr_hostname: string | null;
  count: number;
  disposition: string;
  policy_dkim: string | null;
  policy_spf: string | null;
  auth_dkim_result: string | null;
  auth_spf_result: string | null;
  header_from: string;
  issues: string[];
}

export interface ReportDetail {
  hash: string;
  report_id: string;
  org_name: string;
  domain: string;
  date_begin: number;
  date_end: number;
  policy_p: string;
  policy_pct: number | null;
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
      `SELECT
         r.source_ip, r.count, r.disposition, r.policy_dkim, r.policy_spf,
         r.auth_dkim_result, r.auth_spf_result, r.header_from,
         COALESCE(e.esp_name, 'Unknown') as esp_name, e.ptr_hostname
       FROM dmarc_records r
       LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
       WHERE r.report_hash = ?
       ORDER BY r.count DESC`,
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
      esp_name: string | null;
      ptr_hostname: string | null;
    }>();

  return {
    ...header,
    records: recs.results.map((r) => ({
      source_ip: r.source_ip,
      esp_name: r.esp_name ?? "Unknown",
      ptr_hostname: r.ptr_hostname,
      count: r.count,
      disposition: r.disposition,
      policy_dkim: r.policy_dkim,
      policy_spf: r.policy_spf,
      auth_dkim_result: r.auth_dkim_result,
      auth_spf_result: r.auth_spf_result,
      header_from: r.header_from,
      issues: deriveIssues(r),
    })),
  };
}
