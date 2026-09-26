import { Elysia, t } from "elysia";
import { db, transaction } from "../db";
import { apiKeys, clientKeys } from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { eq, desc, sql } from "drizzle-orm";

function generateApiKeyString(custom?: string): string {
  if (custom && custom.trim().length > 0) {
    const trimmed = custom.trim();
    return trimmed.startsWith("nr-api-") ? trimmed : `nr-api-${trimmed}`;
  }
  const random = Array.from(crypto.getRandomValues(new Uint8Array(20)))
    .map((b) => b.toString(36))
    .join("")
    .slice(0, 24);
  return `nr-api-${random}`;
}

export const routerApiKeysRoutes = new Elysia({ prefix: "/api/router-keys" })
  .use(authMiddleware)
  .onBeforeHandle(({ isAdmin, apiKey, set }) => {
    if (!isAdmin && !apiKey) {
      set.status = 401;
      return { error: "Unauthorized access to router integration API keys" };
    }
  })
  .get("/", async () => {
    const list = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        key: apiKeys.key,
        description: apiKeys.description,
        isActive: apiKeys.isActive,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        secretKeysCount: sql<number>`(SELECT count(*) FROM client_keys WHERE client_keys.api_key_id = api_keys.id)`,
      })
      .from(apiKeys)
      .orderBy(desc(apiKeys.createdAt));

    return {
      keys: list.map((k: any) => ({
        ...k,
        isActive: k.isActive === 1,
        secretKeysCount: Number(k.secretKeysCount || 0),
        displayKey:
          k.key.length > 18
            ? `${k.key.slice(0, 11)}...${k.key.slice(-4)}`
            : k.key,
      })),
    };
  })
  .post(
    "/",
    async ({ body, set }) => {
      const { name, description, customKey } = body;
      const keyStr = generateApiKeyString(customKey);

      // Check duplicate
      const existing = (
        await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.key, keyStr))
          .limit(1)
      )[0];

      if (existing) {
        set.status = 400;
        return { error: "API Key already exists" };
      }

      const id = "ak_" + crypto.randomUUID().replace(/-/g, "");
      const now = Date.now();

      await db.insert(apiKeys).values({
        id,
        name: name.trim(),
        key: keyStr,
        description: description?.trim() || null,
        isActive: 1,
        createdAt: now,
        lastUsedAt: null,
      });

      return {
        success: true,
        key: {
          id,
          name: name.trim(),
          key: keyStr,
          description: description?.trim() || null,
          isActive: true,
          secretKeysCount: 0,
          createdAt: now,
          lastUsedAt: null,
        },
      };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        description: t.Optional(t.String()),
        customKey: t.Optional(t.String()),
      }),
    }
  )
  .patch(
    "/:id",
    async ({ params: { id }, body, set }) => {
      const existing = (
        await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.id, id))
          .limit(1)
      )[0];

      if (!existing) {
        set.status = 404;
        return { error: "API Key not found" };
      }

      const updateData: Record<string, unknown> = {};
      if (body.name !== undefined) updateData.name = body.name.trim();
      if (body.description !== undefined) updateData.description = body.description ? body.description.trim() : null;
      if (body.isActive !== undefined) updateData.isActive = body.isActive ? 1 : 0;

      await db
        .update(apiKeys)
        .set(updateData as never)
        .where(eq(apiKeys.id, id));

      return { success: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.Nullable(t.String())),
        isActive: t.Optional(t.Boolean()),
      }),
    }
  )
  .patch("/:id/toggle", async ({ params: { id }, set }) => {
    const existing = (
      await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, id))
        .limit(1)
    )[0];

    if (!existing) {
      set.status = 404;
      return { error: "API Key not found" };
    }

    const nextState = existing.isActive ? 0 : 1;
    await db
      .update(apiKeys)
      .set({ isActive: nextState })
      .where(eq(apiKeys.id, id));

    return { success: true, isActive: nextState === 1 };
  })
  .post(
    "/:id/rotate",
    async ({ params: { id }, body, set }) => {
      const existing = (
        await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.id, id))
          .limit(1)
      )[0];

      if (!existing) {
        set.status = 404;
        return { error: "API Key not found" };
      }

      const customKey = body?.customKey;
      const newKeyStr = generateApiKeyString(customKey);

      const duplicate = (
        await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.key, newKeyStr))
          .limit(1)
      )[0];

      if (duplicate && duplicate.id !== id) {
        set.status = 400;
        return { error: "API Key already exists" };
      }

      await db
        .update(apiKeys)
        .set({ key: newKeyStr })
        .where(eq(apiKeys.id, id));

      const displayKey =
        newKeyStr.length > 18
          ? `${newKeyStr.slice(0, 11)}...${newKeyStr.slice(-4)}`
          : newKeyStr;

      return {
        success: true,
        message: "Router API key rotated successfully",
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
      const existing = (
        await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.id, id))
          .limit(1)
      )[0];

      if (!existing) {
        set.status = 404;
        return { error: "API Key not found" };
      }

      const customKey = body?.customKey;
      const newKeyStr = generateApiKeyString(customKey);

      const duplicate = (
        await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.key, newKeyStr))
          .limit(1)
      )[0];

      if (duplicate && duplicate.id !== id) {
        set.status = 400;
        return { error: "API Key already exists" };
      }

      await db
        .update(apiKeys)
        .set({ key: newKeyStr })
        .where(eq(apiKeys.id, id));

      const displayKey =
        newKeyStr.length > 18
          ? `${newKeyStr.slice(0, 11)}...${newKeyStr.slice(-4)}`
          : newKeyStr;

      return {
        success: true,
        message: "Router API key rotated successfully",
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
    "/batch-delete",
    async ({ body, set }) => {
      const { ids } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        set.status = 400;
        return { error: "No key IDs provided" };
      }
      // Unlinking and deleting happen in one transaction so a failure cannot
      // leave secret keys pointing at an API key that no longer exists.
      await transaction(async () => {
        for (const id of ids) {
          await db
            .update(clientKeys)
            .set({ apiKeyId: null })
            .where(eq(clientKeys.apiKeyId, id));
          await db.delete(apiKeys).where(eq(apiKeys.id, id));
        }
      });
      return { success: true, deletedCount: ids.length };
    },
    {
      body: t.Object({
        ids: t.Array(t.String()),
      }),
    }
  )
  .delete("/:id", async ({ params: { id }, set }) => {
    const existing = (
      await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1)
    )[0];

    if (!existing) {
      set.status = 404;
      return { error: "API Key not found" };
    }

    await transaction(async () => {
      // Unlink any secret keys that belonged to this API key
      await db.update(clientKeys).set({ apiKeyId: null }).where(eq(clientKeys.apiKeyId, id));
      await db.delete(apiKeys).where(eq(apiKeys.id, id));
    });

    return { success: true };
  });
