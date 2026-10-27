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
// Failing mail from a sender not seen before, one report per domain, for the routing checks.
export const FAIL_ALPHA = { org: "google.com", id: "e2e-g-3", domain: "alpha.example", ageDays: 1, ips: [["203.0.113.150", 30, false]] };
export const FAIL_BETA = { org: "google.com", id: "e2e-g-4", domain: "beta.example", ageDays: 1, ips: [["198.51.100.150", 30, false]] };
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
    async csvRows(dataset, query = "") {
      return (await (await c.http(`/export/${dataset}?range=all${query ? `&${query}` : ""}`)).text()).trim().split("\n").length - 1;
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

/** A small web server inside the app's container that records what webhooks send, so routing can be checked end to end. */
const SINK_PORT = 9911;
const SINK_LOG = "/data/e2e-sink.log";
const SINK_SOURCE = `const http=require('http'),fs=require('fs');http.createServer((q,r)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{fs.appendFileSync(${JSON.stringify(SINK_LOG)},JSON.stringify({path:q.url,body:JSON.parse(b)})+'\\n');r.end('ok')})}).listen(${SINK_PORT},'127.0.0.1')`;
const START_SINK = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(SINK_SOURCE)}],{detached:true,stdio:'ignore'}).unref()`;
const PROBE_SINK = `require('net').connect(${SINK_PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`;
const READ_SINK = `const fs=require('fs');process.stdout.write(fs.existsSync(${JSON.stringify(SINK_LOG)})?fs.readFileSync(${JSON.stringify(SINK_LOG)},'utf8'):'')`;

/**
 * Hooks a driver provides (all async):
 *   exec(...command)              -> stdout of a command run inside the app's container
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

  // ---- domain tags
  const fq = (expr) => `f=${encodeURIComponent(JSON.stringify(expr))}`;
  const tagged = await c.admin({ action: "tags_apply", domains: ["alpha.example"], add: ["emea"] });
  check("a tag can be added to a domain", tagged.status === 200 && tagged.json?.domains === 1, JSON.stringify(tagged));
  check("the tag filters the exports (2 reports and 3 records for alpha.example)", (await c.csvRows("reports", "tag=emea")) === 2 && (await c.csvRows("records", "tag=emea")) === 3);
  check("a tag nobody has shows nothing, not everything", (await c.csvRows("reports", "tag=nobody")) === 0);
  const rule = await c.admin({ action: "tag_rule_save", tag: "bx", expr: { field: "domain", op: "ends", value: "beta.example" } });
  check("an automatic rule tags domains by name", rule.status === 200 && (await c.csvRows("reports", "tag=bx")) === 1, JSON.stringify(rule));
  check("OR combines tags", (await c.csvRows("reports", fq({ any: [{ field: "tag", op: "has", value: "emea" }, { field: "tag", op: "has", value: "bx" }] }))) === 3);
  check("AND narrows them", (await c.csvRows("reports", fq({ all: [{ field: "tag", op: "has", value: "emea" }, { field: "tag", op: "has", value: "bx" }] }))) === 0);
  check("NOT inverts a group", (await c.csvRows("reports", fq({ any: [{ field: "tag", op: "has", value: "emea" }], not: true }))) === 1);
  check("a filter can use the policy and the domain name", (await c.csvRows("reports", fq({ all: [{ field: "policy", op: "is", value: "none" }, { field: "domain", op: "starts", value: "alpha" }] }))) === 2);
  const domainsPage = await (await c.http("/domains?range=all")).text();
  check("the Domains page shows the tags", /class="tag"[^>]*>emea</.test(domainsPage) && /class="tag"[^>]*>bx</.test(domainsPage));
  check("a page with a filter loads and says what it shows", (await (await c.http("/?tag=emea")).text()).includes("has tag emea"));
  const tagExport = await (await c.http("/export/tags?format=csv")).text();
  check("the tags export lists each domain with its own tags and its rule tags", /alpha\.example,emea,/.test(tagExport) && /beta\.example,,bx/.test(tagExport), tagExport);
  const overviewBefore = await c.admin({ action: "tags_overview" });
  const emeaColor = overviewBefore.json?.tags?.find((t) => t.tag === "emea")?.color;
  const bxColor = overviewBefore.json?.tags?.find((t) => t.tag === "bx")?.color;
  check("each new tag gets a colour at once, and the two differ", Boolean(emeaColor && bxColor) && emeaColor !== bxColor, JSON.stringify([emeaColor, bxColor]));
  const picked = emeaColor === "teal" ? "pink" : "teal";
  const colored = await c.admin({ action: "tag_color", tag: "emea", color: picked });
  check("a tag's colour can be chosen", colored.status === 200 && colored.json?.color === picked, JSON.stringify(colored));
  const refused = await c.admin({ action: "tag_color", tag: "emea", color: "javascript:alert(1)" });
  check("a colour that is not on offer is refused", refused.status === 400);
  const coloredPage = await (await c.http("/domains?range=all")).text();
  check("the Domains page shows the chosen colour", new RegExp(`class="tag" data-c="${picked}"[^>]*>emea<`).test(coloredPage));
  const signedOutTags = await createClient().withBase(c.base).navigate("/tags");
  check("the Tags page asks for the login", signedOutTags.status === 303 && signedOutTags.location.startsWith("/login"), JSON.stringify(signedOutTags));
  const tagsPage = await c.http("/tags");
  const tagsHtml = await tagsPage.text();
  check("signed in, the Tags page loads with its panels", tagsPage.status === 200 && tagsHtml.includes("Automatic rules") && tagsHtml.includes("Import and export"));
  check("the Tags link is in the sidebar, and the Admin page no longer has a tags tab", (await (await c.http("/domains")).text()).includes('href="/tags"') && !(await (await c.http("/admin")).text()).includes('data-tab="tags"'));
  const domainsRes = await c.http("/domains");
  check("dashboard pages cannot be kept by a shared cache (they differ when signed in)", /private/.test(domainsRes.headers.get("cache-control") ?? "") && /cookie/i.test(domainsRes.headers.get("vary") ?? ""), JSON.stringify([...domainsRes.headers]));
  const preview = await c.admin({ action: "tags_import", text: "alpha.example, team-a\nbroken", dryRun: true });
  check("an import is checked before anything is changed", preview.json?.domains === 1 && preview.json?.errorCount === 1 && (await c.csvRows("reports", "tag=team-a")) === 0);

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

  // ---- sending alerts and digests to the right webhook
  await h.exec("node", "-e", START_SINK);
  await until("the test webhook receiver", async () => { await h.exec("node", "-e", PROBE_SINK); return true; }, 20000, 500);
  const sinkUrl = (name) => `http://127.0.0.1:${SINK_PORT}/${name}`;
  const hasTag = (tag) => ({ all: [{ field: "tag", op: "has", value: tag }] });
  for (const [name, filter] of [["all", null], ["emea", hasTag("emea")], ["bx", hasTag("bx")], ["nobody", hasTag("nobody")]]) {
    const added = await c.admin({ action: "webhook_add", url: sinkUrl(name), name, type: "json", filter });
    check(`webhook "${name}" added${filter ? " with a filter" : ""}`, added.status === 200, JSON.stringify(added).slice(0, 200));
  }
  const badFilter = await c.admin({ action: "webhook_add", url: sinkUrl("bad"), type: "json", filter: { all: [{ field: "tag", op: "nonsense", value: "x" }] } });
  check("a filter that makes no sense is refused", badFilter.status === 400, JSON.stringify(badFilter).slice(0, 200));
  const hookRows = (await c.admin({ action: "notify_state" })).json?.hooks ?? [];
  check("the Admin page lists each webhook's filter in words", hookRows.find((x) => x.name === "emea")?.filterText === "has tag emea" && hookRows.find((x) => x.name === "all")?.filterText === null, JSON.stringify(hookRows.map((x) => x.filterText)));

  await appendMessages(h.imapPort, [mail(FAIL_ALPHA), mail(FAIL_BETA)]);
  await c.admin({ action: "sync_schedule_save", minutes: 10 });
  const failing = await c.admin({ action: "sync" });
  check("two reports with failing mail from new senders are read", failing.status === 200 && failing.json?.newReports === 2, JSON.stringify(failing).slice(0, 300));
  const readSink = async () => (await h.exec("node", "-e", READ_SINK)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const alertsTo = async (name) => (await readSink()).filter((x) => x.path === `/${name}` && x.body.event === "alerts").flatMap((x) => x.body.alerts.map((a) => a.domain));
  await until("the alerts to arrive", async () => (await alertsTo("all")).length >= 2, 20000, 500);
  check("the webhook with no filter gets the alerts for both domains", JSON.stringify((await alertsTo("all")).sort()) === '["alpha.example","beta.example"]', JSON.stringify(await alertsTo("all")));
  check("the emea webhook gets only alpha.example", JSON.stringify(await alertsTo("emea")) === '["alpha.example"]', JSON.stringify(await alertsTo("emea")));
  check("the bx webhook (an automatic rule's tag) gets only beta.example", JSON.stringify(await alertsTo("bx")) === '["beta.example"]', JSON.stringify(await alertsTo("bx")));
  check("a webhook whose filter matches nothing gets nothing", (await readSink()).filter((x) => x.path === "/nobody").length === 0);
  const emeaMessage = (await readSink()).find((x) => x.path === "/emea" && x.body.event === "alerts");
  check("a filtered message says how it was scoped", emeaMessage?.body.scope?.filter === "has tag emea");

  const before = (await readSink()).length;
  const resync = await c.admin({ action: "sync" });
  check("another sync sends nothing again", resync.status === 200 && (await readSink()).length === before);

  const digest = await c.admin({ action: "digest_now" });
  check("the digest is sent now", digest.status === 200, JSON.stringify(digest).slice(0, 300));
  const digests = (await readSink()).filter((x) => x.body.event === "digest");
  const digestFor = (name) => digests.find((x) => x.path === `/${name}`)?.body;
  check("the digest reaches the webhooks that have domains, and not the one with none", ["all", "emea", "bx"].every((n) => digestFor(n)) && !digestFor("nobody"), JSON.stringify(digests.map((x) => x.path)));
  check("each digest covers its own domains (2, 1 and 1)", [digestFor("all")?.domains.total, digestFor("emea")?.domains.total, digestFor("bx")?.domains.total].join() === "2,1,1", JSON.stringify([digestFor("all")?.domains, digestFor("emea")?.domains, digestFor("bx")?.domains]));
  check("and says so", digestFor("emea")?.scope?.filter === "has tag emea" && digestFor("emea")?.scope?.domains === 1 && digestFor("all")?.scope === null);
  const emeaMessages = digestFor("emea")?.totals.messages, allMessages = digestFor("all")?.totals.messages;
  check("the totals follow the scope", typeof emeaMessages === "number" && emeaMessages < allMessages, JSON.stringify([emeaMessages, allMessages]));
  const nobody = (await c.admin({ action: "notify_state" })).json?.hooks.find((x) => x.name === "nobody");
  check("the webhook that was skipped says why", /no domain matches/.test(nobody?.result?.detail ?? ""), JSON.stringify(nobody?.result));

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
  check("all 6 reports are still there after the restart", (await c.csvRows("reports")) === 6);
  const after = await c.admin({ action: "sync" });
  check("sync works again after the restart (parsers start again)", after.status === 200 && after.json?.mailboxes?.[0]?.ok === true, JSON.stringify(after).slice(0, 300));
  check("and finds nothing duplicated", (await c.csvRows("reports")) === 6);
  check("tags and rules survive the restart", (await c.csvRows("reports", "tag=emea")) === 3 && (await c.csvRows("reports", "tag=bx")) === 3);
  const hooksAfter = (await c.admin({ action: "notify_state" })).json?.hooks ?? [];
  check("webhooks keep their filters over a restart", hooksAfter.find((x) => x.name === "emea")?.filterText === "has tag emea" && hooksAfter.find((x) => x.name === "bx")?.filterText === "has tag bx" && hooksAfter.find((x) => x.name === "all")?.filterText === null, JSON.stringify(hooksAfter.map((x) => x.filterText)));

  check("the changed login survives the restart", (await createClient().withBase(c.base).signIn("owner", NEW_PASSWORD)) && !(await createClient().withBase(c.base).signIn("admin", PASSWORD)));

  // ---- forgot the password: the reset command
  const reset = await h.resetAdmin();
  check("the reset command removes the saved login", /removed/i.test(reset), reset);
  check("and the deployed login works again, the changed one does not", (await createClient().withBase(c.base).signIn("admin", PASSWORD)) && !(await createClient().withBase(c.base).signIn("owner", NEW_PASSWORD)));
}
