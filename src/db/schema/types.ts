/**
 * Dialect-independent row shapes.
 *
 * These are the types the application code programs against. Every dialect
 * schema (sqlite/pg/mysql) is deliberately built so its inferred row type is
 * assignable to the interfaces below, which is what lets the rest of the app
 * stay free of engine-specific branching.
 *
 * Conventions that must hold across all three dialects:
 *  - Flags are `0 | 1` numbers, never booleans. MySQL/Postgres could store real
 *    booleans, but keeping the representation uniform means a row read from
 *    Postgres behaves exactly like one read from SQLite.
 *  - Timestamps are epoch milliseconds in a 64-bit integer. Using JS `Date`
 *    columns would force timezone handling into every call site.
 *  - JSON payloads (model lists, key pools, cached bodies) are TEXT, matching
 *    the pre-existing encoding so existing rows keep working.
 */

export interface Setting {
  key: string;
  value: string;
  updatedAt: number;
}

export interface ApiKey {
  id: string;
  name: string;
  /** nr-api-xxxx — router integration / management API key. */
  key: string;
  description: string | null;
  isActive: number;
  createdAt: number;
  lastUsedAt: number | null;
}

export type InsertApiKey = Omit<ApiKey, "isActive" | "createdAt" | "lastUsedAt" | "description"> & {
  isActive?: number;
  createdAt?: number;
  lastUsedAt?: number | null;
  description?: string | null;
};

export interface ClientKey {
  id: string;
  /** Parent API key. One API key owns many secret keys. */
  apiKeyId: string | null;
  name: string;
  /** sk-neko-xxxx — secret key presented by AI proxy clients. */
  key: string;
  isActive: number;
  /** Requests per minute. */
  rateLimit: number | null;
  /** Maximum total tokens allowed. */
  tokenLimit: number | null;
  usedTokens: number;
  /** JSON string[] of allowed upstream ids. Default '[]' means none. */
  allowedProviders: string;
  /** 1 = round-robin across eligible providers, 0 = primary only. */
  roundRobinProviders: number;
  /** 1 = follow upstream pass-through mode. */
  isFollowUpstream: number;
  createdAt: number;
  lastUsedAt: number | null;
}

export type InsertClientKey = Omit<
  ClientKey,
  | "isActive"
  | "usedTokens"
  | "allowedProviders"
  | "roundRobinProviders"
  | "isFollowUpstream"
  | "createdAt"
  | "lastUsedAt"
  | "apiKeyId"
  | "rateLimit"
  | "tokenLimit"
> & {
  isActive?: number;
  usedTokens?: number;
  allowedProviders?: string;
  roundRobinProviders?: number;
  isFollowUpstream?: number;
  createdAt?: number;
  lastUsedAt?: number | null;
  apiKeyId?: string | null;
  rateLimit?: number | null;
  tokenLimit?: number | null;
};

export interface UpstreamKey {
  id: string;
  /** 'openai' | 'anthropic' | ... */
  provider: string;
  name: string;
  /** Custom provider prefix for model ids, e.g. 'ryzumi'. */
  prefix: string | null;
  apiKey: string;
  /** JSON string[] pool of keys for load balancing. */
  apiKeys: string | null;
  /** JSON array string of { id: string; name?: string; enabled: boolean }[]. */
  models: string | null;
  baseUrl: string | null;
  isActive: number;
  /** 1 = round-robin across active keys, 0 = primary/sequential. */
  roundRobin: number;
  weight: number;
  /** 1 = follow upstream pass-through & live models. */
  followUpstream: number;
  createdAt: number;
  updatedAt: number;
}

export type InsertUpstreamKey = Omit<
  UpstreamKey,
  | "isActive"
  | "roundRobin"
  | "weight"
  | "followUpstream"
  | "createdAt"
  | "updatedAt"
  | "prefix"
  | "apiKeys"
  | "models"
  | "baseUrl"
> & {
  isActive?: number;
  roundRobin?: number;
  weight?: number;
  followUpstream?: number;
  createdAt?: number;
  updatedAt?: number;
  prefix?: string | null;
  apiKeys?: string | null;
  models?: string | null;
  baseUrl?: string | null;
};

export interface TelemetryLog {
  id: string;
  clientKeyId: string | null;
  clientKeyName: string | null;
  upstreamKeyId: string | null;
  provider: string;
  endpoint: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  statusCode: number;
  durationMs: number;
  isStreaming: number;
  errorMessage: string | null;
  createdAt: number;
}

export type InsertTelemetryLog = Omit<
  TelemetryLog,
  | "id"
  | "clientKeyId"
  | "clientKeyName"
  | "upstreamKeyId"
  | "errorMessage"
> & {
  id?: string;
  clientKeyId?: string | null;
  clientKeyName?: string | null;
  upstreamKeyId?: string | null;
  errorMessage?: string | null;
};

export interface ResponseCache {
  hash: string;
  provider: string;
  model: string;
  responseJson: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: number;
  expiresAt: number;
}
