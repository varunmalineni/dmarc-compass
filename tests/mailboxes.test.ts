import test from "node:test";
import assert from "node:assert/strict";
import { addMailbox, updateMailbox, removeMailbox, parseMailboxes, legacyMailbox, toView, fingerprint, connectionKey, containerEnv, validateHost, MAX_MAILBOXES, type Mailbox } from "../src/mailboxes.ts";

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}
const base = { host: "imap.example.com", user: "dmarc@example.com", password: "pw", folder: "" };

test("add: valid mailbox is stored with sensible defaults", () => {
  const r = must(addMailbox([], { ...base, name: "  Main  " }, "m1"));
  assert.deepEqual(r.mailbox, { id: "m1", name: "Main", host: "imap.example.com", user: "dmarc@example.com", password: "pw", folder: "", enabled: true });
});

test("add: the nickname defaults to the user", () => {
  assert.equal(must(addMailbox([], base, "m1")).mailbox.name, "dmarc@example.com");
});

test("add: rejects missing fields, bad hosts, duplicates and the maximum", () => {
  assert.equal(addMailbox([], { ...base, host: "" }, "a").ok, false);
  assert.equal(addMailbox([], { ...base, user: "" }, "a").ok, false);
  assert.equal(addMailbox([], { ...base, password: "" }, "a").ok, false);
  for (const bad of ["imaps://imap.example.com", "https://x.example", "imap.example.com/inbox", "imap example.com", "a;b", "x".repeat(300)]) {
    assert.equal(validateHost(bad).ok, false, bad);
  }
  const one = must(addMailbox([], base, "a")).list;
  assert.equal(addMailbox(one, { ...base, host: "IMAP.EXAMPLE.COM", user: "DMARC@example.com" }, "b").ok, false); // same login, same folder
  assert.equal(addMailbox(one, { ...base, folder: "Reports" }, "b").ok, true); // same login, other folder is fine
  let list: Mailbox[] = [];
  for (let i = 0; i < MAX_MAILBOXES; i++) list = must(addMailbox(list, { ...base, user: `u${i}@example.com` }, `m${i}`)).list;
  assert.equal(addMailbox(list, { ...base, user: "extra@example.com" }, "x").ok, false);
});

test("update: blank password keeps the old one, a new one replaces it", () => {
  const list = must(addMailbox([], base, "m1")).list;
  assert.equal(must(updateMailbox(list, "m1", { name: "Renamed", password: "" })).list[0].password, "pw");
  assert.equal(must(updateMailbox(list, "m1", { password: "new" })).list[0].password, "new");
  assert.equal(must(updateMailbox(list, "m1", {})).list[0].name, list[0].name);
});

test("update: validates, can disable, and cannot collide with another mailbox", () => {
  let list = must(addMailbox([], base, "a")).list;
  list = must(addMailbox(list, { ...base, user: "other@example.com" }, "b")).list;
  assert.equal(updateMailbox(list, "b", { user: "dmarc@example.com" }).ok, false);
  assert.equal(updateMailbox(list, "b", { host: "not a host" }).ok, false);
  assert.equal(updateMailbox(list, "nope", { name: "x" }).ok, false);
  assert.equal(must(updateMailbox(list, "b", { enabled: false })).list[1].enabled, false);
});

test("remove drops only the chosen mailbox", () => {
  let list = must(addMailbox([], base, "a")).list;
  list = must(addMailbox(list, { ...base, user: "o@example.com" }, "b")).list;
  assert.deepEqual(removeMailbox(list, "a").map((m) => m.id), ["b"]);
});

test("parse: tolerates garbage and skips bad entries", () => {
  assert.deepEqual(parseMailboxes("nope"), []);
  assert.deepEqual(parseMailboxes("{}"), []);
  const good = { id: "a", name: "A", host: "imap.example.com", user: "u", password: "p", folder: "X", enabled: false };
  const out = parseMailboxes(JSON.stringify([good, null, 4, { ...good, id: "b", host: "bad host" }, { ...good, id: "c", password: "" }, good]));
  assert.deepEqual(out.map((m) => m.id), ["a"]);
  assert.equal(out[0].enabled, false);
});

test("the view never contains the password", () => {
  const m = must(addMailbox([], { ...base, password: "topsecret" }, "a")).mailbox;
  assert.ok(!JSON.stringify(toView(m, "saved")).includes("topsecret"));
});

test("legacy single mailbox becomes the default entry; INBOX is shown as blank", () => {
  const m = legacyMailbox({ IMAP_HOST: "imap.zoho.com", IMAP_USER: "me@example.com", IMAP_PASSWORD: "p", IMAP_FOLDER: "INBOX" })!;
  assert.equal(m.id, "default");
  assert.equal(m.folder, "");
  assert.equal(legacyMailbox({ IMAP_HOST: "", IMAP_USER: "u", IMAP_PASSWORD: "p", IMAP_FOLDER: "" }), null);
  assert.equal(legacyMailbox({ IMAP_HOST: "bad host", IMAP_USER: "u", IMAP_PASSWORD: "p", IMAP_FOLDER: "" }), null);
});

test("fingerprint changes exactly when a connection detail changes", async () => {
  const m = must(addMailbox([], base, "a")).mailbox;
  const f = await fingerprint(m);
  assert.equal(await fingerprint({ ...m }), f);
  assert.equal(await fingerprint({ ...m, name: "Renamed", enabled: false }), f); // cosmetic: no restart
  assert.equal(await fingerprint({ ...m, host: "IMAP.EXAMPLE.COM" }), f); // host case is not a change
  assert.notEqual(await fingerprint({ ...m, password: "other" }), f);
  assert.notEqual(await fingerprint({ ...m, folder: "Reports" }), f);
  assert.notEqual(await fingerprint({ ...m, user: "x@example.com" }), f);
  assert.ok(!f.includes("pw") && f.length === 24);
  assert.equal(await fingerprint({ ...m, folder: "" }), await fingerprint({ ...m, folder: "INBOX" })); // blank means INBOX
  assert.ok(connectionKey(m).includes("pw")); // the key itself holds the password: never store or log it
});

test("the fingerprint carries the parser-authentication marker, so changing the scheme restarts every parser once", async () => {
  const m = must(addMailbox([], base, "a")).mailbox;
  assert.equal(connectionKey(m), JSON.stringify(["a", "imap.example.com", "dmarc@example.com", "pw", "INBOX", "auth2"]));
  assert.equal(await fingerprint(m, 900), await fingerprint(m));
  assert.notEqual(await fingerprint(m, 300), await fingerprint(m, 900));
  assert.notEqual(await fingerprint(m, 300), await fingerprint(m, 600));
});

test("container environment", () => {
  const m = must(addMailbox([], { ...base, folder: "Reports" }, "a")).mailbox;
  assert.deepEqual(containerEnv(m), { IMAP_HOST: "imap.example.com", IMAP_PORT: "993", IMAP_USER: "dmarc@example.com", IMAP_PASSWORD: "pw", IMAP_FOLDER: "Reports" });
  assert.equal(containerEnv({ ...m, folder: "" }).IMAP_FOLDER, "INBOX");
});
