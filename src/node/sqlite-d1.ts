// Cloudflare D1's API on top of a SQLite file, for the self-hosted build. D1 is
// SQLite, so the app's SQL runs unchanged; this only supplies the call shapes
// the app uses (prepare/bind/first/all/run/batch and their `meta`).
//
// node:sqlite is synchronous, so a long query holds up other requests while it
// runs. That is acceptable for an admin tool with one or a few users.

import { DatabaseSync, type StatementSync } from "node:sqlite";

type Param = string | number | bigint | null | Uint8Array;

interface RunMeta {
  changes: number;
  last_row_id: number;
}

export class Statement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly args: Param[];

  constructor(db: DatabaseSync, sql: string, args: Param[] = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args: unknown[]): Statement {
    return new Statement(this.db, this.sql, args as Param[]);
  }

  private prepared(): StatementSync {
    return this.db.prepare(this.sql);
  }

  // The synchronous versions let batch() run its statements without yielding.
  firstSync<T>(): T | null {
    return (this.prepared().get(...this.args) as T | undefined) ?? null;
  }

  allSync<T>(): { results: T[]; meta: Record<string, never> } {
    return { results: this.prepared().all(...this.args) as T[], meta: {} };
  }

  runSync(): { success: true; meta: RunMeta; results: never[] } {
    const r = this.prepared().run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, results: [] };
  }

  /** Does this statement produce rows? Decides how a batch returns it. */
  returnsRows(): boolean {
    return /^\s*(select|with|pragma|values)\b/i.test(this.sql);
  }

  async first<T = unknown>(): Promise<T | null> {
    return this.firstSync<T>();
  }

  async all<T = unknown>() {
    return this.allSync<T>();
  }

  async run() {
    return this.runSync();
  }
}

export class SqliteD1 {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    // WAL lets reads continue during a write; NORMAL is safe with WAL (a power cut can lose the
    // last moments, never corrupt the file); busy_timeout covers a backup tool holding the file.
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }

  prepare(sql: string): Statement {
    return new Statement(this.raw, sql);
  }

  /** All statements succeed together or none do, like D1's batch(). Runs without
   * yielding, so another request cannot slip a statement into the transaction. */
  async batch(stmts: Statement[]) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = stmts.map((s) => (s.returnsRows() ? { success: true, ...s.allSync() } : s.runSync()));
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // already rolled back by SQLite
      }
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
