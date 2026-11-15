import { describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { reportedContentResponseSchemaMigrations, reportedContentSchemaSql } from "./schema";

describe("reported content response rollout", () => {
  it("builds the owner index concurrently before the response backfill, outside boot SQL", () => {
    expect(reportedContentSchemaSql).not.toContain("platform_operations_reported_content_owner_idx");
    const index = reportedContentResponseSchemaMigrations.findIndex((migration) =>
      migration.statements.some((sql) => sql.includes("platform_operations_reported_content_owner_idx")),
    );
    const backfill = reportedContentResponseSchemaMigrations.findIndex((migration) => migration.dataStep);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(backfill);
    expect(reportedContentResponseSchemaMigrations[index]!.dataStep).toBeUndefined();
    expect(reportedContentResponseSchemaMigrations[index]!.statements).toContainEqual(
      expect.stringContaining("CREATE INDEX CONCURRENTLY"),
    );
  });

  it("executes the owner index through the installed runner without a transaction", async () => {
    const migration = reportedContentResponseSchemaMigrations.find(
      (entry) => entry.migrationId === "20261115_reported_content_owner_index",
    )!;
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("pg_try_advisory_lock") ? [{ acquired: true }] : [],
    }));
    const release = vi.fn();
    const pool = { query, connect: async () => ({ query, release }) } as unknown as PgTransactionalPool;
    await bootstrapContextDatabase(
      { contextName: "platform-operations", schemaSql: reportedContentSchemaSql, schemaMigrations: [migration] },
      pool,
    );
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).not.toContain("BEGIN");
    expect(statements).not.toContain("COMMIT");
    const drop = statements.indexOf(migration.statements[0]!);
    expect(drop).toBeGreaterThan(0);
    expect(statements[drop + 1]).toBe(migration.statements[1]);
    expect(statements[drop + 2]).toContain("INSERT INTO bounded_context_schema_migrations");
    expect(release).toHaveBeenCalled();
  });
});
