// Login sessions for the admin pages. A session is a signed cookie holding its
// expiry; nothing about it is stored per user. Pure apart from Web Crypto, so it
// can be unit-tested with plain Node.
//
// The signature covers the expiry, the admin user name and a fingerprint of the
// admin password, keyed with a random secret kept in the database. So:
//  - changing the admin password (or user) ends every session at once;
//  - the cookie never contains the password, and cannot be used to guess it.

export const SESSION_SECONDS = 12 * 3600;
export const COOKIE_NAME = "__Host-dc_session";
/** Used only when a self-hosted install is deliberately run over plain HTTP: the __Host- prefix
 * and the Secure flag both require HTTPS, so the browser would refuse the cookie. */
export const INSECURE_COOKIE_NAME = "dc_session";

export const cookieName = (secure: boolean) => (secure ? COOKIE_NAME : INSECURE_COOKIE_NAME);

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Tied to the current login: it changes when the user name or password does. */
async function binding(secret: string, user: string, password: string): Promise<string> {
  return hmac(secret, `bind\u0000${user}\u0000${password}`);
}

export async function makeToken(secret: string, user: string, password: string, now: number): Promise<string> {
  const exp = now + SESSION_SECONDS;
  const sig = await hmac(secret, `v1\u0000${exp}\u0000${await binding(secret, user, password)}`);
  return `${exp}.${sig}`;
}

function sameString(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function verifyToken(token: string | null, secret: string, user: string, password: string, now: number): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isInteger(exp) || exp <= now || exp > now + SESSION_SECONDS + 60) return false;
  const want = await hmac(secret, `v1\u0000${exp}\u0000${await binding(secret, user, password)}`);
  return sameString(want, token.slice(dot + 1));
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string, secure = true): string {
  return `${cookieName(secure)}=${token}; Max-Age=${SESSION_SECONDS}; Path=/; ${secure ? "Secure; " : ""}HttpOnly; SameSite=Strict`;
}

export function clearCookie(secure = true): string {
  return `${cookieName(secure)}=; Max-Age=0; Path=/; ${secure ? "Secure; " : ""}HttpOnly; SameSite=Strict`;
}

/** Where to go after signing in: only a path on this site, never another address. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\u0000-\u001f]/.test(next)) return "/admin";
  if (next === "/login" || next.startsWith("/login?") || next === "/logout") return "/admin";
  return next;
}

/** What is asking. A browser navigating to a page should be sent to the sign-in page; a
 * script running in a browser page (fetch) gets a plain 401 it can act on, with no browser
 * password popup; anything else (curl, monitoring) gets the standard Basic challenge. */
export function requesterKind(method: string, mode: string | null, accept: string | null): "page" | "script" | "client" {
  if (method === "GET" && (mode === "navigate" || (mode === null && (accept ?? "").includes("text/html")))) return "page";
  return mode !== null ? "script" : "client";
}
