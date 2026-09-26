/**
 * MySQL / MariaDB driver, backed by `mysql2`.
 *
 * Differences from the other drivers that matter here:
 *  - `mysql2` does not accept `bigint` columns as JS numbers unless asked; the
 *    type parser below converts them, matching what the Postgres driver does.
 *  - There is no `ADD COLUMN IF NOT EXISTS`, so migrations rely on treating a
 *    duplicate-column error as success.
 *  - DDL implicitly commits, so `transaction()` cannot cover schema changes.
 */
import mysql from "mysql2/promise";
import type { DbDriver, SqlParams } from "./types";
import { isDuplicateColumnError } from "./types";

export class MysqlDriver implements DbDriver {
  readonly dialect = "mysql" as const;

  private pool: mysql.Pool;
  private closed = false;
  /** The connection pinned by the in-flight transaction, if any. */
  private txConnection: mysql.PoolConnection | null = null;
  private txDepth = 0;

  constructor(connectionString: string, options: { connectionLimit?: number } = {}) {
    this.pool = mysql.createPool({
      uri: connectionString,
      connectionLimit: options.connectionLimit ?? 10,
      // Return BIGINT as a number rather than a string. Every bigint column in
      // this schema (epoch ms, token counters) is far below 2^53.
      decimalNumbers: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: true,
    });
  }

  private get runner(): mysql.Pool | mysql.PoolConnection {
    return this.txConnection ?? this.pool;
  }

  /** The pool Drizzle's MySQL driver is built on. */
  get client(): mysql.Pool {
    return this.pool;
  }

  async execute(sql: string, params: SqlParams = []): Promise<void> {
    await this.runner.query(sql, [...params]);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: SqlParams = []
  ): Promise<T[]> {
    const [rows] = await this.runner.query(sql, [...params]);
    // Non-SELECT statements yield a header object, not a row array.
    return (Array.isArray(rows) ? rows : []) as T[];
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: SqlParams = []
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0) return fn();

    const connection = await this.pool.getConnection();
    this.txConnection = connection;
    this.txDepth++;
    try {
      await connection.beginTransaction();
      const result = await fn();
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // ignore
      }
      this.rolledBack?.();
      throw error;
    } finally {
      this.txDepth--;
      this.txConnection = null;
      connection.release();
    }
  }

  /** Registered by `db/index.ts` so cache invalidation can hook into rollback. */
  rolledBack: (() => void) | null = null;

  async checkpoint(): Promise<void> {
    // MySQL commits eagerly; nothing to fold down.
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  /**
   * Applies a migration step, treating "duplicate column" as success since
   * MySQL lacks `ADD COLUMN IF NOT EXISTS`.
   */
  async migrate(sql: string): Promise<void> {
    try {
      await this.execute(sql);
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error;
    }
  }
}
