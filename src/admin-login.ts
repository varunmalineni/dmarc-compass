// Which admin login is in force. A login saved from the Admin page (stored hashed in the
// database) wins over the one the app was deployed with (ADMIN_USER / ADMIN_PASSWORD). The
// deployed one stays as the way in on a fresh install, and as the fallback after a reset.

import { getAppSetting, setAppSetting } from "./app-settings.ts";
import { getAdminCreds, type AdminEnv } from "./config.ts";
import { constantTimeMatch, hashPassword, verifyPassword, type PasswordRecord } from "./credentials.ts";

const KEY = "admin_login";

export interface StoredLogin extends PasswordRecord {
  user: string;
  changedAt: number;
}

export type AdminLogin =
  | { source: "env"; user: string; password: string }
  | { source: "stored"; user: string; record: StoredLogin };

function parseStored(text: string | null): StoredLogin | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    if (v && typeof v.user === "string" && typeof v.salt === "string" && typeof v.hash === "string" && Number.isInteger(v.iterations)) {
      return { user: v.user, salt: v.salt, hash: v.hash, iterations: v.iterations, keyed: Boolean(v.keyed), changedAt: Number(v.changedAt) || 0 };
    }
  } catch {
    // ignore: treated as no stored login
  }
  return null;
}

export async function getAdminLogin(db: D1Database, env: AdminEnv): Promise<AdminLogin | null> {
  const stored = parseStored(await getAppSetting(db, KEY));
  if (stored) return { source: "stored", user: stored.user, record: stored };
  const creds = getAdminCreds(env);
  return creds ? { source: "env", user: creds.user, password: creds.password } : null;
}

/** Does this user name and password match? Both parts are always checked, so timing does not
 * reveal which one was wrong. */
export async function checkLogin(login: AdminLogin, key: string | undefined, user: string, password: string): Promise<boolean> {
  const userOk = constantTimeMatch(user, login.user);
  const passOk = login.source === "env" ? constantTimeMatch(password, login.password) : await verifyPassword(password, key, login.record);
  return userOk && passOk;
}

/** What a sign-in session is tied to: it changes whenever the user name or password does, which signs everyone out. */
export function sessionMaterial(login: AdminLogin): string {
  return login.source === "env" ? login.password : `${login.record.salt}.${login.record.hash}`;
}

export async function saveStoredLogin(db: D1Database, key: string | undefined, user: string, password: string, now: number): Promise<StoredLogin> {
  const stored: StoredLogin = { user, ...(await hashPassword(password, key)), changedAt: now };
  await setAppSetting(db, KEY, JSON.stringify(stored));
  return stored;
}

/** Back to the login the app was deployed with. */
export async function clearStoredLogin(db: D1Database): Promise<boolean> {
  const res = await db.prepare("DELETE FROM app_settings WHERE key = ?").bind(KEY).run();
  return (res.meta.changes ?? 0) > 0;
}

export interface AccountView {
  user: string;
  source: "env" | "stored";
  changedAt: number | null;
}

export const accountView = (login: AdminLogin): AccountView => ({
  user: login.user,
  source: login.source,
  changedAt: login.source === "stored" ? login.record.changedAt : null,
});
