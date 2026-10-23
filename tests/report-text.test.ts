import test from "node:test";
import assert from "node:assert/strict";
import { findings, type FindingsInput } from "../src/report-text.ts";

const base: FindingsInput = {
  scope: "all domains", periodLabel: "Last 30 days", messages: 10000, passRate: 96.4, prevPassRate: 95.1,
  domains: 22, enforced: 10, ready: 2, attention: 10,
  topDomain: { domain: "zephyr-travel.example", failing: 2012, rate: 83.7 },
  topSender: { sender: "Amazon SES", ip: "192.0.2.35", failing: 186 },
  policyChanges: 1, newSenders: 2, tlsSessions: 5000, tlsFailed: 120,
};

test("a typical period produces the expected findings in order", () => {
  const f = findings(base);
  assert.match(f[0], /^10,000 messages from 22 domains were reported, and 96\.4% passed DMARC \(up 1\.3 points from the previous period\)\.$/);
  assert.match(f[1], /^10 domains have failing messages .*zephyr-travel\.example with 2,012 failing \(83\.7% pass\)\.$/);
  assert.ok(f.some((l) => /^2 domains had no failing messages and are ready/.test(l)));
  assert.ok(f.some((l) => /^10 domains already publish p=reject\.$/.test(l)));
  assert.ok(f.some((l) => /Amazon SES \(192\.0\.2\.35\), with 186 failing/.test(l)));
  assert.ok(f.some((l) => /^1 policy change was observed\.$/.test(l)));
  assert.ok(f.some((l) => /^2 new failing senders appeared/.test(l)));
  assert.ok(f.some((l) => /^120 of 5,000 reported TLS sessions failed\.$/.test(l)));
});

test("singular and plural wording", () => {
  const f = findings({ ...base, domains: 1, attention: 1, ready: 1, enforced: 1, policyChanges: 1, newSenders: 1 });
  assert.match(f[0], /from 1 domain were reported/);
  assert.match(f[1], /^1 domain has failing messages/);
  assert.ok(f.some((l) => /^1 domain had no failing messages and is ready/.test(l)));
  assert.ok(f.some((l) => /^1 domain already publishes p=reject/.test(l)));
  assert.ok(f.some((l) => /^1 new failing sender appeared/.test(l)));
});

test("an empty period says so and does not invent figures", () => {
  const f = findings({ ...base, messages: 0, passRate: null, prevPassRate: null, attention: 0, ready: 0, enforced: 0, topDomain: null, topSender: null, policyChanges: 0, newSenders: null, tlsFailed: 0 });
  assert.equal(f.length, 1);
  assert.match(f[0], /^No messages were reported for all domains in this period/);
});

test("no previous period means no comparison; flat means unchanged", () => {
  assert.ok(!/previous period/.test(findings({ ...base, prevPassRate: null })[0]));
  assert.match(findings({ ...base, prevPassRate: 96.4 })[0], /unchanged from the previous period/);
  assert.match(findings({ ...base, prevPassRate: 99 })[0], /down 2\.6 points/);
});

test("all-time reports skip the new-sender line (null), healthy TLS adds nothing", () => {
  const f = findings({ ...base, newSenders: null, tlsFailed: 0 });
  assert.ok(!f.some((l) => /new failing/.test(l)));
  assert.ok(!f.some((l) => /TLS/.test(l)));
});
