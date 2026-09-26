import { Elysia, t } from "elysia";
import { db, fetchAll, fetchOne, runStatement } from "../db";
import { clientKeys, apiKeys, telemetryLogs, upstreamKeys } from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { eq, desc, sql } from "drizzle-orm";

async function getFollowUpstreamIds(): Promise<Set<string>> {
  const rows = await fetchAll(db
    .select({ id: upstreamKeys.id })
    .from(upstreamKeys)
    .where(eq(upstreamKeys.followUpstream, 1)));
  const set = new Set(rows.map((r) => r.id));
  set.add("up_bandelbanget_follow");
  set.add("bb");
  return set;
}

function generateKeyString(custom?: string): string {
  if (custom && custom.trim().length > 0) {
    const trimmed = custom.trim();
    if (trimmed.startsWith("sk-neko-")) return trimmed;
    if (trimmed.startsWith("sk-")) {
      return `sk-neko-${trimmed.slice(3)}`;
    }
    return `sk-neko-${trimmed}`;
  }
  const random = Array.from(crypto.getRandomValues(new Uint8Array(20)))
    .map((b) => b.toString(36))
    .join("")
    .slice(0, 28);
  return `sk-neko-${random}`;
}

export const keysRoutes = new Elysia({ prefix: "/api/keys" })
  .use(authMiddleware)
  .onBeforeHandle(({ isAdmin, apiKey, set }) => {
    if (!isAdmin && !apiKey) {
      set.status = 401;
      return { error: "Unauthorized access to Secret Keys" };
    }
  })
  .get("/", async () => {
    const list = await fetchAll(db
      .select({
        id: clientKeys.id,
        apiKeyId: clientKeys.apiKeyId,
        apiKeyName: apiKeys.name,
        name: clientKeys.name,
        key: clientKeys.key,
        isActive: clientKeys.isActive,
        rateLimit: clientKeys.rateLimit,
        tokenLimit: clientKeys.tokenLimit,
        usedTokens: clientKeys.usedTokens,
        allowedProviders: clientKeys.allowedProviders,
        roundRobinProviders: clientKeys.roundRobinProviders,
        isFollowUpstream: clientKeys.isFollowUpstream,
        createdAt: clientKeys.createdAt,
        lastUsedAt: clientKeys.lastUsedAt,
        totalRequests: sql<number>`(SELECT count(*) FROM ${telemetryLogs} WHERE ${telemetryLogs.clientKeyId} = ${clientKeys.id})`,
        totalTokens: sql<number>`(SELECT coalesce(sum(${telemetryLogs.totalTokens}), 0) FROM ${telemetryLogs} WHERE ${telemetryLogs.clientKeyId} = ${clientKeys.id})`,
      })
      .from(clientKeys)
      .leftJoin(apiKeys, eq(clientKeys.apiKeyId, apiKeys.id))
      .orderBy(desc(clientKeys.createdAt)));

    return {
      keys: list.map((k) => {
        let allowedList: string[] = [];
        try {
          if (k.allowedProviders) allowedList = JSON.parse(k.allowedProviders);
        } catch (e) {}

        // Filter ghost non-upstream IDs like "openai"
        allowedList = (Array.isArray(allowedList) ? allowedList : []).filter((p) => p !== "openai");

        return {
          ...k,
          apiKeyId: k.apiKeyId || null,
          apiKeyName: k.apiKeyName || "Unassigned",
          allowedProviders: allowedList,
          roundRobinProviders: k.roundRobinProviders !== 0,
          isFollowUpstream: Boolean(k.isFollowUpstream),
          displayKey:
            k.key.length > 14
              ? `${k.key.slice(0, 10)}...${k.key.slice(-4)}`
              : k.key,
        };
      }),
    };
  })
  .post(
    "/",
    async ({ body, set }) => {
      const { name, apiKeyId, customKey, tokenLimit, rateLimit, allowedProviders, roundRobinProviders, isFollowUpstream } = body;

      const id = "ck_" + crypto.randomUUID().replace(/-/g, "");
      let keyStr: string;

      const followIds = await getFollowUpstreamIds();
      let allowedArr = (Array.isArray(allowedProviders) ? allowedProviders : []).filter((p) => p !== "openai");
      const hasFollow = allowedArr.some((p) => followIds.has(p));
      const isFollow = Boolean(isFollowUpstream) || hasFollow;

      if (isFollow) {
        // Exclusivity: Pass-through cannot be mixed with normal providers
        allowedArr = allowedArr.filter((p: string) => followIds.has(p));
        if (allowedArr.length === 0) {
          const firstFollow = Array.from(followIds)[0] || "up_bandelbanget_follow";
          allowedArr = [firstFollow];
        }

        // Follow Upstream mode: Key is NOT randomly generated with sk-neko- prefix
        // Uses default BB key or valid BB key pass-through
        if (customKey && customKey.trim().length > 0) {
          keyStr = customKey.trim();
        } else {
          // Check if bb-default is taken, if so use bb-default-<id-slice>
          const existingDefault = await fetchOne(db.select().from(clientKeys).where(eq(clientKeys.key, "bb-default")));
          keyStr = existingDefault ? `bb-default-${id.slice(3, 8)}` : "bb-default";
        }
      } else {
        allowedArr = allowedArr.filter((p: string) => !followIds.has(p));
        keyStr = generateKeyString(customKey);
      }

      // Check duplicate
      const existing = await fetchOne(db
        .select()
        .from(clientKeys)
        .where(eq(clientKeys.key, keyStr)));

      if (existing) {
        set.status = 400;
        return { error: "API Key already exists" };
      }

      let assignedApiKeyId = apiKeyId;
      if (assignedApiKeyId) {
        const parentKey = await fetchOne(db.select().from(apiKeys).where(eq(apiKeys.id, assignedApiKeyId)));
        if (!parentKey) {
          set.status = 400;
          return { error: "Specified Router API Key not found" };
        }
      } else {
        // Assign to first existing API Key, or create default API Key if none exists
        const firstApiKey = await fetchOne(db.select().from(apiKeys).limit(1));
        if (firstApiKey) {
          assignedApiKeyId = firstApiKey.id;
        } else {
          const defaultId = "ak_" + crypto.randomUUID().replace(/-/g, "");
          const randomSuffix = Array.from(crypto.getRandomValues(new Uint8Array(20)))
            .map((b) => b.toString(36))
            .join("")
            .slice(0, 24);
          await runStatement(db.insert(apiKeys)
            .values({
              id: defaultId,
              name: "Default API Key",
              key: `nr-api-${randomSuffix}`,
              description: "Default Router Integration Key",
              isActive: 1,
              createdAt: Date.now(),
              lastUsedAt: null,
            }));
          assignedApiKeyId = defaultId;
        }
      }

      const now = Date.now();

      await runStatement(db.insert(clientKeys)
        .values({
          id,
          apiKeyId: assignedApiKeyId,
          name: name.trim(),
          key: keyStr,
          isActive: 1,
          rateLimit: rateLimit ?? null,
          tokenLimit: tokenLimit && tokenLimit > 0 ? tokenLimit : null,
          usedTokens: 0,
          allowedProviders: JSON.stringify(allowedArr),
          roundRobinProviders: roundRobinProviders !== false ? 1 : 0,
          isFollowUpstream: isFollow ? 1 : 0,
          createdAt: now,
          lastUsedAt: null,
        }));

      const parentKeyRecord = await fetchOne(db.select().from(apiKeys).where(eq(apiKeys.id, assignedApiKeyId)));

      return {
        success: true,
        key: {
          id,
          apiKeyId: assignedApiKeyId,
          apiKeyName: parentKeyRecord?.name || "Default API Key",
          name: name.trim(),
          key: keyStr,
          isActive: 1,
          rateLimit: rateLimit ?? null,
          tokenLimit: tokenLimit && tokenLimit > 0 ? tokenLimit : null,
          usedTokens: 0,
          allowedProviders: allowedArr,
          roundRobinProviders: roundRobinProviders !== false,
          isFollowUpstream: isFollow,
          createdAt: now,
        },
      };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        apiKeyId: t.Optional(t.String()),
        customKey: t.Optional(t.String()),
        tokenLimit: t.Optional(t.Nullable(t.Number())),
        rateLimit: t.Optional(t.Nullable(t.Number())),
        allowedProviders: t.Optional(t.Array(t.String())),
        roundRobinProviders: t.Optional(t.Boolean()),
        isFollowUpstream: t.Optional(t.Boolean()),
      }),
    }
  )
  .patch(
    "/:id",
    async ({ params: { id }, body, set }) => {
      const existing = await fetchOne(db
        .select()
        .from(clientKeys)
        .where(eq(clientKeys.id, id)));

      if (!existing) {
        set.status = 404;
        return { error: "Key not found" };
      }

      const updateData: Partial<typeof clientKeys.$inferInsert> = {};
      if (body.name !== undefined) updateData.name = body.name.trim();
      if (body.apiKeyId !== undefined) {
        if (body.apiKeyId) {
          const parent = await fetchOne(db.select().from(apiKeys).where(eq(apiKeys.id, body.apiKeyId)));
          if (!parent) {
            set.status = 400;
            return { error: "Parent Router API Key not found" };
          }
          updateData.apiKeyId = body.apiKeyId;
        } else {
          updateData.apiKeyId = null;
        }
      }
      if (body.isActive !== undefined) updateData.isActive = body.isActive ? 1 : 0;
      if (body.rateLimit !== undefined) {
        updateData.rateLimit = body.rateLimit !== null && body.rateLimit > 0 ? Math.floor(body.rateLimit) : null;
      }
      if (body.tokenLimit !== undefined) {
        updateData.tokenLimit = body.tokenLimit !== null && body.tokenLimit > 0 ? Math.floor(body.tokenLimit) : null;
      }
      if (body.adjustTokenLimit !== undefined) {
        const currentLimit = existing.tokenLimit || 0;
        const newLimit = currentLimit + body.adjustTokenLimit;
        updateData.tokenLimit = newLimit > 0 ? Math.floor(newLimit) : null;
      }
      if (body.allowedProviders !== undefined) {
        const followIds = await getFollowUpstreamIds();
        let arr = (Array.isArray(body.allowedProviders) ? body.allowedProviders : []).filter((p) => p !== "openai");
        const hasFollow = arr.some((p) => followIds.has(p));
        if (hasFollow) {
          arr = arr.filter((p: string) => followIds.has(p));
          updateData.isFollowUpstream = 1;
        } else {
          arr = arr.filter((p: string) => !followIds.has(p));
          updateData.isFollowUpstream = 0;
        }
        updateData.allowedProviders = JSON.stringify(arr);
      }
      if (body.roundRobinProviders !== undefined) {
        updateData.roundRobinProviders = body.roundRobinProviders ? 1 : 0;
      }
      if (body.resetUsedTokens === true) {
        updateData.usedTokens = 0;
      } else if (body.usedTokens !== undefined) {
        updateData.usedTokens = Math.max(0, Math.floor(body.usedTokens));
      } else if (body.adjustTokens !== undefined) {
        updateData.usedTokens = Math.max(0, Math.floor((existing.usedTokens || 0) + body.adjustTokens));
      }

      await runStatement(db.update(clientKeys)
        .set(updateData)
        .where(eq(clientKeys.id, id)));

      const updated = await fetchOne(db.select().from(clientKeys).where(eq(clientKeys.id, id)));

      return { success: true, key: updated };
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        apiKeyId: t.Optional(t.Nullable(t.String())),
        isActive: t.Optional(t.Boolean()),
        tokenLimit: t.Optional(t.Nullable(t.Number())),
        rateLimit: t.Optional(t.Nullable(t.Number())),
        adjustTokenLimit: t.Optional(t.Number()),
        usedTokens: t.Optional(t.Number()),
        adjustTokens: t.Optional(t.Number()),
        resetUsedTokens: t.Optional(t.Boolean()),
        allowedProviders: t.Optional(t.Array(t.String())),
        roundRobinProviders: t.Optional(t.Boolean()),
      }),
    }
  )
  .post(
    "/:id/rotate",
    async ({ params: { id }, body, set }) => {
      const existing = await fetchOne(db
        .select()
        .from(clientKeys)
        .where(eq(clientKeys.id, id)));

      if (!existing) {
        set.status = 404;
        return { error: "Key not found" };
      }

      const customKey = body?.customKey;
      const newKeyStr = generateKeyString(customKey);

      const duplicate = await fetchOne(db
        .select()
        .from(clientKeys)
        .where(eq(clientKeys.key, newKeyStr)));

      if (duplicate && duplicate.id !== id) {
        set.status = 400;
        return { error: "API Key string already exists" };
      }

      await runStatement(db.update(clientKeys)
        .set({ key: newKeyStr })
        .where(eq(clientKeys.id, id)));

      const displayKey =
        newKeyStr.length > 14
          ? `${newKeyStr.slice(0, 10)}...${newKeyStr.slice(-4)}`
          : newKeyStr;

      return {
        success: true,
        message: "Secret key rotated successfully",
        key: newKeyStr,
        displayKey,
      };
    },
    {
      body: t.Optional(
        t.Object({
          customKey: t.Optional(t.String()),
        })
      ),
    }
  )
  .post(
    "/:id/regenerate",
    async ({ params: { id }, body, set }) => {
      const existing = await fetchOne(db
        .select()
        .from(clientKeys)
        .where(eq(clientKeys.id, id)));

      if (!existing) {
        set.status = 404;
        return { error: "Key not found" };
      }

      const customKey = body?.customKey;
      const newKeyStr = generateKeyString(customKey);

      const duplicate = await fetchOne(db
        .select()
        .from(clientKeys)
        .where(eq(clientKeys.key, newKeyStr)));

      if (duplicate && duplicate.id !== id) {
        set.status = 400;
        return { error: "API Key string already exists" };
      }

      await runStatement(db.update(clientKeys)
        .set({ key: newKeyStr })
        .where(eq(clientKeys.id, id)));

      const displayKey =
        newKeyStr.length > 14
          ? `${newKeyStr.slice(0, 10)}...${newKeyStr.slice(-4)}`
          : newKeyStr;

      return {
        success: true,
        message: "Secret key regenerated successfully",
        key: newKeyStr,
        displayKey,
      };
    },
    {
      body: t.Optional(
        t.Object({
          customKey: t.Optional(t.String()),
        })
      ),
    }
  )
  .post(
    "/:id/adjust-quota",
    async ({ params: { id }, body, set }) => {
      const existing = await fetchOne(db
        .select()
        .from(clientKeys)
        .where(eq(clientKeys.id, id)));

      if (!existing) {
        set.status = 404;
        return { error: "Key not found" };
      }

      const updateData: Partial<typeof clientKeys.$inferInsert> = {};

      if (body.deltaTokenLimit !== undefined) {
        const current = existing.tokenLimit || 0;
        const next = current + body.deltaTokenLimit;
        updateData.tokenLimit = next > 0 ? Math.floor(next) : null;
      }
      if (body.setTokenLimit !== undefined) {
        updateData.tokenLimit =
          body.setTokenLimit !== null && body.setTokenLimit > 0
            ? Math.floor(body.setTokenLimit)
            : null;
      }
      if (body.deltaUsedTokens !== undefined) {
        updateData.usedTokens = Math.max(
          0,
          Math.floor((existing.usedTokens || 0) + body.deltaUsedTokens)
        );
      }
      if (body.setUsedTokens !== undefined) {
        updateData.usedTokens = Math.max(0, Math.floor(body.setUsedTokens));
      }
      if (body.resetUsed === true) {
        updateData.usedTokens = 0;
      }
      if (body.setRateLimit !== undefined) {
        updateData.rateLimit =
          body.setRateLimit !== null && body.setRateLimit > 0
            ? Math.floor(body.setRateLimit)
            : null;
      }

      await runStatement(db.update(clientKeys)
        .set(updateData)
        .where(eq(clientKeys.id, id)));

      const updated = await fetchOne(db.select().from(clientKeys).where(eq(clientKeys.id, id)));

      return {
        success: true,
        message: "Key quota and limits updated successfully",
        key: updated,
      };
    },
    {
      body: t.Object({
        deltaTokenLimit: t.Optional(t.Number()),
        setTokenLimit: t.Optional(t.Nullable(t.Number())),
        deltaUsedTokens: t.Optional(t.Number()),
        setUsedTokens: t.Optional(t.Number()),
        resetUsed: t.Optional(t.Boolean()),
        setRateLimit: t.Optional(t.Nullable(t.Number())),
      }),
    }
  )
  .post("/:id/reset-quota", async ({ params: { id }, set }) => {
    const existing = await fetchOne(db
      .select()
      .from(clientKeys)
      .where(eq(clientKeys.id, id)));

    if (!existing) {
      set.status = 404;
      return { error: "Key not found" };
    }

    await runStatement(db.update(clientKeys)
      .set({ usedTokens: 0 })
      .where(eq(clientKeys.id, id)));

    return { success: true, message: "Token quota usage reset to 0" };
  })
  .post(
    "/:id/toggle-provider",
    async ({ params: { id }, body, set }) => {
      const existing = await fetchOne(db
        .select()
        .from(clientKeys)
        .where(eq(clientKeys.id, id)));

      if (!existing) {
        set.status = 404;
        return { success: false, error: "Key not found" };
      }

      const followIds = await getFollowUpstreamIds();
      let currentAllowed: string[] = [];
      try {
        if (existing.allowedProviders) currentAllowed = JSON.parse(existing.allowedProviders);
      } catch (e) {}
      currentAllowed = currentAllowed.filter((p) => p !== "openai");

      let updatedAllowed: string[];
      const providerId = body.providerId;
      const isTargetFollow = followIds.has(providerId);

      const willAllow = body.allowed !== undefined ? body.allowed : !currentAllowed.includes(providerId);

      if (willAllow) {
        if (isTargetFollow) {
          // Exclusivity: Pass-through cannot be mixed with normal providers
          updatedAllowed = [providerId];
        } else {
          // Normal provider: remove any pass-through
          const nonFollow = currentAllowed.filter((p) => !followIds.has(p));
          updatedAllowed = nonFollow.includes(providerId) ? nonFollow : [...nonFollow, providerId];
        }
      } else {
        updatedAllowed = currentAllowed.filter((p) => p !== providerId);
      }

      const hasFollow = updatedAllowed.some((p) => followIds.has(p));

      await runStatement(db.update(clientKeys)
        .set({
          allowedProviders: JSON.stringify(updatedAllowed),
          isFollowUpstream: hasFollow ? 1 : 0,
        })
        .where(eq(clientKeys.id, id)));

      return {
        success: true,
        allowedProviders: updatedAllowed,
      };
    },
    {
      body: t.Object({
        providerId: t.String(),
        allowed: t.Optional(t.Boolean()),
      }),
    }
  )
  .post(
    "/batch-delete",
    async ({ body, set }) => {
      const { ids } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        set.status = 400;
        return { error: "No key IDs provided" };
      }
      for (const id of ids) {
        await runStatement(db.delete(clientKeys).where(eq(clientKeys.id, id)));
      }
      return { success: true, deletedCount: ids.length };
    },
    {
      body: t.Object({
        ids: t.Array(t.String()),
      }),
    }
  )
  .delete("/:id", async ({ params: { id }, set }) => {
    const existing = await fetchOne(db
      .select()
      .from(clientKeys)
      .where(eq(clientKeys.id, id)));

    if (!existing) {
      set.status = 404;
      return { error: "Key not found" };
    }

    await runStatement(db.delete(clientKeys).where(eq(clientKeys.id, id)));
    return { success: true };
  });
