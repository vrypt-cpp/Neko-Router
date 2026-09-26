/**
 * PostgreSQL schema.
 *
 * Deliberate choices, all of which differ from the SQLite build:
 *  - Timestamps and token counters are `bigint`, not `integer`. Postgres
 *    `integer` is 32-bit and epoch milliseconds (~1.8e12) would overflow it.
 *    `bigint` is returned as a JS number via `mode: "number"`, which is exact
 *    well past 2^53, so callers keep seeing plain numbers.
 *  - Flags stay `integer` 0/1 rather than `boolean` so a row read from
 *    Postgres is indistinguishable from one read from SQLite.
 *  - Free-form text uses `text`; there is no length limit to get wrong.
 */
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
} from "drizzle-orm/pg-core";

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  key: text("key").notNull().unique(),
  description: text("description"),
  isActive: integer("is_active").notNull().default(1),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  lastUsedAt: bigint("last_used_at", { mode: "number" }),
});

export const clientKeys = pgTable("client_keys", {
  id: text("id").primaryKey(),
  apiKeyId: text("api_key_id"),
  name: text("name").notNull(),
  key: text("key").notNull().unique(),
  isActive: integer("is_active").notNull().default(1),
  rateLimit: integer("rate_limit"),
  tokenLimit: bigint("token_limit", { mode: "number" }),
  usedTokens: bigint("used_tokens", { mode: "number" }).notNull().default(0),
  allowedProviders: text("allowed_providers").notNull().default("[]"),
  roundRobinProviders: integer("round_robin_providers").notNull().default(1),
  isFollowUpstream: integer("is_follow_upstream").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  lastUsedAt: bigint("last_used_at", { mode: "number" }),
});

export const upstreamKeys = pgTable("upstream_keys", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  prefix: text("prefix"),
  apiKey: text("api_key").notNull(),
  apiKeys: text("api_keys"),
  models: text("models"),
  baseUrl: text("base_url"),
  isActive: integer("is_active").notNull().default(1),
  roundRobin: integer("round_robin").notNull().default(1),
  weight: integer("weight").notNull().default(1),
  followUpstream: integer("follow_upstream").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const telemetryLogs = pgTable("telemetry_logs", {
  id: text("id").primaryKey(),
  clientKeyId: text("client_key_id"),
  clientKeyName: text("client_key_name"),
  upstreamKeyId: text("upstream_key_id"),
  provider: text("provider").notNull(),
  endpoint: text("endpoint").notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  cachedTokens: integer("cached_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  statusCode: integer("status_code").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  isStreaming: integer("is_streaming").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const responseCache = pgTable("response_cache", {
  hash: text("hash").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  responseJson: text("response_json").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});
