// Database schema, applied automatically on first request.
//
// This is the single source of truth for the D1 schema. There is no manual
// `wrangler d1 execute` step: the first request (or cron run) after a deploy
// creates anything that is missing, and records what has been applied in
// `schema_migrations`.
//
// To change the schema, APPEND a new migration. Never edit one that has
// already shipped - existing installs have recorded it as applied.

interface Migration {
  id: number;
  name: string;
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "initial schema",
    statements: [
      // One row per DMARC aggregate (RUA) report received.
      `CREATE TABLE IF NOT EXISTS dmarc_reports (
        hash TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        org_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        date_begin INTEGER NOT NULL,
        date_end INTEGER NOT NULL,
        policy_p TEXT,
        policy_pct INTEGER,
        inserted_at INTEGER NOT NULL
      )`,
      // One row per <record> in a report (per source IP per report).
      `CREATE TABLE IF NOT EXISTS dmarc_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_hash TEXT NOT NULL REFERENCES dmarc_reports(hash),
        source_ip TEXT NOT NULL,
        count INTEGER NOT NULL,
        disposition TEXT,
        policy_dkim TEXT,
        policy_spf TEXT,
        auth_dkim_result TEXT,
        auth_spf_result TEXT,
        header_from TEXT,
        domain TEXT NOT NULL,
        date_begin INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_records_date ON dmarc_records(date_begin)`,
      `CREATE INDEX IF NOT EXISTS idx_records_ip ON dmarc_records(source_ip)`,
      `CREATE INDEX IF NOT EXISTS idx_records_domain ON dmarc_records(domain)`,
      // Reverse-DNS, sender identification and geolocation cache (one row per IP).
      `CREATE TABLE IF NOT EXISTS ip_enrichment (
        ip TEXT PRIMARY KEY,
        ptr_hostname TEXT,
        esp_name TEXT,
        resolved_at INTEGER NOT NULL,
        lat REAL,
        lon REAL,
        city TEXT,
        country TEXT,
        country_code TEXT
      )`,
      // Reserved for alerting (not used yet).
      `CREATE TABLE IF NOT EXISTS alert_state (
        key TEXT PRIMARY KEY,
        last_alerted_at INTEGER NOT NULL
      )`,
      // Encrypted config overrides (IMAP credentials etc). Values are
      // base64(12-byte IV + AES-GCM ciphertext), keyed by CONFIG_ENCRYPTION_KEY.
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      // SMTP TLS (TLS-RPT) reports.
      `CREATE TABLE IF NOT EXISTS tls_reports (
        hash TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        org_name TEXT NOT NULL,
        date_begin INTEGER NOT NULL,
        date_end INTEGER NOT NULL,
        inserted_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tls_policy_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_hash TEXT NOT NULL REFERENCES tls_reports(hash),
        policy_domain TEXT NOT NULL,
        policy_type TEXT NOT NULL,
        successful_count INTEGER NOT NULL,
        failure_count INTEGER NOT NULL,
        date_begin INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tls_failure_details (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_result_id INTEGER NOT NULL REFERENCES tls_policy_results(id),
        result_type TEXT NOT NULL,
        sending_mta_ip TEXT,
        receiving_mx_hostname TEXT,
        failed_session_count INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tls_policy_domain ON tls_policy_results(policy_domain)`,
      `CREATE INDEX IF NOT EXISTS idx_tls_policy_date ON tls_policy_results(date_begin)`,
    ],
  },
  {
    id: 2,
    name: "plain-text app settings",
    statements: [
      // Non-secret application state: the public-dashboard switch, last sync
      // time, and so on. (Secrets live in `settings`, encrypted.)
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    id: 3,
    name: "deduplicate reports and enforce report identity",
    // The container's per-report hash changes across its restarts, so keying
    // on it let the same report be ingested again. A report's real identity is
    // reporter + report ID (+ domain). Keep the earliest copy of each.
    statements: [
      `DELETE FROM dmarc_records WHERE report_hash IN (
         SELECT hash FROM dmarc_reports
          WHERE rowid NOT IN (SELECT MIN(rowid) FROM dmarc_reports GROUP BY org_name, report_id, domain))`,
      `DELETE FROM dmarc_reports
        WHERE rowid NOT IN (SELECT MIN(rowid) FROM dmarc_reports GROUP BY org_name, report_id, domain)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_dmarc_reports_identity ON dmarc_reports(org_name, report_id, domain)`,
      `DELETE FROM tls_failure_details WHERE policy_result_id IN (
         SELECT id FROM tls_policy_results WHERE report_hash IN (
           SELECT hash FROM tls_reports
            WHERE rowid NOT IN (SELECT MIN(rowid) FROM tls_reports GROUP BY org_name, report_id)))`,
      `DELETE FROM tls_policy_results WHERE report_hash IN (
         SELECT hash FROM tls_reports
          WHERE rowid NOT IN (SELECT MIN(rowid) FROM tls_reports GROUP BY org_name, report_id))`,
      `DELETE FROM tls_reports
        WHERE rowid NOT IN (SELECT MIN(rowid) FROM tls_reports GROUP BY org_name, report_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_tls_reports_identity ON tls_reports(org_name, report_id)`,
    ],
  },
  {
    id: 4,
    name: "indexes for notifications",
    // Alerts look at what was ingested since the last run, and at a domain's
    // recent report history. Without these both would scan every report.
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_reports_inserted ON dmarc_reports(inserted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_reports_domain_date ON dmarc_reports(domain, date_begin)`,
      `CREATE INDEX IF NOT EXISTS idx_records_report ON dmarc_records(report_hash)`,
    ],
  },
  {
    id: 5,
    name: "login attempt throttling",
    statements: [
      // One row per client address (IPv6 grouped by /64) that has failed to log in.
      `CREATE TABLE IF NOT EXISTS auth_attempts (
        client TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        window_start INTEGER NOT NULL,
        locked_until INTEGER NOT NULL
      )`,
    ],
  },
  {
    id: 6,
    name: "record which mailbox each report came from",
    statements: [
      // NULL on reports synced before mailboxes could be listed: they came from the original single mailbox.
      `ALTER TABLE dmarc_reports ADD COLUMN mailbox_id TEXT`,
      `ALTER TABLE tls_reports ADD COLUMN mailbox_id TEXT`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id;

// Memoised per isolate: after the first request this is a resolved promise,
// so the check costs nothing. A failure clears it so the next request retries.
let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  ready ??= applyMigrations(db).catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

async function applyMigrations(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`,
    )
    .run();

  const applied = await db.prepare("SELECT id FROM schema_migrations").all<{ id: number }>();
  const done = new Set(applied.results.map((r) => r.id));

  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue;
    // batch() runs as a single transaction: a migration lands fully or not at all.
    await db.batch([
      ...migration.statements.map((sql) => db.prepare(sql)),
      db
        .prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)")
        .bind(migration.id, migration.name, Math.floor(Date.now() / 1000)),
    ]);
  }
}

export async function getSchemaVersion(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT MAX(id) AS v FROM schema_migrations").first<{ v: number | null }>();
  return row?.v ?? 0;
}
