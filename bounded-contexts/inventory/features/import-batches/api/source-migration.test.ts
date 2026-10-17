import { describe, expect, it } from "vitest";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { contractInventoryImportSources } from "./source-migration";

describe("contractInventoryImportSources", () => {
  it("does not reacquire the table lock after a clean marked contraction", async () => {
    const calls: string[] = [];
    let marked = false;
    const client: PgPoolClient = {
      query: async <Row>(sql: string) => {
        calls.push(sql);
        if (sql.includes("information_schema.columns")) return { rows: [{ exists: 1 }] } as { rows: Row[] };
        if (sql.includes("marker_exists"))
          return { rows: [{ marker_exists: marked, legacy_inputs: false, normalized_jobs: false }] } as { rows: Row[] };
        if (sql.includes("INSERT INTO bounded_context_schema_migrations")) marked = true;
        return { rows: [] } as { rows: Row[] };
      },
      release: () => undefined,
    };
    const pool: PgTransactionalPool = {
      query: client.query,
      connect: async () => client,
    };

    await contractInventoryImportSources(pool);
    const secondCallStart = calls.length;
    await contractInventoryImportSources(pool);
    const secondCall = calls.slice(secondCallStart);

    expect(secondCall.some((sql) => sql.includes("LOCK TABLE"))).toBe(false);
    expect(secondCall.some((sql) => /^\s*UPDATE\b/i.test(sql))).toBe(false);
  });
});
