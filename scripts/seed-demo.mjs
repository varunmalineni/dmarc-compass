#!/usr/bin/env node
// Fills a LOCAL development database with synthetic demo data: invented
// `.example` domains, RFC 5737 documentation IPs, made-up locations. Nothing
// here comes from a real mailbox. Used for the README screenshots and for
// trying the UI without an IMAP account.
//
//   npm run dev          # in one terminal; open the page once so the tables exist
//   npm run demo         # in another: loads the data into the local database
//
// `npm run demo` only ever touches the local simulator (it always passes
// --local to wrangler), never your deployed database. It replaces any reports
// already in the local database. Without --apply the SQL is printed instead.
//
// Output is deterministic apart from dates, which are relative to today.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DAY = 86400;
const DAYS = 190;
const now = Math.floor(Date.now() / 1000);
const midnight = now - (now % DAY);

let seed = 20240607;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rand() * a.length)];
const chance = (p) => rand() < p;
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const PLACES = {
  sf: ["San Francisco", "United States", "US", 37.77, -122.42],
  va: ["Ashburn", "United States", "US", 39.04, -77.49],
  or: ["Portland", "United States", "US", 45.52, -122.68],
  tx: ["Dallas", "United States", "US", 32.78, -96.8],
  ie: ["Dublin", "Ireland", "IE", 53.35, -6.26],
  de: ["Frankfurt", "Germany", "DE", 50.11, 8.68],
  uk: ["London", "United Kingdom", "GB", 51.51, -0.13],
  nl: ["Amsterdam", "Netherlands", "NL", 52.37, 4.9],
  sg: ["Singapore", "Singapore", "SG", 1.35, 103.82],
  au: ["Sydney", "Australia", "AU", -33.87, 151.21],
  br: ["Sao Paulo", "Brazil", "BR", -23.55, -46.63],
  jp: ["Tokyo", "Japan", "JP", 35.68, 139.69],
  ro: ["Bucharest", "Romania", "RO", 44.43, 26.1],
  ng: ["Lagos", "Nigeria", "NG", 6.52, 3.38],
  vn: ["Hanoi", "Vietnam", "VN", 21.03, 105.85],
};

// weight = typical share of a domain's volume; pass = chance a message from this sender passes DMARC
const SENDERS = [
  { name: "Google Workspace", slug: "google", ips: 6, places: ["va", "or", "ie", "tx"], weight: 10, pass: 0.9996 },
  { name: "Microsoft 365", slug: "outlook", ips: 5, places: ["va", "ie", "nl"], weight: 9, pass: 0.9996 },
  { name: "Amazon SES", slug: "ses", ips: 6, places: ["va", "or", "ie", "de"], weight: 8, pass: 0.9996 },
  { name: "SendGrid", slug: "sendgrid", ips: 4, places: ["va", "tx"], weight: 5, pass: 0.9996 },
  { name: "Mailchimp", slug: "mailchimp", ips: 4, places: ["va", "tx", "uk"], weight: 4, pass: 0.9995, fixedDaysAgo: 30 },
  { name: "Salesforce", slug: "salesforce", ips: 3, places: ["sf", "va", "de"], weight: 3, pass: 0.9996 },
  { name: "HubSpot", slug: "hubspot", ips: 3, places: ["va", "ie"], weight: 3, pass: 0.9996 },
  { name: "Zendesk", slug: "zendesk", ips: 2, places: ["sf", "ie"], weight: 2, pass: 0.9996 },
  { name: "Postmark", slug: "postmark", ips: 2, places: ["va", "uk"], weight: 2, pass: 0.9996 },
  { name: "Zoho Mail", slug: "zoho", ips: 2, places: ["sg", "au"], weight: 1.5, pass: 0.9996 },
  { name: "Shopify", slug: "shopify", ips: 2, places: ["va", "jp"], weight: 2, pass: 0.9996 },
  // Not authorised to send: shown as failing, unidentified traffic.
  { name: null, slug: "unknown", ips: 5, places: ["ro", "ng", "vn", "br", "jp"], weight: 0.4, pass: 0, rogue: true },
];

// Documentation ranges (RFC 5737): never routable, never a real host.
const RANGES = ["192.0.2.", "198.51.100.", "203.0.113."];
let ipCounter = 10;
const nextIp = () => `${RANGES[Math.floor(ipCounter / 240) % 3]}${(ipCounter++ % 240) + 10}`;
for (const s of SENDERS) {
  s.addrs = Array.from({ length: s.ips }, (_, i) => {
    const place = PLACES[s.places[i % s.places.length]];
    return { ip: nextIp(), place, ptr: s.rogue ? (chance(0.5) ? null : `host-${Math.floor(rand() * 900 + 100)}.dynamic.example`) : `out-${i + 1}.${s.slug}.example` };
  });
}
const byName = Object.fromEntries(SENDERS.map((s) => [s.slug, s]));

const DOMAINS = [
  ["northwind-outdoors.example", "reject", 9, ["google", "ses", "sendgrid", "mailchimp", "shopify", "unknown"]],
  ["lumen-analytics.example", "reject", 8, ["google", "ses", "hubspot", "salesforce"]],
  ["harborline-freight.example", "reject", 7, ["outlook", "ses", "salesforce", "unknown"]],
  ["bluepine-bakery.example", "quarantine", 3, ["google", "mailchimp", "shopify"]],
  ["atlas-legal.example", "reject", 3, ["outlook", "zendesk"]],
  ["cobalt-robotics.example", "reject", 6, ["google", "ses", "sendgrid", "zendesk"]],
  ["fernwood-hotels.example", "quarantine", 7, ["outlook", "mailchimp", "sendgrid", "unknown"]],
  ["quill-and-ink.example", "none", 2, ["google", "mailchimp", "postmark"]],
  ["meridian-health.example", "reject", 6, ["outlook", "salesforce", "ses"]],
  ["orbit-learning.example", "quarantine", 5, ["google", "sendgrid", "hubspot", "mailchimp"]],
  ["saffron-kitchen.example", "none", 2, ["google", "mailchimp", "shopify"]],
  ["tidewater-credit.example", "reject", 6, ["outlook", "ses", "salesforce", "zendesk"]],
  ["vantage-realty.example", "quarantine", 4, ["google", "mailchimp", "hubspot"]],
  ["wren-studio.example", "none", 1, ["google", "postmark"]],
  ["zephyr-travel.example", "none", 5, ["google", "ses", "mailchimp", "sendgrid", "unknown"]],
  ["ironbridge-steel.example", "reject", 3, ["outlook", "zoho"]],
  ["juniper-labs.example", "quarantine", 4, ["google", "ses", "postmark"]],
  ["kestrel-capital.example", "reject", 4, ["outlook", "salesforce", "zendesk"]],
  ["marigold-florist.example", "none", 1, ["google", "mailchimp", "shopify"]],
  ["nimbus-cloud.example", "reject", 8, ["google", "ses", "sendgrid", "hubspot", "zendesk"]],
  ["opal-cosmetics.example", "none", 4, ["google", "mailchimp", "shopify", "sendgrid"]],
  ["pinecrest-schools.example", "quarantine", 3, ["outlook", "zoho", "mailchimp"]],
].map(([name, policy, weight, senders]) => ({ name, policy, weight, senders: senders.map((s) => byName[s]) }));

// A few domains carry a long-running misconfiguration so the dashboard has something to flag.
const BROKEN = {
  "fernwood-hotels.example": "sendgrid",
  "zephyr-travel.example": "ses",
  "opal-cosmetics.example": "sendgrid",
};

const REPORTERS = [
  { org: "google.com", share: 0.5 },
  { org: "Microsoft Corporation", share: 0.3 },
  { org: "Yahoo", share: 0.12 },
  { org: "Mimecast", share: 0.08 },
];

const reports = [];
const records = [];
let n = 0;

for (const d of DOMAINS) {
  for (let day = DAYS; day >= 1; day--) {
    const begin = midnight - day * DAY;
    const dow = new Date(begin * 1000).getUTCDay();
    const weekday = dow === 0 || dow === 6 ? 0.45 : 1;
    // Volume grows slowly over the period.
    const growth = 0.7 + 0.3 * ((DAYS - day) / DAYS);
    for (const rep of REPORTERS) {
      if (!chance(rep.share + 0.2)) continue;
      const hash = `demo${String(++n).padStart(6, "0")}`;
      const rows = [];
      for (const s of d.senders) {
        if (s.rogue ? !chance(0.08) : !chance(0.75)) continue;
        const base = s.weight * d.weight * weekday * growth * rep.share * (0.5 + rand());
        const count = Math.max(1, Math.round(s.rogue ? base * 2 + 1 : base * 3));
        const addr = pick(s.addrs);
        let passes;
        let dkim = "pass";
        let spf = "pass";
        const broken = BROKEN[d.name] === s.slug && (d.name === "zephyr-travel.example" || day > 14) && chance(0.5);
        const mailchimpBroken = s.slug === "mailchimp" && day > s.fixedDaysAgo && d.policy !== "reject" && chance(0.6);
        if (s.rogue) {
          dkim = "fail";
          spf = "fail";
        } else if (broken || mailchimpBroken) {
          dkim = chance(0.85) ? "fail" : "pass";
          spf = chance(0.85) ? "fail" : "pass";
        } else if (!chance(s.pass)) {
          dkim = "fail";
          spf = chance(0.5) ? "fail" : "pass";
        } else if (chance(0.04)) {
          spf = "fail"; // aligned via DKIM only
        } else if (chance(0.03)) {
          dkim = "fail"; // aligned via SPF only
        }
        passes = dkim === "pass" || spf === "pass";
        const disposition = passes ? "none" : d.policy;
        const authDkim = s.rogue ? "none" : dkim;
        const authSpf = s.rogue ? "softfail" : spf === "pass" ? "pass" : "fail";
        rows.push({ ip: addr.ip, count, disposition, dkim, spf, authDkim, authSpf });
      }
      if (!rows.length) continue;
      reports.push({
        hash,
        id: `${rep.org.split(/[ .]/)[0].toLowerCase()}-${d.name.split(".")[0]}-${day}`,
        org: rep.org,
        domain: d.name,
        begin,
        end: begin + DAY - 1,
        policy: d.policy,
        pct: 100,
        insertedAt: begin + DAY + 3600,
      });
      for (const r of rows) records.push({ hash, domain: d.name, begin, ...r });
    }
  }
}

const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, (i + 1) * size));
const out = [];

out.push("DELETE FROM tls_failure_details; DELETE FROM tls_policy_results; DELETE FROM tls_reports;");
out.push("DELETE FROM dmarc_records; DELETE FROM dmarc_reports; DELETE FROM ip_enrichment;");

for (const part of chunk(reports, 150)) {
  out.push(
    "INSERT INTO dmarc_reports (hash, report_id, org_name, domain, date_begin, date_end, policy_p, policy_pct, inserted_at) VALUES\n" +
      part.map((r) => `(${[q(r.hash), q(r.id), q(r.org), q(r.domain), r.begin, r.end, q(r.policy), r.pct, r.insertedAt].join(",")})`).join(",\n") +
      ";",
  );
}
for (const part of chunk(records, 150)) {
  out.push(
    "INSERT INTO dmarc_records (report_hash, source_ip, count, disposition, policy_dkim, policy_spf, auth_dkim_result, auth_spf_result, header_from, domain, date_begin) VALUES\n" +
      part.map((r) => `(${[q(r.hash), q(r.ip), r.count, q(r.disposition), q(r.dkim), q(r.spf), q(r.authDkim), q(r.authSpf), q(r.domain), q(r.domain), r.begin].join(",")})`).join(",\n") +
      ";",
  );
}

const enrich = SENDERS.flatMap((s) =>
  s.addrs.map((a) => `(${[q(a.ip), q(a.ptr), q(s.name), now, a.place[3], a.place[4], q(a.place[0]), q(a.place[1]), q(a.place[2])].join(",")})`),
);
out.push("INSERT INTO ip_enrichment (ip, ptr_hostname, esp_name, resolved_at, lat, lon, city, country, country_code) VALUES\n" + enrich.join(",\n") + ";");

// TLS-RPT: a handful of domains, mostly healthy, one with real failures.
const tlsDomains = DOMAINS.slice(0, 8).map((d) => d.name);
const tlsReports = [];
const tlsPolicies = [];
const tlsFailures = [];
let tlsId = 0;
for (const domain of tlsDomains) {
  for (let day = 60; day >= 1; day -= 1) {
    if (!chance(0.45)) continue;
    const begin = midnight - day * DAY;
    const org = pick(["google.com", "Microsoft Corporation", "Yahoo"]);
    const hash = `tlsdemo${String(++tlsId).padStart(5, "0")}`;
    tlsReports.push([q(hash), q(`tls-${domain.split(".")[0]}-${day}`), q(org), begin, begin + DAY - 1, begin + DAY + 1800].join(","));
    const failing = domain === "harborline-freight.example" && day < 20 && chance(0.7);
    const ok = Math.round(20 + rand() * 300);
    const bad = failing ? Math.round(3 + rand() * 25) : 0;
    tlsPolicies.push({ hash, domain, type: "sts", ok, bad, begin, failing });
  }
}
if (tlsReports.length) {
  out.push("INSERT INTO tls_reports (hash, report_id, org_name, date_begin, date_end, inserted_at) VALUES\n" + tlsReports.map((r) => `(${r})`).join(",\n") + ";");
  out.push(
    "INSERT INTO tls_policy_results (id, report_hash, policy_domain, policy_type, successful_count, failure_count, date_begin) VALUES\n" +
      tlsPolicies.map((p, i) => `(${[i + 1, q(p.hash), q(p.domain), q(p.type), p.ok, p.bad, p.begin].join(",")})`).join(",\n") +
      ";",
  );
  tlsPolicies.forEach((p, i) => {
    if (!p.failing) return;
    tlsFailures.push(`(${[i + 1, q(pick(["certificate-expired", "starttls-not-supported", "validation-failure"])), q(pick(byName.google.addrs).ip), q("mx1.harborline-freight.example"), p.bad].join(",")})`);
  });
  if (tlsFailures.length) {
    out.push("INSERT INTO tls_failure_details (policy_result_id, result_type, sending_mta_ip, receiving_mx_hostname, failed_session_count) VALUES\n" + tlsFailures.join(",\n") + ";");
  }
}

out.push(
  `INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('public_dashboard', 'true', ${now}), ('last_sync', '${JSON.stringify({ at: now - 6 * 60, ok: true, summary: "3 new DMARC reports, 0 new TLS reports" })}', ${now});`,
);

// Tags, an automatic rule and colours, so the Tags page and the filter have something to show.
const TAGS = {
  emea: ["fernwood-hotels", "meridian-health", "atlas-legal", "zephyr-travel", "ironbridge-steel", "tidewater-credit", "pinecrest-schools"],
  us: ["northwind-outdoors", "lumen-analytics", "harborline-freight", "cobalt-robotics", "kestrel-capital", "nimbus-cloud", "vantage-realty"],
  regulated: ["meridian-health", "tidewater-credit", "kestrel-capital", "atlas-legal"],
  marketing: ["northwind-outdoors", "bluepine-bakery", "orbit-learning", "opal-cosmetics", "zephyr-travel", "quill-and-ink"],
  review: ["zephyr-travel", "fernwood-hotels", "opal-cosmetics"],
};
const tagRows = Object.entries(TAGS).flatMap(([tag, names]) => names.map((n) => `(${q(n + ".example")}, ${q(tag)})`));
const tagColors = { emea: "blue", us: "teal", regulated: "purple", marketing: "pink", review: "amber", shops: "green" };
const tagRules = [{ id: "demo-shops", tag: "shops", expr: { any: ["bakery", "kitchen", "cosmetics", "florist"].map((v) => ({ field: "domain", op: "contains", value: v })) } }];
out.push("DELETE FROM domain_tags;");
out.push("INSERT INTO domain_tags (domain, tag) VALUES\n" + tagRows.join(",\n") + ";");
out.push(
  `INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('tag_colors', ${q(JSON.stringify(tagColors))}, ${now}), ('tag_rules', ${q(JSON.stringify(tagRules))}, ${now});`,
);

const sql = out.join("\n") + "\n";
process.stderr.write(`demo data: ${DOMAINS.length} domains, ${Object.keys(TAGS).length + 1} tags, ${reports.length} reports, ${records.length} records, ${tlsReports.length} TLS reports\n`);

if (!process.argv.includes("--apply")) {
  process.stdout.write(sql);
} else {
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
  const config = "wrangler.local.jsonc";
  if (!existsSync(config)) copyFileSync("wrangler.jsonc", config);
  const file = join(mkdtempSync(join(tmpdir(), "dmarc-demo-")), "demo.sql");
  writeFileSync(file, sql);
  const r = spawnSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--file", file, "-c", config], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error("\nIf the error mentions a missing table, run `npm run dev` and open http://localhost:8787 once, then retry.");
    process.exit(r.status ?? 1);
  }
  console.log("\nDemo data loaded into the local database. Reload the dashboard (run `npm run dev` if it is not running).");
}
