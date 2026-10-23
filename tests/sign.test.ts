import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signPayload, webhookHeaders } from "../src/sign.ts";

test("the signature matches an independent HMAC-SHA256 implementation", async () => {
  const body = JSON.stringify({ event: "test", n: 1 });
  const expected = createHmac("sha256", "s3cret").update(`1700000000.${body}`).digest("hex");
  assert.equal(await signPayload("s3cret", 1700000000, body), expected);
});

test("the timestamp is part of the signed data (replay protection)", async () => {
  const a = await signPayload("k", 1, "{}");
  const b = await signPayload("k", 2, "{}");
  assert.notEqual(a, b);
});

test("a different secret or body changes the signature", async () => {
  const base = await signPayload("k", 1, "{}");
  assert.notEqual(base, await signPayload("k2", 1, "{}"));
  assert.notEqual(base, await signPayload("k", 1, '{"a":1}'));
});

test("unicode bodies are signed as UTF-8", async () => {
  const body = '{"name":"café — ñ"}';
  assert.equal(await signPayload("k", 5, body), createHmac("sha256", "k").update(`5.${body}`).digest("hex"));
});

test("headers: signed when a secret is set, unsigned when not", async () => {
  const body = "{}";
  const signed = await webhookHeaders("alerts", body, "k", 100);
  assert.equal(signed["x-dmarc-compass-event"], "alerts");
  assert.equal(signed["x-dmarc-compass-timestamp"], "100");
  assert.equal(signed["x-dmarc-compass-signature"], "sha256=" + createHmac("sha256", "k").update("100.{}").digest("hex"));
  const plain = await webhookHeaders("alerts", body, "", 100);
  assert.equal("x-dmarc-compass-signature" in plain, false);
  assert.equal(plain["content-type"], "application/json");
});
