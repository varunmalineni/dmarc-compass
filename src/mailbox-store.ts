// Mailbox storage, the single-container hand-over, and the sync lock.

import { getAppSetting, setAppSetting } from "./app-settings.ts";
import { decryptValue, encryptValue } from "./crypto-util.ts";
import { callContainer } from "./sync.ts";
import { getEffectiveImapConfig } from "./settings-data.ts";
import { getSyncMinutes } from "./sync-settings.ts";
import { containerIntervalSeconds } from "./sync-schedule.ts";
import {
  addMailbox,
  DEFAULT_ID,
  fingerprint,
  legacyMailbox,
  MAX_MAILBOXES,
  parseMailboxes,
  removeMailbox,
  toView,
  updateMailbox,
  type Mailbox,
  type MailboxView,
} from "./mailboxes.ts";

const LIST_KEY = "MAILBOXES";

export interface MailboxEnv {
  DB: D1Database;
  CONFIG_ENCRYPTION_KEY?: string;
  /** Development only: port of a local fake IMAP server (used for localhost hosts). */
  IMAP_TEST_PORT?: string;
  IMAP_HOST?: string;
  IMAP_USER?: string;
  IMAP_PASSWORD?: string;
  IMAP_FOLDER?: string;
}

type Done = { ok: true } | { ok: false; error: string };

// ------------------------------------------------------------------ storage --

/** The mailboxes. A list saved from /admin wins; otherwise the single mailbox
 * configured before lists existed (saved settings, then Worker secrets) is
 * presented as the first entry, so an upgrade needs no action. */
export async function loadMailboxes(env: MailboxEnv): Promise<{ list: Mailbox[]; source: "saved" | "legacy" }> {
  const key = env.CONFIG_ENCRYPTION_KEY;
  if (key) {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(LIST_KEY).first<{ value: string }>();
    if (row) {
      try {
        return { list: parseMailboxes(await decryptValue(row.value, key)), source: "saved" };
      } catch {
        // An unreadable list (for example after a key change) falls through to the legacy mailbox.
      }
    }
  }
  const legacy = legacyMailbox(await getEffectiveImapConfig(env as Parameters<typeof getEffectiveImapConfig>[0]));
  return { list: legacy ? [legacy] : [], source: "legacy" };
}

async function saveMailboxes(env: MailboxEnv, list: Mailbox[]): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(LIST_KEY, await encryptValue(JSON.stringify(list), env.CONFIG_ENCRYPTION_KEY as string), Math.floor(Date.now() / 1000))
    .run();
}

function needKey(env: MailboxEnv): Done | null {
  return env.CONFIG_ENCRYPTION_KEY
    ? null
    : { ok: false, error: "CONFIG_ENCRYPTION_KEY is not set, so mailbox credentials can't be stored. See Setup status." };
}

export async function addMailboxEntry(env: MailboxEnv, input: Record<string, unknown>): Promise<Done> {
  const missing = needKey(env);
  if (missing) return missing;
  const { list } = await loadMailboxes(env);
  const res = addMailbox(list, input, list.length === 0 ? DEFAULT_ID : crypto.randomUUID().slice(0, 8));
  if (!res.ok) return res;
  await saveMailboxes(env, res.list);
  return { ok: true };
}

export async function updateMailboxEntry(env: MailboxEnv, id: string, patch: Record<string, unknown>): Promise<Done> {
  const missing = needKey(env);
  if (missing) return missing;
  const { list } = await loadMailboxes(env);
  const res = updateMailbox(list, id, patch);
  if (!res.ok) return res;
  await saveMailboxes(env, res.list);
  return { ok: true };
}

export async function removeMailboxEntry(env: MailboxEnv, id: string): Promise<Done> {
  const missing = needKey(env);
  if (missing) return missing;
  const { list } = await loadMailboxes(env);
  if (!list.some((m) => m.id === id)) return { ok: false, error: "That mailbox no longer exists." };
  await saveMailboxes(env, removeMailbox(list, id));
  const results = await loadResults(env.DB);
  delete results[id];
  await setAppSetting(env.DB, "mailbox_results", JSON.stringify(results));
  return { ok: true };
}

// ------------------------------------------------------------------ results --

export interface MailboxResult {
  at: number;
  ok: boolean;
  detail: string;
}

async function loadResults(db: D1Database): Promise<Record<string, MailboxResult>> {
  try {
    const parsed = JSON.parse((await getAppSetting(db, "mailbox_results")) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, MailboxResult>) : {};
  } catch {
    return {};
  }
}

export async function recordMailboxResult(db: D1Database, id: string, r: MailboxResult): Promise<void> {
  const all = await loadResults(db);
  all[id] = { ...r, detail: r.detail.slice(0, 200) };
  await setAppSetting(db, "mailbox_results", JSON.stringify(all));
}

export interface MailboxRow extends MailboxView {
  result: MailboxResult | null;
  reports: number;
}

export interface MailboxesView {
  rows: MailboxRow[];
  source: "saved" | "legacy";
  limit: number;
  canSave: boolean;
}

export async function getMailboxesView(env: MailboxEnv): Promise<MailboxesView> {
  const [{ list, source }, results, counts] = await Promise.all([
    loadMailboxes(env),
    loadResults(env.DB),
    env.DB.prepare("SELECT COALESCE(mailbox_id, ?) AS id, COUNT(*) AS n FROM dmarc_reports GROUP BY 1").bind(DEFAULT_ID).all<{ id: string; n: number }>(),
  ]);
  const n = new Map(counts.results.map((r) => [r.id, r.n]));
  return {
    rows: list.map((m) => ({ ...toView(m, source), result: results[m.id] ?? null, reports: n.get(m.id) ?? 0 })),
    source,
    limit: MAX_MAILBOXES,
    canSave: Boolean(env.CONFIG_ENCRYPTION_KEY),
  };
}

// --------------------------------------------------- one container, in turns --

export async function getCursor(db: D1Database): Promise<number> {
  const n = Number(await getAppSetting(db, "mailbox_cursor"));
  return Number.isFinite(n) ? n : 0;
}

export async function setCursor(db: D1Database, n: number): Promise<void> {
  await setAppSetting(db, "mailbox_cursor", String(n));
}

/** Which mailbox the container is meant to read when it starts. */
export async function desiredMailboxId(db: D1Database): Promise<string | null> {
  return getAppSetting(db, "container_desired");
}

interface Loaded {
  id: string;
  fp: string;
}

async function getLoaded(db: D1Database): Promise<Loaded | null> {
  try {
    const v = JSON.parse((await getAppSetting(db, "container_loaded")) ?? "null");
    return v && typeof v.id === "string" && typeof v.fp === "string" ? v : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ContainerLike {
  fetch(req: Request): Promise<Response>;
}

/** Polls the parser until it has finished reading its mailbox once. Its
 * summary reports `last_update` as null until then. */
export async function waitUntilRead(
  container: ContainerLike,
  env: { DB: D1Database; ADMIN_USER?: string; ADMIN_PASSWORD?: string; HTTP_SERVER_USER?: string; HTTP_SERVER_PASSWORD?: string },
  timeoutMs: number,
  pollMs = 3000,
  /** Lets a caller that knows the parser has died stop waiting at once. */
  gone: () => boolean = () => false,
): Promise<Done> {
  const deadline = Date.now() + timeoutMs;
  let last = "the parser did not answer";
  while (Date.now() < deadline) {
    if (gone()) return { ok: false, error: "The mailbox reader stopped before it finished reading the mailbox." };
    try {
      const res = await callContainer(container, "/summary", env);
      if (res.ok) {
        const s = (await res.json()) as { last_update?: number | null };
        if (s.last_update != null) return { ok: true };
        last = "the parser has not finished reading the mailbox";
      } else {
        last = `the parser answered ${res.status}`;
      }
    } catch (err) {
      last = err instanceof Error ? err.message.slice(0, 80) : "the parser is starting";
    }
    await sleep(pollMs);
  }
  return {
    ok: false,
    error: `Timed out waiting for the mailbox to be read (${last}). Check the host, login and folder, and that the folder is not very large.`,
  };
}

/** Makes the container read `mailbox`, and waits until it has finished reading
 * it. When the container is already on this mailbox that is all it does. When
 * it is not, it records the choice, stops the container (the class reads the
 * choice when it starts again) and waits for the first read.
 *
 * It always waits, not only after a switch: a container that slept between two
 * syncs wakes with an empty memory, and a sync that ran straight away would see
 * no reports. A mailbox that never finishes reading (wrong login, wrong
 * folder) therefore reports a clear timeout instead of silently syncing nothing. */
export async function loadMailbox(
  env: MailboxEnv & { ADMIN_USER?: string; ADMIN_PASSWORD?: string; HTTP_SERVER_USER?: string; HTTP_SERVER_PASSWORD?: string },
  container: ContainerLike,
  mailbox: Mailbox,
  stop: () => Promise<void>,
  timeoutMs: number,
  opts: { onlyMailbox?: boolean; pollMs?: number } = {},
): Promise<Done & { switched?: boolean }> {
  const fp = await fingerprint(mailbox, containerIntervalSeconds(await getSyncMinutes(env.DB)));
  const loaded = await getLoaded(env.DB);

  // First run of this version with a single mailbox: the container was started with
  // that mailbox's settings (changing them always restarted it), so adopt it as it is.
  if (!loaded && opts.onlyMailbox) {
    await setAppSetting(env.DB, "container_desired", mailbox.id);
    await setAppSetting(env.DB, "container_loaded", JSON.stringify({ id: mailbox.id, fp } satisfies Loaded));
  }

  if ((loaded && loaded.id === mailbox.id && loaded.fp === fp) || (!loaded && opts.onlyMailbox)) {
    const ready = await waitUntilRead(container, env, timeoutMs, opts.pollMs);
    return ready.ok ? { ok: true, switched: false } : ready;
  }

  await setAppSetting(env.DB, "container_desired", mailbox.id);
  await env.DB.prepare("DELETE FROM app_settings WHERE key = 'container_loaded'").run();
  await stop();
  const ready = await waitUntilRead(container, env, timeoutMs, opts.pollMs);
  if (!ready.ok) return ready;
  await setAppSetting(env.DB, "container_loaded", JSON.stringify({ id: mailbox.id, fp } satisfies Loaded));
  return { ok: true, switched: true };
}

/** The mailbox the container should start with: the chosen one, else the first enabled. */
export async function mailboxForStart(env: MailboxEnv): Promise<Mailbox | null> {
  const { list } = await loadMailboxes(env);
  const want = await desiredMailboxId(env.DB);
  return list.find((m) => m.id === want) ?? list.find((m) => m.enabled) ?? list[0] ?? null;
}

// --------------------------------------------------------------------- lock --

/** A lease so only one thing drives the container at a time (a sync, or a
 * raw-file request that needs a particular mailbox). Expires on its own. */
export async function acquireLock(db: D1Database, holder: string, ttlSeconds: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('container_lock', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE CAST(app_settings.value AS INTEGER) < ?`,
    )
    .bind(String(now + ttlSeconds), now, now)
    .run();
  void holder;
  return (res.meta.changes ?? 0) > 0;
}

export async function releaseLock(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM app_settings WHERE key = 'container_lock'").run();
}
