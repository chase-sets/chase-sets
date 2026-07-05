import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAGING_DATABASE_CHECKS,
  DEFAULT_STAGING_RESTORE_DRILL_FORK_TIMEOUT_MS,
  STAGING_RESTORE_DRILL_PREFIX,
  buildStagingRestoreDrillName,
  databaseUrlForDatabase,
  normalizeRestoreDrillDatabaseUrl,
  parseDigitalOceanDatabaseRestoreDrillArgs,
  performDigitalOceanDatabaseRestoreDrill,
  resolveRestoreDrillDatabaseSsl,
} from "./digitalocean-database-restore-drill.mjs";

const baseOptions = {
  doctlPath: "doctl",
  sourceClusterId: "db-staging",
  environment: "staging",
  workflowRunId: "987654321",
  workflowRunAttempt: "2",
  commitSha: "a".repeat(40),
  checkedAt: "2026-07-03T07:23:00.000Z",
  databaseChecks: [
    { contextName: "catalog", databaseName: "chase_sets_staging_catalog", eventStoreTables: true },
    { contextName: "control", databaseName: "chase_sets_staging_control", eventStoreTables: false },
  ],
};

describe("digitalocean database restore drill", () => {
  it("forks staging, validates expected databases, records timing, and deletes the fork", async () => {
    const calls = [];
    const result = await performDigitalOceanDatabaseRestoreDrill(baseOptions, {
      now: clock([0, 185000, 186000, 190000]),
      execFile: async (command, args) => {
        calls.push({ command, args });
        if (args[1] === "fork") {
          return { stdout: "" };
        }
        if (args[1] === "list") {
          return {
            stdout: "db-drill\tcs-stg-drill-20260703-987654321-2\tonline\t2026-07-03T07:26:05Z\n",
          };
        }
        if (args[1] === "connection") {
          return {
            stdout: "postgresql://doadmin:super-secret@fork.example.com:25060/defaultdb?sslmode=require\n",
          };
        }
        if (args[1] === "delete") {
          return { stdout: "" };
        }
        throw new Error(`Unexpected doctl command: ${args.join(" ")}`);
      },
      Client: fakeClientClass(),
    });

    expect(result.passesRestoreDrillGate).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: "digitalocean-database-restore-drill/v1",
      environment: "staging",
      sourceClusterId: "db-staging",
      fork: {
        clusterId: "db-drill",
        name: "cs-stg-drill-20260703-987654321-2",
        status: "online",
      },
      timings: {
        forkStartedAt: "1970-01-01T00:00:00.000Z",
        forkAvailableAt: "1970-01-01T00:03:06.000Z",
        forkToAvailableMs: 186000,
      },
      validation: {
        expectedDatabaseCount: 2,
        checkedDatabaseCount: 2,
      },
      cleanup: {
        attempted: true,
        clusterId: "db-drill",
        status: "deleted",
      },
      result: "success",
      errors: [],
    });
    expect(result.record.validation.checks).toEqual([
      expect.objectContaining({
        contextName: "catalog",
        databaseName: "chase_sets_staging_catalog",
        status: "success",
        eventStore: {
          skipped: false,
          tables: ["event_store_streams", "event_store_events"],
          streamCount: "3",
          maxGlobalPosition: "42",
        },
      }),
      expect.objectContaining({
        contextName: "control",
        databaseName: "chase_sets_staging_control",
        status: "success",
        eventStore: {
          skipped: true,
          reason: "control database does not own bounded-context event-store tables.",
        },
      }),
    ]);
    expect(calls).toEqual([
      {
        command: "doctl",
        args: ["databases", "fork", "cs-stg-drill-20260703-987654321-2", "--restore-from-cluster-id", "db-staging"],
      },
      { command: "doctl", args: ["databases", "list", "--format", "ID,Name,Status,Created", "--no-header"] },
      { command: "doctl", args: ["databases", "connection", "db-drill", "--format", "URI", "--no-header"] },
      { command: "doctl", args: ["databases", "delete", "db-drill", "--force"] },
    ]);
    expect(JSON.stringify(result.record)).not.toContain("super-secret");
    expect(JSON.stringify(result.record)).not.toContain("fork.example.com");
  });

  it("deletes the fork and fails the gate when validation fails", async () => {
    const calls = [];
    const result = await performDigitalOceanDatabaseRestoreDrill(baseOptions, {
      now: clock([0, 1000, 2000, 3000]),
      execFile: async (_command, args) => {
        calls.push(args);
        if (args[1] === "fork") {
          return { stdout: "" };
        }
        if (args[1] === "list") {
          return {
            stdout: "db-drill\tcs-stg-drill-20260703-987654321-2\tonline\t2026-07-03T07:26:05Z\n",
          };
        }
        if (args[1] === "connection") {
          return { stdout: "postgresql://doadmin:super-secret@fork.example.com:25060/defaultdb?sslmode=require\n" };
        }
        if (args[1] === "delete") {
          return { stdout: "" };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      },
      Client: fakeClientClass({
        queryOverrides: {
          "SELECT to_regclass": [{ streams_table: "event_store_streams", events_table: null }],
        },
      }),
    });

    expect(result.passesRestoreDrillGate).toBe(false);
    expect(result.record.result).toBe("failure");
    expect(result.record.cleanup.status).toBe("deleted");
    expect(calls.at(-1)).toEqual(["databases", "delete", "db-drill", "--force"]);
    expect(result.record.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("catalog: Database validation failed.; Missing expected event-store table(s)"),
      ]),
    );
  });

  it("bounds fork polling, records safe timeout diagnostics, and attempts cleanup", async () => {
    const calls = [];
    const sleeps = [];
    let currentMs = 0;
    const result = await performDigitalOceanDatabaseRestoreDrill(
      { ...baseOptions, forkTimeoutMs: 65_000, forkPollIntervalMs: 30_000 },
      {
        now: () => currentMs,
        sleep: async (ms) => {
          sleeps.push(ms);
          currentMs += ms;
        },
        execFile: async (_command, args) => {
          calls.push(args);
          if (args[1] === "fork") {
            return { stdout: "" };
          }
          if (args[1] === "list") {
            return {
              stdout: "db-drill\tcs-stg-drill-20260703-987654321-2\tforking\t2026-07-03T07:23:01Z\n",
            };
          }
          if (args[1] === "get") {
            return {
              stdout: "db-drill\tcs-stg-drill-20260703-987654321-2\tforking\t2026-07-03T07:23:01Z\n",
            };
          }
          if (args[1] === "delete") {
            return { stdout: "" };
          }
          throw new Error(`Unexpected doctl command: ${args.join(" ")}`);
        },
        Client: fakeClientClass(),
      },
    );

    expect(result.passesRestoreDrillGate).toBe(false);
    expect(calls).toEqual([
      ["databases", "fork", "cs-stg-drill-20260703-987654321-2", "--restore-from-cluster-id", "db-staging"],
      ["databases", "list", "--format", "ID,Name,Status,Created", "--no-header"],
      ["databases", "get", "db-drill", "--format", "ID,Name,Status,Created", "--no-header"],
      ["databases", "get", "db-drill", "--format", "ID,Name,Status,Created", "--no-header"],
      ["databases", "get", "db-drill", "--format", "ID,Name,Status,Created", "--no-header"],
      ["databases", "delete", "db-drill", "--force"],
    ]);
    expect(sleeps).toEqual([30_000, 30_000, 5_000]);
    expect(result.record).toMatchObject({
      result: "failure",
      fork: {
        clusterId: "db-drill",
        name: "cs-stg-drill-20260703-987654321-2",
        status: "forking",
      },
      timings: {
        forkWaitMs: 65_000,
        forkAvailableAt: null,
        forkToAvailableMs: null,
      },
      cleanup: {
        attempted: true,
        clusterId: "db-drill",
        status: "deleted",
      },
    });
    expect(result.record.errors).toEqual([
      "Timed out waiting for staging restore drill fork 'cs-stg-drill-20260703-987654321-2' to become online.",
      "last observed cluster id: db-drill",
      "last observed status: forking",
    ]);
  });

  it("fails closed before calling doctl outside staging", async () => {
    const result = await performDigitalOceanDatabaseRestoreDrill(
      { ...baseOptions, environment: "production" },
      {
        execFile: async () => {
          throw new Error("doctl should not be called");
        },
      },
    );

    expect(result.passesRestoreDrillGate).toBe(false);
    expect(result.record.cleanup.attempted).toBe(false);
    expect(result.record.errors).toContain(
      "DigitalOcean database restore drill is staging-only; DEPLOYMENT_ENVIRONMENT must be staging.",
    );
  });

  it("parses CLI and environment options", () => {
    const options = parseDigitalOceanDatabaseRestoreDrillArgs(["--source-cluster-id", "db-cli"], {
      DIGITALOCEAN_DATABASE_RESTORE_DRILL_OUT: "artifacts/database-restore-drill/evidence.json",
      DEPLOYMENT_ENVIRONMENT: "staging",
      GITHUB_RUN_ID: "111",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: "b".repeat(40),
      RESTORE_DRILL_DATABASE_CHECKS:
        "catalog:chase_sets_staging_catalog,control:chase_sets_staging_control:database-only",
    });

    expect(options).toMatchObject({
      outPath: "artifacts/database-restore-drill/evidence.json",
      sourceClusterId: "db-cli",
      environment: "staging",
      workflowRunId: "111",
      workflowRunAttempt: "1",
      commitSha: "b".repeat(40),
      databaseChecks: [
        { contextName: "catalog", databaseName: "chase_sets_staging_catalog", eventStoreTables: true },
        { contextName: "control", databaseName: "chase_sets_staging_control", eventStoreTables: false },
      ],
    });
  });

  it("defaults to a 75-minute fork availability budget", () => {
    expect(parseDigitalOceanDatabaseRestoreDrillArgs([], {}).forkTimeoutMs).toBe(75 * 60 * 1000);
    expect(DEFAULT_STAGING_RESTORE_DRILL_FORK_TIMEOUT_MS).toBe(75 * 60 * 1000);
  });

  it("keeps default staging database checks aligned with Terraform names", () => {
    expect(DEFAULT_STAGING_DATABASE_CHECKS.map((check) => check.contextName)).toEqual([
      "auth",
      "catalog",
      "checkout",
      "commercial-terms",
      "control",
      "discovery",
      "fulfillment",
      "identity",
      "inventory",
      "marketplace",
      "notifications",
      "ordering",
      "payments",
      "platform-operations",
      "pricing",
      "public-presence",
      "settlement",
    ]);
    expect(DEFAULT_STAGING_DATABASE_CHECKS).toContainEqual({
      contextName: "platform-operations",
      databaseName: "chase_sets_staging_platform_ops",
      eventStoreTables: true,
    });
  });

  it("builds bounded drill fork names and rewrites fork URLs per database", () => {
    expect(buildStagingRestoreDrillName(baseOptions)).toBe(`${STAGING_RESTORE_DRILL_PREFIX}20260703-987654321-2`);
    expect(
      databaseUrlForDatabase(
        "postgresql://doadmin:secret@fork.example.com:25060/defaultdb?sslmode=require",
        "chase_sets_staging_catalog",
      ),
    ).toBe("postgresql://doadmin:secret@fork.example.com:25060/chase_sets_staging_catalog?sslmode=require");
  });

  it("uses DigitalOcean-compatible TLS settings for restored fork validation", async () => {
    const configs = [];
    const result = await performDigitalOceanDatabaseRestoreDrill(baseOptions, {
      now: clock([0, 1000, 2000, 3000]),
      execFile: async (_command, args) => {
        if (args[1] === "fork") {
          return { stdout: "" };
        }
        if (args[1] === "list") {
          return {
            stdout: "db-drill\tcs-stg-drill-20260703-987654321-2\tonline\t2026-07-03T07:26:05Z\n",
          };
        }
        if (args[1] === "connection") {
          return { stdout: "postgresql://doadmin:super-secret@fork.example.com:25060/defaultdb?sslmode=require\n" };
        }
        if (args[1] === "delete") {
          return { stdout: "" };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      },
      Client: fakeClientClass({
        onConstruct: (config) => configs.push(config),
      }),
    });

    expect(result.passesRestoreDrillGate).toBe(true);
    expect(configs).toHaveLength(2);
    for (const config of configs) {
      expect(config.connectionString).toContain("sslmode=require");
      expect(config.connectionString).toContain("uselibpqcompat=true");
      expect(config.ssl).toEqual({ rejectUnauthorized: false });
    }
  });

  it("normalizes restore-drill TLS URLs without changing explicit compatibility settings", () => {
    expect(normalizeRestoreDrillDatabaseUrl("postgresql://user:pass@example.com:25060/defaultdb?sslmode=require")).toBe(
      "postgresql://user:pass@example.com:25060/defaultdb?sslmode=require&uselibpqcompat=true",
    );
    expect(
      normalizeRestoreDrillDatabaseUrl(
        "postgresql://user:pass@example.com:25060/defaultdb?sslmode=require&uselibpqcompat=false",
      ),
    ).toBe("postgresql://user:pass@example.com:25060/defaultdb?sslmode=require&uselibpqcompat=false");
    expect(resolveRestoreDrillDatabaseSsl("postgresql://user:pass@example.com/defaultdb?sslmode=require")).toEqual({
      rejectUnauthorized: false,
    });
    expect(resolveRestoreDrillDatabaseSsl("postgresql://user:pass@example.com/defaultdb?sslmode=verify-full")).toBe(
      undefined,
    );
  });
});

function fakeClientClass(options = {}) {
  const queryOverrides = options.queryOverrides ?? {};
  const onConstruct = options.onConstruct ?? (() => undefined);
  return class FakeClient {
    constructor(config) {
      onConstruct(config);
      this.config = config;
      this.databaseName = decodeURIComponent(new URL(config.connectionString).pathname.slice(1));
    }

    async connect() {}

    async query(sql) {
      const override = Object.entries(queryOverrides).find(([needle]) => sql.includes(needle));
      if (override) {
        return { rows: override[1] };
      }
      if (sql.includes("current_database()")) {
        return { rows: [{ database_name: this.databaseName }] };
      }
      if (sql.includes("to_regclass")) {
        return { rows: [{ streams_table: "event_store_streams", events_table: "event_store_events" }] };
      }
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ row_count: "3" }] };
      }
      if (sql.includes("MAX(global_position)")) {
        return { rows: [{ max_global_position: "42" }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }

    async end() {}
  };
}

function clock(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
