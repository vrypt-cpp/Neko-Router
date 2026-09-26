/**
 * Database entry point.
 *
 * Responsibilities:
 *  1. Pick the driver from `dbConfig` and construct the Drizzle instance.
 *  2. Create tables and apply late-column migrations.
 *  3. Guarantee the JWT signing secret exists BEFORE any route module is
 *     evaluated, because `@elysiajs/jwt` captures the secret when it is
 *     constructed.
 *
 * Boot ordering and the JWT secret
 * --------------------------------
 * The original code did this synchronously at module load, which worked only
 * because `bun:sqlite` is synchronous. Postgres and MySQL connect
 * asynchronously, so the guarantee is preserved differently: `initDatabase()`
 * must be awaited in `src/index.ts` *before* the route modules are imported,
 * and the secret is cached in memory. Route modules are therefore loaded via
 * dynamic `import()` after initialization. See `assertDatabaseReady()`.
 */
import { drizzle as drizzleSqlite, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { mkdirSync } from "fs";
import { dirname } from "path";

import { dbConfig, describeConnection, isFileBackedSqlite, type Dialect } from "./config";
import * as schema from "./schema";
import { ddl, addColumnStatement, lateAddedColumns } from "./ddl";
import type { DbDriver, SqlParams } from "./driver/types";
import { isDuplicateColumnError, quoteIdent } from "./driver/types";
import { SqliteDriver } from "./driver/sqlite";
import { PostgresDriver } from "./driver/postgres";
import { MysqlDriver } from "./driver/mysql";

/** Legacy export: the SQLite file path, or null on networked engines. */
export const DB_PATH = isFileBackedSqlite ? dbConfig.url : "";
export { dbConfig, isFileBackedSqlite, describeConnection };
export type { Dialect };

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The active driver, or null before `initDatabase()` has run.
 *
 * The driver modules for the two networked engines are imported lazily so a
 * SQLite-only deployment never loads the `pg` / `mysql2` client code. That keeps
 * startup fast and means a missing optional dependency cannot break the
 * default path.
 */
let activeDriver: DbDriver | null = null;

export function getDriver(): DbDriver {
  if (!activeDriver) {
    throw new Error("Database driver is not initialized. Call `initDatabase()` first.");
  }
  return activeDriver;
}

/** True once a driver exists. */
export const hasDriver = (): boolean => activeDriver !== null;

/** Lazily loads the driver module for a dialect. */
async function createDriver(dialect: Dialect): Promise<DbDriver> {
  switch (dialect) {
    case "postgresql": {
      const { PostgresDriver } = await import("./driver/postgres");
      return new PostgresDriver(dbConfig.url);
    }
    case "mysql": {
      const { MysqlDriver } = await import("./driver/mysql");
      return new MysqlDriver(dbConfig.url);
    }
    case "sqlite":
    default: {
      const { SqliteDriver } = await import("./driver/sqlite");
      return new SqliteDriver(dbConfig.url);
    }
  }
}

/**
 * The Drizzle instance for the active dialect.
 *
 * This is a mutable binding rather than a `const` because the driver is created
 * asynchronously during `initDatabase()`. It is assigned exactly once, before
 * any route module is imported, so importers always observe a live instance.
 *
 * TypeScript sees the SQLite shape. The Postgres and MySQL instances are cast
 * into it because all three schemas are built to produce identical row types
 * (same column names, `0 | 1` flags, epoch-millisecond numbers) — see
 * `schema/types.ts`.
 *
 * The handle is declared as non-nullable even though nothing is assigned until
 * `initDatabase()` runs. Consumer modules are only imported after that
 * assignment (see the boot-order note at the top of this file), and any other
 * early access is caught by `assertDatabaseReady()`. Declaring it
 * `| undefined` instead would push a non-null assertion onto every call site
 * for no additional safety.
 */
export let db: BunSQLiteDatabase<typeof schema> = undefined as never;

/**
 * Builds the Drizzle wrapper appropriate to the active driver.
 *
 * Drizzle is handed the driver's native client rather than the driver itself:
 * it calls the client's own method signature, which is not the one
 * {@link DbDriver} implements.
 */
function wrapDrizzle(driverInstance: DbDriver): BunSQLiteDatabase<typeof schema> {
  switch (dbConfig.dialect) {
    case "postgresql":
      return drizzlePostgres(driverInstance.client as never, { schema }) as never;
    case "mysql":
      return drizzleMysql(driverInstance.client as never, {
        schema,
        mode: "default",
      }) as never;
    case "sqlite":
    default:
      return drizzleSqlite(driverInstance.client as never, { schema });
  }
}

/* -------------------------------------------------------------------------- */
/* Raw SQL helpers                                                            */
/* -------------------------------------------------------------------------- */

export const execute = async (sql: string, params?: SqlParams): Promise<void> => {
  await getDriver().execute(sql, params);
};

export const query = async <T = Record<string, never>>(
  sql: string,
  params?: SqlParams
): Promise<T[]> => getDriver().query<T>(sql, params);

export const queryOne = async <T = Record<string, never>>(
  sql: string,
  params?: SqlParams
): Promise<T | null> => getDriver().queryOne<T>(sql, params);

export const transaction = async <T>(fn: () => Promise<T>): Promise<T> =>
  getDriver().transaction(fn);

export const checkpoint = async (): Promise<void> => {
  await getDriver().checkpoint();
};

/** Legacy alias kept for existing call sites. */
export const checkpointWal = checkpoint;

/* -------------------------------------------------------------------------- */
/* Drizzle query execution helpers                                            */
/* -------------------------------------------------------------------------- */

/**
 * These three helpers exist because Drizzle's query builders are awaitable on
 * every supported driver but do not share an execution method: the synchronous
 * SQLite driver offers `.all()` / `.get()` / `.run()`, while the Postgres and
 * MySQL drivers have none of those and are driven purely by `await`.
 *
 * Awaiting the builder directly is therefore the one form that works
 * everywhere, and these helpers wrap it so call sites read the same regardless
 * of which row shape they want.
 */

/** Awaits a Drizzle select and returns all rows. */
export async function fetchAll<T = Record<string, unknown>>(
  builder: PromiseLike<T[]>
): Promise<T[]> {
  return await builder;
}

/**
 * Awaits a Drizzle select and returns the first row, or undefined when the
 * result is empty. Mirrors what the SQLite driver's `.get()` returned.
 */
export async function fetchOne<T = Record<string, unknown>>(
  builder: PromiseLike<T[]>
): Promise<T | undefined> {
  const rows = await builder;
  return Array.isArray(rows) ? rows[0] : undefined;
}

/** Awaits a Drizzle insert/update/delete and discards its result. */
export async function runStatement(
  builder: PromiseLike<unknown>
): Promise<void> {
  await builder;
}

/* -------------------------------------------------------------------------- */
/* Readiness                                                                  */
/* -------------------------------------------------------------------------- */

let ready = false;

/**
 * Throws if the database has not finished initializing.
 *
 * Route modules call this before reading the JWT secret. Reading a setting
 * before the connection is up would return null and, in the old code path,
 * could have degraded to an insecure fallback.
 */
export function assertDatabaseReady(): void {
  if (!ready) {
    throw new Error(
      "Database is not initialized. `initDatabase()` must be awaited before route modules are imported."
    );
  }
}

export function isDatabaseReady(): boolean {
  return ready;
}

/* -------------------------------------------------------------------------- */
/* Schema setup                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Creates missing tables and applies late-added columns.
 *
 * Safe to call repeatedly: tables use `IF NOT EXISTS`, and each `ALTER TABLE` is
 * tolerated whether or not the column is already present. That matters because
 * this runs on every boot against a database that may have been created by any
 * earlier version of the app.
 */
export async function initTables(): Promise<void> {
  for (const statement of ddl.createTables()) {
    await execute(statement);
  }

  for (const [table, column, definition] of lateAddedColumns()) {
    const statement = addColumnStatement(table, column, definition);
    try {
      await execute(statement);
    } catch (error) {
      // Only SQLite and MySQL can surface a duplicate column here: Postgres uses
      // ADD COLUMN IF NOT EXISTS, and any other failure is a real error that
      // must not be swallowed or the schema would silently drift.
      if (
        (dbConfig.dialect === "sqlite" || dbConfig.dialect === "mysql") &&
        isDuplicateColumnError(error)
      ) {
        continue;
      }
      throw error;
    }
  }

  for (const statement of ddl.createIndexes()) {
    await execute(statement);
  }
}

/* -------------------------------------------------------------------------- */
/* Settings helpers (replaces hand-written SQL at every call site)            */
/* -------------------------------------------------------------------------- */

/** In-memory settings cache. Avoids a round trip on hot paths. */
const settingsCache = new Map<string, string>();

/** Quotes an identifier for the active dialect. `key` is reserved in MySQL. */
const ident = (name: string): string => quoteIdent(dbConfig.dialect, name);

/** Reads a single setting value, or null when absent. */
export async function getSetting(key: string): Promise<string | null> {
  if (settingsCache.has(key)) return settingsCache.get(key)!;
  const row = await queryOne<{ value: string }>(
    `SELECT ${ident("value")} FROM settings WHERE ${ident("key")} = ?`,
    [key]
  );
  const value = row?.value ?? null;
  if (value !== null) settingsCache.set(key, value);
  return value;
}

/**
 * Reads a setting, falling back to `fallback` when absent or empty.
 */
export async function getSettingOr(
  key: string,
  fallback: string
): Promise<string> {
  const value = await getSetting(key);
  return value === null || value === "" ? fallback : value;
}

/** Writes a setting and refreshes the cache. */
export async function setSetting(key: string, value: string): Promise<void> {
  const now = Date.now();
  const k = ident("key");
  const v = ident("value");
  const u = ident("updated_at");
  const columns = `(${k}, ${v}, ${u})`;

  // The upsert form differs per engine; dispatch rather than emulate.
  if (dbConfig.dialect === "postgresql") {
    await execute(
      `INSERT INTO settings ${columns} VALUES (?, ?, ?)
       ON CONFLICT (${k}) DO UPDATE SET ${v} = EXCLUDED.${v}, ${u} = EXCLUDED.${u}`,
      [key, value, now]
    );
  } else if (dbConfig.dialect === "mysql") {
    // `VALUES(col)` is deprecated in MySQL 8.0.20+ in favour of a row alias,
    // but the alias form does not exist in MariaDB, so the deprecated spelling
    // is the only one both engines accept.
    await execute(
      `INSERT INTO settings ${columns} VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE ${v} = VALUES(${v}), ${u} = VALUES(${u})`,
      [key, value, now]
    );
  } else {
    await execute(
      `INSERT INTO settings ${columns} VALUES (?, ?, ?)
       ON CONFLICT(${k}) DO UPDATE SET ${v} = excluded.${v}, ${u} = excluded.${u}`,
      [key, value, now]
    );
  }
  settingsCache.set(key, value);
}

/** Reads several settings whose keys start with a prefix, in one round trip. */
export async function getSettingsByPrefix(prefix: string): Promise<Map<string, string>> {
  const k = ident("key");
  const rows = await query<{ key: string; value: string }>(
    `SELECT ${k}, ${ident("value")} FROM settings WHERE ${k} LIKE ?`,
    [`${prefix}%`]
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.key, row.value);
    settingsCache.set(row.key, row.value);
  }
  return map;
}

/** Drops the settings cache; the next read hits the database. */
export function invalidateSettingsCache(): void {
  settingsCache.clear();
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

function randomSecretHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Ensures a JWT signing secret is present and returns it.
 *
 * Fail-closed: a deployment generates a random 256-bit secret on first boot and
 * persists it, so the value is stable across restarts. If `JWT_SECRET` is set it
 * is honoured instead. The result is cached in memory for the synchronous
 * accessor that `@elysiajs/jwt` requires at construction time.
 */
export async function ensureJwtSecret(): Promise<string> {
  const existing = await getSetting("jwt_secret");
  if (existing && existing.length > 0) {
    jwtSecretCache = existing;
    return existing;
  }

  const secret = process.env.JWT_SECRET?.trim() || randomSecretHex();
  await setSetting("jwt_secret", secret);
  jwtSecretCache = secret;
  return secret;
}

let jwtSecretCache: string | null = null;

/**
 * Synchronous access to the JWT secret.
 *
 * Only valid after `initDatabase()` has run — which is exactly when
 * `@elysiajs/jwt` is constructed, because route modules are imported after
 * initialization. Throws rather than returning a placeholder, because a
 * predictable signing secret would let anyone forge an admin session.
 */
export function getJwtSecretCached(): string {
  if (!jwtSecretCache) {
    throw new Error(
      "JWT secret is not initialized. `initDatabase()` must run before route modules are imported."
    );
  }
  return jwtSecretCache;
}

/**
 * Connects, creates the schema, and seeds first-boot data.
 *
 * Must be awaited before any route module is imported.
 */
export async function initDatabase(): Promise<void> {
  if (isFileBackedSqlite) {
    // The driver creates the directory, but the path is also reported by the
    // admin dashboard before the first query in some flows.
    try {
      mkdirSync(dirname(dbConfig.url), { recursive: true });
    } catch {
      // ignore
    }
  }

  activeDriver = await createDriver(dbConfig.dialect);
  // A rolled-back transaction must not leave its writes visible in the
  // in-memory settings cache, so drop the cache whenever one aborts.
  activeDriver.rolledBack = invalidateSettingsCache;
  db = wrapDrizzle(activeDriver);

  await initTables();
  await ensureJwtSecret();
  await seedDefaultPin();

  ready = true;
  console.log(`[db] connected (${dbConfig.dialect}): ${describeConnection()}`);
}

/** Seeds the default admin PIN on first boot only. */
async function seedDefaultPin(): Promise<void> {
  const existing = await getSetting("auth_pin_hash");
  if (existing) return;

  const hashed = await Bun.password.hash("123456", { algorithm: "bcrypt", cost: 10 });
  await setSetting("auth_pin_hash", hashed);
  await setSetting("is_default_pin", "1");
  console.log("Initialized default PIN (123456) with is_default_pin=1");
}

/** Closes the connection. Used by tests and graceful shutdown. */
export async function closeDatabase(): Promise<void> {
  ready = false;
  invalidateSettingsCache();
  jwtSecretCache = null;
  if (activeDriver) {
    await activeDriver.close();
    activeDriver = null;
  }
  // `db` is declared non-nullable, so clearing it needs a cast. The read that
  // actually guards callers is `assertDatabaseReady()` above; resetting the
  // handle too means a racing caller fails at the query rather than holding a
  // handle bound to a closed connection.
  db = undefined as never;
}

/**
 * Reopens the underlying connection.
 *
 * Only meaningful for SQLite; on the networked engines a reconnect would drop
 * the pool, so callers are expected to handle the error.
 */
export async function reloadDatabase(): Promise<void> {
  invalidateSettingsCache();
  const active = getDriver();
  if (dbConfig.dialect === "sqlite") {
    (active as SqliteDriver).reopen();
    // Re-verify the schema: an import may have replaced tables underneath us.
    await initTables();
  } else {
    throw new Error(
      `reloadDatabase() is not supported on the ${dbConfig.dialect} driver; restart the process instead.`
    );
  }
}
