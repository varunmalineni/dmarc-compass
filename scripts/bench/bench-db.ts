// A D1 stand-in on Node's SQLite, backed by a file, that logs every statement
// with its timing. The app's real query code runs against it, so what is
// measured is the product, not a copy of it. Local SQLite is not D1: use the
// plans and query counts here as the reliable signal, and the milliseconds as
// a rough guide.

import { DatabaseSync } from "node:sqlite";

export interface Logged {
  sql: string;
  args: unknown[];
  ms: number;
  rows: number;
}

export class BenchDb {
  raw: DatabaseSync;
  log: Logged[] = [];
  recording = false;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA cache_size = -200000;");
  }

  prepare(sql: string) {
    return new BenchStmt(this, sql, []);
  }

  async batch(stmts: BenchStmt[]) {
    this.raw.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  start() {
    this.log = [];
    this.recording = true;
  }

  stop(): Logged[] {
    this.recording = false;
    return this.log;
  }

  /** The query plan lines for a statement, for spotting full-table scans. */
  plan(sql: string, args: unknown[]): string[] {
    try {
      const rows = this.raw.prepare("EXPLAIN QUERY PLAN " + sql).all(...(args as never[])) as Array<{ detail: string }>;
      return rows.map((r) => r.detail);
    } catch {
      return [];
    }
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

class BenchStmt {
  constructor(private db: BenchDb, private sql: string, private args: unknown[]) {}
  bind(...args: unknown[]) {
    return new BenchStmt(this.db, this.sql, args);
  }
  private time<T>(fn: () => T, rows: (r: T) => number): T {
    const t0 = performance.now();
    const r = fn();
    if (this.db.recording) this.db.log.push({ sql: this.sql, args: this.args, ms: performance.now() - t0, rows: rows(r) });
    return r;
  }
  async first<T = unknown>(): Promise<T | null> {
    return this.time(
      () => (this.db.raw.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null,
      (r) => (r ? 1 : 0),
    );
  }
  async all<T = unknown>() {
    const results = this.time(
      () => this.db.raw.prepare(this.sql).all(...(this.args as never[])) as T[],
      (r) => r.length,
    );
    return { results, meta: {} };
  }
  async run() {
    const r = this.time(
      () => this.db.raw.prepare(this.sql).run(...(this.args as never[])),
      () => 0,
    );
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}
