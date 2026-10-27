#!/usr/bin/env node
// End-to-end test of the self-hosted image with the real parser and a real IMAP server.
//
//   npm run e2e:docker            builds the image first
//   npm run e2e:docker -- --no-build --image my-image:tag
//
// It starts GreenMail (a test mail server), puts DMARC reports in a mailbox, starts the
// dmarc-compass image next to it, and drives it over HTTP like a person would: sign in,
// add the mailbox, sync, look at the data, change settings, restart, and check that
// nothing was lost. Needs Docker. Everything it creates is removed afterwards.

import { execFileSync, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const image = args.includes("--image") ? args[args.indexOf("--image") + 1] : "dmarc-compass:e2e";
const build = !args.includes("--no-build");
const keep = args.includes("--keep");
const GREENMAIL = "greenmail/standalone:2.1.8";
const tag = `dc-e2e-${process.pid}`;
const names = { mail: `${tag}-mail`, app: `${tag}-app`, vol: `${tag}-data` };
const PASSWORD = "e2e-admin-password-123";
const KEY = Buffer.alloc(32, 9).toString("base64");

const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}
async function until(what, fn, ms = 60000, every = 500) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

// ----------------------------------------------------------- test mail content

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
function reportXml({ org, id, domain, ageDays, ips }) {
  const end = now - ageDays * DAY;
  const records = ips
    .map(([ip, count, ok]) => `<record><row><source_ip>${ip}</source_ip><count>${count}</count><policy_evaluated><disposition>none</disposition><dkim>${ok ? "pass" : "fail"}</dkim><spf>${ok ? "pass" : "fail"}</spf></policy_evaluated></row><identifiers><header_from>${domain}</header_from></identifiers><auth_results><dkim><domain>${domain}</domain><result>${ok ? "pass" : "fail"}</result><selector>s1</selector></dkim><spf><domain>${domain}</domain><result>${ok ? "pass" : "fail"}</result></spf></auth_results></record>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" ?><feedback><report_metadata><org_name>${org}</org_name><email>noreply@${org.toLowerCase().replace(/\W/g, "")}.example</email><report_id>${id}</report_id><date_range><begin>${end - DAY}</begin><end>${end}</end></date_range></report_metadata><policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><sp>none</sp><pct>100</pct></policy_published>${records}</feedback>`;
}
function mail(r) {
  const xml = reportXml(r);
  const end = now - r.ageDays * DAY;
  const file = `${r.org}!${r.domain}!${end - DAY}!${end}.xml.gz`;
  const b = "BOUNDARY-e2e";
  return [
    `From: ${r.org} <noreply@${r.org.toLowerCase()}.example>`, "To: dmarc@example.test", `Subject: Report domain: ${r.domain} Submitter: ${r.org} Report-ID: ${r.id}`,
    `Date: ${new Date(end * 1000 + 3600e3).toUTCString()}`, `Message-ID: <${r.id}@${r.org.toLowerCase()}.example>`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${b}"`, "",
    `--${b}`, "Content-Type: text/plain", "", "Aggregate report attached.", `--${b}`, `Content-Type: application/gzip; name="${file}"`, `Content-Disposition: attachment; filename="${file}"`, "Content-Transfer-Encoding: base64", "",
    gzipSync(xml).toString("base64").replace(/(.{76})/g, "$1\r\n"), `--${b}--`, "",
  ].join("\r\n");
}
const REPORTS = [
  { org: "google.com", id: "e2e-g-1", domain: "alpha.example", ageDays: 2, ips: [["203.0.113.7", 40, true], ["203.0.113.99", 6, false]] },
  { org: "Yahoo", id: "e2e-y-1", domain: "alpha.example", ageDays: 2, ips: [["203.0.113.7", 11, true]] },
  { org: "Microsoft Corporation", id: "e2e-m-1", domain: "beta.example", ageDays: 1, ips: [["198.51.100.20", 25, true]] },
];
const LATE = { org: "google.com", id: "e2e-g-2", domain: "beta.example", ageDays: 1, ips: [["198.51.100.21", 9, true]] };

// A just-enough IMAP client to put messages into the test mailbox.
function appendMessages(port, messages) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port });
    let buf = "";
    let i = 0;
    sock.on("data", (d) => (buf += d.toString()));
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("IMAP client timed out")); }, 15000);
    const done = () => { clearTimeout(timer); resolve(); };
    const wait = (re, then) => {
      const t = setInterval(() => {
        if (re.test(buf)) { clearInterval(t); buf = ""; then(); }
      }, 20);
    };
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
    wait(/^\* OK/m, () => {
      sock.write("a1 LOGIN dmarc secretpw\r\n");
      wait(/^a1 OK/m, function next() {
        if (i >= messages.length) { sock.write("a9 LOGOUT\r\n"); return wait(/^a9 /m, () => { sock.end(); done(); }); }
        const m = messages[i++];
        const tagn = `p${i}`;
        sock.write(`${tagn} APPEND INBOX {${Buffer.byteLength(m)}}\r\n`);
        wait(/^\+/m, () => { sock.write(m + "\r\n"); wait(new RegExp(`^${tagn} OK`, "m"), next); });
      });
    });
  });
}

// ------------------------------------------------------------------ the client

let base = "";
let cookie = "";
async function http(path, opts = {}) {
  const res = await fetch(base + path, { redirect: "manual", ...opts, headers: { ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) } });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  return res;
}
const admin = async (body) => {
  const res = await http("/admin", { method: "POST", headers: { "content-type": "application/json", "x-settings-request": "1" }, body: JSON.stringify(body) });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, text }; }
};
async function signIn() {
  cookie = "";
  const res = await http("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: "admin", password: PASSWORD, next: "/admin" }) });
  return res.status === 303 && res.headers.get("location") === "/admin";
}
const csvRows = async (dataset) => ((await (await http(`/export/${dataset}?range=all`)).text()).trim().split("\n").length - 1);

// ------------------------------------------------------------------------ main

let port = 0;
async function startApp() {
  docker("run", "-d", "--name", names.app, "--network", `container:${names.mail}`, "-v", `${names.vol}:/data`,
    "-e", "ADMIN_USER=admin", "-e", `ADMIN_PASSWORD=${PASSWORD}`, "-e", `CONFIG_ENCRYPTION_KEY=${KEY}`,
    "-e", "IMAP_TEST_PORT=3143", "-e", "READ_TIMEOUT_SECONDS=40", "-e", "ALLOW_INSECURE_HTTP=true",
    // GreenMail itself uses 8080 in the shared network namespace.
    "-e", "PORT=8081", image);
  await until("the app to answer /healthz", async () => (await fetch(`${base}/healthz`)).ok, 40000);
}

async function main() {
  if (build) {
    console.log(`Building ${image} ...`);
    docker("build", "-q", "-f", join(root, "deploy/docker/Dockerfile"), "-t", image, root);
  }

  console.log("Starting the test mail server ...");
  docker("run", "-d", "--name", names.mail, "-p", "127.0.0.1::8081", "-p", "127.0.0.1::3143",
    "-e", "GREENMAIL_OPTS=-Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=dmarc:secretpw", GREENMAIL);
  const hostPort = (p) => Number(docker("port", names.mail, String(p)).split("\n")[0].split(":").pop());
  port = hostPort(8081);
  const imapPort = hostPort(3143);
  base = `http://127.0.0.1:${port}`;
  await until("the mail server", async () => { await appendMessages(imapPort, []); return true; }, 90000, 1000);
  await appendMessages(imapPort, REPORTS.map(mail));
  check("test mailbox filled with 3 DMARC reports", true);

  // ---- start, refuse, sign in
  console.log("Starting dmarc-compass ...");
  const bad = spawnSync("docker", ["run", "--rm", image], { encoding: "utf8" });
  check("refuses to start without an admin password", bad.status === 1 && /no default password/i.test(bad.stderr), bad.stderr);

  await startApp();
  check("answers /healthz", (await fetch(`${base}/healthz`)).ok);
  const health = await until("Docker health to be healthy", () => docker("inspect", "-f", "{{.State.Health.Status}}", names.app) === "healthy", 90000, 2000).then(() => true, () => false);
  check("Docker reports the container healthy", health, docker("inspect", "-f", "{{json .State.Health}}", names.app));
  check("runs as an unprivileged user", docker("exec", names.app, "id", "-u") === "1000");

  // fetch() always labels its requests as scripts; use a plain request to act like a browser opening the page.
  const nav = await new Promise((resolve, reject) => {
    const r = httpRequest(`${base}/admin`, { headers: { accept: "text/html" } }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location ?? "" }); });
    r.on("error", reject).end();
  });
  check("signed out, /admin redirects to the sign-in page", nav.status === 303 && nav.location.startsWith("/login"), JSON.stringify(nav));
  const script = await fetch(`${base}/admin`, { method: "POST", headers: { "x-settings-request": "1" } });
  check("a script in a page gets a plain 401 (no browser password popup)", script.status === 401 && !script.headers.get("www-authenticate"));
  check("a wrong password is refused", !(await (async () => { const r = await http("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=admin&password=wrong" }); return r.status === 303; })()));
  check("signing in works over plain HTTP when allowed", await signIn());

  // ---- mailbox and first sync (real parser, real IMAP)
  const add = await admin({ action: "mailbox_add", mailbox: { name: "E2E", host: "127.0.0.1", user: "dmarc", password: "secretpw" } });
  check("mailbox added", add.status === 200, JSON.stringify(add));
  const id = add.json?.mailboxes?.rows?.[0]?.id;
  const test = await admin({ action: "mailbox_test", id });
  check("connection test reaches the IMAP server", test.status === 200, JSON.stringify(test));

  const t0 = Date.now();
  const sync = await admin({ action: "sync" });
  check("sync reads the 3 reports through the real parser", sync.status === 200 && sync.json?.newReports === 3, JSON.stringify(sync).slice(0, 300));
  console.log(`      (first sync took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const again = await admin({ action: "sync" });
  check("a second sync finds nothing new", again.json?.newReports === 0, JSON.stringify(again).slice(0, 200));

  // ---- the data
  const domains = await (await http("/domains?range=all")).text();
  check("Domains page lists both domains", domains.includes("alpha.example") && domains.includes("beta.example"));
  check("export has the 3 reports", (await csvRows("reports")) === 3);
  check("export has the 4 records", (await csvRows("records")) === 4);
  const reportsPage = await (await http("/reports?range=all")).text();
  const hash = reportsPage.match(/href="\/reports\/([^"/?]+)[?"]/)?.[1];
  const xml = hash ? await http(`/reports/${hash}/xml`) : null; // the link already holds the encoded hash
  const xmlText = xml ? await xml.text() : "";
  check("the original XML comes from that mailbox's own parser", xml?.status === 200 && xmlText.includes("<feedback"), `${xml?.status} ${xmlText.slice(0, 120)}`);
  for (const p of ["/", "/reports?range=all", "/map", "/tls-reports"]) check(`page ${p} loads`, (await http(p)).status === 200);

  // ---- the parser only knows what it needs
  const leak = docker("exec", names.app, "node", "-e",
    `const fs=require('fs');for(const d of fs.readdirSync('/proc')){if(!/^\\d+$/.test(d))continue;try{const c=fs.readFileSync('/proc/'+d+'/cmdline','utf8');if(c.includes('dmarc-report-viewer')){const e=fs.readFileSync('/proc/'+d+'/environ','utf8').split('\\0').map(x=>x.split('=')[0]);console.log(JSON.stringify(e));}}catch{}}`);
  const parserEnv = JSON.parse(leak.split("\n")[0] || "[]");
  check("the parser process has no admin password or encryption key", parserEnv.length > 0 && !parserEnv.includes("ADMIN_PASSWORD") && !parserEnv.includes("CONFIG_ENCRYPTION_KEY"), leak);

  // ---- new mail is picked up when the parser re-reads (changing the interval restarts it)
  await appendMessages(imapPort, [mail(LATE)]);
  await admin({ action: "sync_schedule_save", minutes: 5 });
  const late = await admin({ action: "sync" });
  check("a new report is picked up after the parser restarts for a new interval", late.json?.newReports === 1, JSON.stringify(late).slice(0, 300));

  // ---- backup while running
  docker("exec", names.app, "node", "dist/server.mjs", "--backup", "/data/e2e-backup.db");
  const copied = docker("exec", names.app, "node", "-e", "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/e2e-backup.db',{readOnly:true});console.log(d.prepare('select count(*) n from dmarc_reports').get().n)");
  check("a backup made while running holds all 4 reports", copied === "4", copied);
  const again2 = spawnSync("docker", ["exec", names.app, "node", "dist/server.mjs", "--backup", "/data/e2e-backup.db"], { encoding: "utf8" });
  check("a backup never overwrites an existing file", again2.status === 2);

  // ---- restart: clean stop, nothing lost
  const stopStart = Date.now();
  docker("stop", "-t", "20", names.app);
  const stopSeconds = (Date.now() - stopStart) / 1000;
  const exitCode = docker("inspect", "-f", "{{.State.ExitCode}}", names.app);
  check("stops cleanly on SIGTERM (exit 0, within 10 s)", exitCode === "0" && stopSeconds < 10, `exit ${exitCode} after ${stopSeconds}s`);
  docker("start", names.app);
  await until("the app after restart", async () => (await fetch(`${base}/healthz`)).ok, 40000);
  check("the sign-in session survives a restart", (await http("/export/reports?range=all")).status === 200);
  check("all 4 reports are still there after the restart", (await csvRows("reports")) === 4);
  const after = await admin({ action: "sync" });
  check("sync works again after the restart (parsers start again)", after.status === 200 && after.json?.mailboxes?.[0]?.ok === true, JSON.stringify(after).slice(0, 300));
  check("and finds nothing duplicated", (await csvRows("reports")) === 4);
}

try {
  await main();
} catch (err) {
  check("test run completed", false, err.stack ?? String(err));
  try { console.log("\n--- app log ---\n" + docker("logs", "--tail", "40", names.app)); } catch { /* not started */ }
} finally {
  if (keep) console.log(`\nKept containers ${names.app} and ${names.mail} (remove with: docker rm -f ${names.app} ${names.mail}; docker volume rm ${names.vol})`);
  else {
    for (const c of [names.app, names.mail]) { try { docker("rm", "-f", c); } catch { /* gone */ } }
    try { docker("volume", "rm", "-f", names.vol); } catch { /* gone */ }
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
