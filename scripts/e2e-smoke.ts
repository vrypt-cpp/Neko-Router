/**
 * End-to-end HTTP check against a running Neko-Router instance.
 *
 * Boots nothing: start the server yourself with the desired `DATABASE_URL`,
 * then run this against it. Exercises the paths that became asynchronous when
 * the data layer was generalised — login, key CRUD, admin settings, and the
 * export endpoint — because a missed `await` shows up as a 500 with an
 * unresolved value rather than as a type error.
 *
 *   PORT=3000 bun run scripts/e2e-smoke.ts
 */
const PORT = process.env.PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const PIN = process.env.SMOKE_PIN || "123456";

let passed = 0;
let failed = 0;
let cookie = "";

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(
      `  FAIL ${name}`,
      detail !== undefined ? JSON.stringify(detail) : "",
    );
  }
}

async function call(
  path: string,
  init: RequestInit & { expectStatus?: number } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;

  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON (e.g. an exported .sqlite download).
  }
  return { status: response.status, body };
}

console.log(`\n=== e2e against ${BASE} ===`);

console.log("\n[1] reachability");
const root = await call("/");
check("GET / responds", root.status === 200, root.status);

console.log("\n[2] auth");
const unauth = await call("/api/keys");
check("secret keys require auth", unauth.status === 401, unauth);

const login = await call("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ pin: PIN }),
});
check("login with the default PIN succeeds", login.status === 200, login.body);
check(
  "login returns a token or session",
  Boolean(login.body?.token || cookie),
  {
    hasCookie: Boolean(cookie),
  },
);

const badLogin = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ pin: "definitely-not-the-pin" }),
});
check(
  "login with a wrong PIN is rejected",
  badLogin.status === 401,
  badLogin.status,
);

console.log("\n[3] router api keys CRUD");
const unique = `smoke${Date.now().toString(36)}`;
const created = await call("/api/router-keys", {
  method: "POST",
  body: JSON.stringify({
    name: `e2e-${unique}`,
    customKey: `nr-api-${unique}`,
  }),
});
check("create returns 200", created.status === 200, created.body);
const createdId = created.body?.key?.id;
check("create returns an id", typeof createdId === "string", created.body);

const list = await call("/api/router-keys");
check(
  "list includes the new key",
  Array.isArray(list.body?.keys) &&
    list.body.keys.some((k: any) => k.id === createdId),
  list.body?.keys?.length,
);
check(
  "list exposes isActive as a boolean, not 0/1",
  list.body?.keys?.find((k: any) => k.id === createdId)?.isActive === true,
);

const duplicated = await call("/api/router-keys", {
  method: "POST",
  body: JSON.stringify({ name: "dup", customKey: `nr-api-${unique}` }),
});
check("duplicate key is rejected", duplicated.status === 400, duplicated.body);

const toggled = await call(`/api/router-keys/${createdId}/toggle`, {
  method: "PATCH",
});
check("toggle flips the flag", toggled.body?.isActive === false, toggled.body);

const retoggled = await call(`/api/router-keys/${createdId}/toggle`, {
  method: "PATCH",
});
check(
  "toggle flips it back",
  retoggled.body?.isActive === true,
  retoggled.body,
);

const renamed = await call(`/api/router-keys/${createdId}`, {
  method: "PATCH",
  body: JSON.stringify({ name: `e2e-renamed-${unique}` }),
});
check("rename succeeds", renamed.status === 200, renamed.body);

const rotated = await call(`/api/router-keys/${createdId}/rotate`, {
  method: "POST",
});
check(
  "rotate returns a new key",
  rotated.status === 200 && typeof rotated.body?.key === "string",
  rotated.body,
);

const missing = await call("/api/router-keys/does-not-exist", {
  method: "DELETE",
});
check("deleting a missing key is 404", missing.status === 404, missing.body);

console.log("\n[4] secret keys");
const keyCreated = await call("/api/keys", {
  method: "POST",
  body: JSON.stringify({
    name: `e2e-key-${unique}`,
    customKey: `smoke${unique}`,
  }),
});
check("create secret key", keyCreated.status === 200, keyCreated.body);
const secretId = keyCreated.body?.key?.id ?? keyCreated.body?.id;

if (secretId) {
  const updated = await call(`/api/keys/${secretId}`, {
    method: "PATCH",
    body: JSON.stringify({ rateLimit: 42, tokenLimit: 1000 }),
  });
  check("patch secret key", updated.status === 200, updated.body);

  const keyList = await call("/api/keys");
  const found = keyList.body?.keys?.find((k: any) => k.id === secretId);
  check(
    "rate limit persisted as a number",
    found?.rateLimit === 42,
    found?.rateLimit,
  );

  const removed = await call(`/api/keys/${secretId}`, { method: "DELETE" });
  check("delete secret key", removed.status === 200, removed.body);
}

console.log("\n[5] admin");
const settings = await call("/api/admin/settings/optimizations");
check(
  "read optimization settings",
  settings.status === 200 && typeof settings.body === "object",
  settings.body,
);
check(
  "optimization settings are fully resolved",
  typeof settings.body?.cacheTtlSeconds === "number",
  settings.body,
);

const saved = await call("/api/admin/settings/optimizations", {
  method: "POST",
  body: JSON.stringify({ cacheTtlSeconds: 777 }),
});
check("write optimization settings", saved.status === 200, saved.body);
const reread = await call("/api/admin/settings/optimizations");
check(
  "optimization setting persisted",
  reread.body?.cacheTtlSeconds === 777,
  reread.body,
);
// Put it back so repeated runs do not drift.
await call("/api/admin/settings/optimizations", {
  method: "POST",
  body: JSON.stringify({ cacheTtlSeconds: 300 }),
});

const system = await call("/api/admin/system");
check("system info responds", system.status === 200, system.body);
check(
  "system info names the dialect",
  typeof system.body?.database?.dialect === "string",
  system.body?.database,
);

const cleared = await call("/api/admin/cache/clear", { method: "POST" });
check("cache clear responds", cleared.status === 200, cleared.body);

const exported = await fetch(`${BASE}/api/admin/db/export`, {
  headers: { cookie },
});
const exportedBody = Buffer.from(await exported.arrayBuffer());
check("export responds 200", exported.status === 200, exported.status);
check(
  "export is not empty",
  exportedBody.byteLength > 0,
  exportedBody.byteLength,
);
const contentType = exported.headers.get("content-type") ?? "";
// The export format follows whether the database is a *file*, not which engine
// it is. A file-backed SQLite database is exported as a raw binary copy; an
// in-memory SQLite database, Postgres and MySQL all use the JSON document,
// because none of them is a single file the process can hand out.
const expectSqliteFile =
  system.body?.database?.dialect === "sqlite" && !!system.body?.dbPath;
check(
  "export content type matches the engine",
  expectSqliteFile
    ? contentType.includes("sqlite")
    : contentType.includes("json"),
  `${contentType} (dialect=${system.body?.database?.dialect}, dbPath=${JSON.stringify(system.body?.dbPath)})`,
);
if (expectSqliteFile) {
  // The 16-byte SQLite file header. A JSON body would fail this.
  check(
    "sqlite export is a real database file",
    exportedBody.subarray(0, 16).toString("latin1") === "SQLite format 3\0",
    exportedBody.subarray(0, 16).toString("latin1"),
  );
} else {
  // Prove the JSON is a backup document and not a truncated or error body.
  let parsed: any = null;
  try {
    parsed = JSON.parse(exportedBody.toString("utf8"));
  } catch {
    /* left null so the check below reports it */
  }
  check("json export parses", parsed !== null, exportedBody.byteLength);
  // `tables` is a map of table name to that table's rows, not an array.
  check(
    "json export is a backup document",
    typeof parsed?.version === "number" &&
      typeof parsed?.dialect === "string" &&
      parsed?.tables !== null &&
      typeof parsed.tables === "object" &&
      !Array.isArray(parsed.tables) &&
      Object.keys(parsed.tables).length > 0,
    parsed === null ? "unparseable" : Object.keys(parsed),
  );
}

console.log("\n[6] telemetry");
const telemetry = await call("/api/telemetry/stats");
check("telemetry stats respond", telemetry.status === 200, telemetry.status);
// The stats handler is a *synchronous* Elysia handler that returns the promise
// from `getTelemetryStats`. That is correct — Elysia awaits whatever a handler
// returns — but if it were not, the response would be 200 with a serialised
// `Promise` object, i.e. `{}`. Assert on real fields so that failure mode is
// visible instead of silent.
const statsBody = telemetry.body ?? {};
const statKeys = Object.keys(statsBody);
check("telemetry stats have fields", statKeys.length > 0, statsBody);
check(
  "telemetry stats are not an unresolved promise",
  !("then" in statsBody) && statKeys.length > 0,
  statKeys,
);

const logs = await call("/api/telemetry/logs?limit=5");
check("telemetry logs respond", logs.status === 200, logs.status);
check(
  "telemetry logs have an array",
  Array.isArray(logs.body?.logs),
  logs.body,
);

const active = await call("/api/telemetry/active");
check("telemetry active responds", active.status === 200, active.status);
check(
  "telemetry active has an array",
  Array.isArray(active.body?.activeUpstreamIds),
  active.body,
);

console.log("\n[7] router api key is rejected on the data endpoints");
const withRouterKey = await fetch(`${BASE}/api/keys`, {
  headers: { "x-api-key": `nr-api-${unique}` },
});
check(
  "router key cannot list secret keys",
  withRouterKey.status === 401,
  withRouterKey.status,
);

console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed\n`,
);
process.exit(failed === 0 ? 0 : 1);
