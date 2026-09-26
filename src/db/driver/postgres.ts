/**
 * PostgreSQL driver, backed by `node-postgres`.
 *
 * `pg` exposes a connection pool; each pooled client serializes its own
 * statements, so a transaction must pin one client for its whole duration. That
 * is what `transaction()` does here via `pool.connect()`.
 */
import pg from "pg";
import type { DbDriver, SqlParams } from "./types";
import { isDuplicateColumnError } from "./types";

/**
 * `bigint` (OID 20) is returned as a string by `pg` to avoid precision loss.
 * Every bigint in this schema holds a value well inside Number.MAX_SAFE_INTEGER
 * (epoch milliseconds, token counters), so parsing to number is safe and keeps
 * the application free of per-dialect string/number handling.
 */
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

/**
 * Rewrites `?` placeholders to Postgres' `$1`, `$2`, ... form.
 *
 * The application's raw SQL is written once with `?` because that is what
 * SQLite and MySQL accept, and Drizzle's own builders already emit the correct
 * syntax for whichever dialect they were built for. Without this, every
 * hand-written statement in `db/ddl.ts` and `db/backup.ts` would need a
 * dialect branch at the call site.
 *
 * Skips `?` inside string literals, quoted identifiers, dollar-quoted bodies,
 * and comments, and leaves Postgres' `?`, `?|`, `?&` jsonb operators alone.
 */
export function toPositionalPlaceholders(sql: string): string {
  if (!sql.includes("?")) return sql;

  let out = "";
  let index = 0;
  let placeholders = 0;
  const n = sql.length;

  while (index < n) {
    const ch = sql[index];

    // Single-quoted literal, with '' escaping.
    if (ch === "'") {
      let end = index + 1;
      while (end < n) {
        if (sql[end] === "'") {
          if (sql[end + 1] === "'") end += 2;
          else {
            end++;
            break;
          }
        } else end++;
      }
      out += sql.slice(index, end);
      index = end;
      continue;
    }

    // Double-quoted identifier.
    if (ch === '"') {
      let end = index + 1;
      while (end < n && sql[end] !== '"') end++;
      out += sql.slice(index, Math.min(end + 1, n));
      index = end + 1;
      continue;
    }

    // Line comment.
    if (ch === "-" && sql[index + 1] === "-") {
      let end = sql.indexOf("\n", index);
      if (end === -1) end = n;
      out += sql.slice(index, end);
      index = end;
      continue;
    }

    // Block comment.
    if (ch === "/" && sql[index + 1] === "*") {
      let end = sql.indexOf("*/", index + 2);
      end = end === -1 ? n : end + 2;
      out += sql.slice(index, end);
      index = end;
      continue;
    }

    // Dollar-quoted body ($tag$ ... $tag$), which can hold anything.
    if (ch === "$") {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
      if (match) {
        const tag = match[0];
        const close = sql.indexOf(tag, index + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out += sql.slice(index, end);
        index = end;
        continue;
      }
    }

    // `?` followed by `|` or `&` is a jsonb operator, not a placeholder.
    if (ch === "?") {
      const next = sql[index + 1];
      if (next === "|" || next === "&") {
        out += ch;
        index++;
        continue;
      }
      index++;
      out += `$${++placeholders}`;
      continue;
    }

    out += ch;
    index++;
  }

  return out;
}

/**
 * Maps a libpq `sslmode` value in the connection string to a node `tls` connect
 * option.
 *
 * Returns `undefined` — deliberately *not* `false` — when the URL expresses no
 * preference, so `pg` falls back to its own resolution of `PGSSLMODE`,
 * `PGSSLCERT`, `PGSSLROOTCERT` and friends. That fallback only runs when the
 * `ssl` option is left `undefined`, because `pg` reads
 * `typeof config.ssl === 'undefined' ? readSSLConfigFromEnvironment() : config.ssl`.
 * An explicit `false` therefore does not mean "no preference", it means "no
 * TLS, whatever the environment says".
 *
 * That distinction is not academic. `sslmode` is a libpq setting operators
 * routinely set through the environment, so treating its absence as a hard
 * `ssl: false` silently defeats the mechanism every other Postgres tool
 * honours, and the only symptom is a server-side `pg_hba.conf` complaint.
 */
export function sslFromConnectionString(
  connectionString: string,
): boolean | object | undefined {
  const match = /[?&]sslmode=([^&]+)/.exec(connectionString);
  const mode = match?.[1]
    ? decodeURIComponent(match[1]).toLowerCase()
    : undefined;

  switch (mode) {
    case "require":
    case "verify-ca":
    case "verify-full":
      // Certificate verification needs a root CA, which node-postgres only
      // loads from PGSSLROOTCERT. Without one, require encryption but do not
      // claim the peer is verified.
      return { rejectUnauthorized: mode !== "require" };
    case "disable":
      return false;
    default:
      return undefined;
  }
}

/**
 * Recognises the "connected without TLS to a server that only accepts TLS"
 * rejection, which is otherwise reported as an opaque
 * `no pg_hba.conf entry for host ..., no encryption`.
 *
 * Managed PostgreSQL (Aiven, RDS, Cloud SQL, Neon, Supabase) requires TLS and
 * refuses cleartext connections, so this is the most common failure when moving
 * an existing deployment onto Postgres. The server-side message names
 * `pg_hba.conf`, which points the operator at the database rather than at the
 * connection string that actually caused it.
 */
export function isTlsRequiredError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return (
    message.includes("no encryption") ||
    // libpq wording used by some proxies and newer servers.
    /SSL is required|sslmode\s*=\s*require/i.test(message)
  );
}

export class PostgresDriver implements DbDriver {
  readonly dialect = "postgresql" as const;

  private pool: pg.Pool;
  private closed = false;
  /** The client pinned by the in-flight transaction, if any. */
  private txClient: pg.PoolClient | null = null;
  private txDepth = 0;

  constructor(
    connectionString: string,
    options: { max?: number; ssl?: boolean | object } = {},
  ) {
    this.pool = new pg.Pool({
      connectionString,
      max: options.max ?? 10,
      // `pg` does not translate `sslmode` from the connection string, so the
      // mode is resolved here. Leaving it `undefined` when the URL is silent
      // keeps `PGSSLMODE` working; forcing TLS on instead would break the
      // ordinary self-hosted case (`postgres://user:pass@host:5432/db` against
      // a container with no TLS configured), which is the common deployment.
      ssl: options.ssl ?? sslFromConnectionString(connectionString),
    });

    // A pool that cannot connect reports the failure on every queued request,
    // which buries the cause under repeated stack traces. Annotate it once, at
    // the point where the operator can act on it.
    this.pool.on("error", (error) => {
      if (isTlsRequiredError(error)) {
        console.error(
          `[db] PostgreSQL refused a cleartext connection (${error.message}).\n` +
            `     Managed providers require TLS. Either append ?sslmode=require to\n` +
            `     DATABASE_URL or set PGSSLMODE=require in the environment.`,
        );
      }
    });
  }

  /**
   * Every statement runs on the transaction-pinned client when one is active,
   * so statements issued inside `transaction()` are part of that transaction
   * rather than racing against it on a different pooled connection.
   */
  private get runner(): pg.Pool | pg.PoolClient {
    return this.txClient ?? this.pool;
  }

  /** The pool Drizzle's node-postgres driver is built on. */
  get client(): pg.Pool {
    return this.pool;
  }

  async execute(sql: string, params: SqlParams = []): Promise<void> {
    await this.runner.query(toPositionalPlaceholders(sql), [...params]);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: SqlParams = [],
  ): Promise<T[]> {
    const result = await this.runner.query(toPositionalPlaceholders(sql), [
      ...params,
    ]);
    return result.rows as T[];
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: SqlParams = [],
  ): Promise<T | null> {
    const result = await this.runner.query(toPositionalPlaceholders(sql), [
      ...params,
    ]);
    return (result.rows[0] as T | undefined) ?? null;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Postgres has no true nested transactions; join the outer one.
    if (this.txDepth > 0) return fn();

    const client = await this.pool.connect();
    this.txClient = client;
    this.txDepth++;
    try {
      await client.query("BEGIN");
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A rollback failure must not mask the original error.
      }
      this.rolledBack?.();
      throw error;
    } finally {
      this.txDepth--;
      this.txClient = null;
      client.release();
    }
  }

  /** Registered by `db/index.ts` so cache invalidation can hook into rollback. */
  rolledBack: (() => void) | null = null;

  async checkpoint(): Promise<void> {
    // Postgres commits eagerly; there is no write-ahead log to fold down.
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  /**
   * Applies a migration step, treating "column already exists" as success.
   * Postgres supports `ADD COLUMN IF NOT EXISTS`, but the same tolerance is
   * applied here so a failed migration cannot wedge startup.
   */
  async migrate(sql: string): Promise<void> {
    try {
      await this.execute(sql);
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error;
    }
  }
}
