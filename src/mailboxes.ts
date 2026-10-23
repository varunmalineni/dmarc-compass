// The list of mailboxes that receive DMARC / TLS-RPT reports. Pure, so it can
// be unit-tested with plain Node. Storage is in mailbox-store.ts.

import { sanitizeNickname } from "./notify-config.ts";

export interface Mailbox {
  id: string;
  /** Label shown in the UI. */
  name: string;
  host: string;
  user: string;
  password: string;
  /** IMAP folder; blank means INBOX. */
  folder: string;
  /** Disabled mailboxes are skipped. */
  enabled: boolean;
}

/** What the admin UI may see: everything except the password. */
export interface MailboxView {
  id: string;
  name: string;
  host: string;
  user: string;
  folder: string;
  enabled: boolean;
  /** Where it came from: saved in the list, or the single mailbox configured before lists existed. */
  source: "saved" | "legacy";
}

export const MAX_MAILBOXES = 10;
export const DEFAULT_ID = "default";

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const clean = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";

/** A host name, optionally with a port, and nothing else. */
export function validateHost(raw: string): { ok: true; host: string } | { ok: false; error: string } {
  const host = raw.trim();
  if (!host) return { ok: false, error: "Enter the IMAP host." };
  if (/\s/.test(host)) return { ok: false, error: "The IMAP host must not contain spaces." };
  if (/^[a-z]+:\/\//i.test(host)) return { ok: false, error: "Enter the host name only, without imaps:// or https://." };
  if (host.includes("/")) return { ok: false, error: "Enter the host name only, without a path." };
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return { ok: false, error: "That does not look like a host name." };
  if (host.length > 253) return { ok: false, error: "That host name is too long." };
  return { ok: true, host };
}

export function addMailbox(
  list: Mailbox[],
  input: { name?: unknown; host?: unknown; user?: unknown; password?: unknown; folder?: unknown; enabled?: unknown },
  id: string,
): Result<{ list: Mailbox[]; mailbox: Mailbox }> {
  if (list.length >= MAX_MAILBOXES) return { ok: false, error: `You can have at most ${MAX_MAILBOXES} mailboxes.` };
  const host = validateHost(clean(input.host, 253));
  if (!host.ok) return host;
  const user = clean(input.user, 320);
  if (!user) return { ok: false, error: "Enter the mailbox user name." };
  const password = typeof input.password === "string" ? input.password : "";
  if (!password) return { ok: false, error: "Enter the mailbox password." };
  if (password.length > 500) return { ok: false, error: "That password is too long." };
  if (list.some((m) => m.host.toLowerCase() === host.host.toLowerCase() && m.user.toLowerCase() === user.toLowerCase() && m.folder === clean(input.folder, 200))) {
    return { ok: false, error: "That mailbox and folder is already in the list." };
  }
  const mailbox: Mailbox = {
    id,
    name: sanitizeNickname(input.name) || user,
    host: host.host,
    user,
    password,
    folder: clean(input.folder, 200),
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
  };
  return { ok: true, list: [...list, mailbox], mailbox };
}

/** Changes a mailbox. A missing or empty password keeps the current one. */
export function updateMailbox(
  list: Mailbox[],
  id: string,
  patch: { name?: unknown; host?: unknown; user?: unknown; password?: unknown; folder?: unknown; enabled?: unknown },
): Result<{ list: Mailbox[] }> {
  const current = list.find((m) => m.id === id);
  if (!current) return { ok: false, error: "That mailbox no longer exists." };

  let host = current.host;
  if (patch.host !== undefined) {
    const v = validateHost(clean(patch.host, 253));
    if (!v.ok) return v;
    host = v.host;
  }
  let user = current.user;
  if (patch.user !== undefined) {
    user = clean(patch.user, 320);
    if (!user) return { ok: false, error: "Enter the mailbox user name." };
  }
  const password = typeof patch.password === "string" && patch.password !== "" ? patch.password : current.password;
  if (password.length > 500) return { ok: false, error: "That password is too long." };

  const next: Mailbox = {
    ...current,
    name: patch.name === undefined ? current.name : sanitizeNickname(patch.name) || user,
    host,
    user,
    password,
    folder: patch.folder === undefined ? current.folder : clean(patch.folder, 200),
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
  };
  if (list.some((m) => m.id !== id && m.host.toLowerCase() === next.host.toLowerCase() && m.user.toLowerCase() === next.user.toLowerCase() && m.folder === next.folder)) {
    return { ok: false, error: "That mailbox and folder is already in the list." };
  }
  return { ok: true, list: list.map((m) => (m.id === id ? next : m)) };
}

export function removeMailbox(list: Mailbox[], id: string): Mailbox[] {
  return list.filter((m) => m.id !== id);
}

/** Reads a stored list, skipping anything malformed instead of throwing. */
export function parseMailboxes(json: string): Mailbox[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Mailbox[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== "string" || !m.id || seen.has(m.id)) continue;
    const host = validateHost(clean(m.host, 253));
    if (!host.ok || !clean(m.user, 320) || typeof m.password !== "string" || !m.password) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      name: sanitizeNickname(m.name) || clean(m.user, 320),
      host: host.host,
      user: clean(m.user, 320),
      password: m.password,
      folder: clean(m.folder, 200),
      enabled: typeof m.enabled === "boolean" ? m.enabled : true,
    });
    if (out.length >= MAX_MAILBOXES) break;
  }
  return out;
}

/** The mailbox that existed before lists did, as a list entry. */
export function legacyMailbox(c: { IMAP_HOST: string; IMAP_USER: string; IMAP_PASSWORD: string; IMAP_FOLDER: string }): Mailbox | null {
  if (!c.IMAP_HOST || !c.IMAP_USER || !c.IMAP_PASSWORD) return null;
  const host = validateHost(c.IMAP_HOST);
  if (!host.ok) return null;
  return { id: DEFAULT_ID, name: c.IMAP_USER, host: host.host, user: c.IMAP_USER, password: c.IMAP_PASSWORD, folder: c.IMAP_FOLDER === "INBOX" ? "" : c.IMAP_FOLDER, enabled: true };
}

export function toView(m: Mailbox, source: "saved" | "legacy"): MailboxView {
  return { id: m.id, name: m.name, host: m.host, user: m.user, folder: m.folder, enabled: m.enabled, source };
}

/** A string that changes whenever the container would have to be restarted
 * to read this mailbox (any connection detail, or its re-read interval), and
 * only then. The default interval leaves it as it was before intervals could
 * be chosen, so upgrading does not restart anything. */
export function connectionKey(m: Mailbox, intervalSeconds = 900): string {
  const base: unknown[] = [m.id, m.host.toLowerCase(), m.user, m.password, m.folder || "INBOX"];
  return JSON.stringify(intervalSeconds === 900 ? base : [...base, intervalSeconds]);
}

/** SHA-256 of the connection key: stored instead of the key itself, which contains the password. */
export async function fingerprint(m: Mailbox, intervalSeconds = 900): Promise<string> {
  const bytes = new TextEncoder().encode(connectionKey(m, intervalSeconds));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Environment for the parser container for one mailbox. */
export function containerEnv(m: Mailbox): Record<string, string> {
  return {
    IMAP_HOST: m.host,
    IMAP_PORT: "993",
    IMAP_USER: m.user,
    IMAP_PASSWORD: m.password,
    IMAP_FOLDER: m.folder || "INBOX",
  };
}
