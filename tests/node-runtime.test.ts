import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteD1 } from "../src/node/sqlite-d1.ts";
import { readConfig, startupHelp } from "../src/node/config.ts";
import { clientAddress, parseHeadersFile, requestOrigin, sendResponse, staticFiles, toRequest } from "../src/node/http-bridge.ts";
import { applyMigrations } from "../src/migrations.ts";

// ------------------------------------------------------------------- database

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

function memDb() {
  return new SqliteD1(":memory:");
}

test("the SQLite adapter gives the call shapes the app uses", async () => {
  const db = memDb();
  db.raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)");
  const ins = await db.prepare("INSERT INTO t (name) VALUES (?)").bind("a").run();
  assert.deepEqual([ins.success, ins.meta.changes, ins.meta.last_row_id], [true, 1, 1]);
  assert.equal((await db.prepare("INSERT OR IGNORE INTO t (name) VALUES (?)").bind("a").run()).meta.changes, 0);
  assert.deepEqual(plain(await db.prepare("SELECT name FROM t WHERE id = ?").bind(1).first()), { name: "a" });
  assert.equal(await db.prepare("SELECT name FROM t WHERE id = ?").bind(99).first(), null);
  assert.deepEqual(plain((await db.prepare("SELECT name FROM t").all()).results), [{ name: "a" }]);
  assert.deepEqual(plain((await db.prepare("SELECT value FROM json_each(?)").bind('["x","y"]').all()).results), [{ value: "x" }, { value: "y" }]);
});

test("batch is all-or-nothing and returns each statement's result", async () => {
  const db = memDb();
  db.raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)");
  const ok = await db.batch([db.prepare("INSERT INTO t (name) VALUES ('a')"), db.prepare("INSERT INTO t (name) VALUES ('b')"), db.prepare("SELECT COUNT(*) AS n FROM t")]);
  assert.deepEqual([ok[0].meta?.changes, ok[1].meta?.changes], [1, 1]);
  assert.deepEqual(plain((ok[2] as { results: unknown[] }).results), [{ n: 2 }]);
  await assert.rejects(db.batch([db.prepare("INSERT INTO t (name) VALUES ('c')"), db.prepare("INSERT INTO t (name) VALUES ('a')")]));
  assert.deepEqual(plain(await db.prepare("SELECT COUNT(*) AS n FROM t").first()), { n: 2 }, "the first insert was rolled back");
  assert.equal((await db.batch([db.prepare("INSERT INTO t (name) VALUES ('d')")])).length, 1, "and the database still works");
});

test("the whole schema applies to it, and applying twice changes nothing", async () => {
  const db = memDb();
  await applyMigrations(db.asD1());
  await applyMigrations(db.asD1());
  const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const t of ["dmarc_reports", "dmarc_records", "app_settings", "auth_attempts", "schema_migrations"]) assert.ok(tables.includes(t), t);
  assert.equal((db.raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
});

// --------------------------------------------------------------------- config

const goodKey = Buffer.alloc(32, 7).toString("base64");
const base = { ADMIN_USER: "admin", ADMIN_PASSWORD: "a-long-enough-password", CONFIG_ENCRYPTION_KEY: goodKey };

test("it refuses to start without the three required settings, and says what each is for", () => {
  const r = readConfig({}, { publicDir: "/p" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.problems.length, 3);
    const help = startupHelp(r.problems);
    assert.match(help, /ADMIN_USER/);
    assert.match(help, /openssl rand -base64 32/);
    assert.match(help, /no default password/);
  }
});

test("weak or malformed settings are refused", () => {
  const bad = (over: Record<string, string>) => readConfig({ ...base, ...over }, { publicDir: "/p" });
  assert.equal(bad({ ADMIN_PASSWORD: "short" }).ok, false);
  assert.equal(bad({ CONFIG_ENCRYPTION_KEY: "not-a-key" }).ok, false);
  assert.equal(bad({ CONFIG_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }).ok, false, "16 bytes is not enough");
  assert.equal(bad({ PORT: "99999" }).ok, false);
  assert.equal(bad({ PORT: "abc" }).ok, false);
  assert.equal(bad({ PUBLIC_URL: "dmarc.example.com" }).ok, false);
});

test("good settings and the defaults", () => {
  const r = readConfig(base, { publicDir: "/p" });
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual([r.config.port, r.config.host, r.config.dataDir, r.config.publicDir, r.config.parserCommand, r.config.trustProxy], [8080, "0.0.0.0", "./data", "/p", "dmarc-report-viewer", false]);
    assert.equal(r.config.app.ALLOW_INSECURE_HTTP, undefined, "plain HTTP is off unless asked for");
  }
  const custom = readConfig({ ...base, PORT: "3000", TRUST_PROXY: "true", ALLOW_INSECURE_HTTP: "1", PUBLIC_URL: "https://dmarc.example.com/", DATA_DIR: "/data" }, { publicDir: "/p" });
  assert.ok(custom.ok);
  if (custom.ok) assert.deepEqual([custom.config.port, custom.config.trustProxy, custom.config.app.ALLOW_INSECURE_HTTP, custom.config.dataDir], [3000, true, "true", "/data"]);
});

// ------------------------------------------------------------- client address

test("the client address believes a proxy only when told to, and then only the entry the proxy added", () => {
  assert.equal(clientAddress("6.6.6.6", "10.0.0.5", false), "10.0.0.5", "no trusted proxy: ignore the header");
  assert.equal(clientAddress("1.2.3.4", "10.0.0.5", true), "1.2.3.4");
  assert.equal(clientAddress("6.6.6.6, 1.2.3.4", "10.0.0.5", true), "1.2.3.4", "a client-supplied first entry is not believed");
  assert.equal(clientAddress(undefined, "::ffff:192.0.2.9", true), "192.0.2.9");
  assert.equal(clientAddress(null, undefined, false), "unknown");
});

test("the origin comes from the request, a trusted proxy, or a fixed public address", () => {
  const req = (headers: Record<string, string>, encrypted = false) => ({ headers, socket: { encrypted } }) as never;
  assert.equal(requestOrigin(req({ host: "localhost:8080" }), { trustProxy: false }), "http://localhost:8080");
  assert.equal(requestOrigin(req({ host: "h:1", "x-forwarded-proto": "https", "x-forwarded-host": "dmarc.example.com" }), { trustProxy: false }), "http://h:1");
  assert.equal(requestOrigin(req({ host: "h:1", "x-forwarded-proto": "https", "x-forwarded-host": "dmarc.example.com" }), { trustProxy: true }), "https://dmarc.example.com");
  assert.equal(requestOrigin(req({ host: "x" }), { trustProxy: true, publicUrl: "https://fixed.example/" }), "https://fixed.example");
});

// ------------------------------------------------------- a real HTTP round trip

async function roundTrip(opts: { trustProxy: boolean }, handler: (r: Request) => Promise<Response>, send: (base: string) => Promise<Response>) {
  const server = createServer(async (req, res) => {
    try {
      sendResponse(res, await handler(toRequest(req, opts)), req.method ?? "GET");
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    return await send(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("a client cannot choose its own address for the login lockout", async () => {
  let seen: string | null = null;
  const echo = async (r: Request) => { seen = r.headers.get("cf-connecting-ip"); return new Response("ok"); };
  await roundTrip({ trustProxy: false }, echo, (b) => fetch(b, { headers: { "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "7.7.7.7" } }));
  assert.equal(seen, "127.0.0.1");
  await roundTrip({ trustProxy: true }, echo, (b) => fetch(b, { headers: { "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "7.7.7.7, 8.8.8.8" } }));
  assert.equal(seen, "8.8.8.8");
});

test("bodies, several cookies and status codes pass through", async () => {
  const handler = async (r: Request) => {
    const text = await r.text();
    const h = new Headers({ "content-type": "application/json" });
    h.append("set-cookie", "a=1; Path=/");
    h.append("set-cookie", "b=2; Path=/");
    return new Response(JSON.stringify({ method: r.method, text, path: new URL(r.url).pathname + new URL(r.url).search }), { status: 201, headers: h });
  };
  const res = await roundTrip({ trustProxy: false }, handler, (b) => fetch(b + "/x?y=1", { method: "POST", body: "hello=world", headers: { "content-type": "application/x-www-form-urlencoded" } }));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { method: "POST", text: "hello=world", path: "/x?y=1" });
  assert.deepEqual(res.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
});

test("an oversized body is refused", async () => {
  let failed = false;
  const server = createServer((req, res) => {
    try { toRequest(req, { trustProxy: false, maxBodyBytes: 10 }); res.end("ok"); } catch { failed = true; res.writeHead(413).end(); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: "x".repeat(100) });
  server.close();
  assert.equal(res.status, 413);
  assert.ok(failed);
});

// --------------------------------------------------------------- static files

test("static files are served with the rules from _headers, and only from inside the folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pub-"));
  mkdirSync(join(dir, "vendor"));
  writeFileSync(join(dir, "vendor", "app.js"), "console.log(1)");
  writeFileSync(join(dir, "vendor", "f.woff2"), "font");
  writeFileSync(join(dir, "secret.txt"), "top secret");
  const headers = "/vendor/*\n  X-Content-Type-Options: nosniff\n  Cache-Control: public, max-age=86400\n";
  writeFileSync(join(dir, "_headers"), headers);
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "x.txt"), "outside");
  const files = staticFiles(join(dir, "vendor"), headers);

  const js = await files.serve("/app.js", "GET");
  assert.equal(js?.status, 200);
  assert.match(js!.headers.get("content-type")!, /javascript/);
  assert.equal(await js!.text(), "console.log(1)");
  assert.equal((await files.serve("/f.woff2", "GET"))?.headers.get("content-type"), "font/woff2");
  assert.equal(await files.serve("/missing.js", "GET"), null);
  assert.equal(await files.serve("/app.js", "POST"), null);
  assert.equal(await files.serve("/", "GET"), null);
  for (const bad of ["/../secret.txt", "/..%2Fsecret.txt", "/%2e%2e/secret.txt", `/../${outside.split("/").pop()}/x.txt`, "/%00", "/\0"]) assert.equal(await files.serve(bad, "GET"), null, bad);

  const all = staticFiles(dir, headers);
  assert.equal(await all.serve("/_headers", "GET"), null, "the rules file itself is not served");
  const v = await all.serve("/vendor/app.js", "GET");
  assert.equal(v?.headers.get("x-content-type-options"), "nosniff");
  assert.equal(v?.headers.get("cache-control"), "public, max-age=86400");
  assert.equal((await all.serve("/secret.txt", "GET"))?.headers.get("cache-control"), null, "other paths get no vendor rules");
});

test("a link inside the folder cannot be used to read files outside it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pub-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(dir, "ok.txt"), "fine");
  writeFileSync(join(outside, "x.txt"), "outside");
  symlinkSync(join(outside, "x.txt"), join(dir, "file-link.txt"));
  symlinkSync(outside, join(dir, "dir-link"));
  const files = staticFiles(dir, null);
  assert.equal(await (await files.serve("/ok.txt", "GET"))!.text(), "fine");
  assert.equal(await files.serve("/file-link.txt", "GET"), null, "a link to a file elsewhere");
  assert.equal(await files.serve("/dir-link/x.txt", "GET"), null, "a link to a folder elsewhere");
  // The folder itself may be reached through a link (a symlinked public directory is a normal deployment).
  const viaLink = join(mkdtempSync(join(tmpdir(), "via-")), "public");
  symlinkSync(dir, viaLink);
  assert.equal(await (await staticFiles(viaLink, null).serve("/ok.txt", "GET"))!.text(), "fine");
});

test("the _headers format is understood", () => {
  assert.deepEqual(parseHeadersFile("# c\n/vendor/*\n  A: 1\n  B: two words\n/other/*\n  C: 3\n"), [
    { prefix: "/vendor/", headers: { a: "1", b: "two words" } },
    { prefix: "/other/", headers: { c: "3" } },
  ]);
});
