/**
 * Dialect-dispatching schema barrel.
 *
 * Application code imports tables and row types from this module and never
 * learns which engine is active. At runtime the table objects come from the
 * dialect named in `dbConfig`; at the type level they are always presented as
 * the SQLite definitions, whose inferred row types are structurally identical
 * to the Postgres/MySQL ones (same column names, `0 | 1` flags, epoch-ms
 * numbers). Every dialect schema in this folder is written to satisfy that
 * invariant, and `types.ts` states it explicitly.
 */
import { dbConfig } from "../config";
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";
import type * as SqliteSchema from "./sqlite";

import * as sqliteSchema from "./sqlite";
import * as postgresSchema from "./postgres";
import * as mysqlSchema from "./mysql";

const active: typeof SqliteSchema =
  dbConfig.dialect === "postgresql"
    ? (postgresSchema as unknown as typeof SqliteSchema)
    : dbConfig.dialect === "mysql"
      ? (mysqlSchema as unknown as typeof SqliteSchema)
      : sqliteSchema;

export const settings = active.settings;
export const apiKeys = active.apiKeys;
export const clientKeys = active.clientKeys;
export const upstreamKeys = active.upstreamKeys;
export const telemetryLogs = active.telemetryLogs;
export const responseCache = active.responseCache;

/** Logical table names in a stable order, used by the generic backup path. */
export const tableNames = [
  "settings",
  "api_keys",
  "client_keys",
  "upstream_keys",
  "telemetry_logs",
  "response_cache",
] as const;

export type TableName = (typeof tableNames)[number];

/**
 * Every table keyed by its SQL name, for generic iteration (backup/restore,
 * truncate, export). The keys match {@link tableNames} so callers can index
 * both with the same identifier.
 */
export const allTables: Record<TableName, AnySQLiteTable> = {
  settings,
  api_keys: apiKeys,
  client_keys: clientKeys,
  upstream_keys: upstreamKeys,
  telemetry_logs: telemetryLogs,
  response_cache: responseCache,
};

export type {
  Setting,
  ApiKey,
  InsertApiKey,
  ClientKey,
  InsertClientKey,
  UpstreamKey,
  InsertUpstreamKey,
  TelemetryLog,
  InsertTelemetryLog,
  ResponseCache,
} from "./types";
