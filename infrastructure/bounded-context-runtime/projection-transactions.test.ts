import { describe, expect, it, vi } from "vitest";
import { isTransientProjectionError, type ProjectionRunContext } from "@chase-sets/event-core/projector";
import {
  EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
  withPgTransaction,
  type PgPoolClient,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";

const recordEventStoreAppendAdvisoryLockHold = vi.hoisted(() => {
  vi.resetModules();
  return vi.fn();
});

vi.mock("@chase-sets/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/observability")>()),
  recordEventStoreAppendAdvisoryLockHold,
}));

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
  it("sets projection idle and statement timeouts using Postgres SET syntax", async () => {
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
      { sql: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)", values: ["15000ms"] },
      { sql: "SELECT set_config('statement_timeout', $1, true)", values: ["13ms"] },
      { sql: "SELECT 1", values: undefined },
      { sql: "COMMIT", values: undefined },
    ]);
  });

  it("sets a default projection idle timeout when pool metadata and run context omit one", async () => {
    const { calls, pool } = createRecordingPool();

    await withProjectionTransaction(pool, undefined, async (client) => {
      await client.query("SELECT 1");
    });

    expect(calls).toEqual([
      { sql: "BEGIN", values: undefined },
      { sql: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)", values: ["15000ms"] },
      { sql: "SELECT set_config('statement_timeout', $1, true)", values: ["30000ms"] },
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

  it("sets context-provided idle timeouts when pool metadata is unavailable", async () => {
    const { calls, pool } = createRecordingPool();
    const context = {
      idleInTransactionSessionTimeoutMs: 15_000.2,
      statementTimeoutMs: 12.2,
      throwIfLeaseLost: () => undefined,
    } satisfies ProjectionRunContext;

    await withProjectionTransaction(pool, context, async (client) => {
      await client.query("SELECT 1");
    });

    expect(calls).toEqual([
      { sql: "BEGIN", values: undefined },
      { sql: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)", values: ["15001ms"] },
      { sql: "SELECT set_config('statement_timeout', $1, true)", values: ["13ms"] },
      { sql: "SELECT 1", values: undefined },
      { sql: "COMMIT", values: undefined },
    ]);
  });

  it("does not duplicate matching pool and context idle timeouts", async () => {
    const { calls, pool } = createRecordingPool({ idleInTransactionSessionTimeoutMillis: 15_000 });
    const context = {
      idleInTransactionSessionTimeoutMs: 15_000,
      throwIfLeaseLost: () => undefined,
    } satisfies ProjectionRunContext;

    await withProjectionTransaction(pool, context, async (client) => {
      await client.query("SELECT 1");
    });

    expect(calls).toEqual([
      { sql: "BEGIN", values: undefined },
      { sql: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)", values: ["15000ms"] },
      { sql: "SELECT set_config('statement_timeout', $1, true)", values: ["30000ms"] },
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

      expect(calls.map((call) => call.sql)).toEqual([
        "BEGIN",
        "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
        "SELECT set_config('statement_timeout', $1, true)",
        "COMMIT",
      ]);
    }
  });

  it("rolls back projection transactions that exceed the wall-clock budget between queries", async () => {
    const { calls, pool } = createRecordingPool();
    let now = 1_000;
    const originalNow = Date.now;
    Date.now = () => now;

    let thrown: unknown;
    try {
      await withProjectionTransaction(
        pool,
        { transactionTimeoutMs: 50, throwIfLeaseLost: () => undefined },
        async (client) => {
          await client.query("SELECT first");
          now = 1_051;
          await client.query("SELECT second");
        },
      );
    } catch (error) {
      thrown = error;
    } finally {
      Date.now = originalNow;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Projection transaction exceeded 50ms.");
    expect(isTransientProjectionError(thrown)).toBe(true);
    expect(calls).toEqual([
      { sql: "BEGIN", values: undefined },
      { sql: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)", values: ["15000ms"] },
      { sql: "SELECT set_config('statement_timeout', $1, true)", values: ["50ms"] },
      { sql: "SELECT first", values: undefined },
      { sql: "ROLLBACK", values: undefined },
    ]);
  });

  it("records append advisory-lock hold duration at the outer projection transaction boundary", async () => {
    const { pool } = createRecordingPool();
    let now = 1_000;
    const originalNow = Date.now;
    Date.now = () => now;

    try {
      await withProjectionTransaction(
        pool,
        { throwIfLeaseLost: () => undefined },
        async (client) => {
          await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY]);
          now = 1_042;
        },
        {
          handlerKind: "reaction",
          targetContextName: "ordering",
          sourceContextName: "marketplace",
          projectionName: "ordering-marketplace-offer-acceptance",
          subscriptionName: "ordering.marketplace-offer-acceptance",
        },
      );
    } finally {
      Date.now = originalNow;
    }

    expect(recordEventStoreAppendAdvisoryLockHold).toHaveBeenCalledWith({
      durationMs: 42,
      outcome: "committed",
      holderKind: "reaction",
      targetContextName: "ordering",
      sourceContextName: "marketplace",
      projectionName: "ordering-marketplace-offer-acceptance",
      subscriptionName: "ordering.marketplace-offer-acceptance",
    });
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
