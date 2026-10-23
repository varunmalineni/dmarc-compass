// Data exports: every table in the dashboard, as CSV or JSON, using the same
// filters (domains, time range, search) the page was showing.

import { csvRow, CSV_BOM, isoDate, slug } from "./csv";
import { domainFilter, likePattern, rangeLabel, sinceEpoch, type Filters, type ListState } from "./filters";
import { loadDomains } from "./domains-data";

/** A hard ceiling so one request cannot exhaust the Worker's memory. */
export const EXPORT_MAX_ROWS = 100_000;

export const DATASETS = ["domains", "sources", "reports", "records", "tls", "tls-failures"] as const;
export type Dataset = (typeof DATASETS)[number];

export const DATASET_LABELS: Record<Dataset, string> = {
  domains: "Domains",
  sources: "Sending sources",
  reports: "DMARC reports",
  records: "Report records (one row per source per report)",
  tls: "TLS results",
  "tls-failures": "TLS failures",
};

export interface ExportOptions {
  filters: Filters;
  q: string;
  /** Reports only: restrict to reports with DKIM / SPF problems. */
  problem: "all" | "dkim" | "spf" | "any";
  /** Mailbox id to display name, to label where each report came from. */
  mailboxNames?: Record<string, string>;
}

export interface ExportResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

const PASS = (a: string) => `(${a}.policy_dkim = 'pass' OR ${a}.policy_spf = 'pass')`;
const BAD = (col: string) => `CASE WHEN ${col} IS NOT NULL AND ${col} != 'pass' THEN 1 ELSE 0 END`;
const pct = (passed: number, total: number) => (total > 0 ? Math.round((passed / total) * 10000) / 100 : null);

function cap<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return rows.length > EXPORT_MAX_ROWS ? { rows: rows.slice(0, EXPORT_MAX_ROWS), truncated: true } : { rows, truncated: false };
}

export async function buildExport(db: D1Database, dataset: Dataset, o: ExportOptions): Promise<ExportResult> {
  const f = o.filters;
  const since = sinceEpoch(f.range);

  if (dataset === "domains") {
    const list: ListState = { q: o.q, sort: "risk", dir: "desc", page: 1 };
    const data = await loadDomains(db, f, list, { all: true });
    const c = cap(data.rows);
    return {
      columns: ["domain", "policy", "status", "messages", "passed", "failing", "pass_rate_pct", "sources", "last_report_utc"],
      rows: c.rows.map((r) => [r.domain, r.policy, r.status, r.total, r.passed, r.failing, r.total ? Math.round(r.rate * 100) / 100 : null, r.sources, isoDate(r.lastReportAt)]),
      truncated: c.truncated,
    };
  }

  if (dataset === "sources") {
    const dc = domainFilter("r.domain", f);
    const q = o.q ? likePattern(o.q) : null;
    const search = q ? " AND (r.source_ip LIKE ? ESCAPE '\\' OR e.esp_name LIKE ? ESCAPE '\\' OR e.ptr_hostname LIKE ? ESCAPE '\\')" : "";
    const res = await db
      .prepare(
        `SELECT r.source_ip AS ip, COALESCE(MAX(e.esp_name), 'Unknown') AS esp, MAX(e.ptr_hostname) AS ptr,
                COUNT(DISTINCT r.domain) AS domains, SUM(r.count) AS total,
                SUM(CASE WHEN ${PASS("r")} THEN r.count ELSE 0 END) AS passed, MAX(r.date_begin) AS last_seen,
                MAX(${BAD("r.policy_dkim")}) AS i_dkim_policy, MAX(${BAD("r.policy_spf")}) AS i_spf_policy,
                MAX(${BAD("r.auth_dkim_result")}) AS i_dkim_auth, MAX(${BAD("r.auth_spf_result")}) AS i_spf_auth
           FROM dmarc_records r LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
          WHERE r.date_begin >= ?${dc.sql}${search}
          GROUP BY r.source_ip
          ORDER BY (SUM(r.count) - SUM(CASE WHEN ${PASS("r")} THEN r.count ELSE 0 END)) DESC, SUM(r.count) DESC, r.source_ip
          LIMIT ${EXPORT_MAX_ROWS + 1}`,
      )
      .bind(since, ...dc.params, ...(q ? [q, q, q] : []))
      .all<{ ip: string; esp: string; ptr: string | null; domains: number; total: number; passed: number; last_seen: number; i_dkim_policy: number; i_spf_policy: number; i_dkim_auth: number; i_spf_auth: number }>();
    const c = cap(res.results);
    return {
      columns: ["source_ip", "sender", "reverse_dns", "domains", "messages", "passed", "failing", "pass_rate_pct", "issues", "last_seen_utc"],
      rows: c.rows.map((r) => [
        r.ip, r.esp, r.ptr, r.domains, r.total, r.passed, r.total - r.passed, pct(r.passed, r.total),
        [r.i_dkim_policy && "DKIM policy", r.i_spf_policy && "SPF policy", r.i_dkim_auth && "DKIM auth", r.i_spf_auth && "SPF auth"].filter(Boolean).join("; "),
        isoDate(r.last_seen),
      ]),
      truncated: c.truncated,
    };
  }

  if (dataset === "reports") {
    const dc = domainFilter("rep.domain", f);
    const q = o.q ? likePattern(o.q) : null;
    const search = q ? " AND (rep.report_id LIKE ? ESCAPE '\\' OR rep.org_name LIKE ? ESCAPE '\\')" : "";
    const having =
      o.problem === "dkim" ? " HAVING flagged_dkim = 1" : o.problem === "spf" ? " HAVING flagged_spf = 1" : o.problem === "any" ? " HAVING (flagged_dkim = 1 OR flagged_spf = 1)" : "";
    const res = await db
      .prepare(
        `SELECT rep.report_id, rep.org_name, rep.domain, rep.date_begin, rep.date_end, rep.policy_p, rep.policy_pct, rep.mailbox_id,
                COUNT(rec.id) AS records, COALESCE(SUM(rec.count), 0) AS messages,
                COALESCE(SUM(CASE WHEN ${PASS("rec")} THEN 0 ELSE rec.count END), 0) AS failing,
                MAX(${BAD("rec.policy_dkim")}) AS flagged_dkim, MAX(${BAD("rec.policy_spf")}) AS flagged_spf
           FROM dmarc_reports rep LEFT JOIN dmarc_records rec ON rec.report_hash = rep.hash
          WHERE rep.date_end >= ?${dc.sql}${search}
          GROUP BY rep.hash${having}
          ORDER BY rep.date_end DESC, rep.hash
          LIMIT ${EXPORT_MAX_ROWS + 1}`,
      )
      .bind(since, ...dc.params, ...(q ? [q, q] : []))
      .all<{ report_id: string; org_name: string; domain: string; date_begin: number; date_end: number; policy_p: string | null; policy_pct: number | null; mailbox_id: string | null; records: number; messages: number; failing: number; flagged_dkim: number; flagged_spf: number }>();
    const c = cap(res.results);
    return {
      columns: ["report_id", "reporter", "domain", "period_start_utc", "period_end_utc", "policy", "pct", "mailbox", "records", "messages", "failing_messages", "dkim_problem", "spf_problem"],
      rows: c.rows.map((r) => [r.report_id, r.org_name, r.domain, isoDate(r.date_begin), isoDate(r.date_end), r.policy_p, r.policy_pct, o.mailboxNames?.[r.mailbox_id ?? "default"] ?? "", r.records, r.messages, r.failing, !!r.flagged_dkim, !!r.flagged_spf]),
      truncated: c.truncated,
    };
  }

  if (dataset === "records") {
    const dc = domainFilter("r.domain", f);
    const res = await db
      .prepare(
        `SELECT rep.report_id, rep.org_name, r.domain, r.date_begin, r.source_ip, e.esp_name, e.ptr_hostname, r.count,
                r.disposition, r.policy_dkim, r.policy_spf, r.auth_dkim_result, r.auth_spf_result, r.header_from,
                CASE WHEN ${PASS("r")} THEN 1 ELSE 0 END AS passes
           FROM dmarc_records r
           JOIN dmarc_reports rep ON rep.hash = r.report_hash
           LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
          WHERE r.date_begin >= ?${dc.sql}
          ORDER BY r.date_begin DESC, r.id
          LIMIT ${EXPORT_MAX_ROWS + 1}`,
      )
      .bind(since, ...dc.params)
      .all<{ report_id: string; org_name: string; domain: string; date_begin: number; source_ip: string; esp_name: string | null; ptr_hostname: string | null; count: number; disposition: string | null; policy_dkim: string | null; policy_spf: string | null; auth_dkim_result: string | null; auth_spf_result: string | null; header_from: string | null; passes: number }>();
    const c = cap(res.results);
    return {
      columns: ["report_id", "reporter", "domain", "period_start_utc", "source_ip", "sender", "reverse_dns", "messages", "disposition", "policy_dkim", "policy_spf", "auth_dkim", "auth_spf", "header_from", "passes_dmarc"],
      rows: c.rows.map((r) => [r.report_id, r.org_name, r.domain, isoDate(r.date_begin), r.source_ip, r.esp_name, r.ptr_hostname, r.count, r.disposition, r.policy_dkim, r.policy_spf, r.auth_dkim_result, r.auth_spf_result, r.header_from, !!r.passes]),
      truncated: c.truncated,
    };
  }

  if (dataset === "tls") {
    const dc = domainFilter("p.policy_domain", f);
    const res = await db
      .prepare(
        `SELECT p.policy_domain, p.policy_type, p.date_begin, p.successful_count, p.failure_count, t.org_name
           FROM tls_policy_results p JOIN tls_reports t ON t.hash = p.report_hash
          WHERE p.date_begin >= ?${dc.sql}
          ORDER BY p.date_begin DESC, p.id
          LIMIT ${EXPORT_MAX_ROWS + 1}`,
      )
      .bind(since, ...dc.params)
      .all<{ policy_domain: string; policy_type: string; date_begin: number; successful_count: number; failure_count: number; org_name: string }>();
    const c = cap(res.results);
    return {
      columns: ["domain", "policy_type", "period_start_utc", "successful_sessions", "failed_sessions", "reporter"],
      rows: c.rows.map((r) => [r.policy_domain, r.policy_type, isoDate(r.date_begin), r.successful_count, r.failure_count, r.org_name]),
      truncated: c.truncated,
    };
  }

  // tls-failures
  const dc = domainFilter("p.policy_domain", f);
  const res = await db
    .prepare(
      `SELECT p.policy_domain, p.date_begin, d.result_type, d.sending_mta_ip, d.receiving_mx_hostname, d.failed_session_count
         FROM tls_failure_details d JOIN tls_policy_results p ON p.id = d.policy_result_id
        WHERE p.date_begin >= ?${dc.sql}
        ORDER BY p.date_begin DESC, d.id
        LIMIT ${EXPORT_MAX_ROWS + 1}`,
    )
    .bind(since, ...dc.params)
    .all<{ policy_domain: string; date_begin: number; result_type: string; sending_mta_ip: string | null; receiving_mx_hostname: string | null; failed_session_count: number }>();
  const c = cap(res.results);
  return {
    columns: ["domain", "period_start_utc", "failure_type", "sending_mta_ip", "receiving_mx", "failed_sessions"],
    rows: c.rows.map((r) => [r.policy_domain, isoDate(r.date_begin), r.result_type, r.sending_mta_ip, r.receiving_mx_hostname, r.failed_session_count]),
    truncated: c.truncated,
  };
}

export function exportFilename(dataset: Dataset, f: Filters, ext: "csv" | "json", now = new Date()): string {
  const scope = f.domains.length === 0 ? "all-domains" : f.domains.length === 1 ? slug(f.domains[0]) : `${f.domains.length}-domains`;
  const range = f.range === null ? "all-time" : `last-${f.range}d`;
  return `dmarc-compass_${dataset}_${scope}_${range}_${now.toISOString().slice(0, 10)}.${ext}`;
}

/** Streams rows as CSV without building one giant string. */
export function csvStream(columns: string[], rows: unknown[][]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  const BATCH = 2000;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(CSV_BOM + csvRow(columns)));
    },
    pull(controller) {
      if (i >= rows.length) return controller.close();
      let chunk = "";
      for (const end = Math.min(i + BATCH, rows.length); i < end; i++) chunk += csvRow(rows[i]);
      controller.enqueue(enc.encode(chunk));
    },
  });
}

export function describeScope(f: Filters): string {
  const d = f.domains.length === 0 ? "all domains" : f.domains.length === 1 ? f.domains[0] : `${f.domains.length} domains`;
  return `${d}, ${rangeLabel(f.range).toLowerCase()}`;
}
