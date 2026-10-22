export interface TlsDomainSummary {
  policyDomain: string;
  policyType: string;
  totalSuccess: number;
  totalFailure: number;
}

export interface TlsFailureRow {
  resultType: string;
  sendingMtaIp: string | null;
  receivingMxHostname: string | null;
  failedSessionCount: number;
  policyDomain: string;
  dateBegin: number;
}

export interface TlsData {
  totalReports: number;
  totalSuccess: number;
  totalFailure: number;
  byDomain: TlsDomainSummary[];
  recentFailures: TlsFailureRow[];
}

export async function loadTlsData(db: D1Database, domainFilter: string | null): Promise<TlsData> {
  const dc = domainFilter ? "AND policy_domain = ?" : "";
  const params = domainFilter ? [domainFilter] : [];

  const [totalsRow, byDomainRes, failuresRes] = await Promise.all([
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM tls_reports) as total_reports,
           (SELECT COALESCE(SUM(successful_count), 0) FROM tls_policy_results WHERE 1=1 ${dc}) as total_success,
           (SELECT COALESCE(SUM(failure_count), 0) FROM tls_policy_results WHERE 1=1 ${dc}) as total_failure`,
      )
      .bind(...params, ...params)
      .first<{ total_reports: number; total_success: number; total_failure: number }>(),

    db
      .prepare(
        `SELECT policy_domain, policy_type,
           SUM(successful_count) as total_success, SUM(failure_count) as total_failure
         FROM tls_policy_results
         WHERE 1=1 ${dc}
         GROUP BY policy_domain, policy_type
         ORDER BY total_failure DESC, total_success DESC`,
      )
      .bind(...params)
      .all<{ policy_domain: string; policy_type: string; total_success: number; total_failure: number }>(),

    db
      .prepare(
        `SELECT f.result_type, f.sending_mta_ip, f.receiving_mx_hostname, f.failed_session_count,
                p.policy_domain, p.date_begin
         FROM tls_failure_details f
         JOIN tls_policy_results p ON p.id = f.policy_result_id
         WHERE 1=1 ${domainFilter ? "AND p.policy_domain = ?" : ""}
         ORDER BY p.date_begin DESC
         LIMIT 100`,
      )
      .bind(...params)
      .all<{
        result_type: string;
        sending_mta_ip: string | null;
        receiving_mx_hostname: string | null;
        failed_session_count: number;
        policy_domain: string;
        date_begin: number;
      }>(),
  ]);

  return {
    totalReports: totalsRow?.total_reports ?? 0,
    totalSuccess: totalsRow?.total_success ?? 0,
    totalFailure: totalsRow?.total_failure ?? 0,
    byDomain: byDomainRes.results.map((r) => ({
      policyDomain: r.policy_domain,
      policyType: r.policy_type,
      totalSuccess: r.total_success,
      totalFailure: r.total_failure,
    })),
    recentFailures: failuresRes.results.map((r) => ({
      resultType: r.result_type,
      sendingMtaIp: r.sending_mta_ip,
      receivingMxHostname: r.receiving_mx_hostname,
      failedSessionCount: r.failed_session_count,
      policyDomain: r.policy_domain,
      dateBegin: r.date_begin,
    })),
  };
}
