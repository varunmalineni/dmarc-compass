// Domains page data. The per-domain aggregate is computed in one query and
// sorted/searched/paginated in memory: even at several thousand domains that
// is a few hundred KB of rows, and it lets us sort on derived values (risk,
// readiness) that SQL pagination can't.

import { effectiveTags, loadTagData, loadColors, countTags, ruleTags } from "./tags.ts";
import { domainFilter, recordsByDate, sinceEpoch, type Filters, type ListState } from "./filters.ts";
import { getLastSync } from "./app-settings.ts";
import type { Chrome } from "./shared-ui.ts";

const DAY = 86400;
export const DOMAINS_PAGE_SIZE = 20;

const PASS = "(r.policy_dkim = 'pass' OR r.policy_spf = 'pass')";

export type DomainStatus = "enforced" | "ready" | "attention" | "idle";

export interface DomainRow {
  domain: string;
  policy: "none" | "quarantine" | "reject" | null;
  total: number;
  passed: number;
  failing: number;
  rate: number;
  sources: number;
  lastReportAt: number | null;
  status: DomainStatus;
  /** Every tag the domain has, by hand or from a rule. */
  tags: string[];
  /** The ones that come only from a rule, so they can't be removed from the domain by hand. */
  autoTags: string[];
}

export interface DomainsData {
  rows: DomainRow[];
  total: number;
  summary: { domains: number; enforced: number; ready: number; attention: number; idle: number };
}

export const DOMAIN_SORT_KEYS = ["risk", "domain", "policy", "messages", "rate", "sources", "last"] as const;

const STRICTNESS: Record<string, number> = { none: 0, quarantine: 1, reject: 2 };

function asPolicy(p: string | null): DomainRow["policy"] {
  return p === "reject" || p === "quarantine" || p === "none" ? p : null;
}

export async function loadDomains(
  db: D1Database,
  f: Filters,
  list: ListState,
  opts: { all?: boolean } = {},
): Promise<DomainsData> {
  const now = Math.floor(Date.now() / 1000);
  const since = sinceEpoch(f.range, now);
  const rc = domainFilter("r.domain", f);
  const repDc = domainFilter("rep.domain", f);

  const [traffic, reports, policies] = await Promise.all([
    db
      .prepare(
        `SELECT r.domain AS domain, SUM(r.count) AS total,
                SUM(CASE WHEN ${PASS} THEN r.count ELSE 0 END) AS passed,
                COUNT(DISTINCT r.source_ip) AS sources
           FROM dmarc_records r${recordsByDate(f)} WHERE r.date_begin >= ? AND r.date_begin < ?${rc.sql} GROUP BY r.domain`,
      )
      .bind(since, now + DAY, ...rc.params)
      .all<{ domain: string; total: number; passed: number; sources: number }>(),
    db
      .prepare(`SELECT rep.domain AS domain, MAX(rep.date_end) AS last FROM dmarc_reports rep WHERE 1 = 1${repDc.sql} GROUP BY rep.domain`)
      .bind(...repDc.params)
      .all<{ domain: string; last: number }>(),
    db
      .prepare(
        `SELECT rep.domain AS domain, MAX(rep.policy_p) AS policy
           FROM dmarc_reports rep
           JOIN (SELECT domain, MAX(date_end) AS m FROM dmarc_reports GROUP BY domain) x
             ON x.domain = rep.domain AND x.m = rep.date_end
          WHERE 1 = 1${repDc.sql} GROUP BY rep.domain`,
      )
      .bind(...repDc.params)
      .all<{ domain: string; policy: string | null }>(),
  ]);

  const t = new Map(traffic.results.map((r) => [r.domain, r]));
  const pol = new Map(policies.results.map((r) => [r.domain, asPolicy(r.policy)]));

  const tagData = await loadTagData(db);
  let rows: DomainRow[] = reports.results.map((r) => {
    const x = t.get(r.domain);
    const total = x?.total ?? 0;
    const passed = x?.passed ?? 0;
    const failing = total - passed;
    const policy = pol.get(r.domain) ?? null;
    const status: DomainStatus =
      policy === "reject" ? "enforced" : total === 0 ? "idle" : failing === 0 ? "ready" : "attention";
    return {
      domain: r.domain,
      policy,
      total,
      passed,
      failing,
      rate: total > 0 ? (passed / total) * 100 : 0,
      sources: x?.sources ?? 0,
      lastReportAt: r.last,
      status,
      tags: [...effectiveTags(r.domain, tagData)].sort(),
      autoTags: [...ruleTags(r.domain, tagData)].filter((t) => !tagData.manual.get(r.domain)?.has(t)).sort(),
    };
  });

  const summary = { domains: rows.length, enforced: 0, ready: 0, attention: 0, idle: 0 };
  for (const r of rows) summary[r.status]++;

  if (list.q) {
    const q = list.q.toLowerCase();
    rows = rows.filter((r) => r.domain.toLowerCase().includes(q) || r.tags.some((t) => t.includes(q)));
  }

  const dir = list.dir === "asc" ? 1 : -1;
  const cmp: Record<string, (a: DomainRow, b: DomainRow) => number> = {
    risk: (a, b) => b.failing - a.failing || b.total - a.total,
    domain: (a, b) => a.domain.localeCompare(b.domain) * dir,
    policy: (a, b) => ((STRICTNESS[a.policy ?? ""] ?? -1) - (STRICTNESS[b.policy ?? ""] ?? -1)) * dir,
    messages: (a, b) => (a.total - b.total) * dir,
    rate: (a, b) => ((a.total ? a.rate : 101) - (b.total ? b.rate : 101)) * dir,
    sources: (a, b) => (a.sources - b.sources) * dir,
    last: (a, b) => ((a.lastReportAt ?? 0) - (b.lastReportAt ?? 0)) * dir,
  };
  rows.sort((a, b) => (cmp[list.sort] ?? cmp.risk)(a, b) || a.domain.localeCompare(b.domain));

  const total = rows.length;
  if (opts.all) return { rows, total, summary };
  const start = (list.page - 1) * DOMAINS_PAGE_SIZE;
  return { rows: rows.slice(start, start + DOMAINS_PAGE_SIZE), total, summary };
}

/** Data every dashboard page needs for its shell: the domain list for the
 * filter, and the last-sync indicator. */
export async function loadChrome(db: D1Database): Promise<Chrome> {
  const [domains, lastSync, tagData, colors] = await Promise.all([
    db.prepare("SELECT DISTINCT domain FROM dmarc_reports ORDER BY domain COLLATE NOCASE").all<{ domain: string }>(),
    getLastSync(db),
    loadTagData(db),
    loadColors(db),
  ]);
  const allDomains = domains.results.map((r) => r.domain);
  return { allDomains, lastSync, tags: countTags(allDomains, tagData, colors) };
}
