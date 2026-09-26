/**
 * Database configuration resolved from the environment.
 *
 * A single `DATABASE_URL` (or the legacy `DB_PATH` for SQLite) selects the
 * dialect. Everything downstream — schema definitions, DDL, and the Drizzle
 * client — branches on `dialect`, so the rest of the application never needs
 * to know which engine is behind it.
 */

export type Dialect = "sqlite" | "postgresql" | "mysql";

export interface DatabaseConfig {
  dialect: Dialect;
  /**
   * sqlite: filesystem path to the database file.
   * postgresql/mysql: a driver connection URL.
   */
  url: string;
}

const DIALECTS: readonly Dialect[] = ["sqlite", "postgresql", "mysql"];

function isDialect(value: string): value is Dialect {
  return (DIALECTS as readonly string[]).includes(value);
}

/** Maps a connection-URL scheme onto a dialect. Returns null for plain paths. */
function inferDialectFromUrl(url: string): Dialect | null {
  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
  switch (scheme) {
    case "postgres":
    case "postgresql":
      return "postgresql";
    case "mysql":
      return "mysql";
    case "file":
    case "sqlite":
      return "sqlite";
    default:
      return null;
  }
}

/**
 * Strips the libsql-style `file:` prefix so the remainder can be handed to
 * `bun:sqlite` as a plain path.
 */
function stripFileScheme(url: string): string {
  return url.replace(/^file:(?:\/\/)?/i, "");
}

function resolveConfig(): DatabaseConfig {
  const rawDriver = process.env.DB_DRIVER?.trim().toLowerCase() || "";
  const databaseUrl = process.env.DATABASE_URL?.trim() || "";
  const dbPath = process.env.DB_PATH?.trim() || "data/router.db";

  if (rawDriver && !isDialect(rawDriver)) {
    throw new Error(
      `Invalid DB_DRIVER "${rawDriver}". Expected one of: ${DIALECTS.join(", ")}.`,
    );
  }

  if (databaseUrl) {
    const inferred = inferDialectFromUrl(databaseUrl);

    // An explicit DB_DRIVER that contradicts the URL scheme is almost always a
    // half-finished edit, and silently picking one of the two would connect to
    // the wrong database. Fail loudly instead.
    if (rawDriver && inferred && rawDriver !== inferred) {
      throw new Error(
        `Conflicting database configuration: DB_DRIVER="${rawDriver}" but DATABASE_URL uses the "${inferred}" scheme. ` +
          `Remove DB_DRIVER or make it match the URL.`,
      );
    }

    const dialect = (rawDriver || inferred || "sqlite") as Dialect;
    if (dialect === "sqlite") {
      return { dialect, url: stripFileScheme(databaseUrl) };
    }
    return { dialect, url: databaseUrl };
  }

  if (rawDriver && rawDriver !== "sqlite") {
    throw new Error(
      `DB_DRIVER="${rawDriver}" requires DATABASE_URL to be set. ` +
        `Example: DATABASE_URL=postgres://user:pass@host:5432/neko`,
    );
  }

  // Backwards-compatible default: a local SQLite file.
  return { dialect: "sqlite", url: dbPath };
}

export const dbConfig: DatabaseConfig = resolveConfig();

/**
 * True when the active engine is a single local SQLite *file* on disk.
 *
 * Deliberately narrower than `dialect === "sqlite"`. An in-memory SQLite
 * database has no file: there is nothing for `Bun.file()` to read, no size to
 * report in the system panel, and no `.sqlite` binary to export. Excluding it
 * here makes those call sites fall back to the dialect-independent JSON backup,
 * which works on any engine — so `:memory:` degrades to a slower export rather
 * than to a download of a file that does not exist.
 */
export const isFileBackedSqlite =
  dbConfig.dialect === "sqlite" && dbConfig.url !== ":memory:";

/** True for any SQLite engine, including an in-memory one. */
const isSqlite = dbConfig.dialect === "sqlite";

/**
 * A human-readable description of where the data lives, used by the admin
 * dashboard. Redacts any credentials embedded in a connection URL.
 */
export function describeConnection(): string {
  if (isFileBackedSqlite) return dbConfig.url;
  if (isSqlite) return ":memory: (in-memory, discarded on exit)";
  try {
    const parsed = new URL(dbConfig.url);
    const auth = parsed.username ? `${parsed.username}:***@` : "";
    return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`;
  } catch {
    return `${dbConfig.dialect} (configured)`;
  }
}
