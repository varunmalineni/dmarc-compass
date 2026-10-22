import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeConfig, validateWebhookUrl, isValidTimeZone, maskWebhook, sanitizeNickname, DEFAULT_CONFIG } from "../src/notify-config.ts";
import { esc, safe, sections } from "../src/slack-format.ts";

test("defaults: every alert rule is on and the digest is off", () => {
  const c = sanitizeConfig(undefined);
  assert.equal(c.digest.mode, "off");
  assert.deepEqual(c.rules, DEFAULT_CONFIG.rules);
  assert.ok(Object.values(c.rules).every((r) => r.on));
});

test("sanitizeConfig clamps numbers and falls back on junk", () => {
  const c = sanitizeConfig({
    rules: {
      newFailingSender: { on: "yes", minMessages: -5 },
      passRateDrop: { on: false, points: 5000, minMessages: "abc" },
      syncHealth: { staleMinutes: 1 },
    },
    digest: { mode: "hourly", hour: 99, weekday: -3, dayOfMonth: 31, everyDays: 0, timezone: "Not/AZone" },
  });
  assert.equal(c.rules.newFailingSender.on, true); // not a boolean: default
  assert.equal(c.rules.newFailingSender.minMessages, 1);
  assert.equal(c.rules.passRateDrop.on, false);
  assert.equal(c.rules.passRateDrop.points, 100);
  assert.equal(c.rules.passRateDrop.minMessages, DEFAULT_CONFIG.rules.passRateDrop.minMessages);
  assert.equal(c.rules.syncHealth.staleMinutes, 30);
  assert.equal(c.digest.mode, "off"); // unknown mode: default
  assert.equal(c.digest.hour, 23);
  assert.equal(c.digest.weekday, 0);
  assert.equal(c.digest.dayOfMonth, 28); // every month has a 28th
  assert.equal(c.digest.everyDays, 1);
  assert.equal(c.digest.timezone, "UTC");
});

test("sanitizeConfig accepts a valid schedule, including numbers sent as strings", () => {
  const c = sanitizeConfig({ digest: { mode: "weekly", weekday: "1", hour: "9", timezone: "America/New_York", everyDays: "7", dayOfMonth: "15" } });
  assert.deepEqual(c.digest, { mode: "weekly", everyDays: 7, weekday: 1, dayOfMonth: 15, hour: 9, timezone: "America/New_York" });
});

test("sanitizeConfig survives hostile shapes", () => {
  for (const bad of [null, 5, "x", [], { rules: 3 }, { digest: [] }, { rules: { passRateDrop: null } }]) {
    assert.doesNotThrow(() => sanitizeConfig(bad));
  }
});

test("time zone validation", () => {
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(42), false);
});

test("webhook URL must be https without credentials", () => {
  assert.equal(validateWebhookUrl("https://hooks.slack.com/services/T000/B000/XXXX").ok, true);
  assert.equal(validateWebhookUrl("http://hooks.slack.com/services/x").ok, false);
  assert.equal(validateWebhookUrl("http://localhost:9999/hook").ok, true); // loopback only, for local development
  assert.equal(validateWebhookUrl("http://127.0.0.1:9999/hook").ok, true);
  assert.equal(validateWebhookUrl("http://localhost.evil.example/hook").ok, false);
  assert.equal(validateWebhookUrl("http://10.0.0.5/hook").ok, false);
  assert.equal(validateWebhookUrl("https://user:pw@example.com/x").ok, false);
  assert.equal(validateWebhookUrl("not a url").ok, false);
  assert.equal(validateWebhookUrl("javascript:alert(1)").ok, false);
  assert.equal(validateWebhookUrl("https://example.com/" + "a".repeat(600)).ok, false);
});

test("untrusted report text cannot create Slack links, mentions or markup", () => {
  assert.equal(esc("<!channel> <https://evil.example|click> & more"), "&lt;!channel&gt; &lt;https://evil.example|click&gt; &amp; more");
  const s = safe("evil.example\n<!here>\u0000\u0007x");
  assert.ok(!s.includes("<") && !s.includes(">") && !/[\u0000-\u001f]/.test(s));
});

test("safe() truncates long values", () => {
  const out = safe("a".repeat(500), 40);
  assert.equal(out.length, 40);
  assert.ok(out.endsWith("…"));
});

test("sections() keeps every block under Slack's 3000 character limit", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `• line ${i} ` + "x".repeat(40));
  const blocks = sections(lines);
  assert.ok(blocks.length > 1);
  for (const b of blocks) assert.ok(((b.text as { text: string }).text.length) <= 3000);
  const joined = blocks.map((b) => (b.text as { text: string }).text).join("\n");
  assert.ok(joined.includes("line 399"));
  assert.ok(joined.includes("line 0 "));
});

test("sections() truncates a single oversized line", () => {
  const blocks = sections(["y".repeat(10000)]);
  assert.equal(blocks.length, 1);
  assert.ok((blocks[0].text as { text: string }).text.length <= 3000);
});

test("maskWebhook shows the host and last four characters only", () => {
  const url = "https://hooks.slack.com/services/T0AAAAAAA/B0BBBBBBB/SECRETSECRETtail";
  const m = maskWebhook(url);
  assert.equal(m, "https://hooks.slack.com/••••tail");
  assert.ok(!m.includes("T0AAAAAAA") && !m.includes("SECRET"));
  assert.equal(maskWebhook("not a url"), "••••");
});

test("nickname is trimmed, single-spaced, control-free and capped at 40 characters", () => {
  assert.equal(sanitizeNickname("  #dmarc-alerts  "), "#dmarc-alerts");
  assert.equal(sanitizeNickname("a\n\tb   c"), "a b c");
  assert.equal(sanitizeNickname("x".repeat(100)).length, 40);
  assert.equal(sanitizeNickname(42), "");
  assert.equal(sanitizeNickname(undefined), "");
  assert.equal(sanitizeNickname("<b>ok</b>"), "<b>ok</b>"); // stored as text; always escaped on output
});
