// Notifications: alert rules, the digest, and delivery to a Slack-compatible
// incoming webhook.
//
// Alerts are evaluated after each sync, using a cursor (the time of the last
// evaluation) so only data ingested since then is considered. The digest is
// sent on the schedule in digest-schedule.ts. Both go through the same
// webhook. A delivery failure never fails a sync, and nothing is marked as
// "already alerted" until Slack has accepted the message, so a failure is
// retried on the next run.

import { getAppSetting, setAppSetting, getLastSync } from "./app-settings";
import { encryptValue, decryptValue } from "./crypto-util";
import { sanitizeConfig, maskWebhook, DEFAULT_CONFIG, type NotifyConfig } from "./notify-config";
import { addHook, parseHooks, receiving, removeHook, toView, updateHook, type Hook, type HookView, MAX_HOOKS } from "./webhooks";
import { digestDue, digestPeriodDays, nextSlot } from "./digest-schedule";
import { loadDomains } from "./domains-data";
import {
  context,
  header,
  linkBlock,
  num,
  pct,
  safe,
  sections,
  type SlackBlock,
  type SlackMessage,
} from "./slack-format";

export interface NotifyEnv {
  DB: D1Database;
  CONFIG_ENCRYPTION_KEY?: string;
  /** Optional: a webhook URL supplied as a Worker secret instead of saved from /admin. */
  SLACK_WEBHOOK_URL?: string;
}

const DAY = 86400;
const HOOKS_KEY = "SLACK_WEBHOOKS";
/** Before there could be several webhooks, one was stored under this key. */
const LEGACY_KEY = "SLACK_WEBHOOK_URL";
const MAX_LINES_PER_RULE = 10;
const MAX_CANDIDATES = 200;
/** New senders are only alerted on if their traffic is recent, so connecting an
 * old mailbox does not announce years of history. */
const RECENT_DAYS = 14;
const COOLDOWN = { newSender: 365 * DAY, drop: 7 * DAY, policy: 365 * DAY, syncFailed: DAY } as const;

const PASS = "(r.policy_dkim = 'pass' OR r.policy_spf = 'pass')";
const RANK_NAME = ["none", "quarantine", "reject"];

export type RuleId = "newFailingSender" | "passRateDrop" | "policyChange" | "syncHealth";
const RULE_TITLES: Record<RuleId, string> = {
  newFailingSender: "New failing senders",
  passRateDrop: "Pass rate dropped",
  policyChange: "Policy changed",
  syncHealth: "Sync problem",
};

export interface Alert {
  rule: RuleId;
  /** Stable identity, used for the once-only guarantee. */
  key: string;
  line: string;
  /** Larger sorts first within a rule. */
  weight: number;
  cooldown: number;
}

// ---------------------------------------------------------------- settings --

export async function getConfig(db: D1Database): Promise<{ config: NotifyConfig; saved: boolean }> {
  const raw = await getAppSetting(db, "notify_config");
  if (!raw) return { config: DEFAULT_CONFIG, saved: false };
  try {
    return { config: sanitizeConfig(JSON.parse(raw)), saved: true };
  } catch {
    return { config: DEFAULT_CONFIG, saved: false };
  }
}

async function getNumber(db: D1Database, key: string): Promise<number | null> {
  const v = await getAppSetting(db, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- webhooks --

/** A webhook plus where it came from. */
export interface Destination extends Hook {
  source: "saved" | "secret";
}

/** The webhooks saved from /admin. Stored as one encrypted list. */
async function loadSavedHooks(env: NotifyEnv): Promise<Hook[]> {
  const key = env.CONFIG_ENCRYPTION_KEY;
  if (!key) return [];
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(HOOKS_KEY).first<{ value: string }>();
  try {
    if (row) return parseHooks(await decryptValue(row.value, key));
    // Upgrade path: a single webhook saved before lists existed.
    const legacy = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(LEGACY_KEY).first<{ value: string }>();
    if (!legacy) return [];
    const url = await decryptValue(legacy.value, key);
    const name = (await getAppSetting(env.DB, "notify_webhook_name")) ?? "";
    return parseHooks(JSON.stringify([{ id: "h1", name, url, alerts: true, digest: true }]));
  } catch {
    // An unreadable list (for example after a key change) must not break the app.
    return [];
  }
}

async function saveHooks(env: NotifyEnv, list: Hook[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(HOOKS_KEY, await encryptValue(JSON.stringify(list), env.CONFIG_ENCRYPTION_KEY as string), now)
    .run();
  // The list now holds everything the single-webhook keys did.
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(LEGACY_KEY).run();
  await env.DB.prepare("DELETE FROM app_settings WHERE key = 'notify_webhook_name'").run();
}

/** Every webhook that can receive messages: the saved ones, plus one supplied
 * as a Worker secret. */
export async function getDestinations(env: NotifyEnv): Promise<Destination[]> {
  const saved: Destination[] = (await loadSavedHooks(env)).map((h) => ({ ...h, source: "saved" }));
  const secret = env.SLACK_WEBHOOK_URL;
  if (secret && !saved.some((h) => h.url === secret)) {
    saved.push({ id: "secret", name: "Worker secret", url: secret, alerts: true, digest: true, source: "secret" });
  }
  return saved;
}

export interface HookResult {
  at: number;
  ok: boolean;
  kind: "alert" | "digest" | "test";
  detail: string;
}

async function loadResults(db: D1Database): Promise<Record<string, HookResult>> {
  try {
    const raw = await getAppSetting(db, "notify_hook_results");
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, HookResult>) : {};
  } catch {
    return {};
  }
}

async function recordResults(db: D1Database, entries: Array<[string, HookResult]>, forget: string[] = []): Promise<void> {
  const all = await loadResults(db);
  for (const id of forget) delete all[id];
  for (const [id, r] of entries) all[id] = r;
  await setAppSetting(db, "notify_hook_results", JSON.stringify(all));
}

export interface HookRow extends HookView {
  result: HookResult | null;
}

export interface NotifyView {
  config: NotifyConfig;
  saved: boolean;
  hooks: HookRow[];
  hookLimit: number;
  canSaveWebhook: boolean;
  nextDigestAt: number | null;
  baseUrlKnown: boolean;
}

export async function getNotifyView(env: NotifyEnv): Promise<NotifyView> {
  const [{ config, saved }, dests, results, lastSlot, enabledAt, base] = await Promise.all([
    getConfig(env.DB),
    getDestinations(env),
    loadResults(env.DB),
    getNumber(env.DB, "notify_digest_last_slot"),
    getNumber(env.DB, "notify_digest_enabled_at"),
    getAppSetting(env.DB, "base_url"),
  ]);
  const now = Math.floor(Date.now() / 1000);
  return {
    config,
    saved,
    hooks: dests.map((d) => ({ ...toView(d, d.source), result: results[d.id] ?? null })),
    hookLimit: MAX_HOOKS,
    canSaveWebhook: Boolean(env.CONFIG_ENCRYPTION_KEY),
    nextDigestAt: receiving("digest", dests).length ? nextSlot(config.digest, lastSlot, enabledAt ?? now, now) : null,
    baseUrlKnown: Boolean(base),
  };
}

/** Remembers the dashboard's address (from an admin request) so messages can link back to it. */
export async function rememberBaseUrl(db: D1Database, origin: string): Promise<void> {
  if ((await getAppSetting(db, "base_url")) !== origin) await setAppSetting(db, "base_url", origin);
}

type Done = { ok: true } | { ok: false; error: string };

/** Saves the alert rules and digest schedule. */
export async function saveNotifyConfig(env: NotifyEnv, input: unknown): Promise<Done> {
  const now = Math.floor(Date.now() / 1000);
  const next = sanitizeConfig(input);
  const prev = (await getConfig(env.DB)).config;
  await setAppSetting(env.DB, "notify_config", JSON.stringify(next));
  if (JSON.stringify(prev.digest) !== JSON.stringify(next.digest)) {
    // A changed schedule starts from now: it must not fire for a slot that already passed.
    await setAppSetting(env.DB, "notify_digest_enabled_at", String(now));
    await env.DB.prepare("DELETE FROM app_settings WHERE key = 'notify_digest_last_slot'").run();
  }
  if ((await getNumber(env.DB, "notify_cursor")) === null) await setAppSetting(env.DB, "notify_cursor", String(now));
  return { ok: true };
}

function needKey(env: NotifyEnv): Done | null {
  return env.CONFIG_ENCRYPTION_KEY
    ? null
    : { ok: false, error: "CONFIG_ENCRYPTION_KEY is not set, so webhooks can't be stored. See Setup status." };
}

export async function addWebhook(
  env: NotifyEnv,
  input: { url: unknown; name?: unknown; alerts?: unknown; digest?: unknown },
): Promise<Done> {
  const missing = needKey(env);
  if (missing) return missing;
  const before = await getDestinations(env);
  const saved = await loadSavedHooks(env);
  const res = addHook(saved, input, crypto.randomUUID().slice(0, 8));
  if (!res.ok) return res;
  await saveHooks(env, res.list);
  if (before.length === 0) {
    // The first webhook starts clean: history is not "new", and a schedule that
    // was set long ago must not fire a catch-up digest the moment it appears.
    const now = String(Math.floor(Date.now() / 1000));
    await setAppSetting(env.DB, "notify_cursor", now);
    await setAppSetting(env.DB, "notify_digest_enabled_at", now);
    await env.DB.prepare("DELETE FROM app_settings WHERE key = 'notify_digest_last_slot'").run();
  }
  return { ok: true };
}

export async function updateWebhook(
  env: NotifyEnv,
  id: string,
  patch: { name?: unknown; alerts?: unknown; digest?: unknown },
): Promise<Done> {
  const missing = needKey(env);
  if (missing) return missing;
  if (id === "secret") return { ok: false, error: "This webhook comes from a Worker secret and can't be edited here." };
  const res = updateHook(await loadSavedHooks(env), id, patch);
  if (!res.ok) return res;
  await saveHooks(env, res.list);
  return { ok: true };
}

export async function removeWebhook(env: NotifyEnv, id: string): Promise<Done> {
  const missing = needKey(env);
  if (missing) return missing;
  if (id === "secret") return { ok: false, error: "This webhook comes from a Worker secret. Remove the SLACK_WEBHOOK_URL secret to stop using it." };
  const saved = await loadSavedHooks(env);
  if (!saved.some((h) => h.id === id)) return { ok: false, error: "That webhook no longer exists." };
  await saveHooks(env, removeHook(saved, id));
  await recordResults(env.DB, [], [id]);
  return { ok: true };
}

// ---------------------------------------------------------------- delivery --

export async function postSlack(url: string, message: SlackMessage): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    const body = (await res.text().catch(() => "")).slice(0, 100);
    return { ok: false, error: `The webhook answered ${res.status}${body ? `: ${body}` : ""}` };
  } catch (err) {
    // The URL is a credential: never include it in an error.
    return { ok: false, error: `Could not reach the webhook (${err instanceof Error ? err.name : "error"}).` };
  }
}

const hookLabel = (d: Hook) => d.name || maskWebhook(d.url);

/** Sends one message to several webhooks and records how each one went. */
async function deliver(
  env: NotifyEnv,
  targets: Hook[],
  kind: HookResult["kind"],
  message: SlackMessage,
  okDetail: string,
): Promise<{ sent: number; errors: string[] }> {
  const at = Math.floor(Date.now() / 1000);
  const outcomes = await Promise.all(targets.map((t) => postSlack(t.url, message)));
  const entries: Array<[string, HookResult]> = [];
  const errors: string[] = [];
  let sent = 0;
  outcomes.forEach((o, i) => {
    const t = targets[i];
    if (o.ok) {
      sent++;
      entries.push([t.id, { at, ok: true, kind, detail: okDetail }]);
    } else {
      errors.push(`${hookLabel(t)}: ${o.error}`);
      entries.push([t.id, { at, ok: false, kind, detail: o.error.slice(0, 200) }]);
    }
  });
  if (entries.length) await recordResults(env.DB, entries);
  return { sent, errors };
}

// -------------------------------------------------------------------- rules --

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** A source failing DMARC for a domain it was not seen on before. */
async function newFailingSenders(
  db: D1Database,
  win: { kind: "cursor"; cursor: number } | { kind: "period"; since: number },
  minMessages: number,
  now: number,
): Promise<Alert[]> {
  const recent = now - RECENT_DAYS * DAY;
  const where =
    win.kind === "cursor"
      ? "rep.inserted_at > ? AND r.date_begin >= ?"
      : "r.date_begin >= ? AND r.date_begin >= ?";
  const notSeenBefore =
    win.kind === "cursor"
      ? `NOT EXISTS (SELECT 1 FROM dmarc_records o JOIN dmarc_reports orep ON orep.hash = o.report_hash
                      WHERE o.domain = r.domain AND o.source_ip = r.source_ip AND orep.inserted_at <= ?)`
      : `NOT EXISTS (SELECT 1 FROM dmarc_records o WHERE o.domain = r.domain AND o.source_ip = r.source_ip AND o.date_begin < ?)`;
  const bound = win.kind === "cursor" ? win.cursor : win.since;

  const rows = await db
    .prepare(
      `SELECT r.domain AS domain, r.source_ip AS ip, COALESCE(MAX(e.esp_name), 'Unknown sender') AS esp,
              SUM(CASE WHEN ${PASS} THEN 0 ELSE r.count END) AS failing, SUM(r.count) AS total
         FROM dmarc_records r
         JOIN dmarc_reports rep ON rep.hash = r.report_hash
         LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
        WHERE ${where}
        GROUP BY r.domain, r.source_ip
       HAVING failing >= ? AND ${notSeenBefore}
        ORDER BY failing DESC
        LIMIT ${MAX_CANDIDATES}`,
    )
    .bind(bound, win.kind === "cursor" ? recent : Math.max(bound, recent), minMessages, bound)
    .all<{ domain: string; ip: string; esp: string; failing: number; total: number }>();

  return rows.results.map((r) => ({
    rule: "newFailingSender",
    key: `nfs:${r.domain}:${r.ip}`,
    weight: r.failing,
    cooldown: COOLDOWN.newSender,
    line: `• *${safe(r.domain)}*  ${safe(r.esp, 40)} \`${safe(r.ip, 45)}\`  ${num(r.failing)} failing of ${num(r.total)} messages`,
  }));
}

/** A domain's pass rate fell by at least `points` against the previous 7 days. */
async function passRateDrops(
  db: D1Database,
  cfg: NotifyConfig["rules"]["passRateDrop"],
  cursor: number,
  now: number,
): Promise<Alert[]> {
  const w1 = now - 7 * DAY;
  const w2 = now - 14 * DAY;
  const rows = await db
    .prepare(
      `SELECT r.domain AS domain,
              SUM(CASE WHEN r.date_begin >= ? THEN r.count ELSE 0 END) AS cur_total,
              SUM(CASE WHEN r.date_begin >= ? AND ${PASS} THEN r.count ELSE 0 END) AS cur_pass,
              SUM(CASE WHEN r.date_begin < ? THEN r.count ELSE 0 END) AS prev_total,
              SUM(CASE WHEN r.date_begin < ? AND ${PASS} THEN r.count ELSE 0 END) AS prev_pass
         FROM dmarc_records r
        WHERE r.date_begin >= ?
          AND r.domain IN (SELECT DISTINCT domain FROM dmarc_reports WHERE inserted_at > ?)
        GROUP BY r.domain`,
    )
    .bind(w1, w1, w1, w1, w2, cursor)
    .all<{ domain: string; cur_total: number; cur_pass: number; prev_total: number; prev_pass: number }>();

  const out: Alert[] = [];
  for (const r of rows.results) {
    if (r.cur_total < cfg.minMessages || r.prev_total < cfg.minMessages) continue;
    const cur = (r.cur_pass / r.cur_total) * 100;
    const prev = (r.prev_pass / r.prev_total) * 100;
    const drop = prev - cur;
    if (drop < cfg.points) continue;
    out.push({
      rule: "passRateDrop",
      key: `drop:${r.domain}`,
      weight: drop,
      cooldown: COOLDOWN.drop,
      line: `• *${safe(r.domain)}*  ${pct(prev)} → ${pct(cur)} (-${drop.toFixed(1)} pts, ${num(r.cur_total)} messages this week)`,
    });
  }
  return out;
}

/** A domain's published p= or pct= changed. Reporters see a change at different
 * times, so each day takes the strictest value reported that day. */
async function policyChanges(db: D1Database, cursor: number, since: number): Promise<Alert[]> {
  const rows = await db
    .prepare(
      `WITH daily AS (
         SELECT rep.domain AS domain, date(rep.date_begin, 'unixepoch') AS day,
                MAX(CASE rep.policy_p WHEN 'reject' THEN 2 WHEN 'quarantine' THEN 1 ELSE 0 END) AS rank,
                MAX(COALESCE(rep.policy_pct, 100)) AS pct
           FROM dmarc_reports rep
          WHERE rep.date_begin >= ?
            AND rep.domain IN (SELECT DISTINCT domain FROM dmarc_reports WHERE inserted_at > ?)
          GROUP BY rep.domain, day),
       chg AS (
         SELECT domain, day, rank, pct,
                LAG(rank) OVER (PARTITION BY domain ORDER BY day) AS prev_rank,
                LAG(pct)  OVER (PARTITION BY domain ORDER BY day) AS prev_pct
           FROM daily)
       SELECT domain, day, prev_rank, rank, prev_pct, pct FROM chg
        WHERE prev_rank IS NOT NULL AND (rank != prev_rank OR pct != prev_pct) AND day >= date(?, 'unixepoch')
        ORDER BY day DESC
        LIMIT ${MAX_CANDIDATES}`,
    )
    .bind(since - 45 * DAY, cursor, since)
    .all<{ domain: string; day: string; prev_rank: number; rank: number; prev_pct: number; pct: number }>();

  return rows.results.map((r) => {
    const stricter = r.rank > r.prev_rank || (r.rank === r.prev_rank && r.pct > r.prev_pct);
    const from = `p=${RANK_NAME[r.prev_rank]}${r.prev_pct !== 100 ? ` pct=${r.prev_pct}` : ""}`;
    const to = `p=${RANK_NAME[r.rank]}${r.pct !== 100 ? ` pct=${r.pct}` : ""}`;
    return {
      rule: "policyChange" as const,
      key: `pol:${r.domain}:${r.day}:${r.rank}:${r.pct}`,
      weight: r.rank * 1000 + r.pct,
      cooldown: COOLDOWN.policy,
      line: `• *${safe(r.domain)}*  \`${from}\` → \`${to}\`  ${stricter ? "(stricter)" : "(relaxed)"}, seen ${r.day}`,
    };
  });
}

// ---------------------------------------------------------------- messages --

function groupMessage(alerts: Alert[], baseUrl: string | null, preview = false): SlackMessage {
  const blocks: SlackBlock[] = [header(`dmarc-compass: ${alerts.length} alert${alerts.length === 1 ? "" : "s"}`)];
  for (const rule of Object.keys(RULE_TITLES) as RuleId[]) {
    const group = alerts.filter((a) => a.rule === rule).sort((a, b) => b.weight - a.weight);
    if (!group.length) continue;
    const lines = [`*${RULE_TITLES[rule]}* (${group.length})`, ...group.slice(0, MAX_LINES_PER_RULE).map((a) => a.line)];
    if (group.length > MAX_LINES_PER_RULE) lines.push(`_+${group.length - MAX_LINES_PER_RULE} more_`);
    blocks.push(...sections(lines));
  }
  blocks.push(...linkBlock(baseUrl, "/domains", "Open the dashboard"));
  if (preview) blocks.push(context("Preview only. Nothing was sent."));
  return { text: `dmarc-compass: ${alerts.length} alert${alerts.length === 1 ? "" : "s"}`, blocks };
}

const signed = (n: number, digits = 0) => `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(digits)}`;

interface PeriodTotals {
  total: number;
  passed: number;
  sources: number;
  failingSources: number;
  domains: number;
  reports: number;
}

/** Totals for reports whose period starts in [start, end). */
async function periodTotals(db: D1Database, start: number, end: number): Promise<PeriodTotals> {
  const [t, f, rep] = await Promise.all([
    db
      .prepare(
        `SELECT COALESCE(SUM(r.count), 0) AS total,
                COALESCE(SUM(CASE WHEN ${PASS} THEN r.count ELSE 0 END), 0) AS passed,
                COUNT(DISTINCT r.source_ip) AS sources, COUNT(DISTINCT r.domain) AS domains
           FROM dmarc_records r WHERE r.date_begin >= ? AND r.date_begin < ?`,
      )
      .bind(start, end)
      .first<{ total: number; passed: number; sources: number; domains: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT r.source_ip FROM dmarc_records r WHERE r.date_begin >= ? AND r.date_begin < ?
            GROUP BY r.source_ip HAVING SUM(CASE WHEN ${PASS} THEN 0 ELSE r.count END) > 0)`,
      )
      .bind(start, end)
      .first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM dmarc_reports WHERE date_begin >= ? AND date_begin < ?")
      .bind(start, end)
      .first<{ n: number }>(),
  ]);
  return {
    total: t?.total ?? 0,
    passed: t?.passed ?? 0,
    sources: t?.sources ?? 0,
    failingSources: f?.n ?? 0,
    domains: t?.domains ?? 0,
    reports: rep?.n ?? 0,
  };
}

const shortDate = (epoch: number) =>
  new Date(epoch * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The digest covers the last N complete UTC days. Receivers date each report
 * at 00:00 UTC of the day it covers and send it hours later, so a rolling
 * "last 24 hours" window would miss almost everything. */
async function buildDigest(env: NotifyEnv, cfg: NotifyConfig, baseUrl: string | null, now: number): Promise<SlackMessage> {
  const days = digestPeriodDays(cfg.digest);
  const end = now - (now % DAY);
  const start = end - days * DAY;
  const list = { q: "", sort: "risk", dir: "desc" as const, page: 1 };
  const [cur, prev, domains, senders, policies] = await Promise.all([
    periodTotals(env.DB, start, end),
    periodTotals(env.DB, start - days * DAY, start),
    loadDomains(env.DB, { domains: [], range: Math.max(30, days + 1) }, list),
    newFailingSenders(env.DB, { kind: "period", since: start }, cfg.rules.newFailingSender.minMessages, now),
    policyChanges(env.DB, 0, start),
  ]);

  const rate = cur.total ? (cur.passed / cur.total) * 100 : 0;
  const prevRate = prev.total ? (prev.passed / prev.total) * 100 : null;
  const volume = prev.total ? ` (${signed(((cur.total - prev.total) / prev.total) * 100)}% vs the period before)` : "";
  const rateNote = prevRate !== null && cur.total ? ` (${signed(rate - prevRate, 1)} pts)` : "";

  const s = domains.summary;
  const statusDays = Math.max(30, days + 1);
  const attention = domains.rows.filter((r) => r.status === "attention").slice(0, 5);
  const label = days === 1 ? shortDate(start) : `${shortDate(start)} to ${shortDate(end - 1)}`;

  const blocks: SlackBlock[] = [header(`dmarc-compass digest: ${label}`)];
  blocks.push(
    ...sections([
      cur.total ? `*${num(cur.total)}* messages${volume}` : "No messages in reports for this period yet. Receivers can take a day or two to report.",
      ...(cur.total
        ? [
            `Pass rate *${pct(rate)}*${rateNote}  ·  ${num(cur.sources)} sending sources, ${num(cur.failingSources)} failing`,
            `${num(cur.reports)} reports from ${num(cur.domains)} domains`,
          ]
        : []),
    ]),
  );
  blocks.push(
    ...sections([
      `*Domains* (${num(s.domains)}), status over the last ${statusDays} days`,
      `${num(s.enforced)} enforced  ·  ${num(s.ready)} ready to tighten  ·  ${num(s.attention)} need attention  ·  ${num(s.idle)} idle`,
    ]),
  );
  if (attention.length) {
    blocks.push(
      ...sections([
        "*Most failing domains*",
        ...attention.map((r) => `• *${safe(r.domain)}*  ${num(r.failing)} failing of ${num(r.total)} (${pct(r.rate)} pass), \`p=${r.policy ?? "?"}\``),
      ]),
    );
  }
  if (policies.length) {
    blocks.push(
      ...sections([`*Policy changes* (${policies.length})`, ...policies.slice(0, 5).map((a) => a.line), ...(policies.length > 5 ? [`_+${policies.length - 5} more_`] : [])]),
    );
  }
  if (senders.length) {
    blocks.push(
      ...sections([
        `*New failing senders* (${senders.length})`,
        ...senders.slice(0, 5).map((a) => a.line),
        ...(senders.length > 5 ? [`_+${senders.length - 5} more_`] : []),
      ]),
    );
  }
  blocks.push(...linkBlock(baseUrl, "/domains", "Open the dashboard"));
  return { text: `dmarc-compass digest: ${label}`, blocks };
}

// ----------------------------------------------------------- orchestration --

interface Collected {
  alerts: Alert[];
  /** Set when healthy again after a sync alert, so a recovery note can be sent. */
  recovered: boolean;
}

async function collectAlerts(
  env: NotifyEnv,
  cfg: NotifyConfig,
  opts: { cursor: number; now: number; lookbackSince: number },
): Promise<Collected> {
  const { cursor, now, lookbackSince } = opts;
  const r = cfg.rules;
  const [senders, drops, policies] = await Promise.all([
    r.newFailingSender.on ? newFailingSenders(env.DB, { kind: "cursor", cursor }, r.newFailingSender.minMessages, now) : [],
    r.passRateDrop.on ? passRateDrops(env.DB, r.passRateDrop, cursor, now) : [],
    r.policyChange.on ? policyChanges(env.DB, cursor, lookbackSince) : [],
  ]);
  const alerts: Alert[] = [...senders, ...drops, ...policies];

  let recovered = false;
  if (r.syncHealth.on) {
    const last = await getLastSync(env.DB);
    if (last) {
      const staleFor = now - last.at;
      if (!last.ok) {
        alerts.push({
          rule: "syncHealth",
          key: "sync-failed",
          weight: 2,
          cooldown: COOLDOWN.syncFailed,
          line: `• The last sync failed: ${safe(last.summary, 150)}`,
        });
      } else if (staleFor > r.syncHealth.staleMinutes * 60) {
        alerts.push({
          rule: "syncHealth",
          key: "sync-stale",
          weight: 1,
          cooldown: COOLDOWN.syncFailed,
          line: `• No successful sync for ${Math.round(staleFor / 3600)} hours.`,
        });
      } else {
        recovered = (await getAppSetting(env.DB, "notify_sync_alerting")) === "1";
      }
    }
  }
  return { alerts, recovered };
}

async function dropCooledDown(db: D1Database, alerts: Alert[], now: number): Promise<Alert[]> {
  const last = new Map<string, number>();
  for (const part of chunks(alerts.map((a) => a.key), 80)) {
    const rows = await db
      .prepare(`SELECT key, last_alerted_at FROM alert_state WHERE key IN (${part.map(() => "?").join(",")})`)
      .bind(...part)
      .all<{ key: string; last_alerted_at: number }>();
    for (const row of rows.results) last.set(row.key, row.last_alerted_at);
  }
  return alerts.filter((a) => {
    const at = last.get(a.key);
    return at === undefined || now - at >= a.cooldown;
  });
}

async function markSent(db: D1Database, alerts: Alert[], now: number): Promise<void> {
  for (const part of chunks(alerts, 90)) {
    await db.batch(
      part.map((a) =>
        db.prepare("INSERT OR REPLACE INTO alert_state (key, last_alerted_at) VALUES (?, ?)").bind(a.key, now),
      ),
    );
  }
}

export interface NotifyOutcome {
  skipped?: string;
  alertsSent: number;
  digestSent: boolean;
  error?: string;
}

/** Called after every scheduled or manual sync. Never throws. */
export async function runNotifications(env: NotifyEnv): Promise<NotifyOutcome> {
  const outcome: NotifyOutcome = { alertsSent: 0, digestSent: false };
  try {
    const dests = await getDestinations(env);
    if (dests.length === 0) return { ...outcome, skipped: "no webhook configured" };
    const alertTargets = receiving("alerts", dests);
    const digestTargets = receiving("digest", dests);

    const { config: cfg } = await getConfig(env.DB);
    const now = Math.floor(Date.now() / 1000);
    const baseUrl = await getAppSetting(env.DB, "base_url");

    let cursor = await getNumber(env.DB, "notify_cursor");
    if (cursor === null) {
      // First run with a webhook: baseline, so history is not announced.
      await setAppSetting(env.DB, "notify_cursor", String(now));
      cursor = now;
    }

    if (alertTargets.length === 0) {
      // Nobody wants alerts: keep the cursor moving so they are not announced later.
      await setAppSetting(env.DB, "notify_cursor", String(now));
    } else {
      const { alerts: candidates, recovered } = await collectAlerts(env, cfg, { cursor, now, lookbackSince: now - 3 * DAY });
      const fresh = await dropCooledDown(env.DB, candidates, now);

      if (fresh.length) {
        const label = `${fresh.length} alert${fresh.length === 1 ? "" : "s"} sent`;
        const res = await deliver(env, alertTargets, "alert", groupMessage(fresh, baseUrl), label);
        // Sent once at least one webhook has it; a webhook that failed is shown in the panel.
        if (res.sent > 0) {
          await markSent(env.DB, fresh, now);
          if (fresh.some((a) => a.rule === "syncHealth")) await setAppSetting(env.DB, "notify_sync_alerting", "1");
          await setAppSetting(env.DB, "notify_cursor", String(now));
          outcome.alertsSent = fresh.length;
        }
        if (res.errors.length) outcome.error = res.errors.join("; ");
      } else {
        if (recovered) {
          const res = await deliver(
            env,
            alertTargets,
            "alert",
            { text: "dmarc-compass: sync recovered", blocks: [header("dmarc-compass: sync recovered"), ...sections(["Syncing is working again."])] },
            "sync recovered",
          );
          if (res.sent > 0) {
            await env.DB.prepare("DELETE FROM app_settings WHERE key = 'notify_sync_alerting'").run();
            await env.DB.prepare("DELETE FROM alert_state WHERE key IN ('sync-failed', 'sync-stale')").run();
          }
        }
        await setAppSetting(env.DB, "notify_cursor", String(now));
      }
    }

    // The digest is independent of alert delivery.
    if (digestTargets.length) {
      const lastSlot = await getNumber(env.DB, "notify_digest_last_slot");
      const enabledAt = (await getNumber(env.DB, "notify_digest_enabled_at")) ?? now;
      const due = digestDue(cfg.digest, lastSlot, enabledAt, now);
      if (due.due && due.slot !== null) {
        const res = await deliver(env, digestTargets, "digest", await buildDigest(env, cfg, baseUrl, now), "digest sent");
        if (res.sent > 0) {
          await setAppSetting(env.DB, "notify_digest_last_slot", String(due.slot));
          outcome.digestSent = true;
        }
        if (res.errors.length) outcome.error ??= res.errors.join("; ");
      }
    }
  } catch (err) {
    console.error("notifications failed:", err);
    outcome.error = err instanceof Error ? err.message : String(err);
  }
  return outcome;
}

// ------------------------------------------------------------- admin actions --

export async function testWebhook(env: NotifyEnv, id: string): Promise<Done> {
  const dest = (await getDestinations(env)).find((d) => d.id === id);
  if (!dest) return { ok: false, error: "That webhook no longer exists." };
  const res = await deliver(
    env,
    [dest],
    "test",
    {
      text: "dmarc-compass: test message",
      blocks: [header("dmarc-compass: test message"), ...sections([`Notifications are connected${dest.name ? ` (${safe(dest.name, 40)})` : ""}. Alerts and your digest will be delivered to this channel.`])],
    },
    "test message sent",
  );
  return res.sent ? { ok: true } : { ok: false, error: res.errors[0] ?? "Delivery failed." };
}

export async function sendDigestNow(env: NotifyEnv): Promise<Done> {
  const targets = receiving("digest", await getDestinations(env));
  if (targets.length === 0) return { ok: false, error: "No webhook is set to receive the digest." };
  const { config } = await getConfig(env.DB);
  const now = Math.floor(Date.now() / 1000);
  const message = await buildDigest(env, config, await getAppSetting(env.DB, "base_url"), now);
  const res = await deliver(env, targets, "digest", message, "digest sent (manual)");
  if (res.errors.length === 0) return { ok: true };
  return { ok: false, error: res.sent ? `Sent to ${res.sent}, but failed for: ${res.errors.join("; ")}` : res.errors.join("; ") };
}

/** What the alert rules would report for the last 7 days. Sends nothing and
 * ignores the once-only state, so it works as a way to see the rules in action. */
export async function previewAlerts(env: NotifyEnv): Promise<{ count: number; text: string[] }> {
  const { config } = await getConfig(env.DB);
  const now = Math.floor(Date.now() / 1000);
  const since = now - 7 * DAY;
  const { alerts } = await collectAlerts(env, config, { cursor: since, now, lookbackSince: since });
  const lines: string[] = [];
  for (const rule of Object.keys(RULE_TITLES) as RuleId[]) {
    const group = alerts.filter((a) => a.rule === rule).sort((a, b) => b.weight - a.weight);
    if (!group.length) continue;
    lines.push(`${RULE_TITLES[rule]} (${group.length})`);
    for (const a of group.slice(0, MAX_LINES_PER_RULE)) lines.push("  " + a.line.replace(/[*`_]/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    if (group.length > MAX_LINES_PER_RULE) lines.push(`  +${group.length - MAX_LINES_PER_RULE} more`);
  }
  return { count: alerts.length, text: lines };
}

