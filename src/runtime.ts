// What the app needs from the place it runs. The Cloudflare build supplies one
// implementation (cloudflare-host.ts); the self-hosted build supplies another.
// Nothing outside those two files may import runtime-specific modules.

import type { Mailbox } from "./mailboxes.ts";

/** Anything the app can send an HTTP request to: a running parser. */
export interface ParserClient {
  fetch(req: Request): Promise<Response>;
}

export type LeaseResult =
  | { ok: true; client: ParserClient; release(): Promise<void> }
  | { ok: false; error: string; /** Another job is using the parser right now: try again shortly. */ busy?: boolean };

export interface LeaseOptions {
  /** A sync copies reports to the database; "raw" fetches one original file for a person waiting. */
  purpose: "sync" | "raw";
  /** How long to wait for the parser to finish reading the mailbox. */
  timeoutMs: number;
  /** True when this is the only mailbox that exists. */
  onlyMailbox: boolean;
}

/** Gives access to a parser that has finished reading one mailbox. */
export interface ParserHost {
  lease(mailbox: Mailbox, opts: LeaseOptions): Promise<LeaseResult>;
}

export interface TcpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export interface Runtime {
  parsers: ParserHost;
  /** Opens a TCP connection, with TLS from the first byte when `tls` is true. */
  connect(host: string, port: number, tls: boolean): TcpSocket;
}
