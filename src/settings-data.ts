import { encryptValue, decryptValue } from "./crypto-util";

export const CONFIG_KEYS = ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD", "IMAP_FOLDER"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

interface SettingsEnv {
  DB: D1Database;
  CONFIG_ENCRYPTION_KEY?: string;
  // Optional environment fallbacks. A fresh install sets none of these and
  // configures the mailbox from /admin instead.
  IMAP_HOST?: string;
  IMAP_USER?: string;
  IMAP_PASSWORD?: string;
  IMAP_FOLDER?: string;
}

export type ImapConfig = Record<ConfigKey, string>;

/** Resolves the effective IMAP config: the value saved from /admin if there
 * is one, otherwise the matching Worker secret, otherwise empty. This is
 * what the container starts with - see DmarcViewerContainer in index.ts. */
export async function getEffectiveImapConfig(env: SettingsEnv): Promise<ImapConfig> {
  const rows = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${CONFIG_KEYS.map(() => "?").join(",")})`,
  )
    .bind(...CONFIG_KEYS)
    .all<{ key: ConfigKey; value: string }>();

  const overrides = new Map(rows.results.map((r) => [r.key, r.value]));
  const result = {} as ImapConfig;
  for (const key of CONFIG_KEYS) {
    const stored = overrides.get(key);
    // Without the encryption key, saved overrides can't be read: fall back
    // to the plain secret rather than failing the whole request.
    result[key] = stored && env.CONFIG_ENCRYPTION_KEY ? await decryptValue(stored, env.CONFIG_ENCRYPTION_KEY) : (env[key] ?? "");
  }
  return result;
}

/** The container can't start without these three. (Folder defaults to INBOX.) */
export function isImapConfigured(cfg: ImapConfig): boolean {
  return Boolean(cfg.IMAP_HOST && cfg.IMAP_USER && cfg.IMAP_PASSWORD);
}

/** Which keys currently have a value saved from /admin (vs. falling back to
 * a Worker secret) - used to render the admin page accurately. */
export async function getOverriddenKeys(db: D1Database): Promise<Set<ConfigKey>> {
  const rows = await db
    .prepare(`SELECT key FROM settings WHERE key IN (${CONFIG_KEYS.map(() => "?").join(",")})`)
    .bind(...CONFIG_KEYS)
    .all<{ key: ConfigKey }>();
  return new Set(rows.results.map((r) => r.key));
}

export async function setConfigOverride(
  db: D1Database,
  encryptionKey: string,
  key: ConfigKey,
  plaintext: string,
): Promise<void> {
  const encrypted = await encryptValue(plaintext, encryptionKey);
  await db
    .prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`)
    .bind(key, encrypted, Math.floor(Date.now() / 1000))
    .run();
}
