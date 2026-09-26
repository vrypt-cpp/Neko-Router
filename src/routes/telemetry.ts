import { Elysia, t } from "elysia";
import {
  getTelemetryStats,
  getRecentLogs,
  getActiveUpstreamIds,
} from "../services/telemetry";
import { authMiddleware } from "../middleware/auth";

export const telemetryRoutes = new Elysia({ prefix: "/api/telemetry" })
  .use(authMiddleware)
  .onBeforeHandle(({ isAdmin, apiKey, set }) => {
    if (!isAdmin && !apiKey) {
      set.status = 401;
      return { error: "Unauthorized access to telemetry" };
    }
  })
  .get("/active", () => {
    // `getActiveUpstreamIds` reads an in-memory map, so it is genuinely
    // synchronous and needs no await.
    return {
      activeUpstreamIds: getActiveUpstreamIds(),
    };
  })
  .get(
    "/stats",
    ({ query }) => {
      if (query.all === "true" || query.hours === "all" || query.hours === "0") {
        return getTelemetryStats({ all: true });
      }
      if (query.since && !isNaN(Number(query.since)) && Number(query.since) > 0) {
        return getTelemetryStats({ since: Number(query.since) });
      }
      const rangeHours = Number(query.hours) || 24;
      return getTelemetryStats({ timeRangeMs: rangeHours * 60 * 60 * 1000 });
    },
    {
      query: t.Object({
        hours: t.Optional(t.String()),
        since: t.Optional(t.String()),
        all: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/logs",
    async ({ query }) => {
      const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
      const offset = Math.max(0, Number(query.offset) || 0);
      // Must be awaited, not just returned. Elysia awaits the *handler's* return
      // value, so returning a bare promise is enough — but a promise nested
      // inside an object literal is serialised as `{}`, which is what this used
      // to do and what a status-code-only assertion cannot detect.
      const logs = await getRecentLogs(limit, offset);
      return { logs };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    }
  );
