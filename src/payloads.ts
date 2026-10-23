// The JSON documents sent to JSON webhooks. Pure, so they can be unit-tested
// and so the shape receivers depend on is defined in exactly one place.
//
// Every document has:
//   schema   "dmarc-compass.<event>.v1": bump the suffix on a breaking change
//   event    "alerts" | "digest" | "test"
//   sent_at  ISO 8601, UTC

export const SOURCE = "dmarc-compass";

export type RuleKey = "newFailingSender" | "passRateDrop" | "policyChange" | "syncHealth";

const RULE_IDS: Record<RuleKey, string> = {
  newFailingSender: "new_failing_sender",
  passRateDrop: "pass_rate_drop",
  policyChange: "policy_change",
  syncHealth: "sync_problem",
};

export interface AlertLike {
  rule: RuleKey;
  line: string;
  weight: number;
  data: Record<string, unknown>;
}

/** The Slack-formatted line as plain text. */
export function plain(line: string): string {
  return line
    .replace(/^•\s*/, "")
    .replace(/[*`_]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

function links(baseUrl: string | null): Record<string, string> | null {
  if (!baseUrl) return null;
  const b = baseUrl.replace(/\/$/, "");
  return { dashboard: b + "/", domains: b + "/domains", report: b + "/report" };
}

export function alertsPayload(alerts: AlertLike[], baseUrl: string | null, now: number) {
  const ordered = [...alerts].sort((a, b) => b.weight - a.weight);
  return {
    schema: `${SOURCE}.alerts.v1`,
    source: SOURCE,
    event: "alerts",
    sent_at: iso(now),
    count: alerts.length,
    alerts: ordered.map((a) => ({ rule: RULE_IDS[a.rule], message: plain(a.line), ...a.data })),
    links: links(baseUrl),
  };
}

export function testPayload(name: string, now: number) {
  return {
    schema: `${SOURCE}.test.v1`,
    source: SOURCE,
    event: "test",
    sent_at: iso(now),
    message: "Notifications are connected.",
    webhook: name || null,
  };
}

export interface DigestInput {
  periodStart: number;
  periodEnd: number;
  days: number;
  current: { total: number; passed: number; sources: number; failingSources: number; domains: number; reports: number };
  previous: { total: number; passed: number } | null;
  domains: { total: number; enforced: number; ready: number; attention: number; idle: number; statusDays: number };
  mostFailing: Array<{ domain: string; policy: string | null; total: number; failing: number; rate: number }>;
  policyChanges: AlertLike[];
  newFailingSenders: AlertLike[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function digestPayload(d: DigestInput, baseUrl: string | null, now: number) {
  const rate = d.current.total ? (d.current.passed / d.current.total) * 100 : null;
  const prevRate = d.previous && d.previous.total ? (d.previous.passed / d.previous.total) * 100 : null;
  return {
    schema: `${SOURCE}.digest.v1`,
    source: SOURCE,
    event: "digest",
    sent_at: iso(now),
    period: { start: iso(d.periodStart), end: iso(d.periodEnd), days: d.days },
    totals: {
      messages: d.current.total,
      passed: d.current.passed,
      failing: d.current.total - d.current.passed,
      pass_rate_pct: rate === null ? null : r2(rate),
      previous_pass_rate_pct: prevRate === null ? null : r2(prevRate),
      previous_messages: d.previous ? d.previous.total : null,
      sending_sources: d.current.sources,
      failing_sources: d.current.failingSources,
      domains_reporting: d.current.domains,
      reports: d.current.reports,
    },
    domains: {
      total: d.domains.total,
      enforced: d.domains.enforced,
      ready_to_tighten: d.domains.ready,
      needs_attention: d.domains.attention,
      idle: d.domains.idle,
      status_window_days: d.domains.statusDays,
      most_failing: d.mostFailing.map((r) => ({
        domain: r.domain,
        policy: r.policy,
        messages: r.total,
        failing_messages: r.failing,
        pass_rate_pct: r2(r.rate),
      })),
    },
    policy_changes: d.policyChanges.map((a) => a.data),
    new_failing_senders: d.newFailingSenders.map((a) => a.data),
    links: links(baseUrl),
  };
}
