/**
 * MySQL / MariaDB schema.
 *
 * MySQL is the most constrained of the three engines, so this file carries the
 * most dialect-specific decisions:
 *  - Every string column is `varchar(n)` with an explicit length. MySQL cannot
 *    index a bare `TEXT` column without a prefix length, and the unique
 *    constraints on `api_keys.key` / `client_keys.key` require an index.
 *  - LONGTEXT is used for unbounded payloads (cached responses, model lists)
 *    because a cached completion can far exceed varchar limits. Rows of this
 *    type are not indexed, so no prefix length is needed.
 *  - Timestamps are `bigint` in JS-number mode; MySQL `int` is only 32-bit and
 *    would overflow on epoch milliseconds.
 *  - Table and column identifiers are snake_case, matching the other dialects,
 *    so raw SQL written against any of them behaves the same.
 */
import {
  mysqlTable,
  varchar,
  int,
  bigint,
  longtext,
  mediumtext,
  index,
} from "drizzle-orm/mysql-core";

export const settings = mysqlTable("settings", {
  key: varchar("key", { length: 191 }).primaryKey(),
  value: mediumtext("value").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const apiKeys = mysqlTable("api_keys", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  key: varchar("key", { length: 191 }).notNull().unique(),
  description: varchar("description", { length: 1024 }),
  isActive: int("is_active").notNull().default(1),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  lastUsedAt: bigint("last_used_at", { mode: "number" }),
});

export const clientKeys = mysqlTable(
  "client_keys",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    apiKeyId: varchar("api_key_id", { length: 64 }),
    name: varchar("name", { length: 255 }).notNull(),
    key: varchar("key", { length: 191 }).notNull().unique(),
    isActive: int("is_active").notNull().default(1),
    rateLimit: int("rate_limit"),
    tokenLimit: bigint("token_limit", { mode: "number" }),
    usedTokens: bigint("used_tokens", { mode: "number" }).notNull().default(0),
    allowedProviders: mediumtext("allowed_providers").notNull().default("[]"),
    roundRobinProviders: int("round_robin_providers").notNull().default(1),
    isFollowUpstream: int("is_follow_upstream").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    lastUsedAt: bigint("last_used_at", { mode: "number" }),
  },
  (t) => [index("idx_client_keys_api_key_id").on(t.apiKeyId)]
);

export const upstreamKeys = mysqlTable(
  "upstream_keys",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    provider: varchar("provider", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    prefix: varchar("prefix", { length: 191 }),
    apiKey: mediumtext("api_key").notNull(),
    apiKeys: longtext("api_keys"),
    models: longtext("models"),
    baseUrl: varchar("base_url", { length: 1024 }),
    isActive: int("is_active").notNull().default(1),
    roundRobin: int("round_robin").notNull().default(1),
    weight: int("weight").notNull().default(1),
    followUpstream: int("follow_upstream").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_upstream_keys_provider").on(t.provider)]
);

export const telemetryLogs = mysqlTable(
  "telemetry_logs",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    clientKeyId: varchar("client_key_id", { length: 64 }),
    clientKeyName: varchar("client_key_name", { length: 255 }),
    upstreamKeyId: varchar("upstream_key_id", { length: 64 }),
    provider: varchar("provider", { length: 64 }).notNull(),
    endpoint: varchar("endpoint", { length: 255 }).notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    promptTokens: int("prompt_tokens").notNull().default(0),
    completionTokens: int("completion_tokens").notNull().default(0),
    cachedTokens: int("cached_tokens").notNull().default(0),
    totalTokens: int("total_tokens").notNull().default(0),
    statusCode: int("status_code").notNull(),
    durationMs: int("duration_ms").notNull().default(0),
    isStreaming: int("is_streaming").notNull().default(0),
    errorMessage: mediumtext("error_message"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_telemetry_created_at").on(t.createdAt),
    index("idx_telemetry_client_key").on(t.clientKeyId),
    index("idx_telemetry_provider").on(t.provider),
  ]
);

export const responseCache = mysqlTable(
  "response_cache",
  {
    hash: varchar("hash", { length: 191 }).primaryKey(),
    provider: varchar("provider", { length: 64 }).notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    responseJson: longtext("response_json").notNull(),
    promptTokens: int("prompt_tokens").notNull().default(0),
    completionTokens: int("completion_tokens").notNull().default(0),
    totalTokens: int("total_tokens").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_response_cache_expires").on(t.expiresAt)]
);
