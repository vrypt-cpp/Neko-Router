import { sqlite, db } from "../db";
import { clientKeys, apiKeys, type ClientKey, type ApiKey } from "../db/schema";
import { eq } from "drizzle-orm";

/**
 * Returns the JWT signing secret.
 *
 * Fail-closed by design: if no secret has been bootstrapped we throw instead of
 * falling back to a hardcoded value. A predictable signing secret would let anyone
 * forge an admin session token, so a missing secret must never degrade silently.
 *
 * The secret is bootstrapped synchronously in src/db/index.ts (see ensureJwtSecretSync),
 * which is guaranteed to run before any route module reads this value.
 */
export function getJwtSecret(): string {
  let row: { value: string } | null = null;
  try {
    row = sqlite
      .query("SELECT value FROM settings WHERE key = 'jwt_secret'")
      .get() as { value: string } | null;
  } catch (e) {
    throw new Error(
      "Unable to read the JWT secret from the database. Refusing to start with an insecure fallback."
    );
  }

  if (!row?.value) {
    throw new Error(
      "JWT secret is not initialized. Refusing to sign or verify tokens with a predictable secret."
    );
  }

  return row.value;
}

export function isDefaultPin(): boolean {
  try {
    const row = sqlite
      .query("SELECT value FROM settings WHERE key = 'is_default_pin'")
      .get() as { value: string } | null;
    return row?.value === "1";
  } catch (e) {
    return true;
  }
}

export function getTurnstileConfig(): {
  siteKey: string;
  secretKey: string;
  enabled: boolean;
} {
  let siteKey = process.env.TURNSTILE_SITE_KEY || "";
  let secretKey = process.env.TURNSTILE_SECRET_KEY || "";

  try {
    const siteRow = sqlite
      .query("SELECT value FROM settings WHERE key = 'turnstile_site_key'")
      .get() as { value: string } | null;
    if (siteRow?.value) siteKey = siteRow.value;

    const secretRow = sqlite
      .query("SELECT value FROM settings WHERE key = 'turnstile_secret_key'")
      .get() as { value: string } | null;
    if (secretRow?.value) secretKey = secretRow.value;
  } catch (e) {
    // ignore
  }

  const enabled = Boolean(siteKey.trim() && secretKey.trim());
  return { siteKey: siteKey.trim(), secretKey: secretKey.trim(), enabled };
}

export async function verifyTurnstileToken(
  token: string,
  remoteIp?: string
): Promise<{ success: boolean; error?: string }> {
  const { secretKey, enabled } = getTurnstileConfig();
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
      }
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
    const row = sqlite
      .query("SELECT value FROM settings WHERE key = 'auth_pin_hash'")
      .get() as { value: string } | null;
    if (!row?.value) return false;
    return await Bun.password.verify(pin, row.value);
  } catch (e) {
    console.error("Error verifying PIN:", e);
    return false;
  }
}

export async function changePin(
  currentPin: string,
  newPin: string
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

  const now = Date.now();
  sqlite.run(
    "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'auth_pin_hash'",
    [newHash, now]
  );
  sqlite.run(
    "UPDATE settings SET value = '0', updated_at = ? WHERE key = 'is_default_pin'",
    [now]
  );

  return { success: true };
}

export async function validateApiKey(
  providedKey: string
): Promise<ApiKey | null> {
  if (!providedKey) return null;
  const keyRecord = db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.key, providedKey))
    .get();

  if (!keyRecord || !keyRecord.isActive) {
    return null;
  }

  try {
    db.update(apiKeys)
      .set({ lastUsedAt: Date.now() })
      .where(eq(apiKeys.id, keyRecord.id))
      .run();
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
  providedKey: string
): Promise<ClientKey | null> {
  if (!providedKey) return null;
  const keyRecord = db
    .select()
    .from(clientKeys)
    .where(eq(clientKeys.key, providedKey))
    .get();

  if (!keyRecord || !keyRecord.isActive) {
    return null;
  }

  // Update lastUsedAt asynchronously
  try {
    db.update(clientKeys)
      .set({ lastUsedAt: Date.now() })
      .where(eq(clientKeys.id, keyRecord.id))
      .run();
  } catch (e) {}
  return keyRecord;
}

export function incrementClientKeyTokens(clientKeyId: string, tokens: number): void {
  try {
    sqlite.run(
      "UPDATE client_keys SET used_tokens = used_tokens + ? WHERE id = ?",
      [tokens, clientKeyId]
    );
  } catch (e) {
    console.error("Failed to increment key tokens:", e);
  }
}

// In-memory sliding rate limiter per minute
const rateLimitMap = new Map<string, number[]>();

export function checkClientRateLimit(keyId: string, maxPerMinute?: number | null): boolean {
  if (!maxPerMinute || maxPerMinute <= 0) return true;
  const now = Date.now();
  const windowStart = now - 60000;

  const timestamps = (rateLimitMap.get(keyId) || []).filter((t) => t > windowStart);
  if (timestamps.length >= maxPerMinute) {
    return false;
  }
  timestamps.push(now);
  rateLimitMap.set(keyId, timestamps);
  return true;
}
