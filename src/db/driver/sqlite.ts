/**
 * SQLite driver, backed by `bun:sqlite` — the default engine and the one the
 * application shipped with.
 *
 * `bun:sqlite` is synchronous, so every method here resolves immediately. The
 * methods are still async to satisfy `DbDriver`, which lets the rest of the
 * codebase use a single `await`-based code path regardless of engine.
 */
import { Database, type SQLQueryBindings as SqlBinding } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { DbDriver, SqlParams, SqlValue } from "./types";

export class SqliteDriver implements DbDriver {
  readonly dialect = "sqlite" as const;

  private database: Database;
  private closed = false;
  private transactionDepth = 0;
  /** Tail of the transaction mutex chain; see `transaction()`. */
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    if (filePath !== ":memory:") {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.database = new Database(filePath, { create: true });
    this.applyPragmas();
  }

  private applyPragmas(): void {
    // WAL lets readers proceed during writes, which matters because telemetry
    // inserts run on the hot proxy path while admin reads are in flight.
    this.database.run("PRAGMA journal_mode = WAL;");
    this.database.run("PRAGMA synchronous = NORMAL;");
    this.database.run("PRAGMA foreign_keys = ON;");
  }

  /** Reopens the database file, discarding the current connection. */
  reopen(): void {
    if (this.closed) {
      this.closed = false;
      this.database = new Database(this.filePath, { create: true });
      this.applyPragmas();
      return;
    }
    try {
      this.database.close();
    } catch {
      // Closing an already-closed handle is not an error worth surfacing.
    }
    this.database = new Database(this.filePath, { create: true });
    this.applyPragmas();
  }

  /** bun:sqlite only accepts these primitive binding types. */
  private bindings(params: SqlParams): SqlBinding[] {
    return params.map((value) => value as SqlBinding);
  }

  async execute(sql: string, params: SqlParams = []): Promise<void> {
    this.database.run(sql, this.bindings(params));
  }

  async query<T = Record<string, SqlValue>>(
    sql: string,
    params: SqlParams = []
  ): Promise<T[]> {
    return this.database.query(sql).all(...this.bindings(params)) as T[];
  }

  async queryOne<T = Record<string, SqlValue>>(
    sql: string,
    params: SqlParams = []
  ): Promise<T | null> {
    const row = this.database.query(sql).get(...this.bindings(params));
    return (row as T | null) ?? null;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // SQLite has no nested transactions: an inner call joins the outer one
    // rather than opening a second BEGIN, which SQLite would reject.
    if (this.transactionDepth > 0) return fn();

    // Transactions are serialized on a promise chain. Without this, two
    // concurrent callers would interleave BEGIN/COMMIT on the one shared
    // connection and the second COMMIT would fail with "no transaction active".
    const previous = this.transactionQueue;
    let release!: () => void;
    this.transactionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    this.transactionDepth++;
    try {
      this.database.run("BEGIN");
    } catch (error) {
      this.transactionDepth--;
      release();
      throw error;
    }

    try {
      const result = await fn();
      try {
        this.database.run("COMMIT");
      } catch (error) {
        // The work is done but the commit failed; the transaction is still
        // open, so it must be rolled back rather than leaked.
        try {
          this.database.run("ROLLBACK");
        } catch {
          // ignore
        }
        throw error;
      }
      return result;
    } catch (error) {
      try {
        this.database.run("ROLLBACK");
      } catch {
        // A rollback failure must not mask the original error.
      }
      this.rolledBack?.();
      throw error;
    } finally {
      this.transactionDepth--;
      release();
    }
  }

  /** Registered by `db/index.ts` so cache invalidation can hook into rollback. */
  rolledBack: (() => void) | null = null;

  async checkpoint(): Promise<void> {
    // Truncating the WAL keeps the main database file self-contained, which is
    // what the file-based backup path relies on.
    try {
      this.database.run("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // A checkpoint can fail if a reader is active; not fatal.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } catch {
      // ignore
    }
  }

  /** The `bun:sqlite` handle Drizzle's SQLite driver is built on. */
  get client(): Database {
    return this.database;
  }

  get path(): string {
    return this.filePath;
  }
}
