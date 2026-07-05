import { describe, expect, it } from "vitest";
import type { ProjectionRunContext } from "@chase-sets/event-core/projector";
import { withPgTransaction, type PgPoolClient, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createProjectionAwarePool,
  runInProjectionDbContext,
  withProjectionTransaction,
} from "./projection-transactions";

type QueryCall = Readonly<{
  sql: string;
  values: readonly unknown[] | undefined;
}>;

function createRecordingPool(options: { idleInTransactionSessionTimeoutMillis?: number } = {}) {
  const calls: QueryCall[] = [];
  let connectCount = 0;

  const client = {
    query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] as Row[], rowCount: 0 };
    },
    release: () => undefined,
  } satisfies PgPoolClient;

  const pool = {
    query: client.query,
    connect: async () => {
      connectCount += 1;
      return client;
    },
    idleInTransactionSessionTimeoutMillis: options.idleInTransactionSessionTimeoutMillis,
  } satisfies PgTransactionalPool;

  return { calls, getConnectCount: () => connectCount, pool };
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

  it("preserves transaction-local idle timeouts before projection statement timeouts", async () => {
    const { calls, pool } = createRecordingPool({ idleInTransactionSessionTimeoutMillis: 15_000 });
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
      { sql: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)", values: ["15000ms"] },
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

  it("routes nested projection connections through savepoints on the scoped client", async () => {
    const { calls, getConnectCount, pool } = createRecordingPool();
    const projectionAwarePool = createProjectionAwarePool(pool);

    await runInProjectionDbContext(pool, () =>
      withPgTransaction(projectionAwarePool, async (client) => {
        await client.query("INSERT INTO nested_projection_side_effects VALUES ($1)", ["ok"]);
      }),
    );

    const savepoint = String(calls[0]?.sql).replace("SAVEPOINT ", "");
    expect(getConnectCount()).toBe(0);
    expect(savepoint).toMatch(/^projection_nested_tx_\d+$/);
    expect(calls).toEqual([
      { sql: `SAVEPOINT ${savepoint}`, values: undefined },
      { sql: "INSERT INTO nested_projection_side_effects VALUES ($1)", values: ["ok"] },
      { sql: `RELEASE SAVEPOINT ${savepoint}`, values: undefined },
    ]);
  });

  it("rolls back nested projection connections to their savepoint", async () => {
    const { calls, getConnectCount, pool } = createRecordingPool();
    const projectionAwarePool = createProjectionAwarePool(pool);

    await expect(
      runInProjectionDbContext(pool, () =>
        withPgTransaction(projectionAwarePool, async (client) => {
          await client.query("INSERT INTO nested_projection_side_effects VALUES ($1)", ["rollback"]);
          throw new Error("nested projection failure");
        }),
      ),
    ).rejects.toThrow("nested projection failure");

    const savepoint = String(calls[0]?.sql).replace("SAVEPOINT ", "");
    expect(getConnectCount()).toBe(0);
    expect(savepoint).toMatch(/^projection_nested_tx_\d+$/);
    expect(calls).toEqual([
      { sql: `SAVEPOINT ${savepoint}`, values: undefined },
      { sql: "INSERT INTO nested_projection_side_effects VALUES ($1)", values: ["rollback"] },
      { sql: `ROLLBACK TO SAVEPOINT ${savepoint}`, values: undefined },
      { sql: `RELEASE SAVEPOINT ${savepoint}`, values: undefined },
    ]);
  });
});
