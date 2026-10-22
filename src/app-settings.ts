// Non-secret application state, stored as plain text in `app_settings`.
// Secrets (IMAP credentials) are NOT stored here - see settings-data.ts.

export async function getAppSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setAppSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, Math.floor(Date.now() / 1000))
    .run();
}

/** Whether the read-only dashboard pages are viewable without logging in.
 * Defaults to false: a fresh install is private until the admin opts in. */
export async function isDashboardPublic(db: D1Database): Promise<boolean> {
  return (await getAppSetting(db, "public_dashboard")) === "true";
}

export async function setDashboardPublic(db: D1Database, value: boolean): Promise<void> {
  await setAppSetting(db, "public_dashboard", value ? "true" : "false");
}

export interface LastSync {
  at: number;
  ok: boolean;
  summary: string;
}

export async function recordSync(db: D1Database, ok: boolean, summary: string): Promise<void> {
  await setAppSetting(db, "last_sync", JSON.stringify({ at: Math.floor(Date.now() / 1000), ok, summary }));
}

export async function getLastSync(db: D1Database): Promise<LastSync | null> {
  const raw = await getAppSetting(db, "last_sync");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LastSync;
  } catch {
    return null;
  }
}
