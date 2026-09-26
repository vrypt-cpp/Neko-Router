/**
 * Minimal raw-SQL execution surface shared by all dialects.
 *
 * The application needs a small amount of SQL that the Drizzle query builder
 * does not express well (upserts, cache sweeps, DDL). Rather than leak
 * `bun:sqlite` / `pg` / `mysql2` objects across the codebase, every driver
 * implements this interface and callers use it instead.
 *
 * All methods are async by design. The SQLite driver executes synchronously
 * under the hood, but exposing a promise-returning API keeps one code path for
 * all three engines and lets the networked drivers be swapped in without
 * touching callers.
 */

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
export type SqlParams = readonly SqlValue[];

type Dialect = "sqlite" | "postgresql" | "mysql";

/**
 * Quotes an identifier for the given dialect.
 *
 * The three engines disagree here: SQLite and Postgres accept `"name"`, but
 * MySQL's default `sql_mode` reads a double-quoted token as a *string literal*
 * rather than an identifier, so it needs backticks. This is not academic — the
 * `settings` table's primary key column is called `key`, which MySQL reserves.
 */
export function quoteIdent(dialect: Dialect, name: string): string {
  const escaped = name.replace(/"/g, '""').replace(/`/g, "``");
  return dialect === "mysql" ? `\`${escaped}\`` : `"${escaped}"`;
}

export interface DbDriver {
  /** The dialect this driver talks to. */
  readonly dialect: "sqlite" | "postgresql" | "mysql";

  /**
   * The native client, handed to Drizzle so the query builder can talk to the
   * engine directly.
   *
   * This is deliberately *not* the same object as the driver itself. Drizzle
   * calls the native client's own method signature — `client.query(config,
   * params)` for `pg`, `conn.query(config, params)` plus `getConnection()` for
   * `mysql2` — which is not the `query(sql, params)` contract implemented
   * above. Sharing one object for both roles would mean implementing two
   * incompatible signatures on the same method.
   */
  readonly client: unknown;

  /**
   * Runs a statement that returns no rows.
   *
   * @param params values interpolated in place of `?` placeholders. Every
   *   driver rewrites these to its engine's syntax, so callers write `?` once.
   */
  execute(sql: string, params?: SqlParams): Promise<void>;

  /** Runs a query and returns all rows as plain objects. */
  query<T = Record<string, SqlValue>>(sql: string, params?: SqlParams): Promise<T[]>;

  /** Runs a query expected to match at most one row. Returns null if none. */
  queryOne<T = Record<string, SqlValue>>(sql: string, params?: SqlParams): Promise<T | null>;

  /**
   * Runs `fn` inside a transaction, committing on resolve and rolling back on
   * throw. Nested calls join the outer transaction rather than failing.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Flushes any engine-level write buffering so a subsequent read on a
   * different connection observes the writes. A no-op where the engine has no
   * equivalent (SQLite checkpoints its WAL; networked engines commit eagerly).
   */
  checkpoint(): Promise<void>;

  /**
   * Invoked after a transaction rolls back.
   *
   * Callers use this to drop in-memory caches that were populated by writes
   * inside the failed transaction; without it, a rolled-back value would keep
   * being served from cache. Assigned by `initDatabase()`.
   */
  rolledBack: (() => void) | null;

  /** Closes the underlying connection(s). Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * True when the error indicates a column that already exists, which is how a
 * re-run `ALTER TABLE ... ADD COLUMN` surfaces on MySQL. Callers use this to
 * make migrations idempotent on engines lacking `IF NOT EXISTS`.
 */
export function isDuplicateColumnError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const errno = (error as { errno?: number } | null)?.errno;
  // MySQL/MariaDB
  if (code === "ER_DUP_FIELDNAME" || errno === 1060) return true;
  // Postgres
  if (code === "42701") return true;
  const message = String((error as { message?: string } | null)?.message || "");
  return /already exists|duplicate column name/i.test(message);
}
