// The self-hosted server: the same app as the Cloudflare Worker, run by Node with a
// SQLite file for storage and one parser process per mailbox.
//
//   ADMIN_USER=... ADMIN_PASSWORD=... CONFIG_ENCRYPTION_KEY=... node dist/server.mjs

import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handle, runScheduled, type Env } from "../app";
import { ensureSchema } from "../migrations";
import { loadMailboxes } from "../mailbox-store";
import type { Runtime } from "../runtime";
import { readConfig, startupHelp } from "./config";
import { BodyTooLarge, sendResponse, staticFiles, toRequest } from "./http-bridge";
import { ParserPool } from "./parser-pool";
import { SqliteD1 } from "./sqlite-d1";
import { connectTcp } from "./tcp";

const here = dirname(fileURLToPath(import.meta.url));
const TICK_MS = 5 * 60 * 1000;
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const parsed = readConfig(process.env, { publicDir: join(here, "..", "public") });
if (!parsed.ok) {
  console.error(startupHelp(parsed.problems));
  process.exit(1);
}
const config = parsed.config;

mkdirSync(config.dataDir, { recursive: true });
const database = new SqliteD1(join(config.dataDir, "dmarc-compass.db"));
const db = database.asD1();
const env: Env = { DB: db, ...config.app };
await ensureSchema(db);

const pool = new ParserPool({
  env,
  command: config.parserCommand,
  log,
  listMailboxes: async () => (await loadMailboxes(env)).list.filter((m) => m.enabled),
});
const runtime: Runtime = { parsers: pool, connect: connectTcp };

let headersFile: string | null = null;
try {
  headersFile = readFileSync(join(config.publicDir, "_headers"), "utf8");
} catch {
  // no extra header rules
}
const assets = staticFiles(config.publicDir, headersFile);

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  try {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/healthz") {
      await db.prepare("SELECT 1").first();
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("ok\n");
      return;
    }
    const file = await assets.serve(pathname, method);
    if (file) return sendResponse(res, file, method);

    const request = toRequest(req, { trustProxy: config.trustProxy, publicUrl: config.publicUrl });
    sendResponse(res, await handle(request, env, runtime), method);
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      res.writeHead(413, { "content-type": "text/plain" }).end("Request too large\n");
      return;
    }
    console.error("request failed:", err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal error\n");
  }
});
server.requestTimeout = 5 * 60 * 1000;

// Wake every five minutes, on the clock, like the Worker's cron; a sync runs only when one is due.
function startTicks() {
  const tick = () => runScheduled(env, runtime).catch((err) => console.error("scheduled run failed:", err));
  setTimeout(() => {
    void tick();
    setInterval(tick, TICK_MS).unref();
  }, TICK_MS - (Date.now() % TICK_MS)).unref();
  // Parsers of removed or disabled mailboxes are stopped within a minute.
  setInterval(() => pool.sweep().catch((err) => console.error("sweep failed:", err)), 60_000).unref();
}

server.listen(config.port, config.host, () => {
  log(`dmarc-compass listening on http://${config.host}:${config.port} (data in ${config.dataDir})`);
  if (config.app.ALLOW_INSECURE_HTTP) log("WARNING: ALLOW_INSECURE_HTTP is on. Sign-in works over plain HTTP; use HTTPS for anything beyond a trial.");
  if (!config.trustProxy) log("Not trusting proxy headers (TRUST_PROXY unset): the sign-in lockout uses the connection's own address.");
  startTicks();
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log(`${signal} received, shutting down`);
  server.close();
  await pool.stopAll();
  database.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
