import { describe, expect, it, vi } from "vitest";
import {
  bootstrapContextDatabase,
  composeModuleSchemaSql,
  eventSubscriptionSchemaSql,
  SCHEMA_MIGRATIONS_TABLE,
} from "./index";

describe("bounded context runtime schema", () => {
  it("creates projection generation metadata for generation-aware rebuilds", () => {
    expect(eventSubscriptionSchemaSql).toContain("CREATE TABLE IF NOT EXISTS event_projection_group_generations");
    expect(eventSubscriptionSchemaSql).toContain("active_generation bigint NOT NULL DEFAULT 1");
    expect(eventSubscriptionSchemaSql).toContain("rebuilding_generation bigint NULL");
  });

  it("moves event-store backfills and large indexes out of boot-time schema SQL", () => {
    const schemaSql = composeModuleSchemaSql({
      schemaSql: "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);",
    });

    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS event_store_events");
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS example_pages");
    expect(schemaSql).not.toContain("UPDATE event_store_events");
    expect(schemaSql).not.toContain("ALTER COLUMN stream_context_name SET NOT NULL");
    expect(schemaSql).not.toContain("CREATE INDEX IF NOT EXISTS event_store_events_stream_idx");
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
    await bootstrapContextDatabase(module, pool);

    const bootSchemaSql =
      queryLog.find((entry) => entry.sql.includes("CREATE TABLE IF NOT EXISTS event_store_events"))?.sql ?? "";

    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(2);
    expect(queryLog.filter((entry) => entry.sql.includes("pg_try_advisory_lock")).length).toBe(2);
    expect(queryLog.filter((entry) => entry.sql.includes("pg_advisory_unlock")).length).toBe(2);
    expect(queryLog.some((entry) => entry.sql.includes(`CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE}`))).toBe(
      true,
    );
    expect(bootSchemaSql).not.toContain("UPDATE event_store_events");
    expect(bootSchemaSql).not.toContain("CREATE INDEX IF NOT EXISTS event_store_events_stream_idx");
    expect(queryLog.filter((entry) => entry.sql.includes("UPDATE event_store_events")).length).toBe(1);
    expect(
      queryLog.filter((entry) => entry.sql.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_")),
    ).toHaveLength(9);
    expect(
      queryLog.filter((entry) => entry.sql.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_")),
    ).toHaveLength(2);
    expect(appliedMigrations).toEqual(
      new Set([
        "20260628_event_store_context_columns_backfill",
        "20260628_event_store_events_concurrent_indexes",
        "20260703_example_pages_concurrent_indexes",
      ]),
    );
  });
});
