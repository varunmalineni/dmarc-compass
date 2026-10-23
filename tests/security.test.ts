import test from "node:test";
import assert from "node:assert/strict";
import { addNonce, clientKey, constantTimeEqual, csp, newNonce, BASE_HEADERS } from "../src/security.ts";

test("nonces are unique, url-safe and long enough", () => {
  const seen = new Set(Array.from({ length: 200 }, newNonce));
  assert.equal(seen.size, 200);
  for (const n of seen) assert.match(n, /^[A-Za-z0-9]{16,}$/);
});

test("csp: scripts need the nonce, nothing loads from other origins except map tiles when asked", () => {
  const plain = csp("abc123");
  assert.match(plain, /script-src 'self' 'nonce-abc123'/);
  assert.match(plain, /default-src 'none'/);
  assert.match(plain, /frame-ancestors 'none'/);
  assert.match(plain, /object-src 'none'/);
  assert.match(plain, /base-uri 'none'/);
  assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline/.test(plain), "scripts must never allow unsafe-inline or eval");
  assert.ok(!plain.includes("openstreetmap"));
  assert.match(csp("n", { tiles: true }), /img-src 'self' data: https:\/\/\*\.tile\.openstreetmap\.org/);
  for (const d of ["connect-src 'self'", "font-src 'self'", "form-action 'self'"]) assert.ok(plain.includes(d), d);
});

test("addNonce tags every script element and leaves other tags alone", () => {
  const html = '<script>a()</script><script src="/x.js"></script><script type="application/json" id="d">{}</script><scripture>no</scripture><div>x</div>';
  const out = addNonce(html, "N");
  assert.equal((out.match(/<script nonce="N"/g) ?? []).length, 3);
  assert.ok(out.includes("<scripture>"));
  assert.ok(out.includes('<script nonce="N" src="/x.js">'));
});

test("escaped markup from report data is not turned into a script tag", () => {
  const hostile = "&lt;script&gt;alert(1)&lt;/script&gt;";
  assert.equal(addNonce(hostile, "N"), hostile);
});

test("base headers cover the usual set", () => {
  for (const h of ["x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy", "strict-transport-security"]) {
    assert.ok(BASE_HEADERS[h], h);
  }
});

test("clientKey: IPv4 as is, IPv6 grouped by /64, missing is its own bucket", () => {
  assert.equal(clientKey("203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:0db8:0001:0002::/64");
  assert.equal(clientKey("2001:db8:1:2::1"), "2001:0db8:0001:0002::/64");
  assert.equal(clientKey("2001:DB8:1:2:ffff:ffff:ffff:ffff"), clientKey("2001:db8:1:2::5"));
  assert.notEqual(clientKey("2001:db8:1:3::1"), clientKey("2001:db8:1:2::1"));
  assert.equal(clientKey("::1"), "0000:0000:0000:0000::/64");
  assert.equal(clientKey(null), "unknown");
});

test("constantTimeEqual", () => {
  assert.equal(constantTimeEqual("secret", "secret"), true);
  assert.equal(constantTimeEqual("secret", "secreT"), false);
  assert.equal(constantTimeEqual("secret", "secret2"), false);
  assert.equal(constantTimeEqual("", ""), true);
  assert.equal(constantTimeEqual("", "x"), false);
  assert.equal(constantTimeEqual("é", "é"), true);
});
