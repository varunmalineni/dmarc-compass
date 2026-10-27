// One parser process per mailbox, side by side. Each parser reads its own mailbox
// and keeps it in memory, so nothing is switched or shared: a sync or a request
// for an original file talks straight to that mailbox's parser.
//
// The parser is the unmodified upstream dmarc-report-viewer program. It is started
// on first use, restarted if the mailbox's login or the sync interval changes (or
// it dies), and stopped when its mailbox is removed or disabled.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { containerEnv, fingerprint, type Mailbox } from "../mailboxes.ts";
import { waitUntilRead } from "../mailbox-store.ts";
import { containerIntervalSeconds } from "../sync-schedule.ts";
import { getSyncMinutes } from "../sync-settings.ts";
import { internalCredentials } from "../credentials.ts";
import type { LeaseOptions, LeaseResult, ParserClient, ParserHost } from "../runtime.ts";

export interface PoolEnv {
  DB: D1Database;
  CONFIG_ENCRYPTION_KEY?: string;
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  HTTP_SERVER_USER?: string;
  HTTP_SERVER_PASSWORD?: string;
  /** Development only: a plain-TCP IMAP server on this machine, for the "localhost" mailbox host. */
  IMAP_TEST_PORT?: string;
}

export interface PoolOptions {
  env: PoolEnv;
  /** The program to run, and any leading arguments. */
  command: string;
  args?: string[];
  /** Mailboxes that should have a parser right now; others are stopped by sweep(). */
  listMailboxes: () => Promise<Mailbox[]>;
  log?: (line: string) => void;
  /** How often to ask a starting parser whether it has finished its first read. */
  pollMs?: number;
  /** Extra environment for the parser processes (tests, proxies). */
  extraEnv?: Record<string, string>;
}

interface Entry {
  id: string;
  fp: string;
  port: number;
  proc: ChildProcess;
  client: ParserClient;
  exited: { code: number | null; signal: NodeJS.Signals | null } | null;
  tail: string[];
  /** The parser has answered at least once with a finished read. */
  everRead: boolean;
  /** Its first read failed (wrong login, server down). It would wait out its whole interval before trying
   * again, so the next request starts a fresh one instead. */
  readFailed: string | null;
}

const TAIL_LINES = 6;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function loopbackClient(port: number): ParserClient {
  return {
    async fetch(req: Request): Promise<Response> {
      const u = new URL(req.url);
      return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      });
    },
  };
}

export class ParserPool implements ParserHost {
  private entries = new Map<string, Entry>();
  // Work per mailbox is done one step at a time, so two requests cannot both start its parser.
  private chains = new Map<string, Promise<unknown>>();
  private stopping = false;

  private readonly o: PoolOptions;

  constructor(o: PoolOptions) {
    this.o = o;
  }

  private log(line: string) {
    this.o.log?.(line);
  }

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(id) ?? Promise.resolve()).then(fn, fn);
    this.chains.set(id, run.catch(() => {}));
    return run;
  }

  /** The parser for this mailbox, started or restarted if it is missing, dead, or out of date. */
  private ensure(mailbox: Mailbox): Promise<Entry> {
    return this.serial(mailbox.id, async () => {
      if (this.stopping) throw new Error("The server is shutting down.");
      const interval = containerIntervalSeconds(await getSyncMinutes(this.o.env.DB));
      const fp = await fingerprint(mailbox, interval);
      const current = this.entries.get(mailbox.id);
      if (current && current.fp === fp && !current.exited && !current.readFailed) return current;
      if (current) await this.kill(current);
      return this.start(mailbox, interval, fp);
    });
  }

  private async start(mailbox: Mailbox, intervalSeconds: number, fp: string): Promise<Entry> {
    const creds = await internalCredentials(this.o.env);
    if (!creds) throw new Error("Admin credentials are not configured");
    const port = await freePort();

    // The parser gets only what it needs: never this app's admin password, encryption key or webhook.
    const inherited: Record<string, string> = {};
    for (const k of ["PATH", "TZ", "LANG", "TMPDIR", "HOME", "DNS_SERVER"]) if (process.env[k]) inherited[k] = process.env[k] as string;
    const env: Record<string, string> = {
      ...inherited,
      ...containerEnv(mailbox),
      IMAP_CHECK_INTERVAL: String(intervalSeconds),
      LOG_LEVEL: "info",
      HTTP_SERVER_PORT: String(port),
      HTTP_SERVER_BINDING: "127.0.0.1",
      HTTP_SERVER_USER: creds.user,
      HTTP_SERVER_PASSWORD: creds.password,
    };
    // Development only, mirroring the connection test: a "localhost" mailbox is a fake IMAP server without TLS.
    const devPort = Number(this.o.env.IMAP_TEST_PORT) || 0;
    if (devPort && (mailbox.host === "localhost" || mailbox.host === "127.0.0.1")) {
      env.IMAP_PORT = String(devPort);
      env.IMAP_DISABLE_TLS = "true";
    }
    Object.assign(env, this.o.extraEnv);

    const proc = spawn(this.o.command, this.o.args ?? [], { env, stdio: ["ignore", "pipe", "pipe"] });
    const entry: Entry = { id: mailbox.id, fp, port, proc, client: loopbackClient(port), exited: null, tail: [], everRead: false, readFailed: null };

    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        const failed = line.match(/\bERROR\b.*?Failed background update:\s*(.*)$/);
        if (failed && !entry.everRead) entry.readFailed = failed[1].slice(0, 240);
        entry.tail.push(line.slice(0, 300));
        if (entry.tail.length > TAIL_LINES) entry.tail.shift();
        this.log(`[parser ${mailbox.id}] ${line}`);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => {
      entry.exited = { code: null, signal: null };
      entry.tail.push(`could not start: ${err.message}`);
      this.log(`[parser ${mailbox.id}] could not start: ${err.message}`);
    });
    proc.on("exit", (code, signal) => {
      entry.exited = { code, signal };
      this.log(`[parser ${mailbox.id}] exited (${signal ?? code})`);
    });

    this.entries.set(mailbox.id, entry);
    this.log(`[parser ${mailbox.id}] started on port ${port}`);
    return entry;
  }

  private async kill(entry: Entry): Promise<void> {
    this.entries.delete(entry.id);
    if (entry.exited) return;
    const gone = new Promise<void>((resolve) => entry.proc.once("exit", () => resolve()));
    entry.proc.kill("SIGTERM");
    const timer = setTimeout(() => entry.proc.kill("SIGKILL"), 3000);
    await gone;
    clearTimeout(timer);
  }

  async lease(mailbox: Mailbox, opts: LeaseOptions): Promise<LeaseResult> {
    let entry: Entry;
    try {
      entry = await this.ensure(mailbox);
    } catch (err) {
      return { ok: false, error: `Could not start the report reader: ${err instanceof Error ? err.message : err}` };
    }
    const ready = await waitUntilRead(entry.client, this.o.env, opts.timeoutMs, this.o.pollMs, () => entry.exited !== null || entry.readFailed !== null);
    if (ready.ok) entry.everRead = true;
    if (!ready.ok) {
      if (entry.readFailed) return { ok: false, error: `Could not read the mailbox: ${entry.readFailed}` };
      const why = entry.exited ? ` The reader stopped (${entry.exited.signal ?? `exit code ${entry.exited.code}`}).` : "";
      const last = entry.tail.length ? ` Last message: ${entry.tail[entry.tail.length - 1]}` : "";
      return { ok: false, error: ready.error + why + last };
    }
    return { ok: true, client: entry.client, release: async () => {} };
  }

  /** Stops parsers whose mailbox was removed or disabled. */
  async sweep(): Promise<void> {
    const wanted = new Set((await this.o.listMailboxes()).map((m) => m.id));
    for (const entry of [...this.entries.values()]) {
      if (!wanted.has(entry.id)) await this.serial(entry.id, () => this.kill(entry));
    }
  }

  /** The mailbox ids that currently have a running parser. */
  running(): string[] {
    return [...this.entries.values()].filter((e) => !e.exited).map((e) => e.id);
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.entries.values()].map((e) => this.kill(e)));
  }
}
