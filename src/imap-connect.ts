// The IMAP connection test. Opens a TCP connection through the runtime (Workers
// sockets, or Node's net), and the protocol helpers it uses are in imap-probe.ts.

import { loadMailboxes, recordMailboxResult, type MailboxEnv } from "./mailbox-store";
import { validateHost } from "./mailboxes";
import type { Runtime, TcpSocket } from "./runtime";
import {
  awaitingContinuation,
  existsCount,
  friendlyError,
  hasUnsafeChars,
  plainInitialResponse,
  quoted,
  taggedStatus,
  type ProbeResult,
} from "./imap-probe";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, done: (text: string) => boolean, ms: number): Promise<string> {
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (!done(text)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("The server did not answer in time.");
    const r = await Promise.race([reader.read(), sleep(left).then(() => "timeout" as const)]);
    if (r === "timeout") throw new Error("The server did not answer in time.");
    if (r.done) break;
    text += dec.decode(r.value, { stream: true });
  }
  return text;
}

/** Logs in over IMAP and opens the folder. Sends nothing but the login and a
 * read-only SELECT, and always logs out. */
export async function probeMailbox(
  m: { host: string; user: string; password: string; folder: string },
  connect: Runtime["connect"],
  devPort?: number,
): Promise<ProbeResult> {
  const host = validateHost(m.host);
  if (!host.ok) return host;
  if (hasUnsafeChars(m.user) || hasUnsafeChars(m.password) || hasUnsafeChars(m.folder)) {
    return { ok: false, error: "The user, password or folder contains a character that can't be used." };
  }
  // A plain-TCP port is honoured only for a server on this machine, so tests can use a local fake.
  const local = host.host === "localhost" || host.host === "127.0.0.1";
  const port = local && devPort ? devPort : 993;
  let socket: TcpSocket | null = null;
  try {
    socket = connect(host.host, port, !local);
    const reader = socket.readable.getReader();
    const writer = socket.writable.getWriter();
    const enc = new TextEncoder();
    const send = (s: string) => writer.write(enc.encode(s + "\r\n"));

    const greeting = await readUntil(reader, (t) => t.includes("\n"), 10_000);
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) return { ok: false, error: "That does not look like an IMAP server." };

    await send("a1 AUTHENTICATE PLAIN");
    let reply = await readUntil(reader, (t) => awaitingContinuation(t) || taggedStatus(t, "a1") !== null, 10_000);
    if (awaitingContinuation(reply) && !taggedStatus(reply, "a1")) {
      await send(plainInitialResponse(m.user, m.password));
      reply = await readUntil(reader, (t) => taggedStatus(t, "a1") !== null, 15_000);
    }
    let auth = taggedStatus(reply, "a1");
    // PLAIN is not offered (BAD, or NO naming the mechanism): use LOGIN.
    if (auth?.status === "BAD" || (auth?.status === "NO" && /mechanism|not supported|unsupported|not available|disabled/i.test(auth.text))) {
      await send(`a1b LOGIN ${quoted(m.user)} ${quoted(m.password)}`);
      auth = taggedStatus(await readUntil(reader, (t) => taggedStatus(t, "a1b") !== null, 15_000), "a1b");
    }
    if (!auth || auth.status !== "OK") return { ok: false, error: friendlyError("login", auth ?? { status: "NO", text: "" }) };

    await send(`a2 EXAMINE ${quoted(m.folder || "INBOX")}`);
    const sel = await readUntil(reader, (t) => taggedStatus(t, "a2") !== null, 15_000);
    const selStatus = taggedStatus(sel, "a2");
    await send("a3 LOGOUT").catch(() => {});
    if (!selStatus || selStatus.status !== "OK") return { ok: false, error: friendlyError("folder", selStatus ?? { status: "NO", text: "" }) };
    return { ok: true, messages: existsCount(sel) ?? 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    return { ok: false, error: msg.includes("did not answer") ? msg : "Could not connect to the server. Check the host name; port 993 (IMAP over TLS) must be reachable." };
  } finally {
    try {
      await socket?.close();
    } catch {
      // already closed
    }
  }
}

export async function testMailbox(env: MailboxEnv, connect: Runtime["connect"], id: string): Promise<ProbeResult> {
  const { list } = await loadMailboxes(env);
  const m = list.find((x) => x.id === id);
  if (!m) return { ok: false, error: "That mailbox no longer exists." };
  const res = await probeMailbox(m, connect, Number(env.IMAP_TEST_PORT) || undefined);
  await recordMailboxResult(env.DB, id, {
    at: Math.floor(Date.now() / 1000),
    ok: res.ok,
    detail: res.ok ? `Test OK: login works, folder has ${res.messages} message${res.messages === 1 ? "" : "s"}` : `Test failed: ${res.error}`,
  });
  return res;
}

