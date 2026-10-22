// Multi-domain overview - the landing page once more than one domain
// shows up in the data. Built domain-aware from day one since production
// will have 1500+ domains.

export interface DomainSummary {
  domain: string;
  total_count: number;
  passed_count: number;
  pass_rate: number;
  distinct_sources: number;
  last_report_at: number;
  current_policy: string | null;
}

export async function loadDomainsOverview(db: D1Database): Promise<DomainSummary[]> {
  const res = await db
    .prepare(
      `SELECT
         domain,
         SUM(count) as total_count,
         SUM(CASE WHEN policy_dkim='pass' OR policy_spf='pass' THEN count ELSE 0 END) as passed_count,
         COUNT(DISTINCT source_ip) as distinct_sources,
         MAX(date_begin) as last_report_at
       FROM dmarc_records
       GROUP BY domain
       ORDER BY total_count DESC`,
    )
    .all<{
      domain: string;
      total_count: number;
      passed_count: number;
      distinct_sources: number;
      last_report_at: number;
    }>();

  const policyRows = await db
    .prepare(
      `SELECT domain, policy_p FROM dmarc_reports r1
       WHERE date_end = (SELECT MAX(date_end) FROM dmarc_reports r2 WHERE r2.domain = r1.domain)`,
    )
    .all<{ domain: string; policy_p: string }>();
  const policyByDomain = new Map(policyRows.results.map((r) => [r.domain, r.policy_p]));

  return res.results.map((r) => ({
    domain: r.domain,
    total_count: r.total_count,
    passed_count: r.passed_count,
    pass_rate: r.total_count > 0 ? (r.passed_count / r.total_count) * 100 : 0,
    distinct_sources: r.distinct_sources,
    last_report_at: r.last_report_at,
    current_policy: policyByDomain.get(r.domain) ?? null,
  }));
}

export async function loadAllDomainNames(db: D1Database): Promise<string[]> {
  const res = await db.prepare(`SELECT DISTINCT domain FROM dmarc_records ORDER BY domain ASC`).all<{
    domain: string;
  }>();
  return res.results.map((r) => r.domain);
}
