/**
 * Smoke test for the multi-dialect database layer.
 *
 * Exercises the paths that previously used raw `bun:sqlite` calls: settings
 * read/write, upserts, the Drizzle query builder, transactions, and the JWT
 * secret bootstrap.
 *
 *   bun run scripts/db-smoke.ts                                  # SQLite
 *   DB_DRIVER=postgresql DATABASE_URL=postgres://... bun run scripts/db-smoke.ts
 *   DB_DRIVER=mysql      DATABASE_URL=mysql://...      bun run scripts/db-smoke.ts
 *
 * The networked engines are not reset between runs, so the assertions are
 * written to be idempotent rather than assuming a fresh database.
 */
import { rmSync } from "fs";

const DB_FILE = "/tmp/opencode/neko-db-smoke.db";

if (process.env.DATABASE_URL) {
  process.env.DB_DRIVER =
    process.env.DB_DRIVER ??
    (process.env.DATABASE_URL.startsWith("postgres")
      ? "postgresql"
      : process.env.DATABASE_URL.startsWith("mysql")
        ? "mysql"
        : "sqlite");
} else {
  rmSync(DB_FILE, { force: true });
  rmSync(`${DB_FILE}-wal`, { force: true });
  rmSync(`${DB_FILE}-shm`, { force: true });
  process.env.DB_PATH = DB_FILE;
  process.env.DB_DRIVER = "sqlite";
}

const EXPECTED_DIALECT = process.env.DB_DRIVER!;

let passed = 0;
let failed = 0;

/**
 * The section currently being exercised, so a failure names its own context.
 * A bare "FAIL <name>" in a 44-assertion run tells you what broke but not
 * which of the thirteen areas it broke in, which is the first thing you need
 * when a failure only shows up intermittently.
 */
let currentSection = "(none)";

function section(title: string): void {
  currentSection = title;
  console.log(`\n${title}`);
}

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(
      `  FAIL [${currentSection}] ${name}`,
      detail !== undefined ? detail : "(no detail supplied)",
    );
  }
}

const db = await import("../src/db/index");
const schema = await import("../src/db/schema/index");
const { quoteIdent } = await import("../src/db/driver/types");
const { eq, sql } = await import("drizzle-orm");

console.log(`\n=== dialect: ${EXPECTED_DIALECT} ===`);

section("[1] initialization");
await db.initDatabase();
check("driver created", db.hasDriver());
check("drizzle instance present", Boolean(db.db));
check("ready flag set", db.isDatabaseReady());
check(
  `dialect is ${EXPECTED_DIALECT}`,
  db.dbConfig.dialect === EXPECTED_DIALECT,
  db.dbConfig.dialect,
);

section("[1b] clean previous run's rows");
/**
 * The networked engines are not thrown away between runs, so the test has to
 * clear the exact rows it owns rather than assume an empty database. Only the
 * known probe ids are removed — never a blanket truncate, which would be
 * catastrophic if someone pointed this at a real database.
 */
const PROBE_KEYS = [
  "probe_key",
  "absent_key",
  "tx_commit",
  "tx_rollback",
  ...[1, 2, 3, 4, 5].map((n) => `tx_concurrent_${n}`),
];
const K = quoteIdent(db.dbConfig.dialect, "key");
try {
  for (const name of PROBE_KEYS) {
    await db.execute(`DELETE FROM settings WHERE ${K} = ?`, [name]);
  }
  await db.db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, "ak_1"));
  await db.db
    .delete(schema.clientKeys)
    .where(eq(schema.clientKeys.key, "sk-neko-test"));
  check("previous run's rows removed", true);
} catch (e) {
  check("previous run's rows removed", false, String(e));
}

section("[2] idempotent re-init (second boot must not throw)");
try {
  await db.initTables();
  check("re-running initTables is safe", true);
} catch (e) {
  check("re-running initTables is safe", false, String(e));
}

section("[3] settings helpers");
await db.setSetting("probe_key", "hello");
check(
  "setSetting/getSetting round trip",
  (await db.getSetting("probe_key")) === "hello",
);
check(
  "getSetting missing returns null",
  (await db.getSetting("absent_key")) === null,
);
check(
  "getSettingOr falls back",
  (await db.getSettingOr("absent_key", "dflt")) === "dflt",
);
await db.setSetting("probe_key", "updated");
check(
  "upsert overwrites existing",
  (await db.getSetting("probe_key")) === "updated",
);
await db.setSetting("opt_cache_ttl", "120");
await db.setSetting("opt_https_only", "1");
const prefixed = await db.getSettingsByPrefix("opt_");
check("prefix query finds opt_ rows", prefixed.get("opt_cache_ttl") === "120", [
  ...prefixed,
]);

section("[4] jwt secret bootstrap");
const secret = db.getJwtSecretCached();
check(
  "secret is a 64-char hex string",
  /^[0-9a-f]{64}$/.test(secret),
  secret.length,
);
const reloaded = await db.getSetting("jwt_secret");
check("secret persisted to database", reloaded === secret);

section("[5] drizzle query builder (awaited, as pg/mysql require)");
const now = Date.now();
await db.db.insert(schema.apiKeys).values({
  id: "ak_1",
  name: "Primary",
  key: "nr-api-test",
  description: "probe",
  isActive: 1,
  createdAt: now,
});
const fetched = (
  await db.db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.key, "nr-api-test"))
    .limit(1)
)[0];
check(
  "insert then select returns the row",
  fetched?.key === "nr-api-test",
  fetched,
);
check(
  "isActive reads back as a number",
  typeof fetched?.isActive === "number",
  fetched?.isActive,
);
check("createdAt round trips", fetched?.createdAt === now, fetched?.createdAt);

await db.db
  .update(schema.apiKeys)
  .set({ isActive: 0 })
  .where(eq(schema.apiKeys.id, "ak_1"));
const afterUpdate = (
  await db.db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.id, "ak_1"))
    .limit(1)
)[0];
check("update applies", afterUpdate?.isActive === 0, afterUpdate?.isActive);

// Scoped to this test's own row. A bare `count(*)` over the table would assert
// that the database holds nothing but the row this script just inserted, which
// is only true on a dedicated throwaway server — the Postgres and MySQL targets
// are shared long-running instances that also serve the app and the HTTP e2e
// suite, and they legitimately hold other keys.
const counted = await db.db
  .select({ n: sql`count(*)` })
  .from(schema.apiKeys)
  .where(eq(schema.apiKeys.id, "ak_1"));
check("aggregate count works", Number(counted[0]?.n) === 1, counted);

section("[6] client key with JSON + flag columns");
await db.db.insert(schema.clientKeys).values({
  id: "ck_1",
  apiKeyId: "ak_1",
  name: "Client",
  key: "sk-neko-test",
  isActive: 1,
  usedTokens: 5,
  allowedProviders: '["up_1"]',
  roundRobinProviders: 1,
  isFollowUpstream: 0,
  createdAt: now,
});
const client = (
  await db.db
    .select()
    .from(schema.clientKeys)
    .where(eq(schema.clientKeys.key, "sk-neko-test"))
    .limit(1)
)[0];
check(
  "json column preserved",
  client?.allowedProviders === '["up_1"]',
  client?.allowedProviders,
);
check(
  "defaulted flag materialized",
  client?.usedTokens === 5,
  client?.usedTokens,
);

section("[7] transactions (commit and rollback)");
const committed = await db.transaction(async () => {
  await db.setSetting("tx_commit", "yes");
});
check(
  "transaction commits",
  (await db.getSetting("tx_commit")) === "yes",
  committed,
);

// The settings cache is populated by setSetting, so a rolled-back write would
// still be visible through getSetting. Read past the cache to assert what the
// database actually holds. `key` is reserved in MySQL, so it is quoted for the
// active dialect.
const readValue = (name: string) =>
  db.queryOne<{ value: string }>(
    `SELECT ${quoteIdent(db.dbConfig.dialect, "value")} FROM settings WHERE ${quoteIdent(
      db.dbConfig.dialect,
      "key",
    )} = ?`,
    [name],
  );

const txValueInDb = await readValue("tx_rollback");
try {
  await db.transaction(async () => {
    await db.setSetting("tx_rollback", "should_not_persist");
    throw new Error("intentional failure");
  });
} catch {
  // expected
}
const afterRollback = await readValue("tx_rollback");
check(
  "transaction rolls back on throw",
  afterRollback === null,
  afterRollback ?? txValueInDb,
);

section("[8] concurrent transactions do not interleave");
// Each transaction writes then reads its own value. If BEGIN/COMMIT interleaved
// on the shared connection, the reads would observe another transaction's
// uncommitted state and this would fail or throw.
const results = await Promise.all(
  [1, 2, 3, 4, 5].map((n) =>
    db.transaction(async () => {
      await db.setSetting(`tx_concurrent_${n}`, "start");
      await new Promise((r) => setTimeout(r, 5));
      const seen = await db.getSetting(`tx_concurrent_${n}`);
      return { n, seen };
    }),
  ),
);
check(
  "each concurrent transaction sees its own write",
  results.every((r) => r.seen === "start"),
  results,
);

section("[9] raw query helpers");
const V = quoteIdent(db.dbConfig.dialect, "value");
const readSetting = (name: string) =>
  db.query<{ value: string }>(`SELECT ${V} FROM settings WHERE ${K} = ?`, [
    name,
  ]);

const rawRows = await readSetting("probe_key");
check("query() returns rows", rawRows[0]?.value === "updated", rawRows);
const one = await db.queryOne<{ value: string }>(
  `SELECT ${V} FROM settings WHERE ${K} = ?`,
  ["probe_key"],
);
check("queryOne() returns first row", one?.value === "updated", one);
const none = await db.queryOne(`SELECT ${V} FROM settings WHERE ${K} = ?`, [
  "absent_key",
]);
check("queryOne() returns null when absent", none === null, none);

section("[10] checkpoint + close");
await db.checkpoint();
check("checkpoint is a no-op-safe call", true);

section("[11] backup and restore");
const backup = await import("../src/db/backup");

const dump = await backup.exportJsonBackup();
check(
  "export has the expected format marker",
  backup.isJsonBackup(dump),
  dump.format,
);
check(
  "export contains the probe settings row",
  dump.tables.settings?.some(
    (row) => row.key === "probe_key" && row.value === "updated",
  ),
  dump.tables.settings?.find((row) => row.key === "probe_key"),
);
check(
  "export contains the probe api key row",
  dump.tables.api_keys?.some(
    (row) => row.id === "ak_1" && row.key === "nr-api-test",
  ),
);
check(
  "export records the active dialect",
  dump.dialect === db.dbConfig.dialect,
  dump.dialect,
);
check(
  "export covers every known table",
  Object.keys(dump.tables).length === 6,
  Object.keys(dump.tables),
);

check(
  "a document missing required tables is rejected",
  !backup.isJsonBackup({
    format: backup.BACKUP_FORMAT,
    version: 1,
    tables: { settings: [] },
  }),
);
check(
  "a future backup version is rejected",
  !backup.isJsonBackup({
    format: backup.BACKUP_FORMAT,
    version: backup.BACKUP_VERSION + 1,
    tables: Object.fromEntries(backup.REQUIRED_TABLES.map((n) => [n, []])),
  }),
);

// Mutate, then restore, and assert the backup's values came back — including a
// row deleted outright, which is the case a partial restore would miss.
db.invalidateSettingsCache();
await db.setSetting("probe_key", "mutated_after_backup");
await db.execute(`DELETE FROM settings WHERE ${K} = ?`, ["tx_commit"]);
await db.db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, "ak_1"));

const restored = await backup.restoreJsonBackup(dump);
check("restore reports the rows it wrote", restored.rows > 0, restored);
db.invalidateSettingsCache();
check(
  "restore brings back an updated row",
  (await db.getSetting("probe_key")) === "updated",
  await db.getSetting("probe_key"),
);
check(
  "restore brings back a deleted row",
  (await db.getSetting("tx_commit")) === "yes",
);
check(
  "restore brings back a deleted api key",
  (
    await db.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, "ak_1"))
  ).length === 1,
);

section("[12] sqlite file restore (sqlite only)");
if (db.dbConfig.dialect === "sqlite") {
  const path = "/tmp/opencode/neko-db-smoke-restore.sqlite";
  Bun.write(path, Bun.file(db.DB_PATH));
  const integrity = await backup.checkSqliteIntegrity(path);
  check(
    "integrity check passes on a valid file",
    integrity.ok,
    integrity.detail,
  );

  const tables = await backup.sqliteTableNames(path);
  check(
    "file contains the required tables",
    backup.missingRequiredTables(new Set(tables)).length === 0,
    tables,
  );

  await db.setSetting("probe_key", "will_be_overwritten_by_file");
  const summary = await backup.restoreSqliteFile(path);
  check("file restore reports tables copied", summary.tables > 0, summary);
  db.invalidateSettingsCache();
  check(
    "file restore reverts the live row",
    (await db.getSetting("probe_key")) === "updated",
    await db.getSetting("probe_key"),
  );
} else {
  check(
    "sqlite file restore is refused on this engine",
    await (async () => {
      try {
        await backup.restoreSqliteFile("/tmp/opencode/does-not-matter.sqlite");
        return false;
      } catch (e) {
        return e instanceof backup.BackupError;
      }
    })(),
  );
}

section("[13] close");
await db.closeDatabase();
check("close marks driver gone", !db.hasDriver());
check(
  "queries after close throw a clear error",
  await (async () => {
    try {
      await db.getSetting("probe_key");
      return false;
    } catch {
      return true;
    }
  })(),
);

console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed\n`,
);
process.exit(failed === 0 ? 0 : 1);
