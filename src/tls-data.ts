import { domainFilter, sinceEpoch, type Filters } from "./filters";

const LIMIT = 100;

export interface TlsData {
  reports: number;
  success: number;
  failure: number;
  byDomain: Array<{ domain: string; policyType: string; success: number; failure: number }>;
  byDomainTotal: number;
  failures: Array<{
    resultType: string;
    ip: string | null;
    mx: string | null;
    sessions: number;
    domain: string;
    at: number;
  }>;
}

export async function loadTls(db: D1Database, f: Filters): Promise<TlsData> {
  const since = sinceEpoch(f.range);
  const dc = domainFilter("p.policy_domain", f);

  const [totals, byDomain, byDomainCount, failures] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(DISTINCT p.report_hash) AS reports, COALESCE(SUM(p.successful_count), 0) AS success,
                COALESCE(SUM(p.failure_count), 0) AS failure
           FROM tls_policy_results p WHERE p.date_begin >= ?${dc.sql}`,
      )
      .bind(since, ...dc.params)
      .first<{ reports: number; success: number; failure: number }>(),
    db
      .prepare(
        `SELECT p.policy_domain AS domain, p.policy_type AS type, SUM(p.successful_count) AS success, SUM(p.failure_count) AS failure
           FROM tls_policy_results p WHERE p.date_begin >= ?${dc.sql}
          GROUP BY p.policy_domain, p.policy_type ORDER BY failure DESC, success DESC LIMIT ${LIMIT}`,
      )
      .bind(since, ...dc.params)
      .all<{ domain: string; type: string; success: number; failure: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM tls_policy_results p WHERE p.date_begin >= ?${dc.sql} GROUP BY p.policy_domain, p.policy_type)`,
      )
      .bind(since, ...dc.params)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT d.result_type AS type, d.sending_mta_ip AS ip, d.receiving_mx_hostname AS mx,
                d.failed_session_count AS sessions, p.policy_domain AS domain, p.date_begin AS at
           FROM tls_failure_details d JOIN tls_policy_results p ON p.id = d.policy_result_id
          WHERE p.date_begin >= ?${dc.sql} ORDER BY p.date_begin DESC LIMIT ${LIMIT}`,
      )
      .bind(since, ...dc.params)
      .all<{ type: string; ip: string | null; mx: string | null; sessions: number; domain: string; at: number }>(),
  ]);

  return {
    reports: totals?.reports ?? 0,
    success: totals?.success ?? 0,
    failure: totals?.failure ?? 0,
    byDomainTotal: byDomainCount?.n ?? 0,
    byDomain: byDomain.results.map((r) => ({ domain: r.domain, policyType: r.type, success: r.success, failure: r.failure })),
    failures: failures.results.map((r) => ({
      resultType: r.type,
      ip: r.ip,
      mx: r.mx,
      sessions: r.sessions,
      domain: r.domain,
      at: r.at,
    })),
  };
}

export const TLS_LIMIT = LIMIT;
