/**
 * Database backup and restore.
 *
 * Two on-the-wire formats are supported, and which one is produced depends on
 * the active dialect:
 *
 *  - **SQLite** exports the database file itself, which is what earlier
 *    releases did. Existing `.sqlite` backups therefore still import cleanly.
 *  - **Postgres and MySQL** export a JSON document. Neither engine has a
 *    single-file representation that can be streamed over HTTP without shell
 *    access to `pg_dump` / `mysqldump`, which is not something a request
 *    handler can assume.
 *
 * The JSON document is dialect independent: `schema/types.ts` guarantees the
 * three engines store identical column names and value shapes, so a backup
 * taken on one engine restores onto any of them. The `dialect` field is
 * recorded for provenance only and is not enforced.
 *
 * A restore is always a full replace — every row of every known table is
 * deleted and rewritten inside one transaction — so a partially applied import
 * is not a reachable state.
 */
import { unlinkSync, existsSync } from "fs";

import {
  db,
  getDriver,
  runStatement,
  fetchAll,
  queryOne,
  transaction,
} from "./index";
import { dbConfig, isFileBackedSqlite, type Dialect } from "./config";
import { DB_PATH } from "./index";
import { allTables, tableNames } from "./schema";
import type { TableName } from "./schema";

/**
 * Rows inserted per statement. Keeps MySQL's max packet size and SQLite's
 * bound-variable limit in bounds for wide rows such as the response cache.
 */
const INSERT_CHUNK = 200;

/** Tables a backup must contain for a restore to be accepted. */
export const REQUIRED_TABLES: readonly TableName[] = [
  "settings",
  "client_keys",
  "upstream_keys",
  "telemetry_logs",
];

export const BACKUP_FORMAT = "neko-router-backup";
export const BACKUP_VERSION = 1;

export type BackupTables = Partial<
  Record<TableName, Record<string, unknown>[]>
>;

export interface JsonBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** Recorded for provenance; a backup restores onto any dialect. */
  dialect: Dialect;
  createdAt: number;
  tables: BackupTables;
}

export interface RestoreSummary {
  tables: number;
  rows: number;
}

/** Thrown for user-correctable problems so the route can answer 400. */
export class BackupError extends Error {}

/** Identifiers are interpolated into SQL, so quote rather than trust. */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/** Reads every known table into memory. */
export async function exportJsonBackup(): Promise<JsonBackup> {
  const tables: BackupTables = {};
  for (const name of tableNames) {
    tables[name] = await fetchAll<Record<string, unknown>>(
      db.select().from(allTables[name]),
    );
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    dialect: dbConfig.dialect,
    createdAt: Date.now(),
    tables,
  };
}

/** Filename extension matching the produced format for the active dialect. */
export const backupFileExtension = (): string =>
  isFileBackedSqlite ? "sqlite" : "json";

/** Content type matching the produced format for the active dialect. */
export const backupContentType = (): string =>
  isFileBackedSqlite ? "application/x-sqlite3" : "application/json";

/* -------------------------------------------------------------------------- */
/* JSON restore                                                               */
/* -------------------------------------------------------------------------- */

/** Narrows an untrusted parsed document to the backup shape. */
export function isJsonBackup(value: unknown): value is JsonBackup {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<JsonBackup>;
  if (candidate.format !== BACKUP_FORMAT) return false;
  if (
    typeof candidate.version !== "number" ||
    candidate.version > BACKUP_VERSION
  ) {
    return false;
  }
  if (typeof candidate.tables !== "object" || candidate.tables === null)
    return false;
  return REQUIRED_TABLES.every((name) =>
    Array.isArray(candidate.tables![name]),
  );
}

/** Required tables absent from a candidate's table list. */
export function missingRequiredTables(present: Set<string>): TableName[] {
  return REQUIRED_TABLES.filter((name) => !present.has(name));
}

/**
 * Replaces the contents of every known table with the backup's rows.
 *
 * Keys inside a row that this build has no column for are dropped rather than
 * rejected: a backup taken from a newer release may carry columns this build
 * has not migrated yet, and ignoring them still restores everything the
 * running code reads.
 */
export async function restoreJsonBackup(
  payload: JsonBackup,
): Promise<RestoreSummary> {
  const summary: RestoreSummary = { tables: 0, rows: 0 };

  await transaction(async () => {
    for (const name of tableNames) {
      const table = allTables[name];
      const rows = payload.tables[name];

      await runStatement(db.delete(table));

      if (!Array.isArray(rows) || rows.length === 0) continue;
      for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
        const chunk = rows.slice(offset, offset + INSERT_CHUNK);
        await runStatement(db.insert(table).values(chunk as never));
        summary.rows += chunk.length;
      }
      summary.tables++;
    }
  });

  return summary;
}

/* -------------------------------------------------------------------------- */
/* SQLite file restore                                                        */
/* -------------------------------------------------------------------------- */

/** Table names in an attached SQLite database, excluding internal ones. */
async function attachedTableNames(): Promise<string[]> {
  const rows = await getDriver().query<{ name: string }>(
    "SELECT name FROM imported_db.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return rows.map((row) => row.name);
}

/** Column names of `table` in the given attached schema. */
async function columnNames(schema: string, table: string): Promise<string[]> {
  const rows = await getDriver().query<{ name: string }>(
    `SELECT name FROM ${quoteIdent(schema)}.pragma_table_info(?)`,
    [table],
  );
  return rows.map((row) => row.name);
}

async function rowCount(schema: string, table: string): Promise<number> {
  const row = await queryOne<{ count: number | string }>(
    `SELECT count(*) AS count FROM ${quoteIdent(schema)}.${quoteIdent(table)}`,
  );
  return Number(row?.count ?? 0);
}

/**
 * Replaces each live table with the matching table from `imported_db`.
 *
 * Only columns present in both schemas are copied, so a backup from an older
 * release restores into a newer schema and vice versa. Tables the backup does
 * not contain are left untouched, matching the "common columns only" rule.
 */
async function copyFromAttached(): Promise<RestoreSummary> {
  const driver = getDriver();
  const summary: RestoreSummary = { tables: 0, rows: 0 };

  const liveTables = (
    await driver.query<{ name: string }>(
      "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
  ).map((row) => row.name);

  for (const table of await attachedTableNames()) {
    if (!liveTables.includes(table)) continue;

    const liveColumns = await columnNames("main", table);
    const sourceColumns = await columnNames("imported_db", table);
    const common = liveColumns.filter((column) =>
      sourceColumns.includes(column),
    );
    if (common.length === 0) continue;

    const columnList = common.map(quoteIdent).join(", ");
    await driver.execute(`DELETE FROM main.${quoteIdent(table)}`);
    await driver.execute(
      `INSERT INTO main.${quoteIdent(table)} (${columnList}) ` +
        `SELECT ${columnList} FROM imported_db.${quoteIdent(table)}`,
    );

    summary.tables++;
    summary.rows += await rowCount("main", table);
  }

  return summary;
}

/** `PRAGMA integrity_check` on a candidate file, before it replaces anything. */
export async function checkSqliteIntegrity(
  path: string,
): Promise<{ ok: boolean; detail: string }> {
  const { Database } = await import("bun:sqlite");
  const handle = new Database(path, { readonly: true });
  try {
    const row = handle.query("PRAGMA integrity_check;").get() as {
      integrity_check?: string;
    } | null;
    const result = row?.integrity_check ?? "unknown";
    return { ok: result === "ok", detail: result };
  } finally {
    handle.close();
  }
}

/** Table names in a candidate SQLite file. */
export async function sqliteTableNames(path: string): Promise<string[]> {
  const { Database } = await import("bun:sqlite");
  const handle = new Database(path, { readonly: true });
  try {
    const rows = handle
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    return rows.map((row) => row.name);
  } finally {
    handle.close();
  }
}

/**
 * Restores from a `.sqlite` file already written to `tempPath`.
 *
 * SQLite only: attaching a second database is not something a networked engine
 * offers, which is why the export side produces JSON there instead.
 */
export async function restoreSqliteFile(
  tempPath: string,
): Promise<RestoreSummary> {
  if (dbConfig.dialect !== "sqlite") {
    throw new BackupError(
      "SQLite file imports are only supported on the SQLite engine. " +
        "Use a Neko-Router JSON backup instead.",
    );
  }

  const driver = getDriver();
  // ATTACH rejects Windows backslash paths.
  await driver.execute("ATTACH DATABASE ? AS imported_db", [
    tempPath.replace(/\\/g, "/"),
  ]);
  try {
    return await transaction(() => copyFromAttached());
  } finally {
    try {
      await driver.execute("DETACH DATABASE imported_db");
    } catch {
      // A failed transaction may already have released the attachment.
    }
  }
}

/** Path of the file that receives a copy of the live database before a restore. */
export const currentDatabaseBackupPath = (): string | null =>
  isFileBackedSqlite ? `${DB_PATH}.bak` : null;

export const removeIfPresent = (path: string): void => {
  if (existsSync(path)) unlinkSync(path);
};
