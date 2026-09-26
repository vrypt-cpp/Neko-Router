import { db, getSetting, setSetting, getJwtSecretCached } from "../db";
import { clientKeys, apiKeys, type ClientKey, type ApiKey } from "../db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Returns the JWT signing secret.
 *
 * Fail-closed by design: if no secret has been bootstrapped we throw instead of
 * falling back to a hardcoded value. A predictable signing secret would let anyone
 * forge an admin session token, so a missing secret must never degrade silently.
 *
 * The value is read during `initDatabase()` and cached in memory, so this stays
 * synchronous: `@elysiajs/jwt` requires the secret when the plugin is
 * constructed, which happens while route modules are evaluated. That evaluation
 * is deliberately ordered after database initialization in src/index.ts.
 */
export function getJwtSecret(): string {
  try {
    return getJwtSecretCached();
  } catch (e) {
    throw new Error(
      "Unable to read the JWT secret from the database. Refusing to start with an insecure fallback.",
    );
  }
}

/**
 * True while the deployment still uses the seeded PIN (123456).
 *
 * Fails closed on error: treating an unreadable flag as "default" is the
 * safer direction, because the UI will then keep prompting the operator to
 * change it rather than silently dropping the warning.
 */
export async function isDefaultPin(): Promise<boolean> {
  try {
    const value = await getSetting("is_default_pin");
    return value === "1";
  } catch (e) {
    return true;
  }
}

export interface TurnstileConfig {
  siteKey: string;
  secretKey: string;
  enabled: boolean;
}

export async function getTurnstileConfig(): Promise<TurnstileConfig> {
  let siteKey = process.env.TURNSTILE_SITE_KEY || "";
  let secretKey = process.env.TURNSTILE_SECRET_KEY || "";

  try {
    const siteRow = await getSetting("turnstile_site_key");
    if (siteRow) siteKey = siteRow;

    const secretRow = await getSetting("turnstile_secret_key");
    if (secretRow) secretKey = secretRow;
  } catch (e) {
    // Environment variables remain the fallback source.
  }

  const enabled = Boolean(siteKey.trim() && secretKey.trim());
  return { siteKey: siteKey.trim(), secretKey: secretKey.trim(), enabled };
}

export async function verifyTurnstileToken(
  token: string,
  remoteIp?: string,
): Promise<{ success: boolean; error?: string }> {
  const { secretKey, enabled } = await getTurnstileConfig();
  if (!enabled) {
    return { success: true };
  }

  if (!token || !token.trim()) {
    return {
      success: false,
      error: "Cloudflare Turnstile verification is required",
    };
  }

  try {
    const formData = new URLSearchParams();
    formData.append("secret", secretKey);
    formData.append("response", token.trim());
    if (remoteIp) {
      formData.append("remoteip", remoteIp);
    }

    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: formData,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    const data = (await res.json()) as {
      success: boolean;
      "error-codes"?: string[];
    };

    if (data.success) {
      return { success: true };
    }

    console.warn("Turnstile siteverify failed:", data["error-codes"]);
    return {
      success: false,
      error: `Turnstile verification failed (${data["error-codes"]?.join(", ") || "invalid"})`,
    };
  } catch (e: any) {
    console.error("Turnstile request failed:", e);
    return {
      success: false,
      error: "Failed to connect to Cloudflare Turnstile service",
    };
  }
}

export async function verifyPin(pin: string): Promise<boolean> {
  try {
    const hash = await getSetting("auth_pin_hash");
    if (!hash) return false;
    return await Bun.password.verify(pin, hash);
  } catch (e) {
    console.error("Error verifying PIN:", e);
    return false;
  }
}

export async function changePin(
  currentPin: string,
  newPin: string,
): Promise<{ success: boolean; error?: string }> {
  if (!newPin || newPin.length < 6) {
    return { success: false, error: "New PIN must be at least 6 characters" };
  }

  const isValidCurrent = await verifyPin(currentPin);
  if (!isValidCurrent) {
    return { success: false, error: "Current PIN is incorrect" };
  }

  const newHash = await Bun.password.hash(newPin, {
    algorithm: "bcrypt",
    cost: 10,
  });

  await setSetting("auth_pin_hash", newHash);
  await setSetting("is_default_pin", "0");

  return { success: true };
}

export async function validateApiKey(
  providedKey: string,
): Promise<ApiKey | null> {
  if (!providedKey) return null;
  const keyRecord = (
    await db.select().from(apiKeys).where(eq(apiKeys.key, providedKey)).limit(1)
  )[0];

  if (!keyRecord || !keyRecord.isActive) {
    return null;
  }

  // Best-effort usage timestamp: a failure here must not deny a valid key.
  try {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: Date.now() })
      .where(eq(apiKeys.id, keyRecord.id as string));
  } catch (e) {}

  return keyRecord;
}

/**
 * Validates a client key against the keys explicitly registered in the database.
 *
 * Exact-match only, by design. A key authenticates if and only if an identical,
 * active row exists in `client_keys`. There is deliberately no fallback:
 *
 * - Unknown `sk-neko-` keys are rejected (callers must register keys first).
 * - Unknown non-`sk-neko-` keys are rejected too. Previously, any unregistered
 *   string was silently mapped onto a follow-upstream client key whenever a
 *   follow-upstream provider existed, which meant authentication could be
 *   bypassed with an arbitrary string such as "x". Upstream provider secrets
 *   must also never double as gateway credentials, so matching a supplied key
 *   against upstream `apiKey`/`apiKeys` pools is not attempted here.
 *
 * Pass-through / BYOK still works through explicit registration: the operator
 * creates a follow-upstream client key (e.g. `bb-default` or a custom key) and
 * clients present that exact registered key.
 */
export async function validateClientKey(
  providedKey: string,
): Promise<ClientKey | null> {
  if (!providedKey) return null;
  const keyRecord = (
    await db
      .select()
      .from(clientKeys)
      .where(eq(clientKeys.key, providedKey))
      .limit(1)
  )[0];

  if (!keyRecord || !keyRecord.isActive) {
    return null;
  }

  // Best-effort usage timestamp: a failure here must not deny a valid key.
  try {
    await db
      .update(clientKeys)
      .set({ lastUsedAt: Date.now() })
      .where(eq(clientKeys.id, keyRecord.id as string));
  } catch (e) {}
  return keyRecord;
}

/**
 * Adds `tokens` to a client key's running total.
 *
 * Expressed as a single `SET used_tokens = used_tokens + ?` rather than a
 * read-modify-write. The quota check in the proxy compares a *snapshot* of
 * `usedTokens` taken at request start, so a lost update here is not a cosmetic
 * rounding error: on a pooled engine two concurrent requests would both read
 * the same total and both write the same result, and the shortfall would let a
 * key exceed its `tokenLimit` by the amount that went missing. With SQLite the
 * single connection serialised these calls, which is why the read-then-write
 * form was correct there and is not correct on Postgres or MySQL.
 *
 * Callers on the proxy path do not await this; a rejection is logged and
 * swallowed, because losing a usage count must never fail the request being
 * served.
 */
export async function incrementClientKeyTokens(
  clientKeyId: string,
  tokens: number,
): Promise<void> {
  try {
    await db
      .update(clientKeys)
      .set({ usedTokens: sql`${clientKeys.usedTokens} + ${tokens}` })
      .where(eq(clientKeys.id, clientKeyId));
  } catch (e) {
    console.error("Failed to increment key tokens:", e);
  }
}

// In-memory sliding rate limiter per minute
const rateLimitMap = new Map<string, number[]>();

export function checkClientRateLimit(
  keyId: string,
  maxPerMinute?: number | null,
): boolean {
  if (!maxPerMinute || maxPerMinute <= 0) return true;
  const now = Date.now();
  const windowStart = now - 60000;

  const timestamps = (rateLimitMap.get(keyId) || []).filter(
    (t) => t > windowStart,
  );
  if (timestamps.length >= maxPerMinute) {
    return false;
  }
  timestamps.push(now);
  rateLimitMap.set(keyId, timestamps);
  return true;
}
