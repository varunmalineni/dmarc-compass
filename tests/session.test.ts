import test from "node:test";
import assert from "node:assert/strict";
import { makeToken, verifyToken, readCookie, sessionCookie, clearCookie, safeNext, requesterKind, SESSION_SECONDS, COOKIE_NAME } from "../src/session.ts";

const NOW = 1_800_000_000;
const S = "a".repeat(64);

test("a fresh token verifies for 12 hours and not after", async () => {
  assert.equal(SESSION_SECONDS, 12 * 3600);
  const t = await makeToken(S, "admin", "pw", NOW);
  assert.equal(await verifyToken(t, S, "admin", "pw", NOW + 10), true);
  assert.equal(await verifyToken(t, S, "admin", "pw", NOW + SESSION_SECONDS - 1), true);
  assert.equal(await verifyToken(t, S, "admin", "pw", NOW + SESSION_SECONDS), false);
  assert.equal(await verifyToken(t, S, "admin", "pw", NOW + SESSION_SECONDS + 3600), false);
});

test("changing the user name or password ends the session; so does a different secret", async () => {
  const t = await makeToken(S, "admin", "pw", NOW);
  assert.equal(await verifyToken(t, S, "admin", "pw2", NOW + 1), false);
  assert.equal(await verifyToken(t, S, "root", "pw", NOW + 1), false);
  assert.equal(await verifyToken(t, "b".repeat(64), "admin", "pw", NOW + 1), false);
});

test("tampering, extending the expiry and junk are all rejected", async () => {
  const t = await makeToken(S, "admin", "pw", NOW);
  const [exp, sig] = t.split(".");
  assert.equal(await verifyToken(`${Number(exp) + 99999}.${sig}`, S, "admin", "pw", NOW + 1), false);
  assert.equal(await verifyToken(`${exp}.${sig.slice(0, -1)}0`, S, "admin", "pw", NOW + 1), sig.endsWith("0"));
  assert.equal(await verifyToken(`${exp}.`, S, "admin", "pw", NOW + 1), false);
  for (const bad of [null, "", "x", ".", "abc.def", "1.2.3", `${NOW - 5}.${sig}`, `NaN.${sig}`]) assert.equal(await verifyToken(bad as string, S, "admin", "pw", NOW + 1), false, String(bad));
});

test("a token made far in the future (a clock trick) is not accepted", async () => {
  const t = await makeToken(S, "admin", "pw", NOW + 10 * SESSION_SECONDS);
  assert.equal(await verifyToken(t, S, "admin", "pw", NOW), false);
});

test("the password never appears in the token or the cookie", async () => {
  const t = await makeToken(S, "admin", "hunter2-very-secret", NOW);
  assert.ok(!t.includes("hunter2") && !sessionCookie(t).includes("hunter2"));
});

test("cookie reading and the cookie's protective attributes", () => {
  assert.equal(readCookie(`a=1; ${COOKIE_NAME}=tok.en; b=2`, COOKIE_NAME), "tok.en");
  assert.equal(readCookie("a=1", COOKIE_NAME), null);
  assert.equal(readCookie(null, COOKIE_NAME), null);
  const c = sessionCookie("t");
  for (const attr of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${SESSION_SECONDS}`]) assert.ok(c.includes(attr), attr);
  assert.ok(!c.includes("Domain"), "__Host- cookies must not set Domain");
  assert.ok(clearCookie().includes("Max-Age=0"));
});

test("the page to return to must be a path on this site", () => {
  assert.equal(safeNext("/reports?range=30"), "/reports?range=30");
  assert.equal(safeNext("/"), "/");
  for (const bad of [null, undefined, "", "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "evil", "/x\r\nset-cookie: a=b"]) assert.equal(safeNext(bad), "/admin", String(bad));
  assert.equal(safeNext("/login"), "/admin");
  assert.equal(safeNext("/login?next=/x"), "/admin");
  assert.equal(safeNext("/logout"), "/admin");
});

test("browsers opening a page are redirected; scripts in a page get a plain 401; curl gets the standard challenge", () => {
  assert.equal(requesterKind("GET", "navigate", "text/html,*/*"), "page");
  assert.equal(requesterKind("GET", null, "text/html"), "page"); // browsers without Sec-Fetch headers
  assert.equal(requesterKind("GET", "cors", "*/*"), "script");
  assert.equal(requesterKind("GET", "same-origin", "*/*"), "script");
  assert.equal(requesterKind("POST", "same-origin", "*/*"), "script");
  assert.equal(requesterKind("GET", null, "*/*"), "client");
  assert.equal(requesterKind("POST", null, null), "client");
});
