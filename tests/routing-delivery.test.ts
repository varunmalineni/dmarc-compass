import test from "node:test";
import assert from "node:assert/strict";
import { makeBareDb } from "./d1-shim.ts";
import { applyMigrations } from "../src/migrations.ts";
import { addWebhook, runNotifications, sendDigestNow, getNotifyView } from "../src/notify.ts";
import { setAppSetting, getAppSetting, recordSync } from "../src/app-settings.ts";
import { tagsAction } from "../src/tags-admin.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const now = () => Math.floor(Date.now() / 1000);

/** Three domains with failing mail from a new sender: two in emea, one not. */
async function setup() {
  const db = makeBareDb();
  await applyMigrations(db);
  const raw = (db as any).raw;
  const t = now();
  const rep = raw.prepare("INSERT INTO dmarc_reports (hash, report_id, org_name, domain, date_begin, date_end, policy_p, policy_pct, inserted_at) VALUES (?,?,?,?,?,?,?,?,?)");
  const rec = raw.prepare("INSERT INTO dmarc_records (report_hash, source_ip, count, disposition, policy_dkim, policy_spf, header_from, domain, date_begin) VALUES (?,?,?,?,?,?,?,?,?)");
  ["shop.de", "shop.fr", "blog.com"].forEach((d, i) => {
    rep.run(`h${i}`, `r${i}`, "google.com", d, t - 86400, t - 1, "none", 100, t - 60);
    rec.run(`h${i}`, `192.0.2.${i + 1}`, 500, "none", "fail", "fail", d, d, t - 86400);
  });
  await tagsAction(db, "tags_apply", { domains: ["shop.de", "shop.fr"], add: ["emea"] });
  const env = { DB: db, CONFIG_ENCRYPTION_KEY: KEY };
  return { db, env, raw };
}

type Call = { url: string; body: any };

/** Replaces fetch for the length of one test; `failFor` lists URLs that answer 500. */
async function withSink<T>(failFor: string[], run: (calls: Call[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response("", { status: failFor.some((f) => String(url).includes(f)) ? 500 : 200 });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const hook = (path: string, filter?: unknown) => ({ url: `http://127.0.0.1:9/${path}`, type: "json", filter, digest: false });
const domainsOf = (c: Call) => c.body.alerts.map((a: any) => a.domain).sort();
const startCursor = (db: D1Database) => setAppSetting(db, "notify_cursor", String(now() - 3600));
const hasTag = (tag: string) => ({ all: [{ field: "tag", op: "has", value: tag }] });

test("each webhook receives only the alerts for its own domains", async () => {
  const { db, env } = await setup();
  await addWebhook(env, hook("all"));
  await addWebhook(env, hook("emea", hasTag("emea")));
  await addWebhook(env, hook("blog", { all: [{ field: "domain", op: "eq", value: "blog.com" }] }));
  await addWebhook(env, hook("none", hasTag("nobody")));
  await startCursor(db);
  await withSink([], async (calls) => {
    const out = await runNotifications(env);
    assert.equal(out.error, undefined);
    const to = (p: string) => calls.filter((c) => c.url.endsWith("/" + p));
    assert.deepEqual(domainsOf(to("all")[0]), ["blog.com", "shop.de", "shop.fr"]);
    assert.deepEqual(domainsOf(to("emea")[0]), ["shop.de", "shop.fr"]);
    assert.deepEqual(domainsOf(to("blog")[0]), ["blog.com"]);
    assert.equal(to("none").length, 0, "nothing is sent where nothing matches");
    assert.deepEqual(to("emea")[0].body.scope, { filter: "has tag emea" });
    assert.equal(to("all")[0].body.scope, null);
  });
});

test("an alert is sent once: a second run sends nothing", async () => {
  const { db, env } = await setup();
  await addWebhook(env, hook("emea", hasTag("emea")));
  await startCursor(db);
  await withSink([], async (calls) => {
    await runNotifications(env);
    assert.equal(calls.length, 1);
    await runNotifications(env);
    assert.equal(calls.length, 1);
  });
});

test("alerts that no webhook wants are not kept for later", async () => {
  const { db, env } = await setup();
  await addWebhook(env, hook("none", hasTag("nobody")));
  await startCursor(db);
  await withSink([], async (calls) => {
    await runNotifications(env);
    // The tag is given to a domain afterwards: the old alerts must not turn up now.
    await tagsAction(db, "tags_apply", { domains: ["blog.com"], add: ["nobody"] });
    await runNotifications(env);
    assert.equal(calls.length, 0);
  });
});

test("an alert whose webhook is down is tried again, and the others are not repeated", async () => {
  const { db, env } = await setup();
  await addWebhook(env, hook("good", { all: [{ field: "domain", op: "eq", value: "blog.com" }] }));
  await addWebhook(env, hook("down", hasTag("emea")));
  await startCursor(db);
  await withSink(["/down"], async (calls) => {
    const first = await runNotifications(env);
    assert.match(first.error ?? "", /500/);
    assert.equal(calls.filter((c) => c.url.endsWith("/good")).length, 1);
    assert.equal(calls.filter((c) => c.url.endsWith("/down")).length, 1);
    const cursor = await getAppSetting(db, "notify_cursor");
    assert.ok(Number(cursor) < now() - 3000, "the cursor stays behind until everything wanted has gone out");
  });
  await withSink([], async (calls) => {
    await runNotifications(env);
    assert.deepEqual(calls.map((c) => c.url.split("/").pop()), ["down"], "only the one that failed is sent again");
    assert.deepEqual(domainsOf(calls[0]), ["shop.de", "shop.fr"]);
  });
});

test("the sync problem alert reaches every webhook, whatever its filter", async () => {
  const { db, env, raw } = await setup();
  await addWebhook(env, hook("none", hasTag("nobody")));
  await addWebhook(env, hook("emea", hasTag("emea")));
  await startCursor(db);
  raw.prepare("DELETE FROM dmarc_records").run();
  raw.prepare("DELETE FROM dmarc_reports").run();
  await withSink([], async (calls) => {
    await recordSync(db, false, "login failed");
    await runNotifications(env);
    assert.deepEqual(calls.map((c) => c.url.split("/").pop()).sort(), ["emea", "none"]);
    assert.ok(calls.every((c) => c.body.alerts.some((a: any) => a.problem === "sync_failed")));
  });
});

test("the digest is built for each webhook's own domains, and skipped where none match", async () => {
  const { env } = await setup();
  await addWebhook(env, { url: "http://127.0.0.1:9/all", type: "json" });
  await addWebhook(env, { url: "http://127.0.0.1:9/emea", type: "json", filter: hasTag("emea") });
  await addWebhook(env, { url: "http://127.0.0.1:9/none", type: "json", filter: hasTag("nobody") });
  await withSink([], async (calls) => {
    const res = await sendDigestNow(env);
    assert.equal(res.ok, true);
    const to = (p: string) => calls.filter((c) => c.url.endsWith("/" + p));
    assert.equal(to("none").length, 0);
    assert.equal(to("all").length, 1);
    assert.equal(to("emea").length, 1);
    assert.equal(to("emea")[0].body.scope.filter, "has tag emea");
    assert.equal(to("emea")[0].body.scope.domains, 2);
    assert.equal(to("all")[0].body.scope, null);
    assert.equal(to("emea")[0].body.domains.total, 2);
    assert.equal(to("all")[0].body.domains.total, 3);
    const view = await getNotifyView(env);
    assert.match(view.hooks.find((h) => h.filterText === "has tag nobody")!.result!.detail, /no domain matches/);
  });
});

test("nothing to send to anyone is an error for 'send digest now'", async () => {
  const { env } = await setup();
  await addWebhook(env, { url: "http://127.0.0.1:9/none", type: "json", filter: hasTag("nobody") });
  await withSink([], async (calls) => {
    const res = await sendDigestNow(env);
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0);
  });
});
