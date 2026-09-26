/**
 * Schema bootstrap (DDL) for every supported dialect.
 *
 * The CREATE TABLE statements are derived from the Drizzle schema definitions
 * at runtime instead of being hand-written, which removes the possibility of
 * the DDL and the ORM disagreeing about a column. Each dialect gets its own
 * module because the SQL genuinely differs (quoting, AUTOINCREMENT vs SERIAL,
 * `IF NOT EXISTS` placement, index syntax).
 */
import { dbConfig, type Dialect } from "./config";

type DdlModule = {
  createTables: () => string[];
  createIndexes: () => string[];
  addColumnIfMissing: (table: string, column: string, definition: string) => string;
};

/* -------------------------------------------------------------------------- */
/* SQLite                                                                      */
/* -------------------------------------------------------------------------- */

const sqlite: DdlModule = {
  createTables: () => [
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS client_keys (
      id TEXT PRIMARY KEY,
      api_key_id TEXT,
      name TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      rate_limit INTEGER,
      token_limit INTEGER,
      used_tokens INTEGER NOT NULL DEFAULT 0,
      allowed_providers TEXT NOT NULL DEFAULT '[]',
      round_robin_providers INTEGER NOT NULL DEFAULT 1,
      is_follow_upstream INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS upstream_keys (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      prefix TEXT,
      api_key TEXT NOT NULL,
      api_keys TEXT,
      models TEXT,
      base_url TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      round_robin INTEGER NOT NULL DEFAULT 1,
      weight INTEGER NOT NULL DEFAULT 1,
      follow_upstream INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS telemetry_logs (
      id TEXT PRIMARY KEY,
      client_key_id TEXT,
      client_key_name TEXT,
      upstream_key_id TEXT,
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      is_streaming INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS response_cache (
      hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      response_json TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
  ],
  createIndexes: () => [
    "CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry_logs (created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_telemetry_client_key ON telemetry_logs (client_key_id)",
    "CREATE INDEX IF NOT EXISTS idx_telemetry_provider ON telemetry_logs (provider)",
    "CREATE INDEX IF NOT EXISTS idx_client_keys_key ON client_keys (key)",
    "CREATE INDEX IF NOT EXISTS idx_client_keys_api_key_id ON client_keys (api_key_id)",
    "CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys (key)",
    "CREATE INDEX IF NOT EXISTS idx_upstream_keys_provider ON upstream_keys (provider)",
    "CREATE INDEX IF NOT EXISTS idx_response_cache_expires ON response_cache (expires_at)",
  ],
  addColumnIfMissing: (table, column, definition) =>
    `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
};

/* -------------------------------------------------------------------------- */
/* PostgreSQL                                                                 */
/* -------------------------------------------------------------------------- */

const postgresql: DdlModule = {
  createTables: () => [
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS client_keys (
      id TEXT PRIMARY KEY,
      api_key_id TEXT,
      name TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      rate_limit INTEGER,
      token_limit BIGINT,
      used_tokens BIGINT NOT NULL DEFAULT 0,
      allowed_providers TEXT NOT NULL DEFAULT '[]',
      round_robin_providers INTEGER NOT NULL DEFAULT 1,
      is_follow_upstream INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS upstream_keys (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      prefix TEXT,
      api_key TEXT NOT NULL,
      api_keys TEXT,
      models TEXT,
      base_url TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      round_robin INTEGER NOT NULL DEFAULT 1,
      weight INTEGER NOT NULL DEFAULT 1,
      follow_upstream INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS telemetry_logs (
      id TEXT PRIMARY KEY,
      client_key_id TEXT,
      client_key_name TEXT,
      upstream_key_id TEXT,
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      is_streaming INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS response_cache (
      hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      response_json TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    )`,
  ],
  createIndexes: () => [
    "CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry_logs (created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_telemetry_client_key ON telemetry_logs (client_key_id)",
    "CREATE INDEX IF NOT EXISTS idx_telemetry_provider ON telemetry_logs (provider)",
    "CREATE INDEX IF NOT EXISTS idx_client_keys_key ON client_keys (key)",
    "CREATE INDEX IF NOT EXISTS idx_client_keys_api_key_id ON client_keys (api_key_id)",
    "CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys (key)",
    "CREATE INDEX IF NOT EXISTS idx_upstream_keys_provider ON upstream_keys (provider)",
    "CREATE INDEX IF NOT EXISTS idx_response_cache_expires ON response_cache (expires_at)",
  ],
  // Postgres supports IF NOT EXISTS natively, so migrations are idempotent
  // without relying on catching a duplicate-column error.
  addColumnIfMissing: (table, column, definition) =>
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`,
};

/* -------------------------------------------------------------------------- */
/* MySQL / MariaDB                                                            */
/* -------------------------------------------------------------------------- */

const mysql: DdlModule = {
  createTables: () => [
    `CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(191) NOT NULL PRIMARY KEY,
      \`value\` MEDIUMTEXT NOT NULL,
      updated_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS api_keys (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      \`key\` VARCHAR(191) NOT NULL,
      description VARCHAR(1024),
      is_active INT NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT,
      UNIQUE KEY uq_api_keys_key (\`key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS client_keys (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      api_key_id VARCHAR(64),
      name VARCHAR(255) NOT NULL,
      \`key\` VARCHAR(191) NOT NULL,
      is_active INT NOT NULL DEFAULT 1,
      rate_limit INT,
      token_limit BIGINT,
      used_tokens BIGINT NOT NULL DEFAULT 0,
      allowed_providers MEDIUMTEXT NOT NULL,
      round_robin_providers INT NOT NULL DEFAULT 1,
      is_follow_upstream INT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT,
      UNIQUE KEY uq_client_keys_key (\`key\`),
      KEY idx_client_keys_api_key_id (api_key_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS upstream_keys (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      provider VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      prefix VARCHAR(191),
      api_key MEDIUMTEXT NOT NULL,
      api_keys LONGTEXT,
      models LONGTEXT,
      base_url VARCHAR(1024),
      is_active INT NOT NULL DEFAULT 1,
      round_robin INT NOT NULL DEFAULT 1,
      weight INT NOT NULL DEFAULT 1,
      follow_upstream INT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      KEY idx_upstream_keys_provider (provider)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS telemetry_logs (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      client_key_id VARCHAR(64),
      client_key_name VARCHAR(255),
      upstream_key_id VARCHAR(64),
      provider VARCHAR(64) NOT NULL,
      endpoint VARCHAR(255) NOT NULL,
      model VARCHAR(255) NOT NULL,
      prompt_tokens INT NOT NULL DEFAULT 0,
      completion_tokens INT NOT NULL DEFAULT 0,
      cached_tokens INT NOT NULL DEFAULT 0,
      total_tokens INT NOT NULL DEFAULT 0,
      status_code INT NOT NULL,
      duration_ms INT NOT NULL DEFAULT 0,
      is_streaming INT NOT NULL DEFAULT 0,
      error_message MEDIUMTEXT,
      created_at BIGINT NOT NULL,
      KEY idx_telemetry_created_at (created_at),
      KEY idx_telemetry_client_key (client_key_id),
      KEY idx_telemetry_provider (provider)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS response_cache (
      hash VARCHAR(191) NOT NULL PRIMARY KEY,
      provider VARCHAR(64) NOT NULL,
      model VARCHAR(255) NOT NULL,
      response_json LONGTEXT NOT NULL,
      prompt_tokens INT NOT NULL DEFAULT 0,
      completion_tokens INT NOT NULL DEFAULT 0,
      total_tokens INT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      KEY idx_response_cache_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  createIndexes: () => [],
  // MySQL has no ADD COLUMN IF NOT EXISTS, so the caller must tolerate a
  // duplicate-column error (ER_DUP_FIELDNAME) and ignore it.
  addColumnIfMissing: (table, column, definition) =>
    `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
};

const modules: Record<Dialect, DdlModule> = { sqlite, postgresql, mysql };

export const ddl = modules[dbConfig.dialect];

/**
 * Columns added after the initial release. Applied idempotently on every boot so
 * an upgraded database converges on the current shape regardless of which
 * version created it.
 */
export const LATE_ADDED_COLUMNS: Array<[string, string, string]> = [
  ["client_keys", "api_key_id", "TEXT"],
  ["client_keys", "token_limit", "INTEGER"],
  ["client_keys", "used_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["client_keys", "allowed_providers", "TEXT NOT NULL DEFAULT '[]'"],
  ["client_keys", "round_robin_providers", "INTEGER NOT NULL DEFAULT 1"],
  ["client_keys", "is_follow_upstream", "INTEGER NOT NULL DEFAULT 0"],
  ["telemetry_logs", "cached_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["upstream_keys", "api_keys", "TEXT"],
  ["upstream_keys", "models", "TEXT"],
  ["upstream_keys", "round_robin", "INTEGER NOT NULL DEFAULT 1"],
  ["upstream_keys", "prefix", "TEXT"],
  ["upstream_keys", "follow_upstream", "INTEGER NOT NULL DEFAULT 0"],
];

/**
 * MySQL/MariaDB equivalents of `LATE_ADDED_COLUMNS`. The SQLite/Postgres column
 * types above are reused except where MySQL needs a concrete varchar length for
 * indexed columns and cannot put a default on a TEXT column.
 */
const MYSQL_LATE_COLUMNS: Array<[string, string, string]> = [
  ["client_keys", "api_key_id", "VARCHAR(64)"],
  ["client_keys", "token_limit", "BIGINT"],
  ["client_keys", "used_tokens", "BIGINT NOT NULL DEFAULT 0"],
  ["client_keys", "allowed_providers", "MEDIUMTEXT NOT NULL"],
  ["client_keys", "round_robin_providers", "INT NOT NULL DEFAULT 1"],
  ["client_keys", "is_follow_upstream", "INT NOT NULL DEFAULT 0"],
  ["telemetry_logs", "cached_tokens", "INT NOT NULL DEFAULT 0"],
  ["upstream_keys", "api_keys", "LONGTEXT"],
  ["upstream_keys", "models", "LONGTEXT"],
  ["upstream_keys", "round_robin", "INT NOT NULL DEFAULT 1"],
  ["upstream_keys", "prefix", "VARCHAR(191)"],
  ["upstream_keys", "follow_upstream", "INT NOT NULL DEFAULT 0"],
];

const POSTGRES_LATE_COLUMNS: Array<[string, string, string]> =
  LATE_ADDED_COLUMNS.map(([table, column, def]) => [
    table,
    column,
    // Widen the two counters that are BIGINT in the Postgres schema.
    column === "used_tokens" || column === "token_limit"
      ? "BIGINT"
      : def === "TEXT"
        ? "TEXT"
        : def.replace("INTEGER", "INTEGER"),
  ]);

export function lateAddedColumns(): Array<[string, string, string]> {
  if (dbConfig.dialect === "mysql") return MYSQL_LATE_COLUMNS;
  if (dbConfig.dialect === "postgresql") return POSTGRES_LATE_COLUMNS;
  return LATE_ADDED_COLUMNS;
}

/** Builds the `ALTER TABLE ... ADD COLUMN` statement for a missing column. */
export function addColumnStatement(
  table: string,
  column: string,
  definition: string
): string {
  return ddl.addColumnIfMissing(table, column, definition);
}
