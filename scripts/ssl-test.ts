/**
 * Unit tests for the Postgres TLS decision, which needs no database.
 *
 * This logic decided whether a connection was encrypted, and getting it wrong
 * takes a deployment down. It has already failed production twice, in two
 * different ways that both presented as an opaque server-side error naming
 * `pg_hba.conf` or a certificate chain rather than the connection string that
 * caused them. The failure is only observable against a TLS-requiring host, so
 * it cannot be covered by the data-layer smoke test, and it is cheap and pure
 * enough to assert directly.
 *
 *   bun run scripts/ssl-test.ts
 */
import {
  sslFromConnectionString,
  withoutSslModeParam,
  isTlsRequiredError,
} from "../src/db/driver/postgres";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : detail);
  }
}

const HOST = "postgres://u:p@db.example.com:5432/neko";
const REQUIRE = "?sslmode=require";

console.log("\n[1] an explicit sslmode is honoured");
check(
  "sslmode=require requests TLS without demanding a verified peer",
  JSON.stringify(sslFromConnectionString(HOST + REQUIRE)) ===
    JSON.stringify({ rejectUnauthorized: false }),
  sslFromConnectionString(HOST + REQUIRE),
);
check(
  "sslmode=verify-ca demands verification",
  (sslFromConnectionString(HOST + "?sslmode=verify-ca") as any)
    ?.rejectUnauthorized === true,
  sslFromConnectionString(HOST + "?sslmode=verify-ca"),
);
check(
  "sslmode=verify-full demands verification",
  (sslFromConnectionString(HOST + "?sslmode=verify-full") as any)
    ?.rejectUnauthorized === true,
  sslFromConnectionString(HOST + "?sslmode=verify-full"),
);
check(
  "sslmode=disable turns TLS off",
  sslFromConnectionString(HOST + "?sslmode=disable") === false,
  sslFromConnectionString(HOST + "?sslmode=disable"),
);
check(
  "mode is case-insensitive and percent-decoded",
  (sslFromConnectionString(HOST + "?sslmode=REQUIRE") as any)
    ?.rejectUnauthorized === false,
  sslFromConnectionString(HOST + "?sslmode=REQUIRE"),
);
check(
  "sslmode is found among other query parameters",
  (
    sslFromConnectionString(
      HOST + "?application_name=neko&sslmode=require" + "",
    ) as any
  )?.rejectUnauthorized === false,
  sslFromConnectionString(HOST + "?application_name=neko&sslmode=require"),
);

console.log("\n[2] a silent URL defers to pg rather than forcing a decision");
// The regression: returning `false` here overrode PGSSLMODE, because pg only
// reads the environment when the `ssl` option is `undefined`.
check(
  "no sslmode yields undefined, not false",
  sslFromConnectionString(HOST) === undefined,
  sslFromConnectionString(HOST),
);
check(
  "an unknown mode also defers",
  sslFromConnectionString(HOST + "?sslmode=something-else") === undefined,
  sslFromConnectionString(HOST + "?sslmode=something-else"),
);

console.log("\n[3] pg actually respects the environment when we defer");
// Proves the claim above against the installed pg rather than by assertion:
// a deferred `ssl` must pick up PGSSLMODE.
const { default: pg } = await import("pg");
const savedMode = process.env.PGSSLMODE;
process.env.PGSSLMODE = "require";
try {
  const resolved = new pg.Client({
    connectionString: HOST,
    ssl: sslFromConnectionString(HOST),
  }).connectionParameters.ssl;
  check(
    "PGSSLMODE=require takes effect when the URL is silent",
    Boolean(resolved),
    resolved,
  );
} finally {
  if (savedMode === undefined) delete process.env.PGSSLMODE;
  else process.env.PGSSLMODE = savedMode;
}

console.log("\n[4] the translation actually survives pg's config merge");
// The regression that took production down. pg applies the caller's options
// first and the parsed connection string second, so a URL mentioning `sslmode`
// makes pg-connection-string overwrite `ssl` with `{}` — discarding
// `rejectUnauthorized` and silently upgrading `require` to `verify-full`.

/** Mirrors the driver's constructor without opening a connection. */
const resolve = (url: string) => {
  const ssl = sslFromConnectionString(url);
  const effectiveUrl = ssl === undefined ? url : withoutSslModeParam(url);
  return {
    effectiveUrl,
    ssl: new pg.Client({ connectionString: effectiveUrl, ssl })
      .connectionParameters.ssl,
  };
};

check(
  "sslmode is removed so pg cannot overwrite the decision",
  resolve(HOST + REQUIRE).effectiveUrl === HOST,
  resolve(HOST + REQUIRE).effectiveUrl,
);
check(
  "sslmode=require survives the merge as encrypt-without-verify",
  resolve(HOST + REQUIRE).ssl?.rejectUnauthorized === false,
  resolve(HOST + REQUIRE).ssl,
);
check(
  "sslmode=verify-full survives the merge as fully verified",
  resolve(HOST + "?sslmode=verify-full").ssl?.rejectUnauthorized === true,
  resolve(HOST + "?sslmode=verify-full").ssl,
);
check(
  "sslmode=disable survives the merge as no TLS",
  resolve(HOST + "?sslmode=disable").ssl === false,
  resolve(HOST + "?sslmode=disable").ssl,
);
check(
  "other query parameters are preserved",
  resolve(`${HOST}?application_name=neko&sslmode=require`).effectiveUrl ===
    `${HOST}?application_name=neko`,
  resolve(`${HOST}?application_name=neko&sslmode=require`).effectiveUrl,
);
check(
  "a password with reserved characters is not re-encoded",
  withoutSslModeParam("postgres://u:p@ss/w%40rd@h:5432/d?sslmode=require") ===
    "postgres://u:p@ss/w%40rd@h:5432/d",
  withoutSslModeParam("postgres://u:p@ss/w%40rd@h:5432/d?sslmode=require"),
);
check(
  "sslrootcert is left for pg to read",
  withoutSslModeParam(`${HOST}?sslrootcert=/ca.pem&sslmode=require`) ===
    `${HOST}?sslrootcert=/ca.pem`,
  withoutSslModeParam(`${HOST}?sslrootcert=/ca.pem&sslmode=require`),
);
check(
  "a non-URL connection string is untouched",
  withoutSslModeParam("/var/run/postgresql") === "/var/run/postgresql",
  withoutSslModeParam("/var/run/postgresql"),
);
check(
  "a URL with no query string is untouched",
  withoutSslModeParam(HOST) === HOST,
  withoutSslModeParam(HOST),
);

console.log("\n[5] the cleartext rejection is recognised");
check(
  "the exact Aiven/RDS message is detected",
  isTlsRequiredError(
    new Error(
      'no pg_hba.conf entry for host "1.2.3.4", user "u", database "d", no encryption',
    ),
  ),
);
check("a bare string is detected", isTlsRequiredError("no encryption"));
check(
  "a wrong-password failure is not mistaken for a TLS problem",
  !isTlsRequiredError(new Error('password authentication failed for user "u"')),
);
check("a non-Error value is tolerated", !isTlsRequiredError(undefined));

console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
