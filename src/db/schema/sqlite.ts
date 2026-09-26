/**
 * SQLite schema (default engine, backed by `bun:sqlite`).
 *
 * This is the dialect the application shipped with, so its column types are
 * unchanged from the original hand-written schema. Every `0 | 1` flag and epoch
 * millisecond timestamp is preserved to keep existing rows readable.
 */
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  key: text("key").notNull().unique(),
  description: text("description"),
  isActive: integer("is_active").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
});

export const clientKeys = sqliteTable("client_keys", {
  id: text("id").primaryKey(),
  apiKeyId: text("api_key_id"),
  name: text("name").notNull(),
  key: text("key").notNull().unique(),
  isActive: integer("is_active").notNull().default(1),
  rateLimit: integer("rate_limit"),
  tokenLimit: integer("token_limit"),
  usedTokens: integer("used_tokens").notNull().default(0),
  allowedProviders: text("allowed_providers").notNull().default("[]"),
  roundRobinProviders: integer("round_robin_providers").notNull().default(1),
  isFollowUpstream: integer("is_follow_upstream").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
});

export const upstreamKeys = sqliteTable("upstream_keys", {
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
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const telemetryLogs = sqliteTable("telemetry_logs", {
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
  createdAt: integer("created_at").notNull(),
});

export const responseCache = sqliteTable("response_cache", {
  hash: text("hash").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  responseJson: text("response_json").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
