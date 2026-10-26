import { syncReports, callContainer } from "./sync";
import {
  acquireLock,
  addMailboxEntry,
  getCursor,
  getMailboxesView,
  loadMailboxes,
  recordMailboxResult,
  releaseLock,
  removeMailboxEntry,
  setCursor,
  updateMailboxEntry,
} from "./mailbox-store";
import { testMailbox } from "./imap-connect";
import { runRotation, summarize } from "./rotation";
import { getLastAttempt, getSyncMinutes, getTickGap, hasBacklog, markAttempt, recordTick, setBacklog, setSyncMinutes } from "./sync-settings";
import { nextSyncAt, PRESETS, scheduleTooSlow, syncDue } from "./sync-schedule";
import { DEFAULT_ID } from "./mailboxes";
import { loadOverview, SOURCE_SORT_KEYS } from "./dashboard-data";
import { renderOverviewBody } from "./dashboard-html";
import { loadReportsList, loadReportDetail, REPORT_SORT_KEYS, REPORT_FILTERS, type ReportFilter } from "./reports-data";
import { renderReportsBody, renderReportDetailBody } from "./reports-html";
import { renderAdmin } from "./admin-html";
import { buildExport, csvStream, exportFilename, DATASETS, type Dataset } from "./exports";
import { toJsonRows, slug } from "./csv";
import { addNonce, BASE_HEADERS, clientKey, constantTimeEqual, csp, newNonce } from "./security";
import { isLocked, recordFailure, retryAfter, type AttemptState } from "./ratelimit";
import { loadSummary } from "./report-data";
import { renderSummary } from "./report-html";
import {
  addWebhook,
  getNotifyView,
  previewAlerts,
  rememberBaseUrl,
  removeWebhook,
  runNotifications,
  saveNotifyConfig,
  sendDigestNow,
  testWebhook,
  updateWebhook,
} from "./notify";
import { loadDomains, loadChrome, DOMAIN_SORT_KEYS } from "./domains-data";
import { renderDomainsBody } from "./domains-html";
import { loadTls } from "./tls-data";
import { renderTlsBody } from "./tls-html";
import { loadMapPoints } from "./map-data";
import { renderMapBody } from "./map-html";
import { ensureSchema, getSchemaVersion, LATEST_SCHEMA_VERSION } from "./migrations";
import { isDashboardPublic, setDashboardPublic, recordSync, getLastSync, getAppSetting } from "./app-settings";
import { getAdminCreds, SETUP_HELP, type AdminEnv } from "./config";
import { clearCookie, cookieName, makeToken, readCookie, requesterKind, safeNext, sessionCookie, verifyToken } from "./session";
import { renderLogin } from "./login-html";
import { parseFilters, parseList, scopeLabel, rangeLabel, withFilters } from "./filters";
import { layout } from "./shared-ui";
import type { LeaseResult, Runtime } from "./runtime";

export interface Env extends AdminEnv {
  DB: D1Database;
  /** Encrypts mailbox credentials saved from /admin. Set by `npm run setup`. */
  CONFIG_ENCRYPTION_KEY?: string;
  // Optional fallbacks. The mailbox is normally configured from /admin, which
  // takes precedence over these.
  IMAP_HOST?: string;
  IMAP_USER?: string;
  IMAP_PASSWORD?: string;
  IMAP_FOLDER?: string;
  /** Optional: Slack webhook URL as a Worker secret (it can also be saved from /admin). */
  SLACK_WEBHOOK_URL?: string;
  /** Development only: port of a local fake IMAP server, used for localhost mailbox hosts. */
  IMAP_TEST_PORT?: string;
  /** Optional: how long a sync waits for the parser to finish reading one mailbox (default 240). Raise it for very large folders. */
  READ_TIMEOUT_SECONDS?: string;
  /** Self-hosted only: allow signing in over plain HTTP (a trial on a home network). The default needs HTTPS. */
  ALLOW_INSECURE_HTTP?: string;
}

/** Plain HTTP is accepted for sign-in only when the install was told to allow it. */
const insecureHttp = (env: Env, url: URL) => env.ALLOW_INSECURE_HTTP === "true" && url.protocol === "http:";

const HTML = { "content-type": "text/html; charset=utf-8" };

/** Decodes a Basic Authorization header. Null when absent or malformed. */
function readBasic(request: Request): { user: string; password: string } | null {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Basic ")) return null;
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(auth.slice(6)), (c) => c.charCodeAt(0)));
    const sep = decoded.indexOf(":");
    return sep === -1 ? null : { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

function credentialsMatch(request: Request, env: Env): boolean {
  const creds = getAdminCreds(env);
  const given = readBasic(request);
  if (!creds || !given) return false;
  // Both are always compared, so timing does not reveal which one was wrong.
  const userOk = constantTimeEqual(given.user, creds.user);
  const passOk = constantTimeEqual(given.password, creds.password);
  return userOk && passOk;
}

function challenge(env: Env, withHeader = true): Response {
  // No admin login exists yet: say what to do instead of showing a login
  // prompt that can never succeed.
  if (!getAdminCreds(env)) return new Response(SETUP_HELP, { status: 503 });
  return new Response("Unauthorized\n", {
    status: 401,
    headers: withHeader ? { "WWW-Authenticate": 'Basic realm="dmarc-compass"' } : {},
  });
}

/** The key that signs login sessions: random, made on first use, kept in the database. */
async function sessionSecret(db: D1Database): Promise<string> {
  const existing = await getAppSetting(db, "session_secret");
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const fresh = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare("INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('session_secret', ?, ?)").bind(fresh, Math.floor(Date.now() / 1000)).run();
  return (await getAppSetting(db, "session_secret")) ?? fresh; // another request may have won the race
}

/** Is there a valid sign-in cookie? Checking it is a signature check: no throttling, no writes. */
async function hasSession(request: Request, env: Env): Promise<boolean> {
  const creds = getAdminCreds(env);
  const token = readCookie(request.headers.get("cookie"), cookieName(!insecureHttp(env, new URL(request.url))));
  if (!creds || !token) return false;
  return verifyToken(token, await sessionSecret(env.DB), creds.user, creds.password, Math.floor(Date.now() / 1000));
}

async function loadAttempts(env: Env, client: string): Promise<AttemptState | null> {
  const row = await env.DB.prepare("SELECT failures, window_start, locked_until FROM auth_attempts WHERE client = ?")
    .bind(client)
    .first<{ failures: number; window_start: number; locked_until: number }>();
  return row ? { failures: row.failures, windowStart: row.window_start, lockedUntil: row.locked_until } : null;
}

async function noteFailure(env: Env, client: string, state: AttemptState | null, now: number): Promise<void> {
  const next = recordFailure(state, now);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO auth_attempts (client, failures, window_start, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(client) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until`,
    ).bind(client, next.failures, next.windowStart, next.lockedUntil),
    // Housekeeping: forget addresses whose window and lock are both over.
    env.DB.prepare("DELETE FROM auth_attempts WHERE locked_until < ? AND window_start < ?").bind(now, now - 86400),
  ]);
}

/** Null when the request is signed in, either with the sign-in cookie or with a
 * username and password in the Authorization header (scripts). Otherwise the
 * response to send: browsers are redirected to the sign-in page. Repeated wrong
 * passwords from one address lock that address out for a while (HTTP 429). */
async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  if (!getAdminCreds(env)) return challenge(env);

  if (!request.headers.get("authorization")) {
    if (await hasSession(request, env)) return null;
    const kind = requesterKind(request.method, request.headers.get("sec-fetch-mode"), request.headers.get("accept"));
    if (kind === "page") {
      const url = new URL(request.url);
      return new Response(null, { status: 303, headers: { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` } });
    }
    return challenge(env, kind === "client");
  }

  const client = clientKey(request.headers.get("cf-connecting-ip"));
  const now = Math.floor(Date.now() / 1000);
  const state = await loadAttempts(env, client);

  if (isLocked(state, now)) {
    return new Response("Too many failed login attempts. Try again later.\n", {
      status: 429,
      headers: { "retry-after": String(retryAfter(state as AttemptState, now)) },
    });
  }
  if (credentialsMatch(request, env)) {
    if (state) await env.DB.prepare("DELETE FROM auth_attempts WHERE client = ?").bind(client).run();
    return null;
  }

  await noteFailure(env, client, state, now);
  return challenge(env);
}

const sameOrigin = (request: Request, url: URL) => {
  const origin = request.headers.get("origin");
  return origin === null || origin === url.origin;
};

/** The sign-in page and form. */
async function handleLogin(request: Request, env: Env, url: URL): Promise<Response> {
  const creds = getAdminCreds(env);
  if (!creds) return new Response(SETUP_HELP, { status: 503 });
  const page = (status: number, opts: Omit<Parameters<typeof renderLogin>[0], "url">) => new Response(renderLogin({ ...opts, url }), { status, headers: { ...HTML, "cache-control": "no-store", "x-robots-tag": "noindex" } });

  if (request.method === "GET") {
    const next = safeNext(url.searchParams.get("next"));
    if (await hasSession(request, env)) return new Response(null, { status: 303, headers: { location: next } });
    return page(200, { next });
  }
  if (request.method !== "POST") return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, POST" } });
  if (!sameOrigin(request, url)) return jsonError("Forbidden", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Bad request", 400);
  }
  const text = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : "");
  const next = safeNext(text("next"));

  const client = clientKey(request.headers.get("cf-connecting-ip"));
  const now = Math.floor(Date.now() / 1000);
  const state = await loadAttempts(env, client);
  if (isLocked(state, now)) {
    const mins = Math.ceil(retryAfter(state as AttemptState, now) / 60);
    const res = page(429, { next, locked: true, error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` });
    res.headers.set("retry-after", String(retryAfter(state as AttemptState, now)));
    return res;
  }

  // Both are always compared, so timing does not reveal which one was wrong, and the message does not either.
  const userOk = constantTimeEqual(text("username"), creds.user);
  const passOk = constantTimeEqual(text("password"), creds.password);
  if (!(userOk && passOk)) {
    await noteFailure(env, client, state, now);
    return page(401, { next, error: "Wrong username or password." });
  }

  if (state) await env.DB.prepare("DELETE FROM auth_attempts WHERE client = ?").bind(client).run();
  const token = await makeToken(await sessionSecret(env.DB), creds.user, creds.password, now);
  return new Response(null, { status: 303, headers: { location: next, "set-cookie": sessionCookie(token, !insecureHttp(env, url)), "cache-control": "no-store" } });
}

function handleLogout(request: Request, env: Env, url: URL): Response {
  if (request.method !== "POST") return new Response("Method not allowed\n", { status: 405, headers: { allow: "POST" } });
  if (!sameOrigin(request, url)) return jsonError("Forbidden", 403);
  return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": clearCookie(!insecureHttp(env, url)), "cache-control": "no-store" } });
}

/** Gate for the read-only dashboard pages: open when the admin has made the
 * dashboard public, otherwise the admin login is required. */
async function dashboardGate(request: Request, env: Env): Promise<Response | null> {
  if (await isDashboardPublic(env.DB)) return null;
  return requireAdmin(request, env);
}

const SYNC_BUDGET_MS = 11 * 60 * 1000;
const MIN_PER_MAILBOX_MS = 90 * 1000;
const DEFAULT_READ_TIMEOUT_SECONDS = 240;
const readTimeoutMs = (env: Env) => 1000 * Math.min(900, Math.max(10, Number(env.READ_TIMEOUT_SECONDS) || DEFAULT_READ_TIMEOUT_SECONDS));

export interface SyncOutcome {
  newReports: number;
  newTlsReports: number;
  mailboxes: Array<{ id: string; name: string; ok: boolean; newReports: number; newTlsReports: number; error?: string }>;
}

class SyncBusy extends Error {
  constructor() {
    super("A sync is already running. Try again in a minute.");
  }
}

/** Visits each enabled mailbox in turn with the one container, copying new
 * reports into the database. Never runs twice at once. */
async function runSync(env: Env, rt: Runtime): Promise<SyncOutcome> {
  if (!(await acquireLock(env.DB, "sync", 14 * 60))) throw new SyncBusy();
  await markAttempt(env.DB, Math.floor(Date.now() / 1000));
  const leases = new Map<string, Extract<LeaseResult, { ok: true }>>();
  try {
    const { list } = await loadMailboxes(env);
    const enabled = list.filter((m) => m.enabled);
    if (enabled.length === 0) throw new Error("No mailbox is enabled. Add one in Admin.");

    const result = await runRotation(
      enabled,
      await getCursor(env.DB),
      {
        now: () => Date.now(),
        load: async (m) => {
          const lease = await rt.parsers.lease(m, { purpose: "sync", timeoutMs: readTimeoutMs(env), onlyMailbox: list.length === 1 });
          if (!lease.ok) return { ok: false, error: lease.error };
          leases.set(m.id, lease);
          return { ok: true };
        },
        sync: (m) => syncReports(leases.get(m.id)!.client, env, m.id),
        record: (m, o) => recordMailboxResult(env.DB, m.id, o),
      },
      { budgetMs: SYNC_BUDGET_MS, minPerMailboxMs: MIN_PER_MAILBOX_MS },
    );
    await setCursor(env.DB, result.nextCursor);
    await setBacklog(env.DB, result.outcomes.some((o) => o.ok && o.backlog) || result.partial);

    const sum = summarize(result.outcomes, result.partial);
    await recordSync(env.DB, sum.ok, sum.text);
    const out: SyncOutcome = {
      newReports: result.outcomes.reduce((a, o) => a + o.newReports, 0),
      newTlsReports: result.outcomes.reduce((a, o) => a + o.newTlsReports, 0),
      mailboxes: result.outcomes,
    };
    if (!sum.ok && result.outcomes.every((o) => !o.ok)) throw new Error(sum.text);
    return out;
  } catch (err) {
    await recordSync(env.DB, false, String(err instanceof Error ? err.message : err).slice(0, 200));
    throw err;
  } finally {
    for (const lease of leases.values()) await lease.release().catch(() => {});
    await releaseLock(env.DB);
    // Alerts and the digest; never throws, and a Slack problem never fails a sync.
    await runNotifications(env);
  }
}

function jsonError(message: string, status: number): Response {
  return new Response(message + "\n", { status });
}

/** Raw XML / JSON of one report, straight from the container's copy. Always
 * behind the admin login, never the public-dashboard switch: the XML is
 * third-party content and includes the reporter's contact details.
 *
 * D1 stores the container's hash from when the report was synced, but that
 * hash changes whenever the container's mailbox settings do, so the report is
 * looked up in the container by its identity (reporter, report ID, domain). */
async function handleRawReport(request: Request, env: Env, rt: Runtime, hash: string, format: "xml" | "json"): Promise<Response> {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  const row = await env.DB.prepare("SELECT org_name, report_id, domain, mailbox_id FROM dmarc_reports WHERE hash = ?")
    .bind(hash)
    .first<{ org_name: string; report_id: string; domain: string; mailbox_id: string | null }>();
  if (!row) return new Response("Report not found\n", { status: 404 });

  // Reports synced before mailboxes could be listed came from the original one.
  const { list } = await loadMailboxes(env);
  const mailbox = list.find((m) => m.id === (row.mailbox_id ?? DEFAULT_ID));
  if (!mailbox) {
    return new Response(
      "The mailbox this report came from is no longer in the list, so the original file is unavailable. The parsed data in this dashboard is unaffected.\n",
      { status: 404 },
    );
  }

  // Wait for the parser to have read this report's mailbox. Where one parser is shared
  // and a sync is using it, this answers "try again shortly".
  const lease = await rt.parsers.lease(mailbox, { purpose: "raw", timeoutMs: 150_000, onlyMailbox: list.length === 1 });
  if (!lease.ok) {
    return lease.busy
      ? new Response(`${lease.error}\n`, { status: 503, headers: { "retry-after": "30" } })
      : new Response(`${lease.error}\n`, { status: 504 });
  }
  const container = lease.client;
  try {
    let current: string | undefined;
    try {
      const res = await callContainer(container, "/dmarc-reports", env);
      if (!res.ok) return new Response(`The container could not list reports (${res.status}).\n`, { status: 502 });
      const headers = await res.json<Array<{ hash: string; id: string; org: string; domain: string }>>();
      current = headers.find(
        (h) => h.org === row.org_name && h.id === row.report_id && h.domain.toLowerCase() === row.domain.toLowerCase(),
      )?.hash;
    } catch (err) {
      return new Response(`The container is not reachable yet: ${err instanceof Error ? err.message : err}\n`, { status: 502 });
    }
    if (!current) {
      return new Response(
        "The mailbox no longer has this report, so the original file is unavailable. " +
          "The parsed data in this dashboard is unaffected. This happens if the email was deleted or moved out of the mailbox folder.\n",
        { status: 404 },
      );
    }

    const upstream = await callContainer(container, `/dmarc-reports/${encodeURIComponent(current)}/${format}`, env);
    if (!upstream.ok) return new Response(`The container returned ${upstream.status}.\n`, { status: 502 });
    const body = await upstream.text();

    const name = `${row.org_name}_${row.report_id}`.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new Response(body, {
      headers: {
        // Plain text, never application/xml: a crafted report must not be rendered as markup in our origin.
        "content-type": format === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
        "content-disposition": `${download ? "attachment" : "inline"}; filename="${name}.${format}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
      },
    });
  } finally {
    await lease.release();
  }
}

/** Table exports as CSV or JSON. Always behind the admin login: a bulk export
 * of every source IP and sender is more than the page-by-page view of a public
 * dashboard is meant to hand out. */
async function handleExport(request: Request, env: Env, dataset: Dataset, url: URL): Promise<Response> {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  const f = parseFilters(url);
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";
  const problem = url.searchParams.get("filter");
  const { list: mailboxList } = await loadMailboxes(env);
  const result = await buildExport(env.DB, dataset, {
    mailboxNames: Object.fromEntries(mailboxList.map((m) => [m.id, m.name])),
    filters: f,
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 100),
    problem: problem === "dkim" || problem === "spf" || problem === "any" ? problem : "all",
  });

  const headers: Record<string, string> = {
    "content-disposition": `attachment; filename="${exportFilename(dataset, f, format)}"`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "x-export-rows": String(result.rows.length),
    "x-export-truncated": String(result.truncated),
  };
  if (format === "json") {
    return new Response(
      JSON.stringify(
        {
          dataset,
          generated_at: new Date().toISOString(),
          scope: { domains: f.domains, range_days: f.range },
          truncated: result.truncated,
          count: result.rows.length,
          rows: toJsonRows(result.columns, result.rows),
        },
        null,
        1,
      ),
      { headers: { ...headers, "content-type": "application/json; charset=utf-8" } },
    );
  }
  return new Response(csvStream(result.columns, result.rows), {
    headers: { ...headers, "content-type": "text/csv; charset=utf-8" },
  });
}

/** The printable summary report. Admin login only, like the exports. */
async function handleSummary(request: Request, env: Env, url: URL): Promise<Response> {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const f = parseFilters(url);
  const data = await loadSummary(env.DB, f);
  const download = url.searchParams.get("download") === "1";
  const keep = withFilters("/report", f);
  const html = renderSummary(data, {
    downloadHref: keep + (keep.includes("?") ? "&" : "?") + "download=1",
    backHref: withFilters("/", f),
  });
  const scope = f.domains.length === 0 ? "all-domains" : f.domains.length === 1 ? slug(f.domains[0]) : `${f.domains.length}-domains`;
  const range = f.range === null ? "all-time" : `last-${f.range}d`;
  return new Response(html, {
    headers: {
      ...HTML,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(download
        ? { "content-disposition": `attachment; filename="dmarc-compass_summary_${scope}_${range}_${new Date().toISOString().slice(0, 10)}.html"` }
        : {}),
    },
  });
}

/** What Admin needs to show about the sync schedule. */
async function syncScheduleView(env: Env, minutes?: number) {
  const m = minutes ?? (await getSyncMinutes(env.DB));
  const now = Math.floor(Date.now() / 1000);
  const [last, gap] = await Promise.all([getLastAttempt(env.DB), getTickGap(env.DB)]);
  return { minutes: m, presets: PRESETS, nextAt: nextSyncAt(last, m, now), lastAttempt: last, tooSlow: scheduleTooSlow(gap, m), tickGap: gap };
}

async function handleAdmin(request: Request, env: Env, rt: Runtime, url: URL): Promise<Response> {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  if (request.method === "POST") {
    // CSRF guard: a cross-site <form> can't set a custom header without a CORS
    // preflight, which this app never allows. Only the admin page's own
    // fetch() calls include it.
    if (request.headers.get("x-settings-request") !== "1") return jsonError("Forbidden", 403);
    const body = await request.json<Record<string, unknown>>();

    if (body.action === "sync") {
      if ((await loadMailboxes(env)).list.filter((m) => m.enabled).length === 0) return jsonError("Add and enable a mailbox first.", 400);
      try {
        return Response.json(await runSync(env, rt));
      } catch (err) {
        return jsonError(String(err instanceof Error ? err.message : err), err instanceof SyncBusy ? 409 : 502);
      }
    }

    // Mailbox changes answer with the fresh list so the page can redraw without a reload.
    const mailboxState = async () => Response.json({ mailboxes: await getMailboxesView(env) });
    const raw = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
    if (body.action === "mailbox_add") {
      const res = await addMailboxEntry(env, raw(body.mailbox));
      return res.ok ? mailboxState() : jsonError(res.error, 400);
    }
    if (body.action === "mailbox_update") {
      const res = await updateMailboxEntry(env, typeof body.id === "string" ? body.id : "", raw(body.mailbox));
      return res.ok ? mailboxState() : jsonError(res.error, 400);
    }
    if (body.action === "mailbox_remove") {
      const res = await removeMailboxEntry(env, typeof body.id === "string" ? body.id : "");
      return res.ok ? mailboxState() : jsonError(res.error, 400);
    }
    if (body.action === "mailbox_test") {
      const res = await testMailbox(env, rt.connect, typeof body.id === "string" ? body.id : "");
      if (!res.ok) await mailboxState(); // the failure is recorded; the page shows it
      return res.ok ? mailboxState() : jsonError(res.error, 502);
    }
    if (body.action === "mailboxes_state") return mailboxState();

    if (body.action === "sync_schedule_save") {
      const minutes = await setSyncMinutes(env.DB, body.minutes);
      return Response.json(await syncScheduleView(env, minutes));
    }

    // Webhook and notification-setting changes all answer with the fresh list,
    // so the page can redraw without a reload.
    const notifyState = async () => {
      const view = await getNotifyView(env);
      return Response.json({ hooks: view.hooks, nextDigestAt: view.nextDigestAt });
    };
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const optBool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

    if (body.action === "notify_state") return notifyState();
    if (body.action === "notify_save") {
      const res = await saveNotifyConfig(env, body.config);
      return res.ok ? notifyState() : jsonError(res.error, 400);
    }
    if (body.action === "webhook_add") {
      const res = await addWebhook(env, { url: body.url, name: body.name, type: body.type, secret: body.secret, alerts: optBool(body.alerts), digest: optBool(body.digest) });
      return res.ok ? notifyState() : jsonError(res.error, 400);
    }
    if (body.action === "webhook_update") {
      const res = await updateWebhook(env, str(body.id), {
        name: typeof body.name === "string" ? body.name : undefined,
        secret: typeof body.secret === "string" ? body.secret : undefined,
        alerts: optBool(body.alerts),
        digest: optBool(body.digest),
      });
      return res.ok ? notifyState() : jsonError(res.error, 400);
    }
    if (body.action === "webhook_remove") {
      const res = await removeWebhook(env, str(body.id));
      return res.ok ? notifyState() : jsonError(res.error, 400);
    }
    if (body.action === "webhook_test") {
      const res = await testWebhook(env, str(body.id));
      return res.ok ? notifyState() : jsonError(res.error, 502);
    }
    if (body.action === "digest_now") {
      const res = await sendDigestNow(env);
      return res.ok ? notifyState() : jsonError(res.error, 502);
    }
    if (body.action === "notify_preview") {
      return Response.json(await previewAlerts(env));
    }

    if (typeof body.public_dashboard === "boolean") {
      await setDashboardPublic(env.DB, body.public_dashboard);
      return new Response("OK\n");
    }

    return jsonError("Unknown action.", 400);
  }

  await rememberBaseUrl(env.DB, url.origin);

  const [mailboxes, schemaVersion, counts, lastSync, publicDashboard, notify, sync] = await Promise.all([
    getMailboxesView(env),
    getSchemaVersion(env.DB),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM dmarc_reports) AS reports,
         (SELECT COUNT(*) FROM tls_reports) AS tls_reports,
         (SELECT COUNT(DISTINCT domain) FROM dmarc_reports) AS domains`,
    ).first<{ reports: number; tls_reports: number; domains: number }>(),
    getLastSync(env.DB),
    isDashboardPublic(env.DB),
    getNotifyView(env),
    syncScheduleView(env),
  ]);

  return new Response(
    renderAdmin({
      signedIn: await hasSession(request, env),
      notify,
      mailboxes,
      sync,
      publicDashboard,
      status: {
        schemaVersion,
        latestSchemaVersion: LATEST_SCHEMA_VERSION,
        reports: counts?.reports ?? 0,
        tlsReports: counts?.tls_reports ?? 0,
        domains: counts?.domains ?? 0,
        encryptionKeyConfigured: Boolean(env.CONFIG_ENCRYPTION_KEY),
        insecureHttp: insecureHttp(env, url),
        imapConfigured: mailboxes.rows.some((m) => m.enabled),
        lastSync,
      },
    }, url),
    { headers: HTML },
  );
}

/** Adds security headers to every response and a Content-Security-Policy to
 * pages. The policy's nonce is generated per response and stamped on our own
 * <script> tags, so nothing injected into a page can run. */
async function secured(res: Response, url: URL): Promise<Response> {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) if (!headers.has(k)) headers.set(k, v);

  const type = headers.get("content-type") ?? "";
  if (!type.startsWith("text/html") || headers.has("content-security-policy")) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  const nonce = newNonce();
  headers.set("content-security-policy", csp(nonce, { tiles: url.pathname === "/map" }));
  headers.delete("content-length");
  return new Response(addNonce(await res.text(), nonce), { status: res.status, statusText: res.statusText, headers });
}

/** Handles one HTTP request. */
export async function handle(request: Request, env: Env, rt: Runtime): Promise<Response> {
  return secured(await route(request, env, rt), new URL(request.url));
}

async function route(request: Request, env: Env, rt: Runtime): Promise<Response> {
  {
    const url = new URL(request.url);
    const pathname = url.pathname;

    await ensureSchema(env.DB);

    if (pathname === "/login") return handleLogin(request, env, url);
    if (pathname === "/logout") return handleLogout(request, env, url);

    if (pathname === "/admin") return handleAdmin(request, env, rt, url);

    if (pathname === "/report") return handleSummary(request, env, url);

    const exportMatch = pathname.match(/^\/export\/([a-z-]+)$/);
    if (exportMatch && (DATASETS as readonly string[]).includes(exportMatch[1])) {
      return handleExport(request, env, exportMatch[1] as Dataset, url);
    }

    const rawMatch = pathname.match(/^\/reports\/([^/]+)\/(xml|json)$/);
    if (rawMatch) return handleRawReport(request, env, rt, decodeURIComponent(rawMatch[1]), rawMatch[2] as "xml" | "json");

    // Everything below is the read-only dashboard, served from D1.
    const blocked = await dashboardGate(request, env);
    if (blocked) return blocked;

    const f = parseFilters(url);
    const signedIn = await hasSession(request, env);
    const page = (opts: Parameters<typeof layout>[0]) => new Response(layout({ ...opts, signedIn }), { headers: HTML });
    const scope = `${scopeLabel(f)} &middot; ${rangeLabel(f.range)}`;

    if (pathname === "/") {
      const list = parseList(url, SOURCE_SORT_KEYS, "risk", "desc");
      const [data, chrome] = await Promise.all([loadOverview(env.DB, f, list), loadChrome(env.DB)]);
      const { body, scripts } = renderOverviewBody(data, f, list, url, chrome.allDomains.length);
      return page({ title: "Overview", subtitle: scope, active: "overview", url, filters: f, chrome, body, scripts, charts: true });
    }

    if (pathname === "/domains") {
      const list = parseList(url, DOMAIN_SORT_KEYS, "risk", "desc");
      const [data, chrome] = await Promise.all([loadDomains(env.DB, f, list), loadChrome(env.DB)]);
      return page({ title: "Domains", subtitle: scope, active: "domains", url, filters: f, chrome, body: renderDomainsBody(data, f, list, url) });
    }

    if (pathname === "/reports") {
      const list = parseList(url, REPORT_SORT_KEYS, "date", "desc");
      const fp = url.searchParams.get("filter") as ReportFilter;
      const filter: ReportFilter = REPORT_FILTERS.includes(fp) ? fp : "all";
      const [data, chrome] = await Promise.all([loadReportsList(env.DB, f, list, filter), loadChrome(env.DB)]);
      return page({ title: "DMARC reports", subtitle: scope, active: "reports", url, filters: f, chrome, body: renderReportsBody(data, f, list, filter, url) });
    }

    const reportDetailMatch = pathname.match(/^\/reports\/([^/]+)$/);
    if (reportDetailMatch) {
      const [detail, chrome, mailboxes] = await Promise.all([
        loadReportDetail(env.DB, decodeURIComponent(reportDetailMatch[1])),
        loadChrome(env.DB),
        loadMailboxes(env),
      ]);
      if (!detail) return new Response("Report not found\n", { status: 404 });
      // Only name the mailbox when there is more than one to tell apart.
      const mailboxName = mailboxes.list.length > 1 ? (mailboxes.list.find((m) => m.id === (detail.mailboxId ?? DEFAULT_ID))?.name ?? "removed mailbox") : null;
      const { body, scripts } = renderReportDetailBody(detail, f, mailboxName);
      return page({ title: `Report from ${detail.org}`, subtitle: `${detail.domain}`, active: "reports", url, chrome, body, scripts });
    }

    if (pathname === "/tls-reports") {
      const [data, chrome] = await Promise.all([loadTls(env.DB, f), loadChrome(env.DB)]);
      return page({ title: "TLS reports", subtitle: scope, active: "tls", url, filters: f, chrome, body: renderTlsBody(data, f, url) });
    }

    if (pathname === "/map") {
      const [data, chrome] = await Promise.all([loadMapPoints(env.DB, f), loadChrome(env.DB)]);
      const { body, scripts } = renderMapBody(data, f);
      return page({ title: "Sender map", subtitle: scope, active: "map", url, filters: f, chrome, body, scripts, leaflet: true });
    }

    return new Response("Not found\n", { status: 404 });
  }
}

/** The Worker wakes on a fast cron tick. A sync runs only when one is due under
 * the interval chosen in Admin; every tick still checks alerts and the digest,
 * so they are on time however long the sync interval is. */
export async function runScheduled(env: Env, rt: Runtime): Promise<void> {
  await ensureSchema(env.DB);
  const now = Math.floor(Date.now() / 1000);
  await recordTick(env.DB, now);

  if (!getAdminCreds(env) || (await loadMailboxes(env)).list.filter((m) => m.enabled).length === 0) {
    console.log("sync skipped: admin login or mailbox not configured yet");
    await runNotifications(env);
    return;
  }
  const minutes = await getSyncMinutes(env.DB);
  if (!syncDue(await getLastAttempt(env.DB), minutes, now) && !(await hasBacklog(env.DB))) {
    await runNotifications(env);
    return;
  }
  try {
    console.log("sync result:", JSON.stringify(await runSync(env, rt)));
  } catch (err) {
    if (err instanceof SyncBusy) {
      console.log("sync skipped: one is already running");
      await runNotifications(env);
    } else console.error("sync failed:", err);
  }
}
