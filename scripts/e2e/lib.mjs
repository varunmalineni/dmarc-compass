// Shared by the end-to-end tests (docker.mjs, kubernetes.mjs): synthetic DMARC reports,
// a just-enough IMAP client to put them in a test mailbox, an HTTP client that behaves
// like a signed-in person, and the scenario itself. A driver supplies the hooks that
// differ between environments (how to restart, run a command inside, and so on).

import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";

export const PASSWORD = "e2e-admin-password-123";
export const KEY = Buffer.alloc(32, 9).toString("base64");
export const NEW_PASSWORD = "a-brand-new-password-1";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- reporting

const results = [];
export function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}
export function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  return failed.length ? 1 : 0;
}
export async function until(what, fn, ms = 60000, every = 500) {
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

// --------------------------------------------------------- test mail content

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

function reportXml({ org, id, domain, ageDays, ips }) {
  const end = now - ageDays * DAY;
  const records = ips
    .map(([ip, count, ok]) => `<record><row><source_ip>${ip}</source_ip><count>${count}</count><policy_evaluated><disposition>none</disposition><dkim>${ok ? "pass" : "fail"}</dkim><spf>${ok ? "pass" : "fail"}</spf></policy_evaluated></row><identifiers><header_from>${domain}</header_from></identifiers><auth_results><dkim><domain>${domain}</domain><result>${ok ? "pass" : "fail"}</result><selector>s1</selector></dkim><spf><domain>${domain}</domain><result>${ok ? "pass" : "fail"}</result></spf></auth_results></record>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" ?><feedback><report_metadata><org_name>${org}</org_name><email>noreply@${org.toLowerCase().replace(/\W/g, "")}.example</email><report_id>${id}</report_id><date_range><begin>${end - DAY}</begin><end>${end}</end></date_range></report_metadata><policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><sp>none</sp><pct>100</pct></policy_published>${records}</feedback>`;
}

export function mail(r) {
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

export const REPORTS = [
  { org: "google.com", id: "e2e-g-1", domain: "alpha.example", ageDays: 2, ips: [["203.0.113.7", 40, true], ["203.0.113.99", 6, false]] },
  { org: "Yahoo", id: "e2e-y-1", domain: "alpha.example", ageDays: 2, ips: [["203.0.113.7", 11, true]] },
  { org: "Microsoft Corporation", id: "e2e-m-1", domain: "beta.example", ageDays: 1, ips: [["198.51.100.20", 25, true]] },
];
export const LATE = { org: "google.com", id: "e2e-g-2", domain: "beta.example", ageDays: 1, ips: [["198.51.100.21", 9, true]] };

/** Puts messages into the test mailbox over plain IMAP (login dmarc / secretpw). */
export function appendMessages(port, messages) {
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

export function createClient() {
  const c = {
    withBase(base) { c.base = base; return c; },
    base: "",
    cookie: "",
    async http(path, opts = {}) {
      const res = await fetch(c.base + path, { redirect: "manual", ...opts, headers: { ...(c.cookie ? { cookie: c.cookie } : {}), ...(opts.headers ?? {}) } });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) c.cookie = set.map((x) => x.split(";")[0]).join("; ");
      return res;
    },
    async admin(body) {
      const res = await c.http("/admin", { method: "POST", headers: { "content-type": "application/json", "x-settings-request": "1" }, body: JSON.stringify(body) });
      const text = await res.text();
      try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, text }; }
    },
    async signIn(user = "admin", password = PASSWORD) {
      c.cookie = "";
      const res = await c.http("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: user, password, next: "/admin" }) });
      return res.status === 303 && res.headers.get("location") === "/admin";
    },
    async csvRows(dataset) {
      return (await (await c.http(`/export/${dataset}?range=all`)).text()).trim().split("\n").length - 1;
    },
    /** A plain request, like a browser opening a page (fetch always labels itself as a script). */
    navigate(path) {
      return new Promise((resolve, reject) => {
        const r = httpRequest(`${c.base}${path}`, { headers: { accept: "text/html" } }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location ?? "" }); });
        r.on("error", reject).end();
      });
    },
  };
  return c;
}

// ------------------------------------------------------------------ scenario

/** The parts of the check that read the process list of the container. */
export const PARSER_ENV_SCRIPT =
  `const fs=require('fs');for(const d of fs.readdirSync('/proc')){if(!/^\\d+$/.test(d))continue;try{const c=fs.readFileSync('/proc/'+d+'/cmdline','utf8');if(c.includes('dmarc-report-viewer')){const e=fs.readFileSync('/proc/'+d+'/environ','utf8').split('\\0').map(x=>x.split('=')[0]);console.log(JSON.stringify(e));}}catch{}}`;
export const BACKUP_COUNT_SCRIPT =
  "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/e2e-backup.db',{readOnly:true});console.log(d.prepare('select count(*) n from dmarc_reports').get().n)";

/**
 * Hooks a driver provides (all async):
 *   imapPort                      host port of the test IMAP server
 *   refusesWithoutSettings()      -> { ok, detail } | null
 *   healthy()                     -> boolean | null
 *   uid()                         -> string
 *   parserEnvNames()              -> string (the script's output)
 *   backup(), backupAgainStatus() -> count string / exit status
 *   resetAdmin()                  -> the reset command's output
 *   restart()                     -> { exitCode, seconds, extra }  (leaves the app running again, c.base updated)
 */
export async function runScenario(h, c) {
  await appendMessages(h.imapPort, REPORTS.map(mail));
  check("test mailbox filled with 3 DMARC reports", true);

  const refusal = await h.refusesWithoutSettings?.();
  if (refusal) check("refuses to start without an admin password", refusal.ok, refusal.detail);

  check("answers /healthz", (await fetch(`${c.base}/healthz`)).ok);
  const healthy = await h.healthy?.();
  if (healthy !== null && healthy !== undefined) check("the platform reports it healthy", healthy);
  check("runs as an unprivileged user", (await h.uid()) === "1000");

  const nav = await c.navigate("/admin");
  check("signed out, /admin redirects to the sign-in page", nav.status === 303 && nav.location.startsWith("/login"), JSON.stringify(nav));
  const script = await fetch(`${c.base}/admin`, { method: "POST", headers: { "x-settings-request": "1" } });
  check("a script in a page gets a plain 401 (no browser password popup)", script.status === 401 && !script.headers.get("www-authenticate"));
  const bad = await c.http("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=admin&password=wrong" });
  check("a wrong password is refused", bad.status !== 303);
  check("signing in works over plain HTTP when allowed", await c.signIn());

  const add = await c.admin({ action: "mailbox_add", mailbox: { name: "E2E", host: "127.0.0.1", user: "dmarc", password: "secretpw" } });
  check("mailbox added", add.status === 200, JSON.stringify(add));
  const id = add.json?.mailboxes?.rows?.[0]?.id;
  const test = await c.admin({ action: "mailbox_test", id });
  check("connection test reaches the IMAP server", test.status === 200, JSON.stringify(test));

  const t0 = Date.now();
  const sync = await c.admin({ action: "sync" });
  check("sync reads the 3 reports through the real parser", sync.status === 200 && sync.json?.newReports === 3, JSON.stringify(sync).slice(0, 300));
  console.log(`      (first sync took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const again = await c.admin({ action: "sync" });
  check("a second sync finds nothing new", again.json?.newReports === 0, JSON.stringify(again).slice(0, 200));

  const domains = await (await c.http("/domains?range=all")).text();
  check("Domains page lists both domains", domains.includes("alpha.example") && domains.includes("beta.example"));
  check("export has the 3 reports", (await c.csvRows("reports")) === 3);
  check("export has the 4 records", (await c.csvRows("records")) === 4);
  const reportsPage = await (await c.http("/reports?range=all")).text();
  const hash = reportsPage.match(/href="\/reports\/([^"/?]+)[?"]/)?.[1];
  const xml = hash ? await c.http(`/reports/${hash}/xml`) : null;
  const xmlText = xml ? await xml.text() : "";
  check("the original XML comes from that mailbox's own parser", xml?.status === 200 && xmlText.includes("<feedback"), `${xml?.status} ${xmlText.slice(0, 120)}`);
  for (const p of ["/", "/reports?range=all", "/map", "/tls-reports"]) check(`page ${p} loads`, (await c.http(p)).status === 200);

  const leak = await h.parserEnvNames();
  const parserEnv = JSON.parse(leak.split("\n")[0] || "[]");
  check("the parser process has no admin password or encryption key", parserEnv.length > 0 && !parserEnv.includes("ADMIN_PASSWORD") && !parserEnv.includes("CONFIG_ENCRYPTION_KEY"), leak);

  await appendMessages(h.imapPort, [mail(LATE)]);
  await c.admin({ action: "sync_schedule_save", minutes: 5 });
  const late = await c.admin({ action: "sync" });
  check("a new report is picked up after the parser restarts for a new interval", late.json?.newReports === 1, JSON.stringify(late).slice(0, 300));

  const copied = await h.backup();
  check("a backup made while running holds all 4 reports", copied === "4", copied);
  check("a backup never overwrites an existing file", (await h.backupAgainStatus()) === 2);

  // ---- changing the admin login from the Admin page
  const other = createClient();
  other.base = c.base;
  check("a second browser can sign in", await other.signIn());
  const wrongCurrent = await c.admin({ action: "account_save", currentPassword: "not-my-password", newUser: "owner", newPassword: "a-brand-new-password-1" });
  check("changing the login needs the right current password", wrongCurrent.status === 403 && /current password is wrong/i.test(wrongCurrent.text ?? ""), JSON.stringify(wrongCurrent));
  const weak = await c.admin({ action: "account_save", currentPassword: PASSWORD, newUser: "owner", newPassword: "short" });
  check("and a weak new password is refused with the reason", weak.status === 400 && /at least 10/.test(weak.text ?? ""), JSON.stringify(weak));
  const changed = await c.admin({ action: "account_save", currentPassword: PASSWORD, newUser: "owner", newPassword: NEW_PASSWORD });
  check("the login is changed", changed.status === 200 && changed.json?.account?.user === "owner" && changed.json?.account?.source === "stored", JSON.stringify(changed));
  check("the browser that changed it stays signed in", (await c.http("/export/reports?range=all")).status === 200);
  check("every other session is signed out", (await other.http("/export/reports?range=all")).status !== 200);
  check("the old login no longer signs in", !(await createClient().withBase(c.base).signIn("admin", PASSWORD)));
  check("and the new login does", await createClient().withBase(c.base).signIn("owner", NEW_PASSWORD));
  const basic = (u, p) => fetch(`${c.base}/export/reports?range=all`, { headers: { authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") } });
  check("scripts with the new login work and with the old one do not", (await basic("owner", NEW_PASSWORD)).status === 200 && (await basic("admin", PASSWORD)).status === 401);
  const synced = await c.admin({ action: "sync" });
  check("syncing is unaffected by the change (the parser has its own credentials)", synced.status === 200 && synced.json?.mailboxes?.[0]?.ok === true, JSON.stringify(synced).slice(0, 300));

  const r = await h.restart();
  check("stops cleanly on SIGTERM (exit 0, within 10 s)", r.exitCode === "0" && r.seconds < 10, `exit ${r.exitCode} after ${r.seconds}s`);
  for (const extra of r.extra ?? []) check(extra.name, extra.ok, extra.detail);
  check("the sign-in session survives a restart", (await c.http("/export/reports?range=all")).status === 200);
  check("all 4 reports are still there after the restart", (await c.csvRows("reports")) === 4);
  const after = await c.admin({ action: "sync" });
  check("sync works again after the restart (parsers start again)", after.status === 200 && after.json?.mailboxes?.[0]?.ok === true, JSON.stringify(after).slice(0, 300));
  check("and finds nothing duplicated", (await c.csvRows("reports")) === 4);

  check("the changed login survives the restart", (await createClient().withBase(c.base).signIn("owner", NEW_PASSWORD)) && !(await createClient().withBase(c.base).signIn("admin", PASSWORD)));

  // ---- forgot the password: the reset command
  const reset = await h.resetAdmin();
  check("the reset command removes the saved login", /removed/i.test(reset), reset);
  check("and the deployed login works again, the changed one does not", (await createClient().withBase(c.base).signIn("admin", PASSWORD)) && !(await createClient().withBase(c.base).signIn("owner", NEW_PASSWORD)));
}
