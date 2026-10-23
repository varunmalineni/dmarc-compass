// A quick "can we log in and open this folder?" check, run from the Worker
// over a direct TCP connection. It is independent of the parser container, so
// testing a mailbox is fast and never disturbs the container's current mailbox.
//
// The pure parts (command building, reply parsing) are separate from the socket
// so they can be unit-tested with plain Node.

/** Whether the text contains characters that cannot be sent safely in an IMAP command. */
export function hasUnsafeChars(s: string): boolean {
  return /[\u0000\r\n]/.test(s);
}

export function quoted(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function plainInitialResponse(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`\u0000${user}\u0000${password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface TaggedStatus {
  status: "OK" | "NO" | "BAD";
  text: string;
}

/** Finds the tagged completion line for `tag` in a server reply. */
export function taggedStatus(reply: string, tag: string): TaggedStatus | null {
  for (const line of reply.split(/\r?\n/)) {
    if (line.startsWith(tag + " ")) {
      const m = line.slice(tag.length + 1).match(/^(OK|NO|BAD)\b\s*(.*)$/i);
      if (m) return { status: m[1].toUpperCase() as TaggedStatus["status"], text: m[2].replace(/\[[^\]]*\]\s*/, "").slice(0, 120) };
    }
  }
  return null;
}

/** The message count from a SELECT reply ("* 42 EXISTS"). */
export function existsCount(reply: string): number | null {
  const m = reply.match(/^\* (\d+) EXISTS/m);
  return m ? Number(m[1]) : null;
}

export function awaitingContinuation(reply: string): boolean {
  return /^\+/m.test(reply);
}

export type ProbeResult = { ok: true; messages: number } | { ok: false; error: string };

/** Turns a server's refusal into something an admin can act on. */
export function friendlyError(stage: "login" | "folder", s: TaggedStatus): string {
  const t = s.text.toLowerCase();
  if (stage === "folder") return `Logged in, but the folder could not be opened${s.text ? ` (${s.text})` : ""}. Folder names are case-sensitive.`;
  if (t.includes("imap") && (t.includes("disabled") || t.includes("not enabled"))) return `The server says IMAP is not enabled for this account (${s.text}).`;
  return `The server rejected the login${s.text ? ` (${s.text})` : ""}. Check the user name and password; some providers need an app password.`;
}
