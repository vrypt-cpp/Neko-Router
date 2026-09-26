import { Elysia, t } from "elysia";
import {
  DB_PATH,
  checkpoint,
  initTables,
  dbConfig,
  isFileBackedSqlite,
  describeConnection,
  queryOne,
} from "../db";
import { authMiddleware } from "../middleware/auth";
import { existsSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import {
  getOptimizationSettings,
  updateOptimizationSettings,
  clearResponseCache,
} from "../services/optimizer";
import {
  BackupError,
  backupContentType,
  backupFileExtension,
  checkSqliteIntegrity,
  currentDatabaseBackupPath,
  exportJsonBackup,
  isJsonBackup,
  missingRequiredTables,
  removeIfPresent,
  restoreJsonBackup,
  restoreSqliteFile,
  sqliteTableNames,
} from "../db/backup";

/** Recognises a SQLite database file from its 16-byte magic header. */
const isSqliteFile = (bytes: Uint8Array): boolean =>
  new TextDecoder().decode(bytes.subarray(0, 16)).startsWith("SQLite format 3");

/** 100 bytes is far below any real database but comfortably above a JSON
 *  document's own headers, so it catches "you uploaded the wrong file". */
const MIN_UPLOAD_BYTES = 32;

export const adminRoutes = new Elysia({ prefix: "/api/admin" })
  .use(authMiddleware)
  .onBeforeHandle(({ isAdmin, apiKey, set }) => {
    if (!isAdmin && !apiKey) {
      set.status = 401;
      return { error: "Unauthorized access to admin management" };
    }
  })
  .get("/settings/optimizations", async () => {
    return await getOptimizationSettings();
  })
  .post(
    "/settings/optimizations",
    async ({ body }) => {
      return await updateOptimizationSettings(body);
    },
    {
      body: t.Object({
        cacheEnabled: t.Optional(t.Boolean()),
        rtkCompression: t.Optional(t.Boolean()),
        cavemanMode: t.Optional(t.Boolean()),
        minifyPrompt: t.Optional(t.Boolean()),
        cacheTtlSeconds: t.Optional(t.Number()),
        httpsOnly: t.Optional(t.Boolean()),
        requestTimeoutSeconds: t.Optional(t.Number()),
        modelPrefixEnabled: t.Optional(t.Boolean()),
      }),
    },
  )
  .post("/cache/clear", async () => {
    return await clearResponseCache();
  })
  .get("/system", async () => {
    const memory = process.memoryUsage();

    // Only SQLite keeps its whole dataset in a single file whose size can be
    // read from the filesystem. The networked engines split storage across a
    // server we do not own, so reporting a number here would be a fiction.
    let dbSizeBytes: number | null = null;
    if (isFileBackedSqlite && DB_PATH) {
      try {
        dbSizeBytes = (await Bun.file(DB_PATH).arrayBuffer()).byteLength;
      } catch {
        dbSizeBytes = null;
      }
    }

    let database: {
      dialect: string;
      description: string;
      reachable: boolean;
    } | null = null;
    try {
      await queryOne("SELECT 1");
      database = {
        dialect: dbConfig.dialect,
        description: describeConnection(),
        reachable: true,
      };
    } catch {
      database = {
        dialect: dbConfig.dialect,
        description: describeConnection(),
        reachable: false,
      };
    }

    return {
      version: "1.0.0",
      bunVersion: Bun.version,
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rssMb: Math.round((memory.rss / (1024 * 1024)) * 100) / 100,
        heapUsedMb: Math.round((memory.heapUsed / (1024 * 1024)) * 100) / 100,
      },
      dbSizeBytes,
      dbPath: DB_PATH,
      database,
    };
  })
  .get("/db/export", async ({ isAdmin, set }) => {
    // Full database dumps contain every stored secret at once (upstream
    // provider keys, client keys, the PIN hash, and the JWT signing secret).
    // Long-lived nr-api- bearer keys must not be able to exfiltrate them in
    // a single request: export requires the higher-assurance admin session
    // (PIN-derived cookie or admin JWT bearer).
    if (!isAdmin) {
      set.status = 403;
      return { error: "Database export requires an admin session" };
    }

    const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `neko-router-backup-${dateStr}.${backupFileExtension()}`;

    if (isFileBackedSqlite) {
      // Fold the WAL back into the main file so the download is self-contained.
      await checkpoint();
      return new Response(Bun.file(DB_PATH), {
        headers: {
          "Content-Type": backupContentType(),
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    const dump = await exportJsonBackup();
    return new Response(JSON.stringify(dump, null, 2), {
      headers: {
        "Content-Type": backupContentType(),
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  })
  .post(
    "/db/import",
    async ({ body, set, isAdmin }) => {
      // Rewriting the whole database (including the PIN hash and JWT secret)
      // is equivalent to a full account takeover primitive. Same rationale as
      // /db/export above: admin session only.
      if (!isAdmin) {
        set.status = 403;
        return {
          success: false,
          error: "Database import requires an admin session",
        };
      }

      const file = body?.file as Blob | null;
      if (!file) {
        set.status = 400;
        return { success: false, error: "No database file provided" };
      }

      let tempPath: string | null = null;

      try {
        const buffer = await file.arrayBuffer();
        if (buffer.byteLength < MIN_UPLOAD_BYTES) {
          set.status = 400;
          return {
            success: false,
            error: "File too small to be a valid backup",
          };
        }

        // A JSON backup never needs a scratch file; a SQLite file has to be
        // materialised on disk before it can be attached.
        if (!isSqliteFile(new Uint8Array(buffer))) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder().decode(buffer));
          } catch {
            set.status = 400;
            return {
              success: false,
              error:
                "File is neither a SQLite database nor a Neko-Router JSON backup",
            };
          }

          if (!isJsonBackup(parsed)) {
            set.status = 400;
            return {
              success: false,
              error:
                "JSON backup is missing required tables or has an unsupported version",
            };
          }

          const summary = await restoreJsonBackup(parsed);
          await initTables();
          await checkpoint();

          return {
            success: true,
            message: `Restored ${summary.rows} rows across ${summary.tables} tables`,
            ...summary,
          };
        }

        if (dbConfig.dialect !== "sqlite") {
          set.status = 400;
          return {
            success: false,
            error:
              "This deployment does not use SQLite, so a .sqlite backup cannot be restored. " +
              "Export a JSON backup instead.",
          };
        }

        tempPath = join(
          dirname(DB_PATH),
          `temp_import_${crypto.randomUUID().slice(0, 8)}.sqlite`,
        );
        await Bun.write(tempPath, buffer);

        const integrity = await checkSqliteIntegrity(tempPath);
        if (!integrity.ok) {
          removeIfPresent(tempPath);
          set.status = 400;
          return {
            success: false,
            error: `Database integrity check failed: ${integrity.detail}`,
          };
        }

        const missing = missingRequiredTables(
          new Set(await sqliteTableNames(tempPath)),
        );
        if (missing.length > 0) {
          removeIfPresent(tempPath);
          set.status = 400;
          return {
            success: false,
            error: `Schema integrity failure: Missing required tables: ${missing.join(", ")}`,
          };
        }

        // Keep a copy of what is being replaced. SQLite only, for the same
        // reason the export is.
        const backupPath = currentDatabaseBackupPath();
        if (backupPath) {
          removeIfPresent(backupPath);
          try {
            await checkpoint();
            copyFileSync(DB_PATH, backupPath);
          } catch {
            // A missing pre-restore copy must not block the restore itself.
          }
        }

        const summary = await restoreSqliteFile(tempPath);
        removeIfPresent(tempPath);
        tempPath = null;

        await initTables();
        await checkpoint();

        return {
          success: true,
          message: `Restored ${summary.rows} rows across ${summary.tables} tables`,
          ...summary,
        };
      } catch (err: any) {
        if (tempPath && existsSync(tempPath)) removeIfPresent(tempPath);
        const message =
          err instanceof BackupError
            ? err.message
            : err?.message || "Unknown error";
        set.status = err instanceof BackupError ? 400 : 500;
        return { success: false, error: `Import failed: ${message}` };
      }
    },
    {
      body: t.Object({
        file: t.File(),
      }),
    },
  );
