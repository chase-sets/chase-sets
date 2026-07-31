import { describe, expect, it, vi } from "vitest";
import type { BcApiEntry } from "@chase-sets/bounded-context-module";
import {
  bootstrapApiModule,
  bootstrapContextDatabase,
  composeModuleSchemaSql,
  eventSubscriptionSchemaSql,
  SCHEMA_BOOTSTRAP_LOCK_QUERY_TIMEOUT_MS,
  SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_RETRY_BUDGET_MS,
  SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_SETTING,
  SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_RETRIES,
  SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS,
  SCHEMA_MIGRATIONS_TABLE,
  SCHEMA_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE,
} from "./index";

const NO_API_ENTRIES: readonly BcApiEntry[] = [];

describe("bounded context runtime schema", () => {
  it("creates projection generation metadata for generation-aware rebuilds", () => {
    expect(eventSubscriptionSchemaSql).toContain("CREATE TABLE IF NOT EXISTS event_projection_group_generations");
    expect(eventSubscriptionSchemaSql).toContain("active_generation bigint NOT NULL DEFAULT 1");
    expect(eventSubscriptionSchemaSql).toContain("rebuilding_generation bigint NULL");
  });

  it("moves event-store backfills, large indexes, and write-hot fillfactor changes out of boot-time schema SQL", () => {
    const schemaSql = composeModuleSchemaSql({
      schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
    });

    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS event_store_events");
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS example_pages");
    expect(schemaSql).not.toContain("UPDATE event_store_events");
    expect(schemaSql).not.toContain("ALTER COLUMN stream_context_name SET NOT NULL");
    expect(schemaSql).not.toContain("CREATE INDEX IF NOT EXISTS event_store_events_stream_idx");
    expect(schemaSql).not.toContain("SET (fillfactor = 90)");
  });

  it("applies ledgered schema migrations under an advisory lock", async () => {
    const appliedMigrations = new Set<string>();
    const queryLog: { sql: string; values: readonly unknown[] | undefined }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        queryLog.push({ sql, values });
        if (sql.includes("pg_try_advisory_lock")) {
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes(`SELECT 1 FROM ${SCHEMA_MIGRATIONS_TABLE}`)) {
          return { rows: appliedMigrations.has(String(values?.[0])) ? [{ "?column?": 1 }] : [] };
        }
        if (sql.includes(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE}`)) {
          appliedMigrations.add(String(values?.[0]));
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    };

    const module = {
      contextName: "example",
      schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
      schemaMigrations: [
        {
          migrationId: "20260703_example_pages_concurrent_indexes",
          description: "Create example indexes concurrently.",
          statements: [
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_id_idx ON example_pages (id);",
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_name_idx ON example_pages (name);",
          ],
        },
      ],
    };
    await bootstrapContextDatabase(module, pool);
    const firstBootQueryCount = queryLog.length;
    await bootstrapContextDatabase(module, pool);
    const secondBootSql = queryLog
      .slice(firstBootQueryCount)
      .map((entry) => entry.sql)
      .join("\n");

    const bootSchemaSql =
      queryLog.find((entry) => entry.sql.includes("CREATE TABLE IF NOT EXISTS event_store_events"))?.sql ?? "";

    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenNthCalledWith(1, true);
    expect(client.release).toHaveBeenNthCalledWith(2, true);
    expect(queryLog.filter((entry) => entry.sql.includes("pg_try_advisory_lock")).length).toBe(2);
    expect(queryLog.filter((entry) => entry.sql.includes("pg_advisory_unlock")).length).toBe(4);
    expect(
      queryLog.filter((entry) => entry.sql === `SET lock_timeout TO '${SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_SETTING}'`),
    ).toHaveLength(2);
    expect(queryLog.filter((entry) => entry.sql === "RESET lock_timeout")).toHaveLength(2);
    expect(queryLog.some((entry) => entry.sql.includes(`CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE}`))).toBe(
      true,
    );
    expect(bootSchemaSql).not.toContain("UPDATE event_store_events");
    expect(bootSchemaSql).not.toContain("CREATE INDEX IF NOT EXISTS event_store_events_stream_idx");
    expect(bootSchemaSql).not.toContain("SET (fillfactor = 90)");
    expect(queryLog.filter((entry) => entry.sql.includes("UPDATE event_store_events")).length).toBe(1);
    expect(
      queryLog.filter((entry) => entry.sql.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_")),
    ).toHaveLength(9);
    expect(
      queryLog.filter((entry) => entry.sql.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_")),
    ).toHaveLength(2);
    expect(queryLog.filter((entry) => entry.sql === "SET lock_timeout = '5s';")).toHaveLength(1);
    expect(
      queryLog.filter((entry) => entry.sql.includes("ALTER TABLE event_store_streams\n  SET (fillfactor = 90)")),
    ).toHaveLength(1);
    expect(
      queryLog.filter((entry) =>
        entry.sql.includes("ALTER TABLE event_projection_checkpoints\n  SET (fillfactor = 90)"),
      ),
    ).toHaveLength(1);
    expect(secondBootSql).not.toContain("UPDATE event_store_events");
    expect(secondBootSql).not.toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_");
    expect(secondBootSql).not.toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_");
    expect(appliedMigrations).toEqual(
      new Set([
        "20260628_event_store_context_columns_backfill",
        "20260628_event_store_events_concurrent_indexes",
        "20260710_event_store_write_hot_fillfactor",
        "20260710_projection_recovery_marker_backfill",
        "20260703_example_pages_concurrent_indexes",
      ]),
    );
  });

  it("clears stale schema bootstrap advisory locks on reused pool clients", async () => {
    let heldLockCount = 2;
    const lockEvents: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_advisory_unlock_all")) {
          heldLockCount = 0;
          lockEvents.push("released-all");
          return { rows: [] };
        }
        if (sql.includes("pg_try_advisory_lock")) {
          heldLockCount += 1;
          lockEvents.push("acquired");
          return { rows: [{ acquired: true }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    };
    const module = {
      contextName: "example",
      schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
    };

    await bootstrapContextDatabase(module, pool);

    expect(heldLockCount).toBe(0);
    expect(lockEvents).toEqual(["released-all", "acquired", "released-all"]);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("waits past transient schema bootstrap lock contention that outlives the old two-minute ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T00:00:00.000Z"));
    try {
      const appliedMigrations = new Set<string>();
      let lockAttempts = 0;
      const client = {
        query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
          if (sql.includes("pg_try_advisory_lock")) {
            lockAttempts += 1;
            return { rows: [{ acquired: lockAttempts > 30 }] };
          }
          if (sql.includes(`SELECT 1 FROM ${SCHEMA_MIGRATIONS_TABLE}`)) {
            return { rows: appliedMigrations.has(String(values?.[0])) ? [{ "?column?": 1 }] : [] };
          }
          if (sql.includes(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE}`)) {
            appliedMigrations.add(String(values?.[0]));
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => client),
      };
      const module = {
        contextName: "example",
        schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
      };

      const bootstrap = bootstrapContextDatabase(module, pool);
      await vi.advanceTimersByTimeAsync(138_000);
      await bootstrap;

      expect(lockAttempts).toBe(31);
      expect(SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS).toBeGreaterThan(120_000);
      expect(client.release).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails with deploy-useful diagnostics after the schema bootstrap lock wait budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T00:00:00.000Z"));
    try {
      let lockAttempts = 0;
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("pg_try_advisory_lock")) {
            lockAttempts += 1;
            return { rows: [{ acquired: false }] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => client),
      };
      const module = {
        contextName: "example",
        schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
      };

      const bootstrap = bootstrapContextDatabase(module, pool);
      const bootstrapRejected = expect(bootstrap).rejects.toThrow(
        new RegExp(
          `Schema bootstrap lock was not acquired within 600000ms after \\d+ attempts \\(elapsed 600000ms, advisory lock ${SCHEMA_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE}:current_database\\(\\)\\)\\. Another deploy may still be applying schema changes`,
        ),
      );
      await vi.advanceTimersByTimeAsync(SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS + 1);

      await bootstrapRejected;
      expect(lockAttempts).toBeGreaterThan(30);
      expect(client.release).toHaveBeenCalledWith(expect.any(Error));
      expect(client.query).not.toHaveBeenCalledWith("SELECT pg_advisory_unlock($1::bigint)", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors caller-provided schema bootstrap lock acquisition budgets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T00:00:00.000Z"));
    try {
      let lockAttempts = 0;
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("pg_try_advisory_lock")) {
            lockAttempts += 1;
            return { rows: [{ acquired: false }] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => client),
      };
      const module = {
        contextName: "example",
        schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
      };

      const bootstrap = bootstrapContextDatabase(module, pool, {
        lockAcquisitionTimeoutMs: 1_800_000,
      });
      const bootstrapRejected = expect(bootstrap).rejects.toThrow(
        new RegExp(
          `Schema bootstrap lock was not acquired within 1800000ms after \\d+ attempts \\(elapsed 1800000ms, advisory lock ${SCHEMA_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE}:current_database\\(\\)\\)`,
        ),
      );
      await vi.advanceTimersByTimeAsync(1_800_001);

      await bootstrapRejected;
      expect(lockAttempts).toBeGreaterThan(100);
      expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries stalled schema bootstrap lock queries on a fresh client", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T00:00:00.000Z"));
    try {
      const clients = [
        {
          query: vi.fn((sql: string): Promise<Readonly<{ rows: { acquired?: boolean }[] }>> => {
            if (sql.includes("pg_try_advisory_lock")) {
              return new Promise(() => undefined);
            }
            return Promise.resolve({ rows: [] });
          }),
          release: vi.fn(),
        },
        {
          query: vi.fn(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
              return { rows: [{ acquired: true }] };
            }
            return { rows: [] };
          }),
          release: vi.fn(),
        },
      ];
      let connectCount = 0;
      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => clients[connectCount++] ?? clients[1]),
      };
      const module = {
        contextName: "example",
        schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
      };

      const bootstrap = bootstrapContextDatabase(module, pool, {
        lockQueryTimeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await bootstrap;

      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(clients[0].release).toHaveBeenCalledWith(expect.any(Error));
      expect(clients[1].release).toHaveBeenCalledWith(true);
      expect(SCHEMA_BOOTSTRAP_LOCK_QUERY_TIMEOUT_MS).toBeLessThan(180_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries PostgreSQL query_wait_timeout failures during schema bootstrap lock acquisition", async () => {
    vi.useFakeTimers();
    try {
      const clients = [0, 1].map((clientIndex) => ({
        query: vi.fn(async (sql: string) => {
          if (sql.includes("pg_try_advisory_lock")) {
            if (clientIndex === 0) {
              const error = new Error("query_wait_timeout") as Error & { code: string; severity: string };
              error.code = "08P01";
              error.severity = "FATAL";
              throw error;
            }
            return { rows: [{ acquired: true }] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      }));
      let connectCount = 0;
      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => clients[connectCount++] ?? clients[1]),
      };
      const module = {
        contextName: "example",
        schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
      };

      const bootstrap = bootstrapContextDatabase(module, pool);
      await vi.advanceTimersByTimeAsync(2_000);
      await bootstrap;

      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(clients[0].release).toHaveBeenCalledWith(expect.objectContaining({ code: "08P01" }));
      expect(clients[1].release).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries PostgreSQL lock_timeout failures during schema application on a fresh client", async () => {
    vi.useFakeTimers();
    try {
      const appliedMigrations = new Set<string>();
      const queryLog: { clientIndex: number; sql: string; values: readonly unknown[] | undefined }[] = [];
      let schemaAttempts = 0;
      const clients = [0, 1].map((clientIndex) => ({
        query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
          queryLog.push({ clientIndex, sql, values });
          if (sql.includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: true }] };
          }
          if (sql.includes(`SELECT 1 FROM ${SCHEMA_MIGRATIONS_TABLE}`)) {
            return { rows: appliedMigrations.has(String(values?.[0])) ? [{ "?column?": 1 }] : [] };
          }
          if (sql.includes("CREATE TABLE IF NOT EXISTS event_store_events")) {
            schemaAttempts += 1;
            if (schemaAttempts === 1) {
              const error = new Error("canceling statement due to lock timeout") as Error & { code: string };
              error.code = "55P03";
              throw error;
            }
          }
          if (sql.includes(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE}`)) {
            appliedMigrations.add(String(values?.[0]));
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      }));
      let connectCount = 0;
      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => clients[connectCount++] ?? clients[1]),
      };
      const module = {
        contextName: "example",
        schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
      };

      const bootstrap = bootstrapContextDatabase(module, pool);
      await vi.advanceTimersByTimeAsync(2_000);
      await bootstrap;

      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(schemaAttempts).toBe(2);
      expect(clients[0].query).toHaveBeenCalledWith("RESET lock_timeout");
      expect(clients[0].query.mock.calls.some(([sql]) => sql.includes("pg_advisory_unlock"))).toBe(true);
      expect(clients[0].release).toHaveBeenCalledWith(expect.objectContaining({ code: "55P03" }));
      expect(clients[1].release).toHaveBeenCalledWith(true);
      expect(
        queryLog.filter((entry) => entry.sql.includes("pg_try_advisory_lock")).map((entry) => entry.clientIndex),
      ).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives schema application lock_timeout contention beyond the fixed retry ceiling", async () => {
    vi.useFakeTimers();
    try {
      let schemaAttempts = 0;
      const lockTimeoutAttempts = SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_RETRIES + 4;
      const clients = Array.from({ length: lockTimeoutAttempts + 1 }, (_entry, clientIndex) => ({
        query: vi.fn(async (sql: string) => {
          if (sql.includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: true }] };
          }
          if (sql.includes(`SELECT 1 FROM ${SCHEMA_MIGRATIONS_TABLE}`)) {
            return { rows: [] };
          }
          if (sql.includes("CREATE TABLE IF NOT EXISTS event_store_events")) {
            schemaAttempts += 1;
            if (schemaAttempts <= lockTimeoutAttempts) {
              const error = new Error(
                `canceling statement due to lock timeout on attempt ${schemaAttempts}`,
              ) as Error & { code: string };
              error.code = "55P03";
              throw error;
            }
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      }));
      let connectCount = 0;
      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => clients[connectCount++] ?? clients.at(-1)!),
      };
      const module = {
        contextName: "example",
        schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
      };

      const bootstrap = bootstrapContextDatabase(module, pool);
      await vi.advanceTimersByTimeAsync(SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_RETRY_BUDGET_MS - 1);
      await bootstrap;

      expect(pool.connect).toHaveBeenCalledTimes(lockTimeoutAttempts + 1);
      expect(schemaAttempts).toBe(lockTimeoutAttempts + 1);
      expect(clients.slice(0, lockTimeoutAttempts).map((client) => client.release.mock.calls[0]?.[0])).toEqual(
        Array.from({ length: lockTimeoutAttempts }, () => expect.objectContaining({ code: "55P03" })),
      );
      expect(clients[lockTimeoutAttempts].release).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-lock-timeout schema failures", async () => {
    const error = new Error("syntax error at or near broken");
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes("CREATE TABLE IF NOT EXISTS event_store_events")) {
          throw error;
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    };
    const module = {
      contextName: "example",
      schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
    };

    await expect(bootstrapContextDatabase(module, pool)).rejects.toThrow(error);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(error);
  });

  it("fails with deploy-useful diagnostics after schema application lock_timeout retries are exhausted", async () => {
    vi.useFakeTimers();
    try {
      const clients = Array.from({ length: 50 }, (_entry, clientIndex) => ({
        query: vi.fn(async (sql: string) => {
          if (sql.includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: true }] };
          }
          if (sql.includes("CREATE TABLE IF NOT EXISTS event_store_events")) {
            const error = new Error(
              `canceling statement due to lock timeout on attempt ${clientIndex + 1}`,
            ) as Error & { code: string };
            error.code = "55P03";
            throw error;
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      }));
      let connectCount = 0;
      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => clients[connectCount++]),
      };
      const module = {
        contextName: "example",
        schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
      };

      const bootstrap = expect(bootstrapContextDatabase(module, pool)).rejects.toThrow(
        /Schema bootstrap hit PostgreSQL lock_timeout for \d+ attempts over 600000ms/,
      );
      await vi.advanceTimersByTimeAsync(SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_RETRY_BUDGET_MS + 1);
      await bootstrap;

      expect(pool.connect.mock.calls.length).toBeGreaterThan(SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_RETRIES);
      for (const client of clients.slice(0, pool.connect.mock.calls.length)) {
        expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ code: "55P03" }));
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries module schema migrations through API bootstrap", async () => {
    const appliedMigrations = new Set<string>();
    const queryLog: { sql: string; values: readonly unknown[] | undefined }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        queryLog.push({ sql, values });
        if (sql.includes("pg_try_advisory_lock")) {
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes(`SELECT 1 FROM ${SCHEMA_MIGRATIONS_TABLE}`)) {
          return { rows: appliedMigrations.has(String(values?.[0])) ? [{ "?column?": 1 }] : [] };
        }
        if (sql.includes(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE}`)) {
          appliedMigrations.add(String(values?.[0]));
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    };
    const module = {
      contextName: "example",
      routePrefix: "/api/example",
      streamPrefix: "example.",
      schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
      schemaMigrations: [
        {
          migrationId: "20260703_example_api_bootstrap_index",
          description: "Create an example index through API bootstrap.",
          statements: ["CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_id_idx ON example_pages (id);"],
        },
      ],
      apiMounts: [],
      createServices: vi.fn(() => ({ ready: true })),
      buildApis: vi.fn(() => NO_API_ENTRIES),
    };

    const services = await bootstrapApiModule(module as never, pool as never, {}, { completionLabel: "example" });

    expect(services).toEqual({ ready: true });
    expect(appliedMigrations).toContain("20260703_example_api_bootstrap_index");
    expect(queryLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_id_idx ON example_pages (id);",
        }),
      ]),
    );
  });
});
