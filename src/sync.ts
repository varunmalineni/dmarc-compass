import type { DmarcReportJson, ReportHeader } from "./dmarc-types";
import type { TlsReportHeader, TlsReportJson } from "./tls-types";
import { espNameFromPtr } from "./esp.ts";
import { getAdminCreds, type AdminEnv } from "./config.ts";

export interface SyncEnv extends AdminEnv {
  DB: D1Database;
}

/** Makes an authenticated internal request against the dmarc-report-viewer container. */
export async function callContainer(
  container: { fetch(req: Request): Promise<Response> },
  path: string,
  env: SyncEnv,
  init?: RequestInit,
): Promise<Response> {
  const creds = getAdminCreds(env);
  if (!creds) throw new Error("Admin credentials are not configured");
  const auth = "Basic " + btoa(`${creds.user}:${creds.password}`);
  const headers = new Headers(init?.headers);
  headers.set("authorization", auth);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return container.fetch(new Request(`https://internal${path}`, { ...init, headers }));
}

export interface SyncResult {
  newReports: number;
  newRecords: number;
  newTlsReports: number;
  newIpsResolved: number;
  newLocationsResolved: number;
}

function summarizeAuthResult(results: Array<{ result: string }> | null | undefined): string | null {
  if (!results || results.length === 0) return null;
  if (results.some((r) => r.result === "pass")) return "pass";
  return results[0].result;
}

async function syncDmarcReports(
  container: { fetch(req: Request): Promise<Response> },
  env: SyncEnv,
  mailboxId: string,
): Promise<{ newReports: number; newRecords: number; newIps: Set<string> }> {
  const listRes = await callContainer(container, "/dmarc-reports", env);
  if (!listRes.ok) {
    throw new Error(`Failed to list reports: ${listRes.status} ${await listRes.text()}`);
  }
  const headers: ReportHeader[] = await listRes.json();

  // "Already have it" is decided by the report's identity (reporter, report ID,
  // domain), never by the container's hash: that hash is not stable across
  // container restarts, which previously caused every report to be re-ingested.
  const existing = await env.DB.prepare("SELECT org_name, report_id, domain FROM dmarc_reports").all<{
    org_name: string;
    report_id: string;
    domain: string;
  }>();
  const known = new Set(existing.results.map((r) => `${r.org_name}\u0000${r.report_id}\u0000${r.domain.toLowerCase()}`));
  const missing = headers.filter((h) => !known.has(`${h.org}\u0000${h.id}\u0000${h.domain.toLowerCase()}`));

  let newRecords = 0;
  const newIps = new Set<string>();

  for (const header of missing) {
    const jsonRes = await callContainer(container, `/dmarc-reports/${header.hash}/json`, env);
    if (!jsonRes.ok) {
      console.error(`Failed to fetch report ${header.hash}: ${jsonRes.status}`);
      continue;
    }
    const report: DmarcReportJson = await jsonRes.json();

    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO dmarc_reports
         (hash, report_id, org_name, domain, date_begin, date_end, policy_p, policy_pct, inserted_at, mailbox_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        header.hash,
        report.report_metadata.report_id,
        report.report_metadata.org_name,
        report.policy_published.domain,
        report.report_metadata.date_range.begin,
        report.report_metadata.date_range.end,
        report.policy_published.p,
        report.policy_published.pct ?? null,
        Math.floor(Date.now() / 1000),
        mailboxId,
      )
      .run();
    // Ignored by the unique identity index: it's a copy we already hold.
    if (!inserted.meta.changes) continue;

    for (const record of report.record) {
      await env.DB.prepare(
        `INSERT INTO dmarc_records
           (report_hash, source_ip, count, disposition, policy_dkim, policy_spf, auth_dkim_result, auth_spf_result, header_from, domain, date_begin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          header.hash,
          record.row.source_ip,
          record.row.count,
          record.row.policy_evaluated.disposition,
          record.row.policy_evaluated.dkim ?? null,
          record.row.policy_evaluated.spf ?? null,
          summarizeAuthResult(record.auth_results.dkim),
          summarizeAuthResult(record.auth_results.spf),
          record.identifiers.header_from,
          report.policy_published.domain,
          report.report_metadata.date_range.begin,
        )
        .run();
      newRecords++;
      newIps.add(record.row.source_ip);
    }
  }

  return { newReports: missing.length, newRecords, newIps };
}

async function syncTlsReports(
  container: { fetch(req: Request): Promise<Response> },
  env: SyncEnv,
  mailboxId: string,
): Promise<{ newTlsReports: number; newIps: Set<string> }> {
  const listRes = await callContainer(container, "/tls-reports", env);
  if (!listRes.ok) {
    console.error(`Failed to list TLS reports: ${listRes.status}`);
    return { newTlsReports: 0, newIps: new Set() };
  }
  const headers: TlsReportHeader[] = await listRes.json();

  const existing = await env.DB.prepare("SELECT org_name, report_id FROM tls_reports").all<{
    org_name: string;
    report_id: string;
  }>();
  const known = new Set(existing.results.map((r) => `${r.org_name}\u0000${r.report_id}`));
  const missing = headers.filter((h) => !known.has(`${h.org}\u0000${h.id}`));

  const newIps = new Set<string>();

  for (const header of missing) {
    const jsonRes = await callContainer(container, `/tls-reports/${header.hash}/json`, env);
    if (!jsonRes.ok) {
      console.error(`Failed to fetch TLS report ${header.hash}: ${jsonRes.status}`);
      continue;
    }
    const report: TlsReportJson = await jsonRes.json();
    const dateBegin = Math.floor(new Date(report.date_range.start_datetime).getTime() / 1000);
    const dateEnd = Math.floor(new Date(report.date_range.end_datetime).getTime() / 1000);

    const insertedTls = await env.DB.prepare(
      `INSERT OR IGNORE INTO tls_reports (hash, report_id, org_name, date_begin, date_end, inserted_at, mailbox_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(header.hash, report.report_id, report.organization_name, dateBegin, dateEnd, Math.floor(Date.now() / 1000), mailboxId)
      .run();
    if (!insertedTls.meta.changes) continue;

    for (const policyResult of report.policies) {
      const inserted = await env.DB.prepare(
        `INSERT INTO tls_policy_results
           (report_hash, policy_domain, policy_type, successful_count, failure_count, date_begin)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          header.hash,
          policyResult.policy.policy_domain,
          policyResult.policy.policy_type,
          policyResult.summary.total_successful_session_count,
          policyResult.summary.total_failure_session_count,
          dateBegin,
        )
        .run();
      const policyResultId = inserted.meta.last_row_id;

      for (const failure of policyResult.failure_details ?? []) {
        if (failure.sending_mta_ip) newIps.add(failure.sending_mta_ip);
        await env.DB.prepare(
          `INSERT INTO tls_failure_details
             (policy_result_id, result_type, sending_mta_ip, receiving_mx_hostname, failed_session_count)
           VALUES (?, ?, ?, ?, ?)`,
        )
          .bind(
            policyResultId,
            failure.result_type,
            failure.sending_mta_ip ?? null,
            failure.receiving_mx_hostname ?? null,
            failure.failed_session_count,
          )
          .run();
      }
    }
  }

  return { newTlsReports: missing.length, newIps };
}

/** ip-api.com (used by the container's /ips/{ip}/location endpoint) is
 * rate-limited to 45 requests/minute. We cap how many we resolve per
 * sync run well under that, and spread the rest across future runs -
 * matters once there are hundreds/thousands of distinct source IPs. */
const MAX_LOCATIONS_PER_SYNC = 30;

async function resolveLocations(
  container: { fetch(req: Request): Promise<Response> },
  env: SyncEnv,
  candidateIps: Set<string>,
): Promise<number> {
  // Also backfill any previously-enriched IPs that predate the
  // geolocation columns (lat IS NULL).
  const backfill = await env.DB.prepare("SELECT ip FROM ip_enrichment WHERE lat IS NULL").all<{ ip: string }>();
  const toResolve = [...new Set([...candidateIps, ...backfill.results.map((r) => r.ip)])].slice(
    0,
    MAX_LOCATIONS_PER_SYNC,
  );

  let resolved = 0;
  for (const ip of toResolve) {
    const res = await callContainer(container, `/ips/${encodeURIComponent(ip)}/location`, env);
    if (!res.ok) continue;
    const loc = await res.json<{
      lat: number;
      lon: number;
      city: string;
      country: string;
      countryCode: string;
    }>();
    await env.DB.prepare(
      `INSERT INTO ip_enrichment (ip, resolved_at, lat, lon, city, country, country_code)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, city = excluded.city,
         country = excluded.country, country_code = excluded.country_code`,
    )
      .bind(ip, Math.floor(Date.now() / 1000), loc.lat, loc.lon, loc.city, loc.country, loc.countryCode)
      .run();
    resolved++;
  }
  return resolved;
}

export async function syncReports(
  container: { fetch(req: Request): Promise<Response> },
  env: SyncEnv,
  mailboxId: string,
): Promise<SyncResult> {
  const dmarcResult = await syncDmarcReports(container, env, mailboxId);
  const tlsResult = await syncTlsReports(container, env, mailboxId);
  const allNewIps = new Set([...dmarcResult.newIps, ...tlsResult.newIps]);

  // Resolve PTR/ESP enrichment for any IPs we haven't cached yet.
  const cached = await env.DB.prepare("SELECT ip FROM ip_enrichment").all<{ ip: string }>();
  const cachedIps = new Set(cached.results.map((r) => r.ip));
  const toResolve = [...allNewIps].filter((ip) => !cachedIps.has(ip));

  let newIpsResolved = 0;
  const BATCH = 50;
  for (let i = 0; i < toResolve.length; i += BATCH) {
    const batch = toResolve.slice(i, i + BATCH);
    const dnsRes = await callContainer(container, "/ips/dns/batch", env, {
      method: "POST",
      body: JSON.stringify(batch),
    });
    if (!dnsRes.ok) {
      console.error(`PTR batch lookup failed: ${dnsRes.status}`);
      continue;
    }
    const hostnames: Array<string | null> = await dnsRes.json();
    for (let j = 0; j < batch.length; j++) {
      const ip = batch[j];
      const ptr = hostnames[j] ?? null;
      const esp = espNameFromPtr(ptr);
      await env.DB.prepare(
        `INSERT OR REPLACE INTO ip_enrichment (ip, ptr_hostname, esp_name, resolved_at) VALUES (?, ?, ?, ?)`,
      )
        .bind(ip, ptr, esp, Math.floor(Date.now() / 1000))
        .run();
      newIpsResolved++;
    }
  }

  const newLocationsResolved = await resolveLocations(container, env, allNewIps);

  return {
    newReports: dmarcResult.newReports,
    newRecords: dmarcResult.newRecords,
    newTlsReports: tlsResult.newTlsReports,
    newIpsResolved,
    newLocationsResolved,
  };
}
