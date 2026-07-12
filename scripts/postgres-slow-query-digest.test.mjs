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

describe("postgres slow-query digest", () => {
  it("uses encrypted but unverified TLS for DigitalOcean sslmode=require URLs", () => {
    const connectionString = normalizePostgresConnectionString(
      "postgresql://user:secret@db.example:25060/database?sslmode=require",
    );

    expect(connectionString).toContain("sslmode=require");
    expect(connectionString).toContain("uselibpqcompat=true");
    expect(resolvePostgresSsl(connectionString)).toEqual({ rejectUnauthorized: false });
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
        databaseCount: 1,
        collectionErrorCount: 1,
        extensionInstalledDatabaseCount: 1,
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

  it("collects pg_stat_statements through a bounded aggregate query surface", async () => {
    const queries = [];
    const client = {
      async query(sql, params = []) {
        queries.push({ sql, params });
        if (sql.includes("pg_extension e ON e.extname = 'pg_stat_statements'")) {
          return {
            rows: [
              {
                database_name: "checkout",
                extension_installed: true,
                extension_schema: "public",
                shared_preload_library_enabled: true,
                track_setting: "top",
                compute_query_id_setting: "auto",
              },
            ],
          };
        }
        if (sql.includes('FROM "public".pg_stat_statements s')) {
          return {
            rows: [
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
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };

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
    expect(queries.find((query) => query.sql.includes("pg_stat_statements s"))?.sql).not.toContain("s.query ");
    expect(queries.find((query) => query.sql.includes("pg_stat_statements s"))?.params).toEqual([5]);
  });

  it("records extension absence without attempting DDL", async () => {
    const queries = [];
    const client = {
      async query(sql) {
        queries.push(sql);
        return {
          rows: [
            {
              database_name: "catalog",
              extension_installed: false,
              extension_schema: null,
              shared_preload_library_enabled: false,
              track_setting: null,
              compute_query_id_setting: "auto",
            },
          ],
        };
      },
    };

    const evidence = await collectPostgresSlowQueryDigestWithClient(
      client,
      { contextName: "catalog", url: "postgresql://catalog:secret@example/catalog" },
      { topQueryLimit: 5 },
    );

    expect(evidence).toMatchObject({
      pgStatStatements: {
        extensionInstalled: false,
        viewAccessible: false,
      },
      slowQueryDigests: [],
    });
    expect(queries).toHaveLength(1);
    expect(queries.join("\n")).not.toMatch(/CREATE EXTENSION|ALTER SYSTEM/i);
  });

  it("keeps collection failures support-safe and returns a warning record", async () => {
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
            throw new Error(`failed ${database.url} token=abc123 for user@example.com`);
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
    expect(evidence.errors).toEqual([
      {
        contextName: "payments",
        category: "collection-error",
        message: "failed [redacted-postgres-url] token=[redacted] for [redacted-email]",
      },
    ]);
  });
});
