import test from "node:test";
import assert from "node:assert/strict";
import { makeBareDb } from "./d1-shim.ts";
import { applyMigrations } from "../src/migrations.ts";
import { accountView, checkLogin, clearStoredLogin, getAdminLogin, saveStoredLogin, sessionMaterial } from "../src/admin-login.ts";
import { makeToken, verifyToken } from "../src/session.ts";

const KEY = Buffer.alloc(32, 5).toString("base64");
const ENV = { ADMIN_USER: "admin", ADMIN_PASSWORD: "deployed-password-1" };
const NOW = 1_800_000_000;

async function db() {
  const d = makeBareDb();
  await applyMigrations(d);
  return d;
}

test("with nothing saved, the login the app was deployed with is used", async () => {
  const d = await db();
  const login = await getAdminLogin(d, ENV);
  assert.equal(login?.source, "env");
  assert.equal(await checkLogin(login!, KEY, "admin", "deployed-password-1"), true);
  assert.equal(await checkLogin(login!, KEY, "admin", "nope"), false);
  assert.equal(await checkLogin(login!, KEY, "other", "deployed-password-1"), false);
  assert.equal(await getAdminLogin(d, {}), null, "no login anywhere: not configured");
});

test("a login saved from the Admin page takes over, and the deployed password stops working", async () => {
  const d = await db();
  await saveStoredLogin(d, KEY, "boss", "chosen-in-the-gui-99", NOW);
  const login = (await getAdminLogin(d, ENV))!;
  assert.equal(login.source, "stored");
  assert.equal(await checkLogin(login, KEY, "boss", "chosen-in-the-gui-99"), true);
  assert.equal(await checkLogin(login, KEY, "admin", "deployed-password-1"), false);
  assert.equal(await checkLogin(login, KEY, "boss", "deployed-password-1"), false);
  assert.equal(await checkLogin(login, KEY, "admin", "chosen-in-the-gui-99"), false);
  assert.deepEqual(accountView(login), { user: "boss", source: "stored", changedAt: NOW });
});

test("the password is not stored in the database", async () => {
  const d = await db();
  await saveStoredLogin(d, KEY, "boss", "never-written-down-77", NOW);
  const row = (d as any).raw.prepare("SELECT value FROM app_settings WHERE key = 'admin_login'").get().value as string;
  assert.ok(!row.includes("never-written-down"));
  assert.ok(row.includes('"keyed":true'));
});

test("sessions follow the login: a new password or user name ends the old sessions", async () => {
  const d = await db();
  const secret = "s".repeat(64);
  const before = (await getAdminLogin(d, ENV))!;
  const token = await makeToken(secret, before.user, sessionMaterial(before), NOW);
  assert.equal(await verifyToken(token, secret, before.user, sessionMaterial(before), NOW + 5), true);

  await saveStoredLogin(d, KEY, "admin", "second-password-123", NOW + 10);
  const second = (await getAdminLogin(d, ENV))!;
  assert.equal(await verifyToken(token, secret, second.user, sessionMaterial(second), NOW + 20), false, "the deployed-login session is gone");
  const t2 = await makeToken(secret, second.user, sessionMaterial(second), NOW + 20);
  assert.equal(await verifyToken(t2, secret, second.user, sessionMaterial(second), NOW + 30), true);

  await saveStoredLogin(d, KEY, "admin", "third-password-1234", NOW + 40);
  const third = (await getAdminLogin(d, ENV))!;
  assert.equal(await verifyToken(t2, secret, third.user, sessionMaterial(third), NOW + 50), false, "and so is the one before");
});

test("resetting removes the saved login and the deployed one works again", async () => {
  const d = await db();
  assert.equal(await clearStoredLogin(d), false, "nothing to remove");
  await saveStoredLogin(d, KEY, "boss", "chosen-in-the-gui-99", NOW);
  assert.equal(await clearStoredLogin(d), true);
  const login = (await getAdminLogin(d, ENV))!;
  assert.equal(login.source, "env");
  assert.equal(await checkLogin(login, KEY, "admin", "deployed-password-1"), true);
});

test("a damaged saved login is ignored rather than locking everyone out", async () => {
  const d = await db();
  for (const bad of ["not json", "{}", '{"user":"x"}', '{"user":"x","salt":"a","hash":"b","iterations":"many"}']) {
    (d as any).raw.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('admin_login', ?, 0)").run(bad);
    assert.equal((await getAdminLogin(d, ENV))?.source, "env", bad);
  }
});

test("a login saved with a key cannot be checked without it", async () => {
  const d = await db();
  await saveStoredLogin(d, KEY, "boss", "needs-the-key-12345", NOW);
  const login = (await getAdminLogin(d, ENV))!;
  assert.equal(await checkLogin(login, undefined, "boss", "needs-the-key-12345"), false);
  assert.equal(await checkLogin(login, Buffer.alloc(32, 9).toString("base64"), "boss", "needs-the-key-12345"), false);
});
