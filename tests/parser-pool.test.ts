import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeBareDb } from "./d1-shim.ts";
import { applyMigrations } from "../src/migrations.ts";
import { ParserPool } from "../src/node/parser-pool.ts";
import type { Mailbox } from "../src/mailboxes.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-parser.mjs", import.meta.url));

const mb = (id: string, over: Partial<Mailbox> = {}): Mailbox => ({
  id, name: id, host: `imap.${id}.example`, user: `${id}@example.com`, password: "pw-" + id, folder: "INBOX", enabled: true, ...over,
});

async function setup(extraEnv: Record<string, string> = {}, list: Mailbox[] = []) {
  const db = makeBareDb();
  await applyMigrations(db);
  const env = { DB: db, ADMIN_USER: "admin", ADMIN_PASSWORD: "admin-password-123" };
  const logs: string[] = [];
  const pool = new ParserPool({
    env, command: process.execPath, args: [FAKE], pollMs: 20, extraEnv, log: (l) => logs.push(l),
    listMailboxes: async () => list,
  });
  return { db, env, pool, logs, list };
}

const lease = async (pool: ParserPool, m: Mailbox, timeoutMs = 5000) => {
  const r = await pool.lease(m, { purpose: "sync", timeoutMs, onlyMailbox: false });
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r;
};
const whoami = async (c: { fetch(r: Request): Promise<Response> }) => {
  const auth = "Basic " + Buffer.from("admin:admin-password-123").toString("base64");
  return (await c.fetch(new Request("https://internal/whoami", { headers: { authorization: auth } }))).json() as Promise<Record<string, any>>;
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("each mailbox gets its own parser, all running at the same time", async () => {
  const { pool } = await setup();
  try {
    const [a, b, c] = await Promise.all([lease(pool, mb("a")), lease(pool, mb("b")), lease(pool, mb("c"))]);
    const [wa, wb, wc] = await Promise.all([whoami(a.client), whoami(b.client), whoami(c.client)]);
    assert.deepEqual([wa.imapUser, wb.imapUser, wc.imapUser], ["a@example.com", "b@example.com", "c@example.com"]);
    assert.equal(new Set([wa.pid, wb.pid, wc.pid]).size, 3);
    assert.ok([wa.pid, wb.pid, wc.pid].every(alive));
    assert.deepEqual(pool.running().sort(), ["a", "b", "c"]);
    assert.equal(wa.binding, "127.0.0.1");
  } finally { await pool.stopAll(); }
});

test("asking again reuses the running parser; two requests at once start only one", async () => {
  const { pool, logs } = await setup();
  try {
    const [x, y] = await Promise.all([lease(pool, mb("a")), lease(pool, mb("a"))]);
    const first = (await whoami(x.client)).pid;
    assert.equal((await whoami(y.client)).pid, first);
    assert.equal((await whoami((await lease(pool, mb("a"))).client)).pid, first);
    assert.equal(logs.filter((l) => l.includes("started on port")).length, 1);
  } finally { await pool.stopAll(); }
});

test("a changed password restarts only that mailbox's parser", async () => {
  const { pool } = await setup();
  try {
    const a1 = await whoami((await lease(pool, mb("a"))).client);
    const b1 = await whoami((await lease(pool, mb("b"))).client);
    const a2 = await whoami((await lease(pool, mb("a", { password: "new-password" }))).client);
    assert.notEqual(a2.pid, a1.pid);
    assert.equal(alive(a1.pid), false, "the old one was stopped");
    assert.equal((await whoami((await lease(pool, mb("b"))).client)).pid, b1.pid);
  } finally { await pool.stopAll(); }
});

test("changing the sync interval restarts parsers so they re-read on the new schedule", async () => {
  const { pool, db } = await setup();
  try {
    const before = await whoami((await lease(pool, mb("a"))).client);
    assert.equal(before.interval, "900");
    (db as any).raw.exec("INSERT OR REPLACE INTO app_settings VALUES ('sync_interval_minutes', '5', 0)");
    const after = await whoami((await lease(pool, mb("a"))).client);
    assert.equal(after.interval, "300");
    assert.notEqual(after.pid, before.pid);
  } finally { await pool.stopAll(); }
});

test("a parser that died is started again on the next request", async () => {
  const { pool } = await setup();
  try {
    const first = await whoami((await lease(pool, mb("a"))).client);
    process.kill(first.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    const second = await whoami((await lease(pool, mb("a"))).client);
    assert.notEqual(second.pid, first.pid);
    assert.ok(alive(second.pid));
  } finally { await pool.stopAll(); }
});

test("a parser that keeps crashing gives a clear error with its last message, not a long wait", async () => {
  const { pool } = await setup({ FAKE_EXIT_AFTER_MS: "100", FAKE_READ_DELAY_MS: "60000" });
  try {
    const started = Date.now();
    const r = await pool.lease(mb("a"), { purpose: "sync", timeoutMs: 20000, onlyMailbox: false });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /stopped/i);
      assert.match(r.error, /exit code 3/);
      assert.match(r.error, /IMAP login failed/);
    }
    assert.ok(Date.now() - started < 5000, "did not wait out the timeout");
  } finally { await pool.stopAll(); }
});

test("a mailbox that never finishes reading times out with the usual message", async () => {
  const { pool } = await setup({ FAKE_READ_DELAY_MS: "60000" });
  try {
    const r = await pool.lease(mb("a"), { purpose: "sync", timeoutMs: 300, onlyMailbox: false });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Timed out waiting for the mailbox to be read/);
  } finally { await pool.stopAll(); }
});

test("sweep stops parsers of mailboxes that were removed or disabled", async () => {
  const list = [mb("a"), mb("b")];
  const { pool } = await setup({}, list);
  try {
    const a = await whoami((await lease(pool, list[0])).client);
    const b = await whoami((await lease(pool, list[1])).client);
    list.splice(1, 1); // b is removed
    await pool.sweep();
    assert.deepEqual(pool.running(), ["a"]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(b.pid), false);
    assert.equal(alive(a.pid), true);
  } finally { await pool.stopAll(); }
});

test("the parser is not given this app's secrets", async () => {
  process.env.CONFIG_ENCRYPTION_KEY = "should-not-leak";
  process.env.ADMIN_PASSWORD = "should-not-leak";
  process.env.SLACK_WEBHOOK_URL = "https://hooks.example/should-not-leak";
  const { pool } = await setup();
  try {
    const names: string[] = (await whoami((await lease(pool, mb("a"))).client)).envNames;
    for (const secret of ["CONFIG_ENCRYPTION_KEY", "ADMIN_PASSWORD", "ADMIN_USER", "SLACK_WEBHOOK_URL"]) assert.ok(!names.includes(secret), secret);
    assert.ok(names.includes("HTTP_SERVER_PASSWORD") && names.includes("IMAP_PASSWORD"), "it still gets its own settings");
  } finally {
    await pool.stopAll();
    for (const k of ["CONFIG_ENCRYPTION_KEY", "ADMIN_PASSWORD", "SLACK_WEBHOOK_URL"]) delete process.env[k];
  }
});

test("a localhost mailbox uses the plain-TCP test server only when one is configured", async () => {
  const { pool, env } = await setup();
  try {
    const plain = await whoami((await lease(pool, mb("a", { host: "localhost" }))).client);
    assert.equal(plain.imapDisableTls, undefined);
    (env as any).IMAP_TEST_PORT = "14300";
    const dev = await whoami((await lease(pool, mb("a", { host: "localhost", password: "x" }))).client);
    assert.deepEqual([dev.imapPort, dev.imapDisableTls], ["14300", "true"]);
    const remote = await whoami((await lease(pool, mb("b"))).client);
    assert.equal(remote.imapDisableTls, undefined, "a real host never loses TLS");
  } finally { await pool.stopAll(); }
});

test("stopAll stops every parser and refuses new ones", async () => {
  const { pool } = await setup();
  const w = await whoami((await lease(pool, mb("a"))).client);
  await pool.stopAll();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(w.pid), false);
  const r = await pool.lease(mb("a"), { purpose: "sync", timeoutMs: 500, onlyMailbox: false });
  assert.equal(r.ok, false);
});

test("a program that cannot be found reports that clearly", async () => {
  const db = makeBareDb();
  await applyMigrations(db);
  const pool = new ParserPool({ env: { DB: db, ADMIN_USER: "admin", ADMIN_PASSWORD: "admin-password-123" }, command: "/nonexistent/parser", pollMs: 20, listMailboxes: async () => [] });
  try {
    const r = await pool.lease(mb("a"), { purpose: "sync", timeoutMs: 3000, onlyMailbox: false });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /could not start|stopped/i);
  } finally { await pool.stopAll(); }
});
