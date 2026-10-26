// Synthetic data at fleet scale. Invented .example domains and documentation
// IP ranges only. Shapes follow real behaviour: a few busy domains and a long
// tail of quiet ones; big receivers report most days, small ones rarely; each
// domain sends from a small set of addresses.

import type { DatabaseSync } from "node:sqlite";

export interface Scale {
  domains: number;
  days: number;
  seed: number;
}

export const SIZES: Record<string, Scale> = {
  small: { domains: 300, days: 90, seed: 7 },
  typical: { domains: 1500, days: 90, seed: 7 },
  stress: { domains: 1500, days: 730, seed: 7 },
};

const DAY = 86400;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REPORTERS: Array<[string, number]> = [
  ["google.com", 0.95],
  ["Microsoft Corporation", 0.55],
  ["Yahoo", 0.35],
  ["Mimecast", 0.1],
  ["Proofpoint", 0.08],
];

const ESPS = ["Google Workspace", "Microsoft 365", "Amazon SES", "SendGrid", "Mailchimp", "Salesforce", "HubSpot", "Zendesk", "Postmark", null];
const PLACES: Array<[string, string, string, number, number]> = [
  ["Ashburn", "United States", "US", 39.04, -77.49],
  ["Dublin", "Ireland", "IE", 53.35, -6.26],
  ["Frankfurt", "Germany", "DE", 50.11, 8.68],
  ["London", "United Kingdom", "GB", 51.51, -0.13],
  ["Singapore", "Singapore", "SG", 1.35, 103.82],
  ["Sydney", "Australia", "AU", -33.87, 151.21],
];

export interface Generated {
  domains: number;
  reports: number;
  records: number;
  messages: number;
  ips: number;
  tlsResults: number;
  seconds: number;
}

export function generate(raw: DatabaseSync, scale: Scale, now = Math.floor(Date.now() / 1000)): Generated {
  const t0 = Date.now();
  const rand = rng(scale.seed);
  const midnight = now - (now % DAY);

  const insReport = raw.prepare(
    "INSERT INTO dmarc_reports (hash, report_id, org_name, domain, date_begin, date_end, policy_p, policy_pct, inserted_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  const insRecord = raw.prepare(
    "INSERT INTO dmarc_records (report_hash, source_ip, count, disposition, policy_dkim, policy_spf, auth_dkim_result, auth_spf_result, header_from, domain, date_begin) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insIp = raw.prepare(
    "INSERT OR REPLACE INTO ip_enrichment (ip, ptr_hostname, esp_name, resolved_at, lat, lon, city, country, country_code) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  const insTls = raw.prepare("INSERT INTO tls_reports (hash, report_id, org_name, date_begin, date_end, inserted_at) VALUES (?,?,?,?,?,?)");
  const insTlsRes = raw.prepare(
    "INSERT INTO tls_policy_results (report_hash, policy_domain, policy_type, successful_count, failure_count, date_begin) VALUES (?,?,?,?,?,?)",
  );

  // The IP pool: private 10.x addresses (never routable, so never a real host).
  const poolSize = Math.max(500, scale.domains * 5);
  const pool: string[] = [];
  raw.exec("BEGIN");
  for (let i = 0; i < poolSize; i++) {
    const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    pool.push(ip);
    const place = PLACES[Math.floor(rand() * PLACES.length)];
    const esp = ESPS[Math.floor(rand() * ESPS.length)];
    insIp.run(ip, esp ? `out-${i}.${esp.split(" ")[0].toLowerCase()}.example` : null, esp, now, rand() < 0.97 ? place[3] : null, place[4], place[0], place[1], place[2]);
  }
  raw.exec("COMMIT");

  let reports = 0;
  let records = 0;
  let messages = 0;
  let tlsResults = 0;

  raw.exec("BEGIN");
  for (let d = 0; d < scale.domains; d++) {
    const domain = `d${String(d).padStart(4, "0")}.example`;
    // Pareto-ish: ~5% busy, the rest quiet.
    const activity = Math.min(1, 0.06 + Math.pow(rand(), 3.2) * 1.4);
    const senders = 2 + Math.floor(activity * 22);
    const myIps = Array.from({ length: senders }, () => pool[Math.floor(rand() * pool.length)]);
    const weight = Math.max(1, Math.round(Math.pow(activity, 2) * 400));
    const failing = rand() < 0.25; // a quarter of domains have a misconfigured sender
    const policyStages = rand() < 0.3 ? ["none", "quarantine", "reject"] : rand() < 0.5 ? ["none"] : ["reject"];
    const hasTls = rand() < 0.15;

    for (let day = scale.days; day >= 1; day--) {
      const begin = midnight - day * DAY;
      const stage = policyStages[Math.min(policyStages.length - 1, Math.floor(((scale.days - day) / scale.days) * policyStages.length))];
      const dow = new Date(begin * 1000).getUTCDay();
      const weekend = dow === 0 || dow === 6 ? 0.5 : 1;

      for (const [org, p] of REPORTERS) {
        if (rand() > p * activity * weekend * 1.6) continue;
        const hash = `r${reports}`;
        insReport.run(hash, `${org.slice(0, 3)}-${d}-${day}`, org, domain, begin, begin + DAY - 1, stage, 100, begin + DAY + 14400);
        reports++;
        const n = 1 + Math.floor(rand() * Math.min(senders, 1 + activity * 7));
        for (let k = 0; k < n; k++) {
          const ip = myIps[Math.floor(rand() * myIps.length)];
          const count = 1 + Math.floor(rand() * weight * 0.6);
          const bad = failing && k === 0 && rand() < 0.6;
          insRecord.run(hash, ip, count, bad ? stage : "none", bad ? "fail" : "pass", bad ? "fail" : "pass", bad ? "fail" : "pass", bad ? "fail" : "pass", domain, domain, begin);
          records++;
          messages += count;
        }
      }
      if (hasTls && rand() < 0.5) {
        const th = `t${tlsResults}`;
        insTls.run(th, `tls-${d}-${day}`, "google.com", begin, begin + DAY - 1, begin + DAY);
        insTlsRes.run(th, domain, "sts", 20 + Math.floor(rand() * 400), rand() < 0.1 ? 1 + Math.floor(rand() * 20) : 0, begin);
        tlsResults++;
      }
    }
    if (d % 100 === 99) {
      raw.exec("COMMIT");
      raw.exec("BEGIN");
    }
  }
  raw.exec("COMMIT");
  raw.exec("ANALYZE");

  return { domains: scale.domains, reports, records, messages, ips: poolSize, tlsResults, seconds: (Date.now() - t0) / 1000 };
}
