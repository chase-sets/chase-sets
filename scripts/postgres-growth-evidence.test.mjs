import { describe, expect, it } from "vitest";
import {
  POSTGRES_GROWTH_EVIDENCE_VERSION,
  buildPostgresGrowthEvidence,
  collectPostgresDatabaseGrowthWithClient,
  parseDatabaseUrls,
  parsePostgresGrowthEvidenceArgs,
  runPostgresGrowthEvidence,
  validatePostgresGrowthEvidenceOptions,
} from "./postgres-growth-evidence.mjs";
import { normalizePostgresConnectionString, resolvePostgresSsl } from "./lib/postgres-connection.mjs";

const checkedAt = "2026-07-03T14:30:00.000Z";

describe("postgres growth evidence", () => {
  it("preserves full certificate verification for managed PostgreSQL URLs", () => {
    const connectionString = normalizePostgresConnectionString(
      "postgresql://user:secret@db.example:25060/database?sslmode=require",
    );

    expect(connectionString).toContain("sslmode=verify-full");
    expect(connectionString).toContain("uselibpqcompat=true");
    expect(resolvePostgresSsl(connectionString, {})).toEqual({ rejectUnauthorized: true });
  });

  it("parses options and database URLs from flags and environment", () => {
    const options = parsePostgresGrowthEvidenceArgs(
      [
        "--environment",
        "production",
        "--checked-at",
        checkedAt,
        "--top-table-limit",
        "12",
        "--connection-utilization-warning-percent",
        "75",
        "--contexts",
        "catalog,checkout",
        "--database-url",
        "catalog=postgresql://catalog:secret@db.example/catalog",
        "--out",
        "artifacts/postgres-growth.json",
      ],
      {
        DATABASE_URL_CHECKOUT: "postgresql://checkout:secret@db.example/checkout",
        PLATFORM_CONTROL_DATABASE_URL: "postgresql://control:secret@db.example/control",
      },
    );

    expect(options).toMatchObject({
      environment: "production",
      checkedAt,
      topTableLimit: 12,
      connectionUtilizationWarningPercent: 75,
      contexts: ["catalog", "checkout"],
      outPath: "artifacts/postgres-growth.json",
    });
    expect(options.databaseUrls.map((entry) => entry.contextName)).toEqual(["catalog", "checkout", "control"]);
  });

  it("validates required options before connecting to databases", () => {
    expect(
      validatePostgresGrowthEvidenceOptions({
        environment: "",
        checkedAt: "soon",
        topTableLimit: 101,
        connectionUtilizationWarningPercent: 0,
        databaseUrls: [],
      }),
    ).toEqual([
      "--environment is required.",
      "--checked-at must be an ISO timestamp.",
      "--top-table-limit must be an integer from 1 to 100.",
      "--connection-utilization-warning-percent must be an integer from 1 to 100.",
      "At least one DATABASE_URL_<CONTEXT>, PLATFORM_CONTROL_DATABASE_URL, or --database-url context=url is required.",
    ]);

    expect(
      validatePostgresGrowthEvidenceOptions({
        environment: "staging",
        checkedAt,
        topTableLimit: 20,
        connectionUtilizationWarningPercent: 80,
        contexts: ["catalog"],
        databaseUrls: [{ contextName: "checkout", url: "postgresql://checkout" }],
      }),
    ).toEqual(["--contexts did not match any configured database URLs."]);
  });

  it("deduplicates and normalizes database URL sources", () => {
    expect(
      parseDatabaseUrls(["--database-url", "checkout=postgresql://flag"], {
        DATABASE_URL_CHECKOUT: "postgresql://env",
        DATABASE_URL_COMMERCIAL_TERMS: "postgresql://terms",
        PLATFORM_CONTROL_DATABASE_URL: "postgresql://control",
      }),
    ).toEqual([
      { contextName: "checkout", url: "postgresql://flag" },
      { contextName: "commercial-terms", url: "postgresql://terms" },
      { contextName: "control", url: "postgresql://control" },
    ]);
  });

  it("builds support-safe aggregate evidence", () => {
    const evidence = buildPostgresGrowthEvidence({
      environment: "staging",
      checkedAt,
      topTableLimit: 20,
      connectionUtilizationWarningPercent: 80,
      databases: [
        {
          contextName: "checkout",
          databaseName: "chase_sets_checkout",
          databaseSizeBytes: "2048",
          tableCount: "2",
          estimatedLiveRows: "30",
          estimatedDeadRows: "4",
          connections: {
            active: "4",
            max: "100",
            utilizationPercent: "4",
          },
          largestTables: [
            {
              schemaName: "public",
              tableName: "checkout_sessions",
              totalBytes: "1024",
              heapBytes: "512",
              indexBytes: "256",
              toastBytes: "256",
              estimatedLiveRows: "20",
              estimatedDeadRows: "1",
              lastVacuumAt: null,
              lastAutoVacuumAt: "2026-07-03T14:00:00.000Z",
              lastAnalyzeAt: null,
              lastAutoAnalyzeAt: null,
            },
          ],
          eventStore: {
            present: true,
            estimatedEvents: "10",
            totalBytes: "512",
            maxGlobalPosition: "42",
            lastRecordedAt: "2026-07-03T14:01:00.000Z",
          },
        },
      ],
      errors: [
        {
          contextName: "payments",
          message: "connect failed for postgresql://user:password@db.example/payments?token=secret",
        },
      ],
    });

    expect(evidence).toMatchObject({
      schemaVersion: POSTGRES_GROWTH_EVIDENCE_VERSION,
      result: "warning",
      summary: {
        databaseCount: 1,
        collectionErrorCount: 1,
        warningCount: 0,
        totalDatabaseSizeBytes: 2048,
        totalEstimatedLiveRows: 30,
        largestTableBytes: 1024,
        maxConnectionUtilizationPercent: 4,
      },
      databases: [
        {
          contextName: "checkout",
          databaseSizeBytes: 2048,
          connections: {
            active: 4,
            max: 100,
            utilizationPercent: 4,
          },
          largestTables: [
            {
              schemaName: "public",
              tableName: "checkout_sessions",
              totalBytes: 1024,
            },
          ],
          eventStore: {
            present: true,
            maxGlobalPosition: "42",
          },
        },
      ],
    });
    expect(JSON.stringify(evidence)).not.toContain("password");
    expect(JSON.stringify(evidence)).not.toContain("secret");
    expect(JSON.stringify(evidence)).not.toContain("postgresql://");
  });

  it("warns when connection pressure crosses the support-safe threshold", () => {
    const evidence = buildPostgresGrowthEvidence({
      environment: "production",
      checkedAt,
      topTableLimit: 20,
      connectionUtilizationWarningPercent: 80,
      databases: [
        {
          contextName: "checkout",
          databaseName: "checkout",
          databaseSizeBytes: "2048",
          tableCount: "2",
          estimatedLiveRows: "30",
          estimatedDeadRows: "4",
          connections: {
            active: "82",
            max: "100",
            utilizationPercent: "82",
          },
          largestTables: [],
          eventStore: { present: false },
        },
      ],
      errors: [],
    });

    expect(evidence.result).toBe("warning");
    expect(evidence.summary).toMatchObject({
      warningCount: 1,
      maxConnectionUtilizationPercent: 82,
    });
    expect(evidence.warnings).toEqual([
      {
        contextName: "checkout",
        category: "connection-pressure",
        message: "Connection utilization is 82% of max_connections.",
        thresholdPercent: 80,
        utilizationPercent: 82,
      },
    ]);
  });

  it("collects database growth through a bounded query surface", async () => {
    const queries = [];
    const client = {
      async query(sql, params = []) {
        queries.push({ sql, params });
        if (sql.includes("pg_database_size")) {
          return {
            rows: [
              {
                database_name: "checkout",
                database_size_bytes: "4096",
                table_count: "3",
                estimated_live_rows: "120",
                estimated_dead_rows: "7",
                active_connections: "5",
                max_connections: "100",
                connection_utilization_percent: "5",
              },
            ],
          };
        }
        if (sql.includes("FROM pg_stat_user_tables s") && sql.includes("ORDER BY total_bytes")) {
          return {
            rows: [
              {
                schema_name: "public",
                table_name: "event_store_events",
                total_bytes: "2048",
                heap_bytes: "1024",
                index_bytes: "768",
                toast_bytes: "256",
                estimated_live_rows: "100",
                estimated_dead_rows: "2",
                last_vacuum_at: null,
                last_auto_vacuum_at: null,
                last_analyze_at: null,
                last_auto_analyze_at: null,
              },
            ],
          };
        }
        if (sql.includes("to_regclass('public.event_store_events')")) {
          return { rows: [{ events_table: "event_store_events" }] };
        }
        if (sql.includes("ORDER BY global_position DESC")) {
          return {
            rows: [
              {
                estimated_events: "100",
                total_bytes: "2048",
                max_global_position: "9001",
                last_recorded_at: "2026-07-03T14:01:00.000Z",
              },
            ],
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };

    const evidence = await collectPostgresDatabaseGrowthWithClient(
      client,
      { contextName: "checkout", url: "postgresql://checkout:secret@example/checkout" },
      { topTableLimit: 5 },
    );

    expect(evidence).toMatchObject({
      contextName: "checkout",
      databaseName: "checkout",
      databaseSizeBytes: "4096",
      tableCount: "3",
      connections: {
        active: "5",
        max: "100",
        utilizationPercent: "5",
      },
      eventStore: {
        present: true,
        maxGlobalPosition: "9001",
      },
    });
    expect(queries.some((query) => query.sql.includes("COUNT(*) FROM public.event_store_events"))).toBe(false);
    expect(queries.find((query) => query.sql.includes("ORDER BY total_bytes"))?.params).toEqual([5]);
  });

  it("keeps collection failures support-safe and returns a warning record", async () => {
    const evidence = await runPostgresGrowthEvidence(
      {
        environment: "staging",
        checkedAt,
        topTableLimit: 20,
        databaseUrls: [
          { contextName: "checkout", url: "postgresql://checkout:secret@example/checkout" },
          { contextName: "payments", url: "postgresql://payments:secret@example/payments" },
        ],
        connectionUtilizationWarningPercent: 80,
      },
      {
        async collectDatabase(database) {
          if (database.contextName === "payments") {
            throw new Error(`failed ${database.url} -----BEGIN CERTIFICATE----- ca-marker`);
          }
          return {
            contextName: database.contextName,
            databaseName: "checkout",
            databaseSizeBytes: 1,
            tableCount: 1,
            estimatedLiveRows: 1,
            estimatedDeadRows: 0,
            connections: { active: 1, max: 100, utilizationPercent: 1 },
            largestTables: [],
            eventStore: { present: false },
          };
        },
      },
    );

    expect(evidence.result).toBe("warning");
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
});
