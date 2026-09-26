import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { initDatabase } from "./db";
import { existsSync, watch } from "fs";
import { join } from "path";
import { webHandler, htmlTemplate, bundleFrontend } from "./web/handler";

// Connect to the database and create the schema BEFORE any route module is
// evaluated. Route modules are loaded with dynamic import() below rather than
// static import() at the top of this file, because ES module imports are
// hoisted: a static import would evaluate them first, and they read the JWT
// signing secret at evaluation time (the @elysiajs/jwt plugin captures it when
// constructed). With a networked engine (Postgres/MySQL) the connection is
// asynchronous, so that ordering guarantee cannot be left to chance.
await initDatabase();

const [
  { authRoutes },
  { keysRoutes },
  { routerApiKeysRoutes },
  { upstreamRoutes },
  { telemetryRoutes },
  { adminRoutes },
  { proxyRoutes },
  { apiProvidersRoutes },
] = await Promise.all([
  import("./routes/auth"),
  import("./routes/keys"),
  import("./routes/api-keys"),
  import("./routes/upstreams"),
  import("./routes/telemetry"),
  import("./routes/admin"),
  import("./routes/proxy"),
  import("./routes/api-providers"),
]);

// Pre-bundle frontend in memory on startup (background)
bundleFrontend().catch((err) => console.error("[Frontend] Bundle preheat error:", err));

// Watch .env for changes in both development and production
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  let debounceTimer: any = null;
  watch(envPath, (eventType) => {
    if (eventType === "change" || eventType === "rename") {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log("\x1b[33m%s\x1b[0m", "⚙️  [.env] Configuration change detected! Reloading process...");
        process.exit(0);
      }, 300);
    }
  });
}

const port = parseInt(process.env.PORT || "3000", 10);
const host = process.env.HOST || "0.0.0.0";

const app = new Elysia()
  .use(
    cors({
      origin: true,
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "anthropic-version", "anthropic-beta"],
    })
  )
  .use(
    swagger({
      path: "/swagger",
      documentation: {
        info: {
          title: "Neko-Router API Gateway",
          version: "1.0.0",
          description:
            "Ultra-low latency AI Gateway & Router for OpenAI and Anthropic compatible endpoints with real-time stream passthrough and token telemetry.",
        },
        tags: [
          { name: "Proxy", description: "AI proxy endpoints (OpenAI & Anthropic)" },
          { name: "Auth", description: "Authentication & PIN management" },
          { name: "Keys", description: "Client access keys management" },
          { name: "Router Keys", description: "Router integration API keys management" },
          { name: "Upstreams", description: "Upstream provider keys management" },
          { name: "API Providers", description: "BandelBanget and external API providers management" },
          { name: "Telemetry", description: "Token usage and latency metrics" },
          { name: "Admin", description: "Database backup, restore, and system metrics" },
        ],
      },
    })
  )
  // Health & Info Endpoint
  .get("/health", () => ({ status: "ok", timestamp: Date.now() }))
  // Register Route Modules
  .use(authRoutes)
  .use(keysRoutes)
  .use(routerApiKeysRoutes)
  .use(upstreamRoutes)
  .use(apiProvidersRoutes)
  .use(telemetryRoutes)
  .use(adminRoutes)
  .use(proxyRoutes)
  // Dynamic Web Frontend Handler
  .use(webHandler)
  // Catch-all SPA route: serves dynamic HTML template (no dist needed)
  .get("*", ({ set }) => {
    set.headers["Content-Type"] = "text/html; charset=utf-8";
    return htmlTemplate;
  });

app.listen({ port, hostname: host }, () => {
  console.log(`🐱 Neko-Router AI Gateway is running at http://${host}:${port}`);
  console.log(`📖 Interactive OpenAPI Docs at http://${host}:${port}/swagger`);
});

export type App = typeof app;
