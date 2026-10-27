import type { DmarcReportJson, ReportHeader } from "./dmarc-types";
import type { TlsReportHeader, TlsReportJson } from "./tls-types";
import { espNameFromPtr } from "./esp.ts";
import type { AdminEnv } from "./config.ts";
import { internalCredentials } from "./credentials.ts";
import { getAppSetting, setAppSetting } from "./app-settings.ts";
import { streamObjects } from "./json-stream.ts";

export interface SyncEnv extends AdminEnv {
  DB: D1Database;
  CONFIG_ENCRYPTION_KEY?: string;
}

/** Makes an authenticated internal request against the dmarc-report-viewer container. */
export async function callContainer(
  container: { fetch(req: Request): Promise<Response> },
  path: string,
  env: SyncEnv,
  init?: RequestInit,
): Promise<Response> {
  const creds = await internalCredentials(env);
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
  /** True when more remains to copy (a large first import, or older history still being checked): sync again soon. */
  backlog: boolean;
}

/** How far back the report list is checked on every sync (by the report's end date). */
export const RECENT_DAYS = 30;
/** Older history is walked backwards over several syncs, keeping at most this many list entries in memory. */
export const KEEP_ENTRIES = 75_000;
/** New reports copied per sync. The rest wait for the next one, so a first import of years of
 * mail takes several syncs instead of exceeding the Worker's time and database-call limits. */
export const MAX_NEW_REPORTS = 600;
/** After the history has been walked once, it is walked again this often, to pick up late arrivals. */
export const RECHECK_DAYS = 30;
/** Reports fetched at once, and reports written per database call. */
const FETCH_AT_ONCE = 5;
const WRITE_REPORTS = 25;
const WRITE_RECORDS = 2000;
const DAY = 86400;

/** One line of the container's list, reduced to what is needed: its identity, its hash (to fetch it) and its end date. */
interface Entry {
  key: string;
  hash: string;
  end: number;
}

interface BackfillState {
  /** Reports ending before this have not been checked yet; 0 means all history has been. */
  cursor: number;
  /** When the whole history was last finished. */
  doneAt: number | null;
}

const identity = (org: string, id: string, domain: string) => `${org}\u0000${id}\u0000${domain.toLowerCase()}`;

async function loadBackfill(db: D1Database, mailboxId: string, now: number): Promise<BackfillState> {
  const fresh = { cursor: now - RECENT_DAYS * DAY, doneAt: null };
  try {
    const v = JSON.parse((await getAppSetting(db, `backfill:${mailboxId}`)) ?? "null");
    if (v && typeof v.cursor === "number") {
      const st: BackfillState = { cursor: v.cursor, doneAt: typeof v.doneAt === "number" ? v.doneAt : null };
      // Finished long ago: walk the history again from the top.
      if (st.cursor === 0 && st.doneAt !== null && now - st.doneAt > RECHECK_DAYS * DAY) return fresh;
      return st;
    }
  } catch {
    // start over
  }
  return fresh;
}

/** Reads the container's report list as a stream, keeping only what is needed:
 * everything from the last RECENT_DAYS, plus older entries up to a memory cap
 * (the newest ones below `cursor`). Never holds the whole list. */
export async function readReportList(
  body: ReadableStream<Uint8Array>,
  now: number,
  cursor: number,
  keep = KEEP_ENTRIES,
): Promise<{ recent: Entry[]; older: Entry[]; oldestKept: number | null; droppedBelow: number | null; total: number }> {
  const recentFrom = now - RECENT_DAYS * DAY;
  const recent: Entry[] = [];
  const buckets = new Map<number, Entry[]>(); // older entries by day
  let kept = 0;
  let droppedBelow: number | null = null;
  let total = 0;

  for await (const h of streamObjects<ReportHeader>(body)) {
    total++;
    const e: Entry = { key: identity(h.org, h.id, h.domain), hash: h.hash, end: h.date_end };
    if (e.end >= recentFrom) {
      recent.push(e);
      continue;
    }
    if (e.end >= cursor) continue; // checked already
    if (droppedBelow !== null && e.end < droppedBelow) continue;
    const day = Math.floor(e.end / DAY);
    const list = buckets.get(day);
    if (list) list.push(e);
    else buckets.set(day, [e]);
    kept++;
    while (kept > keep && buckets.size > 1) {
      // Over the cap: forget the oldest day. It will be reached on a later sync.
      let oldest = Infinity;
      for (const d of buckets.keys()) if (d < oldest) oldest = d;
      kept -= buckets.get(oldest)!.length;
      buckets.delete(oldest);
      droppedBelow = Math.max(droppedBelow ?? 0, (oldest + 1) * DAY);
    }
  }

  const older = [...buckets.values()].flat();
  let oldestKept: number | null = null;
  for (const e of older) if (oldestKept === null || e.end < oldestKept) oldestKept = e.end;
  return { recent, older, oldestKept, droppedBelow, total };
}

/** Identities already stored for reports ending in [from, to). */
async function storedIdentities(db: D1Database, from: number, to: number): Promise<Set<string>> {
  const out = new Set<string>();
  const PAGE = 20_000;
  let after = from;
  let afterId = -1;
  for (;;) {
    const res = await db
      .prepare(
        `SELECT rowid AS rid, org_name, report_id, domain, date_end FROM dmarc_reports
          WHERE date_end >= ? AND date_end < ? AND (date_end > ? OR (date_end = ? AND rowid > ?))
          ORDER BY date_end, rowid LIMIT ${PAGE}`,
      )
      .bind(from, to, after, after, afterId)
      .all<{ rid: number; org_name: string; report_id: string; domain: string; date_end: number }>();
    for (const r of res.results) out.add(identity(r.org_name, r.report_id, r.domain));
    if (res.results.length < PAGE) return out;
    const last = res.results[res.results.length - 1];
    after = last.date_end;
    afterId = last.rid;
  }
}

function summarizeAuthResult(results: Array<{ result: string }> | null | undefined): string | null {
  if (!results || results.length === 0) return null;
  if (results.some((r) => r.result === "pass")) return "pass";
  return results[0].result;
}

const INSERT_REPORTS = `INSERT OR IGNORE INTO dmarc_reports
    (hash, report_id, org_name, domain, date_begin, date_end, policy_p, policy_pct, inserted_at, mailbox_id)
  SELECT json_extract(value, '$.hash'), json_extract(value, '$.id'), json_extract(value, '$.org'), json_extract(value, '$.domain'),
         json_extract(value, '$.begin'), json_extract(value, '$.end'), json_extract(value, '$.p'), json_extract(value, '$.pct'), ?, ?
    FROM json_each(?)`;

// A record is written only for a report that was stored in this same batch and has none yet, so a
// report ignored as a copy of one we already hold (same identity, different hash) adds nothing.
const INSERT_RECORDS = `INSERT INTO dmarc_records
    (report_hash, source_ip, count, disposition, policy_dkim, policy_spf, auth_dkim_result, auth_spf_result, header_from, domain, date_begin)
  SELECT json_extract(j.value, '$.h'), json_extract(j.value, '$.ip'), json_extract(j.value, '$.n'), json_extract(j.value, '$.disp'),
         json_extract(j.value, '$.dkim'), json_extract(j.value, '$.spf'), json_extract(j.value, '$.adkim'), json_extract(j.value, '$.aspf'),
         json_extract(j.value, '$.from'), json_extract(j.value, '$.domain'), json_extract(j.value, '$.begin')
    FROM json_each(?) j
   WHERE EXISTS (SELECT 1 FROM dmarc_reports r WHERE r.hash = json_extract(j.value, '$.h'))
     AND NOT EXISTS (SELECT 1 FROM dmarc_records x WHERE x.report_hash = json_extract(j.value, '$.h'))`;

export interface Pending {
  reports: unknown[];
  records: unknown[];
}

export async function writePending(env: SyncEnv, mailboxId: string, p: Pending): Promise<{ reports: number; records: number }> {
  if (p.reports.length === 0) return { reports: 0, records: 0 };
  const [r, rec] = await env.DB.batch([
    env.DB.prepare(INSERT_REPORTS).bind(Math.floor(Date.now() / 1000), mailboxId, JSON.stringify(p.reports)),
    env.DB.prepare(INSERT_RECORDS).bind(JSON.stringify(p.records)),
  ]);
  return { reports: r.meta.changes ?? 0, records: rec.meta.changes ?? 0 };
}

async function syncDmarcReports(
  container: { fetch(req: Request): Promise<Response> },
  env: SyncEnv,
  mailboxId: string,
  keep: number,
): Promise<{ newReports: number; newRecords: number; newIps: Set<string>; backlog: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const listRes = await callContainer(container, "/dmarc-reports", env);
  if (!listRes.ok || !listRes.body) {
    throw new Error(`Failed to list reports: ${listRes.status} ${await listRes.text()}`);
  }

  const state = await loadBackfill(env.DB, mailboxId, now);
  const list = await readReportList(listRes.body, now, state.cursor, keep);

  // "Already have it" is decided by the report's identity (reporter, report ID,
  // domain), never by the container's hash: that hash is not stable across
  // container restarts, which previously caused every report to be re-ingested.
  const recentFrom = now - RECENT_DAYS * DAY;
  const known = await storedIdentities(env.DB, recentFrom, Number.MAX_SAFE_INTEGER);
  if (list.oldestKept !== null) for (const k of await storedIdentities(env.DB, list.oldestKept, Math.min(state.cursor, recentFrom))) known.add(k);

  // Newest first, so a long backlog fills in the recent weeks before the old ones.
  const seen = new Set<string>();
  const missing = [...list.recent, ...list.older]
    .sort((a, b) => b.end - a.end)
    .filter((e) => {
      if (known.has(e.key) || seen.has(e.key)) return false;
      seen.add(e.key);
      return true;
    });
  const batch = missing.slice(0, MAX_NEW_REPORTS);

  let newReports = 0;
  let newRecords = 0;
  const newIps = new Set<string>();
  let pending: Pending = { reports: [], records: [] };
  const flush = async () => {
    const w = await writePending(env, mailboxId, pending);
    newReports += w.reports;
    newRecords += w.records;
    pending = { reports: [], records: [] };
  };

  for (let i = 0; i < batch.length; i += FETCH_AT_ONCE) {
    const fetched = await Promise.all(
      batch.slice(i, i + FETCH_AT_ONCE).map(async (header) => {
        const res = await callContainer(container, `/dmarc-reports/${encodeURIComponent(header.hash)}/json`, env);
        if (!res.ok) {
          console.error(`Failed to fetch report ${header.hash}: ${res.status}`);
          return null;
        }
        return { header, report: (await res.json()) as DmarcReportJson };
      }),
    );
    for (const f of fetched) {
      if (!f) continue;
      const { header, report } = f;
      const domain = report.policy_published.domain;
      const begin = report.report_metadata.date_range.begin;
      pending.reports.push({
        hash: header.hash,
        id: report.report_metadata.report_id,
        org: report.report_metadata.org_name,
        domain,
        begin,
        end: report.report_metadata.date_range.end,
        p: report.policy_published.p,
        pct: report.policy_published.pct ?? null,
      });
      for (const record of report.record) {
        pending.records.push({
          h: header.hash,
          ip: record.row.source_ip,
          n: record.row.count,
          disp: record.row.policy_evaluated.disposition,
          dkim: record.row.policy_evaluated.dkim ?? null,
          spf: record.row.policy_evaluated.spf ?? null,
          adkim: summarizeAuthResult(record.auth_results.dkim),
          aspf: summarizeAuthResult(record.auth_results.spf),
          from: record.identifiers.header_from,
          domain,
          begin,
        });
        newIps.add(record.row.source_ip);
      }
      if (pending.reports.length >= WRITE_REPORTS || pending.records.length >= WRITE_RECORDS) await flush();
    }
  }
  await flush();

  // Move the history walk on only when everything it covered is stored.
  const leftover = missing.length > batch.length;
  let walking = state.cursor > 0;
  if (!leftover && state.cursor > 0) {
    const next = list.droppedBelow;
    if (next === null) await saveBackfill(env.DB, mailboxId, { cursor: 0, doneAt: now });
    else await saveBackfill(env.DB, mailboxId, { cursor: next, doneAt: null });
    walking = next !== null;
  }
  return { newReports, newRecords, newIps, backlog: leftover || walking };
}

async function saveBackfill(db: D1Database, mailboxId: string, st: BackfillState): Promise<void> {
  await setAppSetting(db, `backfill:${mailboxId}`, JSON.stringify(st));
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

const RETRY_LOCATION_AFTER = 7 * 86400;

async function resolveLocations(
  container: { fetch(req: Request): Promise<Response> },
  env: SyncEnv,
  candidateIps: Set<string>,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  // Also backfill previously-enriched IPs that have no location yet. An address that
  // could not be located is retried only after a week, so a few permanent failures
  // (private ranges, say) cannot use up every run's allowance.
  const room = Math.max(0, MAX_LOCATIONS_PER_SYNC - candidateIps.size);
  const backfill = room
    ? await env.DB.prepare(
        `SELECT ip FROM ip_enrichment WHERE lat IS NULL AND (loc_tried_at IS NULL OR loc_tried_at < ?)
          ORDER BY loc_tried_at IS NOT NULL, loc_tried_at LIMIT ?`,
      )
        .bind(now - RETRY_LOCATION_AFTER, room)
        .all<{ ip: string }>()
    : { results: [] as Array<{ ip: string }> };
  const toResolve = [...new Set([...candidateIps, ...backfill.results.map((r) => r.ip)])].slice(0, MAX_LOCATIONS_PER_SYNC);

  let resolved = 0;
  for (const ip of toResolve) {
    const res = await callContainer(container, `/ips/${encodeURIComponent(ip)}/location`, env);
    if (!res.ok) {
      await env.DB.prepare("UPDATE ip_enrichment SET loc_tried_at = ? WHERE ip = ?").bind(now, ip).run();
      continue;
    }
    const loc = await res.json<{
      lat: number;
      lon: number;
      city: string;
      country: string;
      countryCode: string;
    }>();
    await env.DB.prepare(
      `INSERT INTO ip_enrichment (ip, resolved_at, lat, lon, city, country, country_code, loc_tried_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, city = excluded.city,
         country = excluded.country, country_code = excluded.country_code, loc_tried_at = excluded.loc_tried_at`,
    )
      .bind(ip, now, loc.lat, loc.lon, loc.city, loc.country, loc.countryCode, now)
      .run();
    resolved++;
  }
  return resolved;
}

/** The addresses among `ips` that have no enrichment row yet. */
async function uncached(db: D1Database, ips: string[]): Promise<Set<string>> {
  const missing = new Set<string>();
  const CHUNK = 5000;
  for (let i = 0; i < ips.length; i += CHUNK) {
    const part = ips.slice(i, i + CHUNK);
    const res = await db
      .prepare("SELECT value AS ip FROM json_each(?) WHERE value NOT IN (SELECT ip FROM ip_enrichment)")
      .bind(JSON.stringify(part))
      .all<{ ip: string }>();
    for (const r of res.results) missing.add(r.ip);
  }
  return missing;
}

export async function syncReports(
  container: { fetch(req: Request): Promise<Response> },
  env: SyncEnv,
  mailboxId: string,
  opts: { keepEntries?: number } = {},
): Promise<SyncResult> {
  const dmarcResult = await syncDmarcReports(container, env, mailboxId, opts.keepEntries ?? KEEP_ENTRIES);
  const tlsResult = await syncTlsReports(container, env, mailboxId);
  const allNewIps = new Set([...dmarcResult.newIps, ...tlsResult.newIps]);

  // Resolve PTR/ESP enrichment for any IPs we haven't cached yet. One lookup call and one
  // database call per 50 addresses, however many a large import brings.
  const toResolve = [...(await uncached(env.DB, [...allNewIps]))];

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
    const rows = batch.map((ip, j) => ({ ip, ptr: hostnames[j] ?? null, esp: espNameFromPtr(hostnames[j] ?? null) }));
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ip_enrichment (ip, ptr_hostname, esp_name, resolved_at)
       SELECT json_extract(value, '$.ip'), json_extract(value, '$.ptr'), json_extract(value, '$.esp'), ? FROM json_each(?)`,
    )
      .bind(Math.floor(Date.now() / 1000), JSON.stringify(rows))
      .run();
    newIpsResolved += rows.length;
  }

  const newLocationsResolved = await resolveLocations(container, env, allNewIps);

  return {
    newReports: dmarcResult.newReports,
    newRecords: dmarcResult.newRecords,
    newTlsReports: tlsResult.newTlsReports,
    newIpsResolved,
    newLocationsResolved,
    backlog: dmarcResult.backlog,
  };
}
