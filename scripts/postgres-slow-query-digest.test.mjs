import { describe, expect, it } from "vitest";
import {
  POSTGRES_SLOW_QUERY_DIGEST_VERSION,
  buildPostgresSlowQueryDigest,
  collectPostgresSlowQueryDigestWithClient,
  parsePostgresSlowQueryDigestArgs,
  runPostgresSlowQueryDigest,
  validatePostgresSlowQueryDigestOptions,
} from "./postgres-slow-query-digest.mjs";
import { normalizePostgresConnectionString, resolvePostgresSsl } from "./lib/postgres-connection.mjs";

const checkedAt = "2026-07-03T15:30:00.000Z";

function insufficientPrivilegeError(message) {
  return Object.assign(new Error(message), { code: "42501" });
}

function selfSignedCertificateError() {
  return Object.assign(new Error("self-signed certificate in certificate chain"), {
    code: "SELF_SIGNED_CERT_IN_CHAIN",
  });
}

function createFakeExtensionStatusClient({
  extensionInstalled,
  extensionSchema = "public",
  postureValues = {},
  deniedSettings = [],
  digestRows = [],
}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("pg_extension e ON e.extname = 'pg_stat_statements'")) {
        return {
          rows: [
            {
              database_name: "checkout",
              extension_installed: extensionInstalled,
              extension_schema: extensionInstalled ? extensionSchema : null,
            },
          ],
        };
      }
      if (sql.includes("current_setting($1, true)")) {
        const settingName = params[0];
        if (deniedSettings.includes(settingName)) {
          throw insufficientPrivilegeError(`permission denied for parameter "${settingName}"`);
        }
        return { rows: [{ value: postureValues[settingName] ?? null }] };
      }
      if (sql.includes(`FROM "${extensionSchema}".pg_stat_statements s`)) {
        return { rows: digestRows };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

describe("postgres slow-query digest", () => {
  it("preserves full certificate verification for managed PostgreSQL URLs", () => {
    const connectionString = normalizePostgresConnectionString(
      "postgresql://user:secret@db.example:25060/database?sslmode=require",
    );

    expect(connectionString).toContain("sslmode=verify-full");
    expect(connectionString).toContain("uselibpqcompat=true");
    expect(resolvePostgresSsl(connectionString, {})).toEqual({ rejectUnauthorized: true });
  });

  it("parses options and database URLs from flags and environment", () => {
    const options = parsePostgresSlowQueryDigestArgs(
      [
        "--environment",
        "production",
        "--checked-at",
        checkedAt,
        "--top-query-limit",
        "10",
        "--contexts",
        "catalog,checkout",
        "--database-url",
        "catalog=postgresql://catalog:secret@db.example/catalog",
        "--out",
        "artifacts/postgres-slow-query-digest.json",
      ],
      {
        DATABASE_URL_CHECKOUT: "postgresql://checkout:secret@db.example/checkout",
        PLATFORM_CONTROL_DATABASE_URL: "postgresql://control:secret@db.example/control",
      },
    );

    expect(options).toMatchObject({
      environment: "production",
      checkedAt,
      topQueryLimit: 10,
      contexts: ["catalog", "checkout"],
      outPath: "artifacts/postgres-slow-query-digest.json",
    });
    expect(options.databaseUrls.map((entry) => entry.contextName)).toEqual(["catalog", "checkout", "control"]);
  });

  it("validates required options before connecting to databases", () => {
    expect(
      validatePostgresSlowQueryDigestOptions({
        environment: "",
        checkedAt: "soon",
        topQueryLimit: 101,
        databaseUrls: [],
      }),
    ).toEqual([
      "--environment is required.",
      "--checked-at must be an ISO timestamp.",
      "--top-query-limit must be an integer from 1 to 100.",
      "At least one DATABASE_URL_<CONTEXT>, PLATFORM_CONTROL_DATABASE_URL, or --database-url context=url is required.",
    ]);

    expect(
      validatePostgresSlowQueryDigestOptions({
        environment: "staging",
        checkedAt,
        topQueryLimit: 20,
        contexts: ["catalog"],
        databaseUrls: [{ contextName: "checkout", url: "postgresql://checkout" }],
      }),
    ).toEqual(["--contexts did not match any configured database URLs."]);
  });

  it("builds support-safe aggregate evidence without query text or literals", () => {
    const evidence = buildPostgresSlowQueryDigest({
      environment: "staging",
      checkedAt,
      topQueryLimit: 25,
      databases: [
        {
          contextName: "checkout",
          databaseName: "chase_sets_checkout",
          pgStatStatements: {
            extensionInstalled: true,
            viewAccessible: true,
            sharedPreloadLibraryEnabled: true,
            trackSetting: "top",
            computeQueryIdSetting: "auto",
          },
          slowQueryDigests: [
            {
              fingerprint: "pgss-0123456789abcdef",
              query: "SELECT * FROM checkout_sessions WHERE account_id = 'acct_secret'",
              calls: "5",
              totalExecTimeMs: "125.4567",
              meanExecTimeMs: "25.091",
              maxExecTimeMs: "40.5",
              stddevExecTimeMs: "3.2",
              rowsReturned: "10",
              sharedBlockHits: "100",
              sharedBlockReads: "4",
              tempBlockReads: "0",
              tempBlockWrites: "1",
              walBytes: "512",
            },
          ],
        },
      ],
      errors: [
        {
          contextName: "payments",
          message:
            "connect failed for postgresql://user:password@db.example/payments?token=secret and owner@example.com",
        },
      ],
    });

    expect(evidence).toMatchObject({
      schemaVersion: POSTGRES_SLOW_QUERY_DIGEST_VERSION,
      result: "warning",
      summary: {
        attemptedDatabaseCount: 2,
        collectedDatabaseCount: 1,
        extensionAbsentDatabaseCount: 0,
        extensionInstalledDatabaseCount: 1,
        collectionErrorCount: 1,
        digestCount: 1,
        totalCalls: 5,
        largestTotalExecTimeMs: 125.457,
      },
      databases: [
        {
          contextName: "checkout",
          pgStatStatements: {
            extensionInstalled: true,
            viewAccessible: true,
          },
          slowQueryDigests: [
            {
              fingerprint: "pgss-0123456789abcdef",
              calls: 5,
              totalExecTimeMs: 125.457,
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("SELECT *");
    expect(serialized).not.toContain("acct_secret");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("password@");
  });

  it("preserves a null (undetermined) optional posture setting through sanitization", () => {
    const evidence = buildPostgresSlowQueryDigest({
      environment: "staging",
      checkedAt,
      topQueryLimit: 25,
      databases: [
        {
          contextName: "checkout",
          databaseName: "chase_sets_checkout",
          pgStatStatements: {
            extensionInstalled: true,
            viewAccessible: true,
            sharedPreloadLibraryEnabled: null,
            trackSetting: null,
            computeQueryIdSetting: "auto",
          },
          slowQueryDigests: [],
        },
      ],
      errors: [],
    });

    expect(evidence.result).toBe("success");
    expect(evidence.databases[0].pgStatStatements).toMatchObject({
      extensionInstalled: true,
      viewAccessible: true,
      sharedPreloadLibraryEnabled: null,
      trackSetting: null,
      computeQueryIdSetting: "auto",
    });
  });

  it("collects pg_stat_statements through a bounded aggregate query surface", async () => {
    const client = createFakeExtensionStatusClient({
      extensionInstalled: true,
      postureValues: {
        shared_preload_libraries: "pg_stat_statements",
        "pg_stat_statements.track": "top",
        compute_query_id: "auto",
      },
      digestRows: [
        {
          query_id: "847261",
          calls: "7",
          total_exec_time_ms: "320.5",
          mean_exec_time_ms: "45.8",
          max_exec_time_ms: "90.1",
          stddev_exec_time_ms: "8.4",
          rows_returned: "42",
          shared_block_hits: "1000",
          shared_block_reads: "25",
          temp_block_reads: "0",
          temp_block_writes: "2",
          wal_bytes: "2048",
        },
      ],
    });

    const evidence = await collectPostgresSlowQueryDigestWithClient(
      client,
      { contextName: "checkout", url: "postgresql://checkout:secret@example/checkout" },
      { topQueryLimit: 5 },
    );

    expect(evidence).toMatchObject({
      contextName: "checkout",
      databaseName: "checkout",
      pgStatStatements: {
        extensionInstalled: true,
        viewAccessible: true,
        sharedPreloadLibraryEnabled: true,
        trackSetting: "top",
        computeQueryIdSetting: "auto",
      },
      slowQueryDigests: [
        {
          calls: "7",
          totalExecTimeMs: "320.5",
        },
      ],
    });
    expect(evidence.slowQueryDigests[0].fingerprint).toMatch(/^pgss-[a-f0-9]{16}$/);
    expect(evidence.slowQueryDigests[0].fingerprint).not.toContain("847261");
    expect(client.queries).toHaveLength(5);
    expect(client.queries.filter((query) => query.sql.includes("current_setting($1, true)")).map((q) => q.params[0])).toEqual([
      "shared_preload_libraries",
      "pg_stat_statements.track",
      "compute_query_id",
    ]);
    const digestQuery = client.queries.find((query) => query.sql.includes("pg_stat_statements s"));
    expect(digestQuery.sql).not.toContain("s.query ");
    expect(digestQuery.params).toEqual([5]);
  });

  it("collects accessible extension/view/digest evidence when a role is denied an optional posture setting", async () => {
    const client = createFakeExtensionStatusClient({
      extensionInstalled: true,
      deniedSettings: ["shared_preload_libraries"],
      postureValues: {
        "pg_stat_statements.track": "top",
        compute_query_id: "auto",
      },
      digestRows: [
        {
          query_id: "1",
          calls: "3",
          total_exec_time_ms: "10",
          mean_exec_time_ms: "3.3",
          max_exec_time_ms: "5",
          stddev_exec_time_ms: "1",
          rows_returned: "1",
          shared_block_hits: "1",
          shared_block_reads: "0",
          temp_block_reads: "0",
          temp_block_writes: "0",
          wal_bytes: "0",
        },
      ],
    });

    const evidence = await collectPostgresSlowQueryDigestWithClient(
      client,
      { contextName: "checkout", url: "postgresql://checkout:secret@example/checkout" },
      { topQueryLimit: 5 },
    );

    expect(evidence.pgStatStatements).toEqual({
      extensionInstalled: true,
      viewAccessible: true,
      sharedPreloadLibraryEnabled: null,
      trackSetting: "top",
      computeQueryIdSetting: "auto",
    });
    expect(evidence.slowQueryDigests).toHaveLength(1);
    expect(JSON.stringify(evidence)).not.toMatch(/permission denied|42501/);
  });

  it("records extension absence without attempting DDL and without a digest query", async () => {
    const client = createFakeExtensionStatusClient({
      extensionInstalled: false,
      postureValues: {
        shared_preload_libraries: "",
        "pg_stat_statements.track": null,
        compute_query_id: "auto",
      },
    });

    const evidence = await collectPostgresSlowQueryDigestWithClient(
      client,
      { contextName: "catalog", url: "postgresql://catalog:secret@example/catalog" },
      { topQueryLimit: 5 },
    );

    expect(evidence).toMatchObject({
      pgStatStatements: {
        extensionInstalled: false,
        viewAccessible: false,
        sharedPreloadLibraryEnabled: false,
        computeQueryIdSetting: "auto",
      },
      slowQueryDigests: [],
    });
    expect(client.queries).toHaveLength(4);
    expect(client.queries.map((query) => query.sql).join("\n")).not.toMatch(/CREATE EXTENSION|ALTER SYSTEM/i);
  });

  it("keeps a genuine mixed run's collection failures support-safe and returns an advisory warning", async () => {
    const evidence = await runPostgresSlowQueryDigest(
      {
        environment: "staging",
        checkedAt,
        topQueryLimit: 25,
        databaseUrls: [
          { contextName: "checkout", url: "postgresql://checkout:secret@example/checkout" },
          { contextName: "payments", url: "postgresql://payments:secret@example/payments" },
        ],
      },
      {
        async collectDatabase(database) {
          if (database.contextName === "payments") {
            throw new Error(
              `failed ${database.url} token=abc123 for user@example.com -----BEGIN CERTIFICATE----- ca-marker`,
            );
          }
          return {
            contextName: database.contextName,
            databaseName: "checkout",
            pgStatStatements: {
              extensionInstalled: false,
              viewAccessible: false,
              sharedPreloadLibraryEnabled: false,
              trackSetting: null,
              computeQueryIdSetting: "auto",
            },
            slowQueryDigests: [],
          };
        },
      },
    );

    expect(evidence.result).toBe("warning");
    expect(evidence.summary).toMatchObject({
      attemptedDatabaseCount: 2,
      collectedDatabaseCount: 1,
      extensionAbsentDatabaseCount: 1,
      collectionErrorCount: 1,
    });
    expect(evidence.errors).toEqual([
      {
        contextName: "payments",
        category: "collection-error",
        classification: "postgres-query-failed",
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("CERTIFICATE");
    expect(JSON.stringify(evidence)).not.toContain("ca-marker");
  });

  it("fails closed when every attempted database fails to collect (zero coverage)", async () => {
    const contexts = ["checkout", "payments", "catalog"];
    const evidence = await runPostgresSlowQueryDigest(
      {
        environment: "staging",
        checkedAt,
        topQueryLimit: 25,
        databaseUrls: contexts.map((contextName) => ({
          contextName,
          url: `postgresql://${contextName}:secret@example/${contextName}`,
        })),
      },
      {
        async collectDatabase() {
          throw selfSignedCertificateError();
        },
      },
    );

    expect(evidence.result).toBe("failure");
    expect(evidence.summary).toMatchObject({
      attemptedDatabaseCount: 3,
      collectedDatabaseCount: 0,
      extensionAbsentDatabaseCount: 0,
      collectionErrorCount: 3,
      digestCount: 0,
      totalCalls: 0,
      largestTotalExecTimeMs: 0,
      largestMaxExecTimeMs: 0,
    });
    expect(evidence.errors).toHaveLength(3);
    for (const error of evidence.errors) {
      expect(error).toEqual({
        contextName: error.contextName,
        category: "collection-error",
        classification: "self-signed-certificate-in-certificate-chain",
        code: "SELF_SIGNED_CERT_IN_CHAIN",
      });
    }
  });

  it("keeps a genuine PostgreSQL insufficient-privilege collection failure bounded and support-safe", async () => {
    const evidence = await runPostgresSlowQueryDigest(
      {
        environment: "staging",
        checkedAt,
        topQueryLimit: 25,
        databaseUrls: [{ contextName: "checkout", url: "postgresql://checkout:secret@example/checkout" }],
      },
      {
        async collectDatabase() {
          throw insufficientPrivilegeError(
            'permission denied for parameter "shared_preload_libraries" -- secret@example.com https://internal.example/leak',
          );
        },
      },
    );

    expect(evidence.result).toBe("failure");
    expect(evidence.errors).toEqual([
      {
        contextName: "checkout",
        category: "collection-error",
        classification: "postgres-query-failed",
        code: "42501",
      },
    ]);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("permission denied");
    expect(serialized).not.toContain("secret@example.com");
    expect(serialized).not.toContain("https://internal.example/leak");
  });
});
