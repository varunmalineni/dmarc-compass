// Admin credentials: hashing, checking, and the separate secret the app and its parser
// use to talk to each other. Pure apart from Web Crypto, so it is unit-tested with Node.

const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const toB64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Cloudflare Workers refuse more than this many PBKDF2 rounds. With one admin account behind a
 * lockout of ten tries per 15 minutes, it is enough; the key-based step below adds to it. */
export const ITERATIONS = 100_000;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;
export const MAX_USER = 64;

export interface PasswordRecord {
  salt: string;
  iterations: number;
  hash: string;
  /** The password was first mixed with CONFIG_ENCRYPTION_KEY, so a copy of the database alone cannot be attacked. */
  keyed: boolean;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

async function derive(password: string, key: string | undefined, salt: Uint8Array, iterations: number): Promise<string> {
  const material = key ? await hmacHex(key, `password\u0000${password}`) : password;
  const base = await crypto.subtle.importKey("raw", enc.encode(material), "PBKDF2", false, ["deriveBits"]);
  return toB64(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256));
}

export async function hashPassword(password: string, key: string | undefined, o: { salt?: Uint8Array; iterations?: number } = {}): Promise<PasswordRecord> {
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const iterations = o.iterations ?? ITERATIONS;
  return { salt: toB64(salt), iterations, hash: await derive(password, key, salt, iterations), keyed: Boolean(key) };
}

function sameString(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export const constantTimeMatch = sameString;

export async function verifyPassword(password: string, key: string | undefined, rec: PasswordRecord): Promise<boolean> {
  if (rec.keyed && !key) return false;
  return sameString(await derive(password, rec.keyed ? key : undefined, fromB64(rec.salt), rec.iterations), rec.hash);
}

// --------------------------------------------------- app <-> parser credentials

export interface InternalEnv {
  CONFIG_ENCRYPTION_KEY?: string;
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  HTTP_SERVER_USER?: string;
  HTTP_SERVER_PASSWORD?: string;
}

/** What the app and the parser use to authenticate to each other. Derived from the encryption key, so
 * the parser never learns the admin password and changing the admin password never affects syncing.
 * An install without an encryption key keeps the old behaviour (the admin login) so it does not break. */
export async function internalCredentials(env: InternalEnv): Promise<{ user: string; password: string } | null> {
  if (env.CONFIG_ENCRYPTION_KEY) return { user: "dmarc-compass", password: await hmacHex(env.CONFIG_ENCRYPTION_KEY, "parser-auth-v1") };
  const user = env.ADMIN_USER || env.HTTP_SERVER_USER;
  const password = env.ADMIN_PASSWORD || env.HTTP_SERVER_PASSWORD;
  return user && password ? { user, password } : null;
}

// ------------------------------------------------------------------ validation

export type Validation = { ok: true; user: string; password: string } | { ok: false; error: string };

/** The rules for a new admin login. `newPassword` empty means "keep the current password". */
export function validateNewLogin(input: { currentUser: string; currentPassword: string; newUser: string; newPassword: string }): Validation {
  const user = input.newUser.trim();
  const password = input.newPassword === "" ? input.currentPassword : input.newPassword;

  if (!user) return { ok: false, error: "Enter a user name." };
  if (user.length > MAX_USER) return { ok: false, error: `The user name can be at most ${MAX_USER} characters.` };
  if (/[\u0000-\u001f\u007f:]/.test(user)) return { ok: false, error: "The user name can't contain a colon or control characters." };
  if (input.newPassword !== "") {
    if (password.length < MIN_PASSWORD) return { ok: false, error: `The new password must be at least ${MIN_PASSWORD} characters.` };
    if (password.length > MAX_PASSWORD) return { ok: false, error: `The new password can be at most ${MAX_PASSWORD} characters.` };
    if (password.toLowerCase() === user.toLowerCase()) return { ok: false, error: "The password can't be the same as the user name." };
    if (password === input.currentPassword) return { ok: false, error: "The new password must be different from the current one." };
  }
  if (input.newPassword === "" && user === input.currentUser) return { ok: false, error: "Nothing to change: enter a new user name or a new password." };
  return { ok: true, user, password };
}
