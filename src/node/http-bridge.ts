// Turns Node's HTTP server objects into the Request/Response the app speaks, and
// serves the static files that Cloudflare serves from its assets binding.

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { extname, join, normalize, sep } from "node:path";

/** The client's address, for the failed-login throttle. Behind a reverse proxy the
 * address comes from the proxy's X-Forwarded-For (its last entry, the one the proxy
 * itself added; earlier entries are whatever the client claimed). Without a trusted
 * proxy, only the connection's own address is believed. */
export function clientAddress(forwardedFor: string | null | undefined, remote: string | undefined, trustProxy: boolean): string {
  if (trustProxy && forwardedFor) {
    const last = forwardedFor.split(",").pop()?.trim();
    if (last) return last;
  }
  return (remote ?? "unknown").replace(/^::ffff:/, "");
}

export interface BridgeOptions {
  trustProxy: boolean;
  /** Fixed public address of the site (e.g. https://dmarc.example.com); otherwise derived from the request. */
  publicUrl?: string;
  maxBodyBytes?: number;
}

export function requestOrigin(req: IncomingMessage, o: BridgeOptions): string {
  if (o.publicUrl) return o.publicUrl.replace(/\/+$/, "");
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(",")[0].trim();
  const proto = (o.trustProxy && first(req.headers["x-forwarded-proto"])) || ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  const host = (o.trustProxy && first(req.headers["x-forwarded-host"])) || req.headers.host || "localhost";
  return `${proto === "https" ? "https" : "http"}://${host}`;
}

export class BodyTooLarge extends Error {}

export function toRequest(req: IncomingMessage, o: BridgeOptions): Request {
  const max = o.maxBodyBytes ?? 10 * 1024 * 1024;
  const url = new URL(req.url ?? "/", requestOrigin(req, o));

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    // Never believe a client-supplied copy of the header the app trusts for the client's address.
    if (k.toLowerCase() === "cf-connecting-ip") continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, v);
  }
  const fwd = req.headers["x-forwarded-for"];
  headers.set("cf-connecting-ip", clientAddress(Array.isArray(fwd) ? fwd.join(",") : fwd, req.socket.remoteAddress, o.trustProxy));

  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });

  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) throw new BodyTooLarge();
  let seen = 0;
  const body = (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new BodyTooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Request(url, { method, headers, body, duplex: "half" } as RequestInit);
}

export function sendResponse(res: ServerResponse, response: Response, method: string): void {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, response.statusText || undefined, headers);
  if (!response.body || method === "HEAD") {
    res.end();
    return;
  }
  Readable.fromWeb(response.body as never).on("error", () => res.destroy()).pipe(res);
}

// ---------------------------------------------------------------- static files

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".json": "application/json",
};

/** Rules from public/_headers (the file Cloudflare reads): a path pattern, then indented headers. */
export function parseHeadersFile(text: string): Array<{ prefix: string; headers: Record<string, string> }> {
  const rules: Array<{ prefix: string; headers: Record<string, string> }> = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ prefix: raw.trim().replace(/\*$/, ""), headers: {} });
    } else if (rules.length) {
      const i = raw.indexOf(":");
      if (i > 0) rules[rules.length - 1].headers[raw.slice(0, i).trim().toLowerCase()] = raw.slice(i + 1).trim();
    }
  }
  return rules;
}

export interface StaticFiles {
  serve(pathname: string, method: string): Promise<Response | null>;
}

export function staticFiles(root: string, headersFile: string | null): StaticFiles {
  const rules = headersFile ? parseHeadersFile(headersFile) : [];
  const base = normalize(root);
  return {
    async serve(pathname, method) {
      if (method !== "GET" && method !== "HEAD") return null;
      let rel: string;
      try {
        rel = decodeURIComponent(pathname);
      } catch {
        return null;
      }
      if (rel.includes("\0") || rel.endsWith("/") || rel === "/_headers") return null;
      const file = normalize(join(base, rel));
      // Stay inside the folder: no ../ tricks, however they are spelled.
      if (file !== base && !file.startsWith(base + sep)) return null;
      try {
        if (!(await stat(file)).isFile()) return null;
        const body = await readFile(file);
        const headers: Record<string, string> = { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" };
        for (const r of rules) if (rel.startsWith(r.prefix)) Object.assign(headers, r.headers);
        return new Response(method === "HEAD" ? null : body, { headers });
      } catch {
        return null;
      }
    },
  };
}
