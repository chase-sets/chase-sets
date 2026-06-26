import { describe, expect, it } from "vitest";
import type { ProjectionRunContext } from "@chase-sets/event-core/projector";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { withProjectionTransaction } from "./projection-transactions";

type QueryCall = Readonly<{
  sql: string;
  values: readonly unknown[] | undefined;
}>;

function createRecordingPool() {
  const calls: QueryCall[] = [];

  const client = {
    query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] as Row[], rowCount: 0 };
    },
    release: () => undefined,
  } satisfies PgPoolClient;

  const pool = {
    query: client.query,
    connect: async () => client,
  } satisfies PgTransactionalPool;

  return { calls, pool };
}

describe("projection transactions", () => {
  it("sets projection statement timeouts using Postgres SET syntax", async () => {
    const { calls, pool } = createRecordingPool();
    const context = {
      statementTimeoutMs: 12.2,
      throwIfLeaseLost: () => undefined,
    } satisfies ProjectionRunContext;

    await expect(
      withProjectionTransaction(pool, context, async (client) => {
        await client.query("SELECT 1");
        return "done";
      }),
    ).resolves.toBe("done");

    expect(calls).toEqual([
      { sql: "BEGIN", values: undefined },
      { sql: "SELECT set_config('statement_timeout', $1, true)", values: ["13ms"] },
      { sql: "SELECT 1", values: undefined },
      { sql: "COMMIT", values: undefined },
    ]);
  });

  it("skips invalid or disabled projection statement timeouts", async () => {
    for (const statementTimeoutMs of [undefined, 0, -1, Number.POSITIVE_INFINITY]) {
      const { calls, pool } = createRecordingPool();
      const context =
        statementTimeoutMs === undefined
          ? { throwIfLeaseLost: () => undefined }
          : {
              statementTimeoutMs,
              throwIfLeaseLost: () => undefined,
            };

      await withProjectionTransaction(pool, context, async () => undefined);

      expect(calls.map((call) => call.sql)).toEqual(["BEGIN", "COMMIT"]);
    }
  });
});
