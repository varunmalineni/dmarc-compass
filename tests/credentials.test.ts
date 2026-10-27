import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, internalCredentials, validateNewLogin, ITERATIONS, MIN_PASSWORD } from "../src/credentials.ts";

const KEY = Buffer.alloc(32, 5).toString("base64");

test("a password verifies against its record, and only that password", async () => {
  const rec = await hashPassword("correct horse battery", KEY);
  assert.equal(await verifyPassword("correct horse battery", KEY, rec), true);
  for (const wrong of ["", "correct horse batter", "Correct horse battery", "correct horse battery "]) assert.equal(await verifyPassword(wrong, KEY, rec), false, JSON.stringify(wrong));
});

test("the record never contains the password, and each hash gets its own salt", async () => {
  const a = await hashPassword("a-very-secret-password", KEY);
  const b = await hashPassword("a-very-secret-password", KEY);
  assert.ok(!JSON.stringify(a).includes("a-very-secret"));
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(a.iterations, ITERATIONS);
  assert.ok(ITERATIONS <= 100_000, "Cloudflare Workers refuse more PBKDF2 rounds than this");
});

test("with a key, the database alone is not enough: a different key cannot verify", async () => {
  const rec = await hashPassword("pw-with-the-key-123", KEY);
  assert.equal(rec.keyed, true);
  assert.equal(await verifyPassword("pw-with-the-key-123", Buffer.alloc(32, 6).toString("base64"), rec), false);
  assert.equal(await verifyPassword("pw-with-the-key-123", undefined, rec), false);
});

test("without a key it still works, and is marked as such", async () => {
  const rec = await hashPassword("pw-without-a-key-1", undefined);
  assert.equal(rec.keyed, false);
  assert.equal(await verifyPassword("pw-without-a-key-1", undefined, rec), true);
  assert.equal(await verifyPassword("pw-without-a-key-1", KEY, rec), true, "a key later added does not break an unkeyed record");
  assert.equal(await verifyPassword("other", undefined, rec), false);
});

test("a known answer: the same salt and password always give the same hash", async () => {
  const salt = new Uint8Array(16).fill(3);
  const a = await hashPassword("known-answer-password", KEY, { salt, iterations: 1000 });
  const b = await hashPassword("known-answer-password", KEY, { salt, iterations: 1000 });
  assert.equal(a.hash, b.hash);
  assert.notEqual((await hashPassword("known-answer-passwore", KEY, { salt, iterations: 1000 })).hash, a.hash);
});

test("the app and parser share a secret derived from the key, not the admin password", async () => {
  const a = await internalCredentials({ CONFIG_ENCRYPTION_KEY: KEY, ADMIN_USER: "admin", ADMIN_PASSWORD: "first-password-1" });
  const b = await internalCredentials({ CONFIG_ENCRYPTION_KEY: KEY, ADMIN_USER: "someone", ADMIN_PASSWORD: "changed-password-2" });
  assert.deepEqual(a, b, "changing the admin login does not change it");
  assert.ok(a && a.password.length >= 32 && !a.password.includes("first-password"));
  const other = await internalCredentials({ CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64") });
  assert.notEqual(other?.password, a?.password);
  assert.ok(!a!.user.includes(":"), "usable in HTTP Basic Auth");
});

test("an install with no encryption key keeps using the admin login so it does not break", async () => {
  assert.deepEqual(await internalCredentials({ ADMIN_USER: "u", ADMIN_PASSWORD: "p" }), { user: "u", password: "p" });
  assert.deepEqual(await internalCredentials({ HTTP_SERVER_USER: "old", HTTP_SERVER_PASSWORD: "legacy" }), { user: "old", password: "legacy" });
  assert.equal(await internalCredentials({}), null);
});

const ok = { currentUser: "admin", currentPassword: "current-password-1", newUser: "admin", newPassword: "brand-new-password" };

test("a valid change is accepted, trimming the user name", () => {
  assert.deepEqual(validateNewLogin({ ...ok }), { ok: true, user: "admin", password: "brand-new-password" });
  assert.deepEqual(validateNewLogin({ ...ok, newUser: "  boss  " }), { ok: true, user: "boss", password: "brand-new-password" });
  assert.deepEqual(validateNewLogin({ ...ok, newUser: "boss", newPassword: "" }), { ok: true, user: "boss", password: "current-password-1" }, "user name only: the password is kept");
});

test("weak or unusable logins are refused with a reason", () => {
  const err = (over: object) => { const r = validateNewLogin({ ...ok, ...over }); assert.equal(r.ok, false); return r.ok ? "" : r.error; };
  assert.match(err({ newPassword: "short" }), new RegExp(`at least ${MIN_PASSWORD}`));
  assert.match(err({ newPassword: "x".repeat(201) }), /at most/);
  assert.match(err({ newUser: "" }), /user name/i);
  assert.match(err({ newUser: "   " }), /user name/i);
  assert.match(err({ newUser: "a".repeat(65) }), /at most 64/);
  assert.match(err({ newUser: "has:colon" }), /colon/);
  assert.match(err({ newUser: "line\nbreak" }), /control/);
  assert.match(err({ newUser: "Admin", newPassword: "admin" + "x".repeat(0) }), /at least/);
  assert.match(err({ newUser: "samename-1234", newPassword: "SAMENAME-1234" }), /same as the user name/);
  assert.match(err({ newPassword: "current-password-1" }), /different from the current/);
  assert.match(err({ newUser: "admin", newPassword: "" }), /Nothing to change/);
});
