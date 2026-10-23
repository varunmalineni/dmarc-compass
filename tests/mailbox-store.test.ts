import test from "node:test";
import assert from "node:assert/strict";
import { makeDb, KEY } from "./d1-shim.ts";
import {
  acquireLock, releaseLock, loadMailboxes, addMailboxEntry, updateMailboxEntry, removeMailboxEntry, loadMailbox,
  waitUntilRead, recordMailboxResult, getMailboxesView, mailboxForStart, getCursor, setCursor,
} from "../src/mailbox-store.ts";
import { fingerprint, type Mailbox } from "../src/mailboxes.ts";

const base = { host: "imap.example.com", user: "dmarc@example.com", password: "pw", folder: "" };
const env = (db: D1Database, extra: object = {}) => ({ DB: db, CONFIG_ENCRYPTION_KEY: KEY, ...extra });

test("lock: one holder at a time, released on demand, and it expires by itself", async () => {
  const db = makeDb();
  assert.equal(await acquireLock(db, "sync", 60), true);
  assert.equal(await acquireLock(db, "raw", 60), false); // busy
  await releaseLock(db);
  assert.equal(await acquireLock(db, "raw", 60), true);
  // an expired lease can be taken over (simulate a crashed holder)
  db.raw.exec("UPDATE app_settings SET value = '1' WHERE key = 'container_lock'");
  assert.equal(await acquireLock(db, "sync", 60), true);
  assert.equal(await acquireLock(db, "sync", 60), false);
});

test("no mailbox configured -> empty list; Worker secrets alone become the default mailbox", async () => {
  const db = makeDb();
  assert.deepEqual((await loadMailboxes(env(db))).list, []);
  const { list, source } = await loadMailboxes(env(db, { IMAP_HOST: "imap.zoho.com", IMAP_USER: "me@example.com", IMAP_PASSWORD: "s3", IMAP_FOLDER: "INBOX" }));
  assert.equal(source, "legacy");
  assert.deepEqual(list.map((m) => [m.id, m.host, m.folder]), [["default", "imap.zoho.com", ""]]);
});

test("a mailbox saved with the old single-mailbox settings is still found", async () => {
  const db = makeDb();
  const { encryptValue } = await import("../src/crypto-util.ts");
  for (const [k, v] of [["IMAP_HOST", "imap.old.example"], ["IMAP_USER", "old@example.com"], ["IMAP_PASSWORD", "oldpw"], ["IMAP_FOLDER", "Reports"]]) {
    db.raw.prepare("INSERT INTO settings VALUES (?, ?, 0)").run(k, await encryptValue(v, KEY));
  }
  const { list, source } = await loadMailboxes(env(db));
  assert.equal(source, "legacy");
  assert.deepEqual([list[0].id, list[0].host, list[0].user, list[0].password, list[0].folder], ["default", "imap.old.example", "old@example.com", "oldpw", "Reports"]);
});

test("adding the first mailbox to a legacy install keeps the default id, so old reports still match", async () => {
  const db = makeDb();
  const e = env(db, { IMAP_HOST: "imap.zoho.com", IMAP_USER: "me@example.com", IMAP_PASSWORD: "s3" });
  assert.equal((await addMailboxEntry(e, { ...base, name: "Second" })).ok, true);
  const { list, source } = await loadMailboxes(e);
  assert.equal(source, "saved");
  assert.deepEqual(list.map((m) => m.id).sort(), ["default", list.find((m) => m.id !== "default")!.id].sort());
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "default"); // the original stays first
});

test("saving needs the encryption key; the list is stored encrypted", async () => {
  const db = makeDb();
  const r = await addMailboxEntry({ DB: db }, base);
  assert.equal(r.ok, false);
  await addMailboxEntry(env(db), base);
  const stored = (db.raw.prepare("SELECT value FROM settings WHERE key = 'MAILBOXES'").get() as { value: string }).value;
  assert.ok(!stored.includes("imap.example.com") && !stored.includes("dmarc@example.com") && !stored.includes("pw"));
});

test("update, pause and remove persist; removing clears its status", async () => {
  const db = makeDb();
  const e = env(db);
  await addMailboxEntry(e, base);
  const id = (await loadMailboxes(e)).list[0].id;
  assert.equal(id, "default");
  await recordMailboxResult(db, id, { at: 1, ok: true, detail: "x" });
  assert.equal((await updateMailboxEntry(e, id, { enabled: false, name: "Paused" })).ok, true);
  const m = (await loadMailboxes(e)).list[0];
  assert.deepEqual([m.enabled, m.name, m.password], [false, "Paused", "pw"]);
  assert.equal((await removeMailboxEntry(e, "nope")).ok, false);
  assert.equal((await removeMailboxEntry(e, id)).ok, true);
  assert.deepEqual((await loadMailboxes(e)).list, []);
  assert.equal(((await getMailboxesView(e)).rows).length, 0);
  assert.equal(JSON.parse((db.raw.prepare("SELECT value FROM app_settings WHERE key = 'mailbox_results'").get() as { value: string }).value)[id], undefined);
});

test("view: report counts per mailbox, with untagged old reports counted under the default", async () => {
  const db = makeDb();
  const e = env(db);
  await addMailboxEntry(e, base);
  await addMailboxEntry(e, { ...base, user: "two@example.com" });
  const second = (await loadMailboxes(e)).list[1].id;
  db.raw.exec(`INSERT INTO dmarc_reports VALUES ('a', NULL), ('b', 'default'), ('c', '${second}')`);
  const rows = (await getMailboxesView(e)).rows;
  assert.deepEqual(rows.map((r) => [r.id, r.reports]), [["default", 2], [second, 1]]);
  assert.ok(!JSON.stringify(rows).includes("pw"));
});

function fakeContainer(script: Array<number | null | "err" | 500>) {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    async fetch(req: Request) {
      calls.push(new URL(req.url).pathname);
      const step = script[Math.min(i++, script.length - 1)];
      if (step === "err") throw new Error("Container port connection closed unexpectedly");
      if (step === 500) return new Response("no", { status: 500 });
      return Response.json({ last_update: step });
    },
  };
}
const creds = { ADMIN_USER: "u", ADMIN_PASSWORD: "p" };

test("waitUntilRead keeps polling through errors and 'not yet', then succeeds", async () => {
  const c = fakeContainer(["err", 500, null, null, 1792000000]);
  const r = await waitUntilRead(c, { DB: makeDb(), ...creds }, 5000, 1);
  assert.equal(r.ok, true);
  assert.equal(c.calls.length, 5);
});

test("waitUntilRead times out with a helpful message", async () => {
  const r = await waitUntilRead(fakeContainer([null]), { DB: makeDb(), ...creds }, 60, 10);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /Timed out waiting for the mailbox to be read.*not finished reading.*host, login and folder/);
});

async function mb(over: Partial<Mailbox> = {}): Promise<Mailbox> {
  return { id: "a", name: "A", host: "imap.example.com", user: "u@example.com", password: "pw", folder: "", enabled: true, ...over };
}

test("loadMailbox: switching restarts the container once and records what is loaded", async () => {
  const db = makeDb();
  let stops = 0;
  const c = fakeContainer([1]);
  const r1 = await loadMailbox({ DB: db, ...creds }, c, await mb(), async () => { stops++; }, 1000, { pollMs: 1 });
  assert.deepEqual([r1.ok, (r1 as { switched?: boolean }).switched, stops], [true, true, 1]);
  assert.equal((db.raw.prepare("SELECT value FROM app_settings WHERE key = 'container_desired'").get() as { value: string }).value, "a");
  // same mailbox again: nothing to do
  const r2 = await loadMailbox({ DB: db, ...creds }, c, await mb(), async () => { stops++; }, 1000, { pollMs: 1 });
  assert.deepEqual([r2.ok, (r2 as { switched?: boolean }).switched, stops], [true, false, 1]);
  // renaming does not restart; changing the password does
  await loadMailbox({ DB: db, ...creds }, c, await mb({ name: "Renamed" }), async () => { stops++; }, 1000, { pollMs: 1 });
  assert.equal(stops, 1);
  await loadMailbox({ DB: db, ...creds }, c, await mb({ password: "new" }), async () => { stops++; }, 1000, { pollMs: 1 });
  assert.equal(stops, 2);
});

test("loadMailbox: taking turns between two mailboxes switches each time", async () => {
  const db = makeDb();
  let stops = 0;
  const c = fakeContainer([1]);
  const A = await mb(), B = await mb({ id: "b", user: "b@example.com" });
  for (const m of [A, B, A, B]) await loadMailbox({ DB: db, ...creds }, c, m, async () => { stops++; }, 1000, { pollMs: 1 });
  assert.equal(stops, 4);
});

test("loadMailbox: a mailbox that never finishes reading is not recorded as loaded", async () => {
  const db = makeDb();
  const r = await loadMailbox({ DB: db, ...creds }, fakeContainer([null]), await mb(), async () => {}, 40, { pollMs: 5 });
  assert.equal(r.ok, false);
  assert.equal(db.raw.prepare("SELECT value FROM app_settings WHERE key = 'container_loaded'").get(), undefined);
});

test("loadMailbox: the first run with a single mailbox adopts the running container without a restart", async () => {
  const db = makeDb();
  let stops = 0;
  const r = await loadMailbox({ DB: db, ...creds }, fakeContainer([null]), await mb(), async () => { stops++; }, 1000, { onlyMailbox: true, pollMs: 1 });
  assert.deepEqual([r.ok, stops], [true, 0]);
  // ...and afterwards a changed password still triggers a restart
  const r2 = await loadMailbox({ DB: db, ...creds }, fakeContainer([1]), await mb({ password: "changed" }), async () => { stops++; }, 1000, { onlyMailbox: true, pollMs: 1 });
  assert.deepEqual([r2.ok, stops], [true, 1]);
});

test("the container starts with the chosen mailbox, else the first enabled one", async () => {
  const db = makeDb();
  const e = env(db);
  await addMailboxEntry(e, base);
  await addMailboxEntry(e, { ...base, user: "two@example.com" });
  const [a, b] = (await loadMailboxes(e)).list;
  assert.equal((await mailboxForStart(e))!.id, a.id);
  db.raw.prepare("INSERT INTO app_settings VALUES ('container_desired', ?, 0)").run(b.id);
  assert.equal((await mailboxForStart(e))!.id, b.id);
  await updateMailboxEntry(e, a.id, { enabled: false });
  db.raw.exec("DELETE FROM app_settings WHERE key = 'container_desired'");
  assert.equal((await mailboxForStart(e))!.id, b.id); // skips the paused one
});

test("cursor round-trips and defaults to zero", async () => {
  const db = makeDb();
  assert.equal(await getCursor(db), 0);
  await setCursor(db, 3);
  assert.equal(await getCursor(db), 3);
});

test("fingerprint is stable for equal mailboxes", async () => {
  assert.equal(await fingerprint(await mb()), await fingerprint(await mb()));
});
