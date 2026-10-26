// A just-enough Cloudflare D1 look-alike on Node's built-in SQLite, so code
// that talks to D1 can be tested for real (same SQL dialect) without a Worker.
import { DatabaseSync } from "node:sqlite";

class Stmt {
  db: DatabaseSync;
  sql: string;
  args: unknown[];
  constructor(db: DatabaseSync, sql: string, args: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args); }
  async first<T = unknown>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...(this.args as never[])) as T) ?? null; }
  async all<T = unknown>() { return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[], meta: {} }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

function wrap(raw: DatabaseSync) {
  const db = {
    prepare: (sql: string) => new Stmt(raw, sql),
    async batch(stmts: Stmt[]) {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    raw,
  };
  return db as unknown as D1Database & { raw: DatabaseSync };
}

/** An empty database: the real schema comes from ensureSchema(). */
export function makeBareDb() {
  return wrap(new DatabaseSync(":memory:"));
}

export function makeDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE dmarc_reports (hash TEXT PRIMARY KEY, mailbox_id TEXT);
  `);
  return wrap(raw);
}

export const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
