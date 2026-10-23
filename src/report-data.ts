// Data for the printable summary report. Everything here reuses the queries
// that power the dashboard pages, so the numbers in a report always match what
// the pages show for the same filters.

import { loadOverview, type Overview, type SourceRow } from "./dashboard-data";
import { loadDomains, type DomainRow, type DomainsData } from "./domains-data";
import { loadTls, type TlsData } from "./tls-data";
import { newFailingSenders, policyChanges, type Alert } from "./notify";
import { sinceEpoch, type Filters, type ListState } from "./filters";

export const REPORT_DOMAIN_ROWS = 15;
export const REPORT_SENDER_ROWS = 8;

export interface SummaryData {
  generatedAt: number;
  filters: Filters;
  /** Start of the window (0 for all time) and the end (now). */
  from: number;
  to: number;
  overview: Overview;
  domains: DomainsData;
  topDomains: DomainRow[];
  topSenders: SourceRow[];
  policyChanges: Alert[];
  /** Null when the range is "all time": "new" has no meaning without a start. */
  newSenders: Alert[] | null;
  tls: TlsData;
}

export async function loadSummary(db: D1Database, f: Filters): Promise<SummaryData> {
  const now = Math.floor(Date.now() / 1000);
  const since = sinceEpoch(f.range, now);
  const risk: ListState = { q: "", sort: "risk", dir: "desc", page: 1 };
  const scope = f.domains.length ? new Set(f.domains) : null;
  const inScope = (a: Alert) => !scope || scope.has(String(a.data.domain));

  const [overview, domains, tls, changes, senders] = await Promise.all([
    loadOverview(db, f, risk),
    loadDomains(db, f, risk, { all: true }),
    loadTls(db, f),
    policyChanges(db, 0, since),
    f.range === null ? Promise.resolve(null) : newFailingSenders(db, { kind: "period", since }, 20, now),
  ]);

  return {
    generatedAt: now,
    filters: f,
    from: since,
    to: now,
    overview,
    domains,
    topDomains: domains.rows.filter((r) => r.failing > 0).slice(0, REPORT_DOMAIN_ROWS),
    topSenders: overview.sources.rows.filter((r) => r.rate < 100).slice(0, REPORT_SENDER_ROWS),
    policyChanges: changes.filter(inScope),
    newSenders: senders ? senders.filter(inScope) : null,
    tls,
  };
}

/** The trend as at most `maxBars` buckets: days for short ranges, weeks beyond that. */
export function bucketTrend(
  days: string[],
  passed: number[],
  failed: number[],
  maxBars = 120,
): { labels: string[]; passed: number[]; failed: number[]; unit: "day" | "week" } {
  if (days.length <= maxBars) return { labels: days, passed, failed, unit: "day" };
  const labels: string[] = [];
  const p: number[] = [];
  const x: number[] = [];
  for (let i = 0; i < days.length; i += 7) {
    labels.push(days[i]);
    p.push(passed.slice(i, i + 7).reduce((a, b) => a + b, 0));
    x.push(failed.slice(i, i + 7).reduce((a, b) => a + b, 0));
  }
  return { labels, passed: p, failed: x, unit: "week" };
}
