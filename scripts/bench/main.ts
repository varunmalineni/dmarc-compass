// Scale benchmark. Runs the app's real query and render code against a
// generated SQLite database shaped like the production schema.
//
//   npm run bench -- typical        # 1,500 domains, 90 days
//   npm run bench -- stress         # 1,500 domains, 2 years
//   npm run bench -- typical --regen

import { existsSync, statSync, unlinkSync } from "node:fs";
import { BenchDb, type Logged } from "./bench-db.ts";
import { generate, SIZES } from "./gen.ts";
import { ensureSchema } from "../../src/migrations";
import { parseFilters, parseList } from "../../src/filters";
import { loadFilters } from "../../src/tags";
import { loadOverview, SOURCE_SORT_KEYS } from "../../src/dashboard-data";
import { renderOverviewBody } from "../../src/dashboard-html";
import { loadDomains, loadChrome, DOMAIN_SORT_KEYS } from "../../src/domains-data";
import { renderDomainsBody } from "../../src/domains-html";
import { loadReportsList, loadReportDetail, REPORT_SORT_KEYS } from "../../src/reports-data";
import { renderReportsBody, renderReportDetailBody } from "../../src/reports-html";
import { loadTls } from "../../src/tls-data";
import { renderTlsBody } from "../../src/tls-html";
import { loadMapPoints } from "../../src/map-data";
import { renderMapBody } from "../../src/map-html";
import { loadSummary } from "../../src/report-data";
import { renderSummary } from "../../src/report-html";
import { buildExport, DATASETS, type Dataset } from "../../src/exports";
import { layout } from "../../src/shared-ui";
import { previewAlerts, collectDigest, collectAlerts } from "../../src/notify";
import { DEFAULT_CONFIG } from "../../src/notify-config";
import { syncReports } from "../../src/sync";

const size = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "typical";
const regen = process.argv.includes("--regen");
const quick = process.argv.includes("--quick");
const scale = SIZES[size];
if (!scale) throw new Error(`unknown size "${size}" (${Object.keys(SIZES).join(", ")})`);

const path = `/tmp/dmarc-bench-${size}.db`;
if (regen && existsSync(path)) for (const f of [path, path + "-wal", path + "-shm"]) existsSync(f) && unlinkSync(f);
const fresh = !existsSync(path);
const bench = new BenchDb(path);
const db = bench.asD1();
await ensureSchema(db);

const count = (sql: string) => (bench.raw.prepare(sql).get() as { n: number }).n;
if (fresh) {
  process.stdout.write(`generating ${size} (${scale.domains} domains x ${scale.days} days)... `);
  const g = generate(bench.raw, scale);
  console.log(`${g.seconds.toFixed(0)}s`);
}
const stats = {
  reports: count("SELECT COUNT(*) n FROM dmarc_reports"),
  records: count("SELECT COUNT(*) n FROM dmarc_records"),
  domains: count("SELECT COUNT(DISTINCT domain) n FROM dmarc_reports"),
  messages: count("SELECT SUM(count) n FROM dmarc_records"),
  tls: count("SELECT COUNT(*) n FROM tls_policy_results"),
};
const mb = (statSync(path).size / 1048576).toFixed(0);
console.log(`\n== ${size}: ${stats.domains.toLocaleString()} domains, ${stats.reports.toLocaleString()} reports, ${stats.records.toLocaleString()} records, ${stats.messages.toLocaleString()} messages, ${stats.tls.toLocaleString()} TLS results, database ${mb} MB\n`);

// ------------------------------------------------------------------ helpers --

interface Row {
  name: string;
  ms: number;
  dbMs: number;
  queries: number;
  slowest: { ms: number; sql: string; args: unknown[] } | null;
  extra: string;
  log: Logged[];
}
const rows: Row[] = [];
const BASE = "http://localhost";
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function measure(name: string, fn: () => Promise<string | void>, runs = quick ? 1 : 3): Promise<Row> {
  const times: number[] = [];
  let best: Row | null = null;
  const all: Row[] = [];
  for (let i = 0; i < runs; i++) {
    bench.start();
    const t0 = performance.now();
    const extra = (await fn()) ?? "";
    const ms = performance.now() - t0;
    const log = bench.stop();
    times.push(ms);
    const slowest = log.length ? log.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
    all.push({ name, ms, dbMs: log.reduce((a, l) => a + l.ms, 0), queries: log.length, slowest: slowest && { ms: slowest.ms, sql: slowest.sql, args: slowest.args }, extra, log });
  }
  best = all.sort((a, b) => a.ms - b.ms)[Math.floor(all.length / 2)];
  best.ms = median(times);
  rows.push(best);
  return best;
}

const kb = (s: string) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB`;

async function page(path: string, which: "overview" | "domains" | "reports" | "tls" | "map" | "report" | "detail"): Promise<string> {
  const url = new URL(BASE + path);
  const f = await loadFilters(db, url);
  let html = "";
  if (which === "overview") {
    const list = parseList(url, SOURCE_SORT_KEYS, "risk", "desc");
    const [data, chrome] = await Promise.all([loadOverview(db, f, list), loadChrome(db)]);
    const { body, scripts } = renderOverviewBody(data, f, list, url, chrome.allDomains.length);
    html = layout({ title: "Overview", subtitle: "", active: "overview", url, filters: f, chrome, body, scripts, charts: true });
  } else if (which === "domains") {
    const list = parseList(url, DOMAIN_SORT_KEYS, "risk", "desc");
    const [data, chrome] = await Promise.all([loadDomains(db, f, list), loadChrome(db)]);
    html = layout({ title: "Domains", subtitle: "", active: "domains", url, filters: f, chrome, body: renderDomainsBody(data, f, list, url) });
  } else if (which === "reports") {
    const list = parseList(url, REPORT_SORT_KEYS, "date", "desc");
    const fp = url.searchParams.get("filter");
    const filter = fp === "dkim" || fp === "spf" || fp === "any" ? fp : "all";
    const [data, chrome] = await Promise.all([loadReportsList(db, f, list, filter), loadChrome(db)]);
    html = layout({ title: "Reports", subtitle: "", active: "reports", url, filters: f, chrome, body: renderReportsBody(data, f, list, filter, url) });
  } else if (which === "tls") {
    const [data, chrome] = await Promise.all([loadTls(db, f), loadChrome(db)]);
    html = layout({ title: "TLS", subtitle: "", active: "tls", url, filters: f, chrome, body: renderTlsBody(data, f, url) });
  } else if (which === "map") {
    const [data, chrome] = await Promise.all([loadMapPoints(db, f), loadChrome(db)]);
    const { body, scripts } = renderMapBody(data, f);
    html = layout({ title: "Map", subtitle: "", active: "map", url, filters: f, chrome, body, scripts, leaflet: true });
  } else if (which === "report") {
    html = renderSummary(await loadSummary(db, f), { downloadHref: "#", backHref: "/" });
  } else {
    const hash = (bench.raw.prepare("SELECT hash FROM dmarc_reports ORDER BY date_end DESC LIMIT 1").get() as { hash: string }).hash;
    const [detail, chrome] = await Promise.all([loadReportDetail(db, hash), loadChrome(db)]);
    const { body, scripts } = renderReportDetailBody(detail!, f, null);
    html = layout({ title: "Detail", subtitle: "", active: "reports", url, chrome, body, scripts });
  }
  return html;
}

const someDomains = (n: number) => (bench.raw.prepare(`SELECT DISTINCT domain FROM dmarc_reports ORDER BY domain LIMIT ${n}`).all() as Array<{ domain: string }>).map((r) => r.domain);
const oneDomain = someDomains(1)[0];
const busy = (bench.raw.prepare("SELECT domain FROM dmarc_reports GROUP BY domain ORDER BY COUNT(*) DESC LIMIT 1").get() as { domain: string }).domain;
const d25 = encodeURIComponent(someDomains(25).join(","));

// ---- tags: about a quarter of the domains get tags by hand, and two rules add more

if (count("SELECT COUNT(*) n FROM domain_tags") === 0) {
  const all = (bench.raw.prepare("SELECT DISTINCT domain FROM dmarc_reports ORDER BY domain").all() as Array<{ domain: string }>).map((r) => r.domain);
  const ins = bench.raw.prepare("INSERT OR IGNORE INTO domain_tags (domain, tag) VALUES (?, ?)");
  bench.raw.exec("BEGIN");
  all.forEach((d, i) => {
    if (i % 4 === 0) ins.run(d, "tier-1");
    if (i % 7 === 0) ins.run(d, "team-a");
    if (i % 11 === 0) ins.run(d, "eu");
  });
  bench.raw.exec("COMMIT");
  const rules = [{ id: "r1", tag: "numbered-low", expr: { field: "domain", op: "starts", value: "d00" } }, { id: "r2", tag: "ends-7", expr: { field: "domain", op: "ends", value: "7.example" } }];
  bench.raw.prepare("INSERT OR REPLACE INTO app_settings VALUES ('tag_rules', ?, 0)").run(JSON.stringify(rules));
}

// -------------------------------------------------------------------- pages --

const P: Array<[string, string, Parameters<typeof page>[1]]> = [
  ["Overview, all domains, 7d", "/?range=7", "overview"],
  ["Overview, all domains, 30d", "/?range=30", "overview"],
  ["Overview, all domains, 90d (default)", "/", "overview"],
  ["Overview, all domains, 1y", "/?range=365", "overview"],
  ["Overview, all domains, all time", "/?range=all", "overview"],
  ["Overview, 1 quiet domain, 90d", `/?domains=${oneDomain}`, "overview"],
  ["Overview, 1 busy domain, all time", `/?domains=${busy}&range=all`, "overview"],
  ["Overview, 25 domains, 90d", `/?domains=${d25}`, "overview"],
  ["Overview, sources searched ('out-1')", "/?q=out-1", "overview"],
  ["Overview, tag filter (any 1 of ~400 domains), 90d", "/?tag=tier-1", "overview"],
  ["Overview, tag AND NOT (tier-1 and not eu), 90d", `/?f=${encodeURIComponent(JSON.stringify({ all: [{ field: "tag", op: "has", value: "tier-1" }, { field: "tag", op: "not_has", value: "eu" }] }))}`, "overview"],
  ["Overview, policy filter (needs latest policies), 90d", `/?f=${encodeURIComponent(JSON.stringify({ field: "policy", op: "is", value: "reject" }))}`, "overview"],
  ["Domains, with tags column, 90d (default)", "/domains", "domains"],
  ["Domains, tag filter", "/domains?tag=team-a", "domains"],
  ["Reports list, tag filter, 90d", "/reports?tag=eu", "reports"],
  ["Domains, 90d (default)", "/domains", "domains"],
  ["Domains, all time", "/domains?range=all", "domains"],
  ["Domains, searched", "/domains?q=d01", "domains"],
  ["Reports list, 90d", "/reports", "reports"],
  ["Reports list, all time", "/reports?range=all", "reports"],
  ["Reports list, problems only, 90d", "/reports?filter=any", "reports"],
  ["Reports list, searched", "/reports?q=goo", "reports"],
  ["Report detail", "/reports/x", "detail"],
  ["TLS, 90d", "/tls-reports", "tls"],
  ["Map, 90d", "/map", "map"],
  ["Map, all time", "/map?range=all", "map"],
  ["Summary report, 30d", "/report?range=30", "report"],
  ["Summary report, 90d", "/report", "report"],
  ["Summary report, all time", "/report?range=all", "report"],
];
for (const [name, path, which] of P) {
  await measure(`page: ${name}`, async () => `${kb(await page(path, which))}`);
}

// ------------------------------------------------------------------ exports --

for (const d of DATASETS) {
  await measure(`export: ${d}, 90d`, async () => {
    const r = await buildExport(db, d as Dataset, { filters: parseFilters(new URL(BASE + "/")), q: "", problem: "all" });
    return `${r.rows.length.toLocaleString()} rows${r.truncated ? " (capped)" : ""}`;
  });
}
await measure("export: reports, all time", async () => {
  const r = await buildExport(db, "reports", { filters: parseFilters(new URL(BASE + "/?range=all")), q: "", problem: "all" });
  return `${r.rows.length.toLocaleString()} rows${r.truncated ? " (capped)" : ""}`;
});
await measure("export: records, all time", async () => {
  const r = await buildExport(db, "records", { filters: parseFilters(new URL(BASE + "/?range=all")), q: "", problem: "all" });
  return `${r.rows.length.toLocaleString()} rows${r.truncated ? " (capped)" : ""}`;
});

// ------------------------------------------------------ alerts and the digest --

const env = { DB: db };
bench.raw.prepare("INSERT OR REPLACE INTO app_settings VALUES ('notify_config', ?, 0)").run(JSON.stringify(DEFAULT_CONFIG));
await measure("alerts: preview (last 7 days)", async () => `${(await previewAlerts(env)).count} alerts`);
await measure("digest: weekly data", async () => {
  const d = await collectDigest(env, { ...DEFAULT_CONFIG, digest: { ...DEFAULT_CONFIG.digest, mode: "weekly" } }, Math.floor(Date.now() / 1000));
  return `${d.cur.total.toLocaleString()} messages`;
});
await measure("alerts: after a sync (cursor = last 15 min)", async () => {
  // what runs every sync: only data ingested since the last evaluation
  bench.raw.prepare("UPDATE dmarc_reports SET inserted_at = ? WHERE hash IN (SELECT hash FROM dmarc_reports ORDER BY rowid DESC LIMIT 60)").run(Math.floor(Date.now() / 1000) - 60);
  const now = Math.floor(Date.now() / 1000);
  const r = await collectAlerts(env, DEFAULT_CONFIG, { cursor: now - 900, now, lookbackSince: now - 3 * 86400 });
  return `${r.alerts.length} candidate alerts`;
});

// --------------------------------------------------------------------- sync --

async function syncCase(label: string, missing: number, opts: { oldest?: boolean; freshWalk?: boolean } = {}): Promise<void> {
  const headers = bench.raw.prepare("SELECT hash, report_id id, org_name org, domain, date_begin, date_end FROM dmarc_reports").all() as Array<Record<string, unknown>>;
  // Steady state and catch-up: the newest reports are the missing ones. Backfill: the oldest are, and the history walk starts over.
  const byAge = [...headers].sort((a, b) => Number(a.date_end) - Number(b.date_end));
  const cut = (opts.oldest ? byAge.slice(0, missing) : byAge.slice(-missing)).map((h) => String(h.hash));
  if (opts.freshWalk) bench.raw.exec("DELETE FROM app_settings WHERE key LIKE 'backfill:%'");
  let peak = 0;
  let lastGc = 0;
  // Live memory only: measured after a collection, while the sync holds its list entries (when it fetches reports).
  const sample = () => {
    if (Date.now() - lastGc < 200) return;
    global.gc?.();
    lastGc = Date.now();
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  };
  const stash = new Map<string, { rep: Record<string, unknown>; recs: Array<Record<string, unknown>> }>();
  for (const h of cut) {
    stash.set(h, {
      rep: bench.raw.prepare("SELECT * FROM dmarc_reports WHERE hash = ?").get(h) as Record<string, unknown>,
      recs: bench.raw.prepare("SELECT * FROM dmarc_records WHERE report_hash = ?").all(h) as Array<Record<string, unknown>>,
    });
  }
  bench.raw.exec("BEGIN");
  for (const h of cut) {
    bench.raw.prepare("DELETE FROM dmarc_records WHERE report_hash = ?").run(h);
    bench.raw.prepare("DELETE FROM dmarc_reports WHERE hash = ?").run(h);
  }
  bench.raw.exec("COMMIT");

  // The list is produced lazily, as the real container streams it, so the heap measured is the app's, not the fake's.
  const listBody = () => {
    let i = 0;
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= headers.length) return c.close();
        const part = headers.slice(i, i + 2000).map((h) => JSON.stringify({ ...h, records: 1, flagged_dkim: false, flagged_spf: false, flagged_dmarc: false, flagged: false }));
        c.enqueue(enc.encode((i === 0 ? "[" : ",") + part.join(",") + (i + 2000 >= headers.length ? "]" : "")));
        i += 2000;
      },
    });
  };
  const listBytes = headers.length * 190;
  const container = {
    async fetch(req: Request): Promise<Response> {
      sample();
      const u = new URL(req.url);
      if (u.pathname === "/dmarc-reports") return new Response(listBody());
      if (u.pathname === "/tls-reports") return new Response("[]");
      const m = u.pathname.match(/^\/dmarc-reports\/([^/]+)\/json$/);
      if (m) {
        const s = stash.get(decodeURIComponent(m[1]))!;
        return Response.json({
          report_metadata: { org_name: s.rep.org_name, email: "x@example.com", report_id: s.rep.report_id, date_range: { begin: s.rep.date_begin, end: s.rep.date_end } },
          policy_published: { domain: s.rep.domain, p: s.rep.policy_p, pct: 100 },
          record: s.recs.map((r) => ({
            row: { source_ip: r.source_ip, count: r.count, policy_evaluated: { disposition: r.disposition, dkim: r.policy_dkim, spf: r.policy_spf } },
            identifiers: { header_from: r.header_from },
            auth_results: { dkim: [{ domain: r.domain, result: r.auth_dkim_result }], spf: [{ domain: r.domain, result: r.auth_spf_result }] },
          })),
        });
      }
      if (u.pathname === "/ips/dns/batch") return Response.json([]);
      return new Response("nope", { status: 404 });
    },
  };

  global.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  peak = heap0;
  bench.start();
  const t0 = performance.now();
  let note = "";
  let runs = 0;
  let got = 0;
  try {
    for (;;) {
      const r = await syncReports(container, { DB: db, ADMIN_USER: "u", ADMIN_PASSWORD: "p" } as never, "default");
      runs++;
      got += r.newReports;
      if (!r.backlog || runs >= 60) break;
    }
    note = `${got} new reports in ${runs} sync${runs > 1 ? "s" : ""}`;
  } catch (e) {
    note = `FAILED: ${(e as Error).message}`;
  }
  const ms = performance.now() - t0;
  const log = bench.stop();
  const heapMb = (peak - heap0) / 1048576;
  rows.push({
    name: `sync: ${label}`,
    ms,
    dbMs: log.reduce((a, l) => a + l.ms, 0),
    queries: log.length,
    slowest: null,
    extra: `${note}; list ~${(listBytes / 1048576).toFixed(0)} MB; peak +${heapMb.toFixed(0)} MB heap; ${(log.length / runs).toFixed(0)} queries per sync`,
    log,
  });
}
await syncCase("first sync after upgrade: walks existing history, 50 new", 50);
await syncCase("steady state, 50 new reports", 50);
await syncCase("catch-up, 600 new reports", 600);
await syncCase("backfill, 3,000 oldest reports missing, history walk restarted", 3000, { oldest: true, freshWalk: true });

// ------------------------------------------------------------------- report --

const fmt = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString());
console.log("| what | total ms | db ms | queries | note |");
console.log("|---|---:|---:|---:|---|");
for (const r of rows) console.log(`| ${r.name} | ${fmt(r.ms)} | ${fmt(r.dbMs)} | ${r.queries} | ${r.extra} |`);

// --detail "regex": every query of the matching rows, slowest first, with its plan
const detail = process.argv.find((a) => a.startsWith("--detail="))?.slice(9);
if (detail) {
  const re = new RegExp(detail, "i");
  for (const r of rows.filter((x) => re.test(x.name))) {
    console.log(`\n### ${r.name}: ${fmt(r.ms)} ms, ${r.queries} queries`);
    for (const l of [...r.log].sort((a, b) => b.ms - a.ms).slice(0, 8)) {
      console.log(`- ${fmt(l.ms)} ms, ${l.rows} rows: ${l.sql.replace(/\s+/g, " ").slice(0, 150)}\n    plan: ${bench.plan(l.sql, l.args).join(" | ").slice(0, 260)}`);
    }
  }
}

// query plans for anything slow or heavy
const interesting = rows.filter((r) => r.dbMs > 150 || r.queries > 100).flatMap((r) => r.log.map((l) => ({ ...l, from: r.name })));
const seen = new Set<string>();
const scans: Array<{ from: string; ms: number; sql: string; plan: string[] }> = [];
for (const l of interesting.sort((a, b) => b.ms - a.ms)) {
  const key = l.sql.replace(/\s+/g, " ");
  if (seen.has(key) || l.ms < 40) continue;
  seen.add(key);
  const plan = bench.plan(l.sql, l.args);
  scans.push({ from: l.from, ms: l.ms, sql: key.slice(0, 200), plan });
  if (scans.length >= 14) break;
}
console.log("\n## Slowest single queries (>= 40 ms) and their plans\n");
for (const s of scans) {
  console.log(`- ${Math.round(s.ms)} ms in "${s.from}"\n  ${s.sql}\n  plan: ${s.plan.join(" | ")}`);
}
