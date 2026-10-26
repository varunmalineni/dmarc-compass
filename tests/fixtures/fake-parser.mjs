// A stand-in for the upstream parser program, for tests. It speaks just enough of the
// same HTTP API (Basic auth, /summary, /dmarc-reports) and is configured the same way
// (environment variables), so the pool can be tested without the real binary.
//
// Extra behaviour, set through the environment:
//   FAKE_READ_DELAY_MS  how long after start until /summary reports a first read
//   FAKE_EXIT_AFTER_MS  exit with code 3 after this long (a crash)

import { createServer } from "node:http";

const env = process.env;
const started = Date.now();
const readDelay = Number(env.FAKE_READ_DELAY_MS || 0);

if (env.FAKE_EXIT_AFTER_MS) {
  console.error("IMAP login failed: authentication rejected");
  setTimeout(() => process.exit(3), Number(env.FAKE_EXIT_AFTER_MS));
}

const expected = "Basic " + Buffer.from(`${env.HTTP_SERVER_USER}:${env.HTTP_SERVER_PASSWORD}`).toString("base64");

const server = createServer((req, res) => {
  req.url = decodeURIComponent(req.url);
  if (req.headers.authorization !== expected) {
    res.writeHead(401).end("unauthorized");
    return;
  }
  const json = (o) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
  if (req.url === "/summary") return json({ last_update: Date.now() - started >= readDelay ? 1_800_000_000 : null });
  const end = Math.floor(Date.now() / 1000) - 7200;
  const hash = `h-${env.IMAP_USER}`;
  const domain = String(env.IMAP_USER).split("@")[1] || "example.com";
  if (req.url === "/dmarc-reports") return json([{ hash, id: `r-${env.IMAP_USER}`, org: "google.com", domain, date_begin: end - 86400, date_end: end, records: 1, flagged_dkim: false, flagged_spf: false, flagged_dmarc: false, flagged: false }]);
  if (req.url === `/dmarc-reports/${hash}/json`) {
    return json({
      report_metadata: { org_name: "google.com", email: "noreply@google.com", report_id: `r-${env.IMAP_USER}`, date_range: { begin: end - 86400, end } },
      policy_published: { domain, p: "none", pct: 100 },
      record: [
        { row: { source_ip: "192.0.2.10", count: 40, policy_evaluated: { disposition: "none", dkim: "pass", spf: "pass" } }, identifiers: { header_from: domain }, auth_results: { dkim: [{ domain, result: "pass" }], spf: [{ domain, result: "pass" }] } },
        { row: { source_ip: "192.0.2.99", count: 5, policy_evaluated: { disposition: "none", dkim: "fail", spf: "fail" } }, identifiers: { header_from: domain }, auth_results: { dkim: [{ domain, result: "fail" }], spf: [{ domain, result: "fail" }] } },
      ],
    });
  }
  if (req.url === "/tls-reports") return json([]);
  if (req.method === "POST" && req.url === "/ips/dns/batch") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => json(JSON.parse(body).map(() => null)));
    return;
  }
  if (req.url.startsWith("/ips/")) return res.writeHead(404).end("no location");
  if (req.url === "/whoami") {
    return json({
      pid: process.pid,
      imapUser: env.IMAP_USER,
      imapHost: env.IMAP_HOST,
      imapPort: env.IMAP_PORT,
      imapDisableTls: env.IMAP_DISABLE_TLS,
      interval: env.IMAP_CHECK_INTERVAL,
      binding: env.HTTP_SERVER_BINDING,
      envNames: Object.keys(env),
    });
  }
  res.writeHead(404).end("not found");
});

server.listen(Number(env.HTTP_SERVER_PORT), env.HTTP_SERVER_BINDING);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
