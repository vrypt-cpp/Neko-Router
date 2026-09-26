import {
  dbConfig,
  getSettingsByPrefix,
  setSetting,
  execute,
  query,
  queryOne,
} from "../db";

export interface OptimizationSettings {
  cacheEnabled: boolean;
  rtkCompression: boolean;
  cavemanMode: boolean;
  minifyPrompt: boolean;
  cacheTtlSeconds: number;
  httpsOnly: boolean;
  requestTimeoutSeconds: number;
  modelPrefixEnabled: boolean;
}

/**
 * Values applied when no row exists yet.
 *
 * `cacheEnabled` and `modelPrefixEnabled` default to true, which preserves the
 * original `!== "0"` comparison: an absent setting means enabled.
 */
export const DEFAULT_OPTIMIZATION_SETTINGS: OptimizationSettings = {
  cacheEnabled: true,
  rtkCompression: false,
  cavemanMode: false,
  minifyPrompt: false,
  cacheTtlSeconds: 3600,
  httpsOnly: false,
  requestTimeoutSeconds: 0,
  modelPrefixEnabled: true,
};

/**
 * Cached settings so the proxy hot path does not query the database per
 * request. Refreshed on write and on a short TTL, since an operator can also
 * edit these rows directly.
 */
let cachedSettings: OptimizationSettings = { ...DEFAULT_OPTIMIZATION_SETTINGS };
let cacheLoaded = false;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5_000;

function parseSettings(map: Map<string, string>): OptimizationSettings {
  const timeoutVal = parseInt(map.get("opt_request_timeout") || "0", 10);
  const ttlVal = parseInt(map.get("opt_cache_ttl") || "3600", 10);

  return {
    cacheEnabled: map.get("opt_cache_enabled") !== "0",
    rtkCompression: map.get("opt_rtk_compression") === "1",
    cavemanMode: map.get("opt_caveman_mode") === "1",
    minifyPrompt: map.get("opt_minify_prompt") === "1",
    cacheTtlSeconds: Number.isFinite(ttlVal) && ttlVal > 0 ? ttlVal : 3600,
    httpsOnly: map.get("opt_https_only") === "1",
    requestTimeoutSeconds: isNaN(timeoutVal) || timeoutVal < 0 ? 0 : timeoutVal,
    modelPrefixEnabled: map.get("opt_model_prefix_enabled") !== "0",
  };
}

/**
 * Reads the settings rows and refreshes the cache.
 *
 * Called on boot and whenever the cache expires. On a read failure the previous
 * values are retained: a transient error must not silently disable caching.
 */
export async function loadOptimizationSettings(): Promise<OptimizationSettings> {
  try {
    const map = await getSettingsByPrefix("opt_");
    cachedSettings = parseSettings(map);
  } catch (e) {
    // Keep whatever is cached (or the defaults) rather than losing them.
  }
  cacheLoaded = true;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedSettings;
}

/** Marks the cache stale so the next read reloads from the database. */
export function invalidateOptimizationSettings(): void {
  cacheLoaded = false;
  cacheExpiresAt = 0;
}

/**
 * Synchronous settings read for the proxy hot path.
 *
 * `optimizeRequestBody()` runs on every proxied request, so it must not await a
 * database round trip. It reads the cache, which is refreshed by
 * `getOptimizationSettings()` from request handlers.
 */
export function getOptimizationSettingsSync(): OptimizationSettings {
  return cachedSettings;
}

/**
 * Settings for handlers that can await a read, refreshing the cache when stale.
 */
export async function getOptimizationSettings(): Promise<OptimizationSettings> {
  if (cacheLoaded && Date.now() < cacheExpiresAt) {
    return cachedSettings;
  }
  return loadOptimizationSettings();
}

export function isHttpsRequest(request: Request): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.toLowerCase() === "https";
  }
  const forwardedSsl = request.headers.get("x-forwarded-ssl");
  if (forwardedSsl && forwardedSsl.toLowerCase() === "on") {
    return true;
  }
  try {
    const url = new URL(request.url);
    return url.protocol === "https:";
  } catch (e) {
    return false;
  }
}

export function checkHttpsRequirement(request: Request): Response | null {
  // Synchronous read: this runs per request on the proxy path.
  const opt = getOptimizationSettingsSync();
  if (!opt.httpsOnly) return null;

  if (!isHttpsRequest(request)) {
    return new Response(
      JSON.stringify({
        error: {
          message:
            "HTTPS is required by server policy. Unencrypted HTTP requests are rejected. Please use https:// or set 'X-Forwarded-Proto: https'.",
          type: "https_required",
          code: "https_only",
        },
      }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
  return null;
}

/**
 * Persists a partial settings update.
 *
 * Only the keys present in `settings` are written, so a partial PATCH leaves
 * the rest untouched. The cache is invalidated afterwards so the next read
 * reflects what was just written; the returned value is read back from the
 * database rather than assembled locally, so any server-side normalization is
 * reflected to the caller.
 */
export async function updateOptimizationSettings(
  settings: Partial<OptimizationSettings>
): Promise<OptimizationSettings> {
  const flag = (value: boolean) => (value ? "1" : "0");

  if (settings.cacheEnabled !== undefined) {
    await setSetting("opt_cache_enabled", flag(settings.cacheEnabled));
  }
  if (settings.rtkCompression !== undefined) {
    await setSetting("opt_rtk_compression", flag(settings.rtkCompression));
  }
  if (settings.cavemanMode !== undefined) {
    await setSetting("opt_caveman_mode", flag(settings.cavemanMode));
  }
  if (settings.minifyPrompt !== undefined) {
    await setSetting("opt_minify_prompt", flag(settings.minifyPrompt));
  }
  if (settings.cacheTtlSeconds !== undefined) {
    await setSetting("opt_cache_ttl", String(Math.max(60, settings.cacheTtlSeconds)));
  }
  if (settings.httpsOnly !== undefined) {
    await setSetting("opt_https_only", flag(settings.httpsOnly));
  }
  if (settings.requestTimeoutSeconds !== undefined) {
    const timeoutVal = Math.max(0, Math.floor(Number(settings.requestTimeoutSeconds) || 0));
    await setSetting("opt_request_timeout", String(timeoutVal));
  }
  if (settings.modelPrefixEnabled !== undefined) {
    await setSetting("opt_model_prefix_enabled", flag(settings.modelPrefixEnabled));
  }

  invalidateOptimizationSettings();
  return loadOptimizationSettings();
}

/**
 * RTK (Repeated Token Knowledge) Compression
 * Eliminates duplicate sentences, repeated words, and redundant whitespace bloat.
 */
export function applyRTKCompression(text: string): string {
  if (!text || text.length < 10) return text;

  // 1. Collapse multiple line breaks and trailing spaces
  let cleaned = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");

  // 2. Remove immediate duplicate consecutive lines
  const lines = cleaned.split("\n");
  const filteredLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const curr = lines[i]?.trim();
    const prev = filteredLines[filteredLines.length - 1]?.trim();
    if (curr && curr === prev) {
      continue; // skip duplicate repeated line
    }
    filteredLines.push(lines[i] ?? "");
  }

  return filteredLines.join("\n");
}

/**
 * Minify prompt: strip excessive whitespace and redundant padding
 */
export function minifyContent(text: string): string {
  if (!text) return text;
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l, idx, arr) => !(l.trim() === "" && arr[idx - 1]?.trim() === ""))
    .join("\n");
}

/**
 * Apply active global optimizations to OpenAI / Anthropic request payload
 */
export function optimizeRequestBody(body: any, provider: "openai" | "anthropic"): any {
  // Synchronous read: this function runs on every proxied request, so it must
  // not await a database round trip.
  const opt = getOptimizationSettingsSync();
  if (!opt.rtkCompression && !opt.cavemanMode && !opt.minifyPrompt) {
    return body;
  }

  const cloned = JSON.parse(JSON.stringify(body));

  // 1. Caveman Mode: Inject ultra-dense conciseness directive
  const cavemanInstruction =
    "Caveman Mode Active: Respond with extreme brevity and maximum density. Omit all pleasantries, preambles, greetings, apologies, and conversational fluff. Use telegram style where appropriate.";

  if (opt.cavemanMode) {
    if (provider === "openai" && Array.isArray(cloned.messages)) {
      const existingSystem = cloned.messages.find((m: any) => m.role === "system");
      if (existingSystem) {
        existingSystem.content = `${existingSystem.content}\n\n[DIRECTIVE: ${cavemanInstruction}]`;
      } else {
        cloned.messages.unshift({ role: "system", content: cavemanInstruction });
      }
    } else if (provider === "anthropic") {
      if (cloned.system) {
        cloned.system = `${cloned.system}\n\n[DIRECTIVE: ${cavemanInstruction}]`;
      } else {
        cloned.system = cavemanInstruction;
      }
    }
  }

  // 2. RTK Compression & Minification on User / Context messages
  if (opt.rtkCompression || opt.minifyPrompt) {
    if (Array.isArray(cloned.messages)) {
      for (const msg of cloned.messages) {
        if (typeof msg.content === "string") {
          if (opt.minifyPrompt) {
            msg.content = minifyContent(msg.content);
          }
          if (opt.rtkCompression) {
            msg.content = applyRTKCompression(msg.content);
          }
        }
      }
    }
  }

  return cloned;
}

/**
 * Exact Response Cache Helpers
 */

/** Deterministic JSON serialization: object keys sorted recursively, so
 *  semantically identical payloads always hash identically regardless of
 *  property insertion order. Returns null on (unexpected) failure. */
function stableStringify(value: any): string | null {
  try {
    const seen = new Set<object>();
    const sort = (v: any): any => {
      if (v === null || typeof v !== "object") return v;
      if (seen.has(v)) return "[circular]";
      seen.add(v);
      if (Array.isArray(v)) {
        const arr = v.map(sort);
        seen.delete(v);
        return arr;
      }
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) {
        const val = (v as Record<string, any>)[k];
        if (val !== undefined && typeof val !== "function") {
          out[k] = sort(val);
        }
      }
      seen.delete(v);
      return out;
    };
    const result = JSON.stringify(sort(value));
    return typeof result === "string" ? result : null;
  } catch (e) {
    return null;
  }
}

export interface CacheKeyParams {
  provider: string;
  model: string;
  /** Identity of the calling client key: the cache is partitioned per key so
   *  one tenant can never be served another tenant's cached response. */
  clientKeyId?: string | null;
  /** Identity of the selected upstream (id + base URL): the same prompt can
   *  legitimately produce different outputs on different providers. */
  upstreamId?: string | null;
  upstreamBaseUrl?: string | null;
  /** Full generation-affecting request payload (messages plus temperature,
   *  max_tokens, tools, thinking, response_format, stream flag, ...).
   *  Passing the whole body instead of cherry-picked fields guarantees a
   *  newly introduced parameter can never collide with an older entry. */
  body?: any;
}

/**
 * Computes the response-cache key. Every dimension that can change the
 * upstream's output — caller identity, selected upstream, model, and the
 * complete request payload — participates in the hash. Requests differing in
 * any of these dimensions never share a cache entry.
 */
export async function computeCacheKey(params: CacheKeyParams): Promise<string> {
  const normalized = {
    provider: params.provider,
    model: params.model,
    clientKeyId: params.clientKeyId ?? null,
    upstreamId: params.upstreamId ?? null,
    upstreamBaseUrl: params.upstreamBaseUrl ?? null,
    body: params.body ?? null,
  };
  const payload = stableStringify(normalized) ?? JSON.stringify(normalized);
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload)
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Reads a cached response.
 *
 * An expired entry is deleted on read and reported as a miss. Returns null on
 * any error: a cache problem must degrade to a real upstream call, never fail
 * the request.
 */
export async function getCachedResponse(hash: string): Promise<{
  responseJson: any;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} | null> {
  try {
    const now = Date.now();
    const row = await queryOne<{
      response_json: string;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      expires_at: number;
    }>(
      "SELECT response_json, prompt_tokens, completion_tokens, total_tokens, expires_at FROM response_cache WHERE hash = ?",
      [hash]
    );

    if (!row) return null;
    if (Number(row.expires_at) < now) {
      await execute("DELETE FROM response_cache WHERE hash = ?", [hash]);
      return null;
    }

    return {
      responseJson: JSON.parse(row.response_json),
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      totalTokens: Number(row.total_tokens),
    };
  } catch (e) {
    return null;
  }
}

/**
 * Stores a response in the cache, replacing any existing entry for the hash.
 *
 * The upsert form differs per engine, so the statement is selected by dialect
 * rather than emulated with a delete-then-insert (which would leave a window
 * with no entry and race with concurrent readers).
 */
export async function setCachedResponse(
  hash: string,
  provider: string,
  model: string,
  responseObj: any,
  promptTokens: number,
  completionTokens: number,
  ttlSeconds = 3600
): Promise<void> {
  try {
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    const jsonStr = JSON.stringify(responseObj);
    const total = promptTokens + completionTokens;

    const assignments = [
      "provider = ?",
      "model = ?",
      "response_json = ?",
      "prompt_tokens = ?",
      "completion_tokens = ?",
      "total_tokens = ?",
      "expires_at = ?",
    ].join(", ");

    if (dbConfig.dialect === "postgresql") {
      await execute(
        `INSERT INTO response_cache (hash, provider, model, response_json, prompt_tokens, completion_tokens, total_tokens, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hash) DO UPDATE SET ${assignments}`,
        [
          hash,
          provider,
          model,
          jsonStr,
          promptTokens,
          completionTokens,
          total,
          now,
          expiresAt,
        ]
      );
    } else if (dbConfig.dialect === "mysql") {
      // MySQL has no `excluded`; VALUES() refers to the proposed row.
      await execute(
        `INSERT INTO response_cache (hash, provider, model, response_json, prompt_tokens, completion_tokens, total_tokens, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           provider = VALUES(provider),
           model = VALUES(model),
           response_json = VALUES(response_json),
           prompt_tokens = VALUES(prompt_tokens),
           completion_tokens = VALUES(completion_tokens),
           total_tokens = VALUES(total_tokens),
           expires_at = VALUES(expires_at)`,
        [
          hash,
          provider,
          model,
          jsonStr,
          promptTokens,
          completionTokens,
          total,
          now,
          expiresAt,
        ]
      );
    } else {
      await execute(
        `INSERT INTO response_cache (hash, provider, model, response_json, prompt_tokens, completion_tokens, total_tokens, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET ${assignments}`,
        [
          hash,
          provider,
          model,
          jsonStr,
          promptTokens,
          completionTokens,
          total,
          now,
          expiresAt,
        ]
      );
    }
  } catch (e) {
    // A failed cache write must not fail the request being served.
    console.error("Failed to save response cache:", e);
  }
}

/** Empties the response cache and reports how many rows were removed. */
export async function clearResponseCache(): Promise<{ cleared: number }> {
  try {
    const row = await queryOne<{ count: number }>(
      "SELECT count(*) as count FROM response_cache"
    );
    const count = Number(row?.count ?? 0);
    await execute("DELETE FROM response_cache");
    return { cleared: count };
  } catch (e) {
    return { cleared: 0 };
  }
}

/** Deletes expired cache entries. Intended to be called on a timer. */
export async function purgeExpiredCacheEntries(): Promise<number> {
  try {
    const row = await queryOne<{ count: number }>(
      "SELECT count(*) as count FROM response_cache WHERE expires_at < ?",
      [Date.now()]
    );
    const count = Number(row?.count ?? 0);
    if (count > 0) {
      await execute("DELETE FROM response_cache WHERE expires_at < ?", [Date.now()]);
    }
    return count;
  } catch (e) {
    return 0;
  }
}
