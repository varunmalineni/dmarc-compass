import { Container, getContainer } from "@cloudflare/containers";
import { syncReports, callContainer } from "./sync";
import { loadOverview, SOURCE_SORT_KEYS } from "./dashboard-data";
import { renderOverviewBody } from "./dashboard-html";
import { loadReportsList, loadReportDetail, REPORT_SORT_KEYS, REPORT_FILTERS, type ReportFilter } from "./reports-data";
import { renderReportsBody, renderReportDetailBody } from "./reports-html";
import {
  getEffectiveImapConfig,
  getOverriddenKeys,
  setConfigOverride,
  isImapConfigured,
  type ConfigKey,
} from "./settings-data";
import { renderAdmin } from "./admin-html";
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
import { isDashboardPublic, setDashboardPublic, recordSync, getLastSync } from "./app-settings";
import { getAdminCreds, SETUP_HELP, type AdminEnv } from "./config";
import { parseFilters, parseList, scopeLabel, rangeLabel } from "./filters";
import { layout } from "./shared-ui";

interface Env extends AdminEnv {
  DMARC_CONTAINER: DurableObjectNamespace<DmarcViewerContainer>;
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
}

const HTML = { "content-type": "text/html; charset=utf-8" };
const NOT_CONFIGURED_MAILBOX =
  "No mailbox is configured yet.\n\nOpen /admin, enter the IMAP details of the mailbox that receives your DMARC reports, and save.\n";

// A single long-lived instance of the dmarc-report-viewer container, which
// does the IMAP fetching and report parsing. It keeps everything in memory
// and re-fetches from IMAP on every start, so the durable copy of the data is
// the D1 database (see sync.ts), not the container.
export class DmarcViewerContainer extends Container<Env> {
  defaultPort = 8080;
  // Sleep after 30 minutes without requests. The 15-minute cron sync keeps it
  // awake in practice; if it does sleep, the next request starts it again.
  sleepAfter = "30m";
  pingEndpoint = "localhost/health";

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const creds = getAdminCreds(this.env);
    if (!creds) return new Response(SETUP_HELP, { status: 503 });

    // Internal only: the Worker calls this after a settings save so the
    // container restarts with the new environment. It is never reachable
    // from outside; the Worker is the only caller of this class.
    if (url.pathname === "/admin/restart") {
      if (request.headers.get("x-admin-token") !== creds.password) {
        return new Response("Forbidden\n", { status: 403 });
      }
      await this.stop();
      return new Response("Stopping. The next request starts a fresh container.\n");
    }

    await ensureSchema(this.env.DB);
    const imap = await getEffectiveImapConfig(this.env);
    if (!isImapConfigured(imap)) return new Response(NOT_CONFIGURED_MAILBOX, { status: 503 });

    // Credentials are injected here at start time rather than baked into the
    // image. Values saved from /admin win over the Worker secrets.
    await this.startAndWaitForPorts({
      startOptions: {
        envVars: {
          IMAP_HOST: imap.IMAP_HOST,
          IMAP_PORT: "993",
          IMAP_USER: imap.IMAP_USER,
          IMAP_PASSWORD: imap.IMAP_PASSWORD,
          IMAP_FOLDER: imap.IMAP_FOLDER || "INBOX",
          IMAP_CHECK_INTERVAL: "900",
          LOG_LEVEL: "debug",
          HTTP_SERVER_PORT: "8080",
          HTTP_SERVER_USER: creds.user,
          HTTP_SERVER_PASSWORD: creds.password,
        },
      },
    });
    return this.containerFetch(request);
  }

  override onStart() {
    console.log("dmarc-report-viewer container started");
  }

  override onError(error: unknown) {
    console.error("dmarc-report-viewer container error:", error);
    throw error;
  }
}

function hasValidBasicAuth(request: Request, env: Env): boolean {
  const creds = getAdminCreds(env);
  const auth = request.headers.get("authorization");
  if (!creds || !auth?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(auth.slice(6));
    const sep = decoded.indexOf(":");
    if (sep === -1) return false;
    return decoded.slice(0, sep) === creds.user && decoded.slice(sep + 1) === creds.password;
  } catch {
    return false;
  }
}

function challenge(env: Env): Response {
  // No admin login exists yet: say what to do instead of showing a login
  // prompt that can never succeed.
  if (!getAdminCreds(env)) return new Response(SETUP_HELP, { status: 503 });
  return new Response("Unauthorized\n", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="dmarc-compass"' },
  });
}

/** Gate for the read-only dashboard pages: open when the admin has made the
 * dashboard public, otherwise the admin login is required. */
async function dashboardGate(request: Request, env: Env): Promise<Response | null> {
  if (await isDashboardPublic(env.DB)) return null;
  return hasValidBasicAuth(request, env) ? null : challenge(env);
}

async function restartContainer(env: Env): Promise<void> {
  const creds = getAdminCreds(env);
  if (!creds) return;
  const container = getContainer(env.DMARC_CONTAINER, "dmarc-viewer");
  try {
    await container.fetch(
      new Request("https://internal/admin/restart", { method: "POST", headers: { "x-admin-token": creds.password } }),
    );
  } catch (err) {
    // The container may simply not be running yet; the next request starts it.
    console.warn("container restart skipped:", err);
  }
}

async function runSync(env: Env): Promise<Awaited<ReturnType<typeof syncReports>>> {
  const container = getContainer(env.DMARC_CONTAINER, "dmarc-viewer");
  try {
    const result = await syncReports(container, env);
    await recordSync(
      env.DB,
      true,
      `${result.newReports} new DMARC reports, ${result.newTlsReports} new TLS reports`,
    );
    return result;
  } catch (err) {
    await recordSync(env.DB, false, String(err instanceof Error ? err.message : err).slice(0, 200));
    throw err;
  } finally {
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
async function handleRawReport(request: Request, env: Env, hash: string, format: "xml" | "json"): Promise<Response> {
  if (!hasValidBasicAuth(request, env)) return challenge(env);

  const row = await env.DB.prepare("SELECT org_name, report_id, domain FROM dmarc_reports WHERE hash = ?")
    .bind(hash)
    .first<{ org_name: string; report_id: string; domain: string }>();
  if (!row) return new Response("Report not found\n", { status: 404 });

  const container = getContainer(env.DMARC_CONTAINER, "dmarc-viewer");
  let current: string | undefined;
  try {
    const list = await callContainer(container, "/dmarc-reports", env);
    if (!list.ok) return new Response(`The container could not list reports (${list.status}).\n`, { status: 502 });
    const headers = await list.json<Array<{ hash: string; id: string; org: string; domain: string }>>();
    current = headers.find(
      (h) => h.org === row.org_name && h.id === row.report_id && h.domain.toLowerCase() === row.domain.toLowerCase(),
    )?.hash;
  } catch (err) {
    return new Response(`The container is not reachable yet: ${err instanceof Error ? err.message : err}\n`, { status: 502 });
  }
  if (!current) {
    return new Response(
      "The container no longer has this report, so the original file is unavailable. " +
        "The parsed data in this dashboard is unaffected. This happens if the email was deleted or moved out of the mailbox folder.\n",
      { status: 404 },
    );
  }

  const upstream = await callContainer(container, `/dmarc-reports/${encodeURIComponent(current)}/${format}`, env);
  if (!upstream.ok) return new Response(`The container returned ${upstream.status}.\n`, { status: 502 });

  const name = `${row.org_name}_${row.report_id}`.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  const download = new URL(request.url).searchParams.get("download") === "1";
  return new Response(upstream.body, {
    headers: {
      // Plain text, never application/xml: a crafted report must not be rendered as markup in our origin.
      "content-type": format === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${name}.${format}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
}

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!hasValidBasicAuth(request, env)) return challenge(env);

  if (request.method === "POST") {
    // CSRF guard: a cross-site <form> can't set a custom header without a CORS
    // preflight, which this app never allows. Only the admin page's own
    // fetch() calls include it.
    if (request.headers.get("x-settings-request") !== "1") return jsonError("Forbidden", 403);
    const body = await request.json<Record<string, unknown>>();

    if (body.action === "sync") {
      const imap = await getEffectiveImapConfig(env);
      if (!isImapConfigured(imap)) return jsonError("Configure the mailbox first.", 400);
      try {
        return Response.json(await runSync(env));
      } catch (err) {
        return jsonError(String(err instanceof Error ? err.message : err), 502);
      }
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
      const res = await addWebhook(env, { url: body.url, name: body.name, alerts: optBool(body.alerts), digest: optBool(body.digest) });
      return res.ok ? notifyState() : jsonError(res.error, 400);
    }
    if (body.action === "webhook_update") {
      const res = await updateWebhook(env, str(body.id), {
        name: typeof body.name === "string" ? body.name : undefined,
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

    const fieldMap: Record<string, ConfigKey> = {
      imap_host: "IMAP_HOST",
      imap_user: "IMAP_USER",
      imap_folder: "IMAP_FOLDER",
      imap_password: "IMAP_PASSWORD",
    };
    const changes = Object.entries(fieldMap).filter(([field]) => typeof body[field] === "string" && body[field]);
    if (changes.length === 0) return new Response("Nothing to save\n");
    if (!env.CONFIG_ENCRYPTION_KEY) {
      return jsonError("CONFIG_ENCRYPTION_KEY is not set, so credentials can't be stored. See the setup status on this page.", 400);
    }
    for (const [field, key] of changes) {
      await setConfigOverride(env.DB, env.CONFIG_ENCRYPTION_KEY, key, body[field] as string);
    }
    await restartContainer(env);
    return new Response("OK\n");
  }

  await rememberBaseUrl(env.DB, url.origin);

  const [imap, overridden, passwordRow, schemaVersion, counts, lastSync, publicDashboard, notify] = await Promise.all([
    getEffectiveImapConfig(env),
    getOverriddenKeys(env.DB),
    env.DB.prepare("SELECT updated_at FROM settings WHERE key = 'IMAP_PASSWORD'").first<{ updated_at: number }>(),
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
  ]);

  return new Response(
    renderAdmin({
      notify,
      imapHost: imap.IMAP_HOST,
      imapUser: imap.IMAP_USER,
      imapFolder: imap.IMAP_FOLDER,
      overridden,
      passwordUpdatedAt: passwordRow?.updated_at ?? null,
      publicDashboard,
      status: {
        schemaVersion,
        latestSchemaVersion: LATEST_SCHEMA_VERSION,
        reports: counts?.reports ?? 0,
        tlsReports: counts?.tls_reports ?? 0,
        domains: counts?.domains ?? 0,
        encryptionKeyConfigured: Boolean(env.CONFIG_ENCRYPTION_KEY),
        imapConfigured: isImapConfigured(imap),
        lastSync,
      },
    }, url),
    { headers: HTML },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    await ensureSchema(env.DB);

    if (pathname === "/admin") return handleAdmin(request, env, url);

    const rawMatch = pathname.match(/^\/reports\/([^/]+)\/(xml|json)$/);
    if (rawMatch) return handleRawReport(request, env, decodeURIComponent(rawMatch[1]), rawMatch[2] as "xml" | "json");

    // Everything below is the read-only dashboard, served from D1.
    const blocked = await dashboardGate(request, env);
    if (blocked) return blocked;

    const f = parseFilters(url);
    const page = (opts: Parameters<typeof layout>[0]) => new Response(layout(opts), { headers: HTML });
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
      const [detail, chrome] = await Promise.all([loadReportDetail(env.DB, decodeURIComponent(reportDetailMatch[1])), loadChrome(env.DB)]);
      if (!detail) return new Response("Report not found\n", { status: 404 });
      return page({ title: `Report from ${detail.org}`, subtitle: `${detail.domain}`, active: "reports", url, chrome, body: renderReportDetailBody(detail, f) });
    }

    if (pathname === "/tls-reports") {
      const [data, chrome] = await Promise.all([loadTls(env.DB, f), loadChrome(env.DB)]);
      return page({ title: "TLS reports", subtitle: scope, active: "tls", url, filters: f, chrome, body: renderTlsBody(data, f) });
    }

    if (pathname === "/map") {
      const [data, chrome] = await Promise.all([loadMapPoints(env.DB, f), loadChrome(env.DB)]);
      const { body, scripts } = renderMapBody(data, f);
      return page({ title: "Sender map", subtitle: scope, active: "map", url, filters: f, chrome, body, scripts, leaflet: true });
    }

    return new Response("Not found\n", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await ensureSchema(env.DB);

    if (!getAdminCreds(env) || !isImapConfigured(await getEffectiveImapConfig(env))) {
      console.log("sync skipped: admin login or mailbox not configured yet");
      await runNotifications(env);
      return;
    }
    try {
      console.log("sync result:", JSON.stringify(await runSync(env)));
    } catch (err) {
      console.error("sync failed:", err);
    }
  },
} satisfies ExportedHandler<Env>;
