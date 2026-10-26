import test from "node:test";
import assert from "node:assert/strict";
import { makeBareDb } from "./d1-shim.ts";
import { applyMigrations } from "../src/migrations.ts";
import { syncReports, readReportList, writePending, MAX_NEW_REPORTS, RECENT_DAYS } from "../src/sync.ts";

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

interface Fake {
  org: string;
  id: string;
  domain: string;
  daysAgo: number;
  ips?: string[];
}

/** A stand-in for the parser container serving a list of reports. */
function container(reports: Fake[], salt = "a") {
  const hashOf = (r: Fake) => `${salt}:${r.org}:${r.id}:${r.domain}`;
  const calls = { list: 0, report: 0 };
  return {
    calls,
    async fetch(req: Request): Promise<Response> {
      const u = new URL(req.url);
      if (u.pathname === "/dmarc-reports") {
        calls.list++;
        const rows = reports.map((r) => {
          const end = NOW - r.daysAgo * DAY;
          return { hash: hashOf(r), id: r.id, org: r.org, domain: r.domain, date_begin: end - DAY, date_end: end, records: 1, flagged_dkim: false, flagged_spf: false, flagged_dmarc: false, flagged: false };
        });
        return new Response(JSON.stringify(rows));
      }
      const m = u.pathname.match(/^\/dmarc-reports\/([^/]+)\/json$/);
      if (m) {
        calls.report++;
        const r = reports.find((x) => hashOf(x) === decodeURIComponent(m[1]))!;
        const end = NOW - r.daysAgo * DAY;
        return Response.json({
          report_metadata: { org_name: r.org, email: "x@example.com", report_id: r.id, date_range: { begin: end - DAY, end } },
          policy_published: { domain: r.domain, p: "none", pct: 100 },
          record: (r.ips ?? ["192.0.2.1"]).map((ip, i) => ({
            row: { source_ip: ip, count: 10 + i, policy_evaluated: { disposition: "none", dkim: "pass", spf: i ? "fail" : "pass" } },
            identifiers: { header_from: r.domain },
            auth_results: { dkim: [{ domain: r.domain, result: "pass" }], spf: [{ domain: r.domain, result: i ? "fail" : "pass" }] },
          })),
        });
      }
      if (u.pathname === "/tls-reports") return new Response("[]");
      if (u.pathname === "/ips/dns/batch") return Response.json(((await req.json()) as string[]).map(() => null));
      return new Response("nope", { status: 404 });
    },
  };
}

async function setup() {
  const db = makeBareDb();
  await applyMigrations(db);
  return { db, env: { DB: db, ADMIN_USER: "u", ADMIN_PASSWORD: "p" } };
}

const count = (db: ReturnType<typeof makeBareDb>, table: string) => (db.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
const many = (n: number, daysAgo = 3): Fake[] => Array.from({ length: n }, (_, i) => ({ org: "google.com", id: `id-${i}`, domain: `d${i % 50}.example`, daysAgo: daysAgo + (i % 5) }));

test("a first sync stores reports and records; a second finds nothing new and has nothing queued", async () => {
  const { db, env } = await setup();
  const c = container([
    { org: "google.com", id: "g1", domain: "a.example", daysAgo: 2, ips: ["192.0.2.1", "192.0.2.2"] },
    { org: "yahoo", id: "y1", domain: "a.example", daysAgo: 400 },
  ]);
  const r1 = await syncReports(c, env, "default");
  assert.deepEqual([r1.newReports, r1.newRecords], [2, 3]);
  assert.equal(count(db, "dmarc_reports"), 2);
  assert.equal(count(db, "dmarc_records"), 3);
  assert.equal(r1.backlog, false, "the old report was reached in the same sync");
  assert.equal((db.raw.prepare("SELECT mailbox_id m FROM dmarc_reports LIMIT 1").get() as { m: string }).m, "default");

  const before = c.calls.report;
  const r2 = await syncReports(c, env, "default");
  assert.deepEqual([r2.newReports, r2.newRecords, r2.backlog], [0, 0, false]);
  assert.equal(c.calls.report, before, "nothing is downloaded again");
  assert.equal(count(db, "dmarc_records"), 3);
});

test("the container restarting (new hashes for the same reports) does not store anything twice", async () => {
  const { db, env } = await setup();
  await syncReports(container(many(40), "first"), env, "default");
  const r = await syncReports(container(many(40), "second-run-different-hashes"), env, "default");
  assert.equal(r.newReports, 0);
  assert.equal(count(db, "dmarc_reports"), 40);
  assert.equal(count(db, "dmarc_records"), 40);
});

test("two copies of one report (same reporter, id, domain) are stored once, with their records once", async () => {
  const { db, env } = await setup();
  const dup: Fake = { org: "google.com", id: "same", domain: "a.example", daysAgo: 1, ips: ["192.0.2.1", "192.0.2.2"] };
  const c = container([dup, { ...dup }]);
  // The same identity appears twice in the list; both get the same hash here, which is the harder case for the records.
  const r = await syncReports(c, env, "default");
  assert.equal(r.newReports, 1);
  assert.equal(count(db, "dmarc_reports"), 1);
  assert.equal(count(db, "dmarc_records"), 2);
});

test("a copy of a stored report that arrives under a different hash adds no records", async () => {
  const { db, env } = await setup();
  const one: Fake[] = [{ org: "google.com", id: "x", domain: "a.example", daysAgo: 1, ips: ["192.0.2.1", "192.0.2.2"] }];
  await syncReports(container(one, "a"), env, "default");
  db.raw.exec("DELETE FROM app_settings WHERE key LIKE 'backfill:%'");
  await syncReports(container(one, "b"), env, "default");
  assert.equal(count(db, "dmarc_reports"), 1);
  assert.equal(count(db, "dmarc_records"), 2);
});

test("a big import is copied a slice at a time and reports that more is waiting", async () => {
  const { db, env } = await setup();
  const total = MAX_NEW_REPORTS * 2 + 100;
  const c = container(many(total));
  const r1 = await syncReports(c, env, "default");
  assert.equal(r1.newReports, MAX_NEW_REPORTS);
  assert.equal(r1.backlog, true);
  const r2 = await syncReports(c, env, "default");
  assert.equal(r2.newReports, MAX_NEW_REPORTS);
  assert.equal(r2.backlog, true);
  const r3 = await syncReports(c, env, "default");
  assert.equal(r3.newReports, 100);
  assert.equal(r3.backlog, false);
  assert.equal(count(db, "dmarc_reports"), total);
  assert.equal(count(db, "dmarc_records"), total);
});

test("the newest reports are copied first", async () => {
  const { db, env } = await setup();
  const reports = many(MAX_NEW_REPORTS + 50, 1).map((r, i) => ({ ...r, daysAgo: 1 + i * 0.01 }));
  const oldest = reports.at(-1)!;
  await syncReports(container(reports), env, "default");
  assert.equal(count(db, "dmarc_reports"), MAX_NEW_REPORTS);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM dmarc_reports WHERE report_id = ?").get(oldest.id) as { n: number }).n, 0);
});

test("history older than the recent window is walked in steps when it is too big to hold", async () => {
  const { db, env } = await setup();
  // 3 recent + 90 old reports spread over 90 days: more than the (shrunk) memory cap allows at once.
  const reports: Fake[] = [...many(3, 2), ...Array.from({ length: 90 }, (_, i) => ({ org: "yahoo", id: `old-${i}`, domain: "b.example", daysAgo: RECENT_DAYS + 5 + i }))];
  const list = await readReportList(new Response(JSON.stringify(reports.map((r) => ({ hash: r.id, id: r.id, org: r.org, domain: r.domain, date_begin: 0, date_end: NOW - r.daysAgo * DAY })))).body!, NOW, NOW - RECENT_DAYS * DAY, 20);
  assert.equal(list.recent.length, 3);
  assert.ok(list.older.length <= 20 + 2, `kept ${list.older.length}`);
  assert.ok(list.droppedBelow !== null && list.older.every((e) => e.end >= list.droppedBelow!), "everything kept is newer than what was dropped");
  assert.equal(list.total, 93);
  // and without a cap, everything older is kept and nothing is dropped
  const all = await readReportList(new Response(JSON.stringify(reports.map((r) => ({ hash: r.id, id: r.id, org: r.org, domain: r.domain, date_begin: 0, date_end: NOW - r.daysAgo * DAY })))).body!, NOW, NOW - RECENT_DAYS * DAY);
  assert.equal(all.older.length, 90);
  assert.equal(all.droppedBelow, null);
  void db; void env;
});

test("a late report inside the recent window is picked up by the next sync", async () => {
  const { db, env } = await setup();
  const base = many(10);
  const c = container(base);
  await syncReports(c, env, "default");
  const late: Fake = { org: "mimecast", id: "late", domain: "z.example", daysAgo: 20 };
  const r = await syncReports(container([...base, late]), env, "default");
  assert.equal(r.newReports, 1);
  assert.equal(count(db, "dmarc_reports"), 11);
});

test("history is checked again after a month, to catch very late arrivals", async () => {
  const { db, env } = await setup();
  const base = many(5);
  await syncReports(container(base), env, "default");
  const lateOld: Fake = { org: "mimecast", id: "very-late", domain: "z.example", daysAgo: 200 };
  assert.equal((await syncReports(container([...base, lateOld]), env, "default")).newReports, 0, "not looked for yet");
  const st = JSON.parse((db.raw.prepare("SELECT value v FROM app_settings WHERE key = 'backfill:default'").get() as { v: string }).v);
  st.doneAt = NOW - 31 * DAY;
  db.raw.prepare("UPDATE app_settings SET value = ? WHERE key = 'backfill:default'").run(JSON.stringify(st));
  assert.equal((await syncReports(container([...base, lateOld]), env, "default")).newReports, 1);
});

test("each mailbox keeps its own place in the history", async () => {
  const { db, env } = await setup();
  await syncReports(container(many(3)), env, "one");
  const keys = (db.raw.prepare("SELECT key FROM app_settings WHERE key LIKE 'backfill:%'").all() as Array<{ key: string }>).map((r) => r.key);
  assert.deepEqual(keys, ["backfill:one"]);
});

test("new IPs are enriched in bulk, and addresses that cannot be located are not retried every sync", async () => {
  const { db, env } = await setup();
  const ips = Array.from({ length: 120 }, (_, i) => `198.51.100.${i + 1}`);
  const c = container([{ org: "google.com", id: "many-ips", domain: "a.example", daysAgo: 1, ips }]);
  const r = await syncReports(c, env, "default");
  assert.equal(r.newIpsResolved, 120);
  assert.equal(count(db, "ip_enrichment"), 120);
  const tried = (db.raw.prepare("SELECT COUNT(*) n FROM ip_enrichment WHERE loc_tried_at IS NOT NULL").get() as { n: number }).n;
  assert.equal(tried, 30, "the first 30 were attempted (the fake has no locations) and marked");
  await syncReports(c, env, "default");
  const tried2 = (db.raw.prepare("SELECT COUNT(*) n FROM ip_enrichment WHERE loc_tried_at IS NOT NULL").get() as { n: number }).n;
  assert.equal(tried2, 60, "the next 30 were tried, not the same 30 again");
});

test("a long history is walked back over several syncs and every report ends up stored once", async () => {
  const { db, env } = await setup();
  const reports: Fake[] = [...many(3, 2), ...Array.from({ length: 90 }, (_, i) => ({ org: "yahoo", id: `old-${i}`, domain: "b.example", daysAgo: RECENT_DAYS + 5 + i }))];
  const c = container(reports);
  let runs = 0;
  let last = await syncReports(c, env, "m", { keepEntries: 20 });
  const stored = [count(db, "dmarc_reports")];
  while (last.backlog && runs < 20) {
    runs++;
    last = await syncReports(c, env, "m", { keepEntries: 20 });
    stored.push(count(db, "dmarc_reports"));
  }
  assert.ok(runs >= 3 && runs < 10, `took ${runs + 1} syncs`);
  assert.equal(last.backlog, false);
  assert.equal(count(db, "dmarc_reports"), 93);
  assert.equal(count(db, "dmarc_records"), 93);
  assert.ok(stored.every((n, i) => i === 0 || n >= stored[i - 1]), "progress never goes backwards");
  assert.equal(JSON.parse((db.raw.prepare("SELECT value v FROM app_settings WHERE key = 'backfill:m'").get() as { v: string }).v).cursor, 0);
  const reports2 = c.calls.report;
  await syncReports(c, env, "m", { keepEntries: 20 });
  assert.equal(c.calls.report, reports2, "once finished, nothing is fetched again");
});

test("the batch writer skips records of a report it ignored as a copy, and never doubles records", async () => {
  const { db, env } = await setup();
  const rep = (hash: string) => ({ hash, id: "same", org: "google.com", domain: "a.example", begin: 1, end: 2, p: "none", pct: 100 });
  const rec = (h: string, ip: string) => ({ h, ip, n: 5, disp: "none", dkim: "pass", spf: "pass", adkim: "pass", aspf: "pass", from: "a.example", domain: "a.example", begin: 1 });
  const first = await writePending(env, "m", { reports: [rep("h1"), rep("h2")], records: [rec("h1", "192.0.2.1"), rec("h1", "192.0.2.2"), rec("h2", "192.0.2.1")] });
  assert.deepEqual(first, { reports: 1, records: 2 });
  // the same hash again: the report is ignored and its records are not added a second time
  const again = await writePending(env, "m", { reports: [rep("h1")], records: [rec("h1", "192.0.2.1")] });
  assert.deepEqual(again, { reports: 0, records: 0 });
  assert.equal(count(db, "dmarc_records"), 2);
  assert.equal(count(db, "dmarc_reports"), 1);
});
