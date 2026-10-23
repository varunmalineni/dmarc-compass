import test from "node:test";
import assert from "node:assert/strict";
import { alertsPayload, digestPayload, testPayload, plain, type AlertLike, type DigestInput } from "../src/payloads.ts";

const NOW = 1_800_000_000;
const alerts: AlertLike[] = [
  { rule: "passRateDrop", weight: 6, line: "• *a.example*  100.0% → 90.0% (-10.0 pts, 500 messages this week)", data: { domain: "a.example", drop_points: 10 } },
  { rule: "newFailingSender", weight: 75, line: "• *b.example*  Amazon SES `192.0.2.1`  75 failing of 75 messages", data: { domain: "b.example", source_ip: "192.0.2.1", failing_messages: 75 } },
];

test("plain() turns a Slack line into readable text and restores escaped characters", () => {
  assert.equal(plain("• *b.example*  Amazon SES `192.0.2.1`  75 failing"), "b.example Amazon SES 192.0.2.1 75 failing");
  assert.equal(plain("• *x*  &lt;!channel&gt; &amp; more"), "x <!channel> & more");
});

test("alerts payload: stable schema, snake_case rule ids, ordered by weight, data merged in", () => {
  const p = alertsPayload(alerts, "https://dash.example.com/", NOW);
  assert.equal(p.schema, "dmarc-compass.alerts.v1");
  assert.equal(p.event, "alerts");
  assert.equal(p.sent_at, "2027-01-15T08:00:00.000Z");
  assert.equal(p.count, 2);
  assert.deepEqual(p.alerts.map((a) => a.rule), ["new_failing_sender", "pass_rate_drop"]);
  assert.equal(p.alerts[0].domain, "b.example");
  assert.equal(p.alerts[0].failing_messages, 75);
  assert.match(p.alerts[0].message, /Amazon SES 192\.0\.2\.1 75 failing/);
  assert.deepEqual(p.links, { dashboard: "https://dash.example.com/", domains: "https://dash.example.com/domains", report: "https://dash.example.com/report" });
});

test("alerts payload: links are null when the dashboard address is unknown; input is not mutated", () => {
  const copy = JSON.stringify(alerts);
  assert.equal(alertsPayload(alerts, null, NOW).links, null);
  assert.equal(JSON.stringify(alerts), copy);
});

test("a payload survives a JSON round trip unchanged (no undefined, dates, or functions)", () => {
  const p = alertsPayload(alerts, null, NOW);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});

test("test payload names the webhook, or null", () => {
  assert.equal(testPayload("Ops", NOW).webhook, "Ops");
  assert.equal(testPayload("", NOW).webhook, null);
  assert.equal(testPayload("", NOW).schema, "dmarc-compass.test.v1");
});

const digest: DigestInput = {
  periodStart: NOW - 7 * 86400, periodEnd: NOW, days: 7,
  current: { total: 1000, passed: 950, sources: 12, failingSources: 3, domains: 5, reports: 40 },
  previous: { total: 800, passed: 784 },
  domains: { total: 22, enforced: 10, ready: 2, attention: 10, idle: 0, statusDays: 30 },
  mostFailing: [{ domain: "z.example", policy: "none", total: 400, failing: 80, rate: 80 }],
  policyChanges: [{ rule: "policyChange", weight: 1, line: "", data: { domain: "w.example", direction: "stricter" } }],
  newFailingSenders: [],
};

test("digest payload: totals, deltas inputs, domain status and nested lists", () => {
  const p = digestPayload(digest, null, NOW);
  assert.equal(p.schema, "dmarc-compass.digest.v1");
  assert.equal(p.totals.messages, 1000);
  assert.equal(p.totals.failing, 50);
  assert.equal(p.totals.pass_rate_pct, 95);
  assert.equal(p.totals.previous_pass_rate_pct, 98);
  assert.equal(p.domains.ready_to_tighten, 2);
  assert.deepEqual(p.domains.most_failing[0], { domain: "z.example", policy: "none", messages: 400, failing_messages: 80, pass_rate_pct: 80 });
  assert.deepEqual(p.policy_changes, [{ domain: "w.example", direction: "stricter" }]);
  assert.deepEqual(p.new_failing_senders, []);
  assert.equal(p.period.days, 7);
});

test("digest payload with no traffic reports null rates, not NaN or 0", () => {
  const p = digestPayload({ ...digest, current: { ...digest.current, total: 0, passed: 0 }, previous: null }, null, NOW);
  assert.equal(p.totals.pass_rate_pct, null);
  assert.equal(p.totals.previous_pass_rate_pct, null);
  assert.equal(p.totals.previous_messages, null);
  assert.equal(JSON.stringify(p).includes("NaN"), false);
});
