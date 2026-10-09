import { describe, expect, it, vi } from "vitest";
import {
  isPgConnectionLevelError,
  isPgRetryableTransientError,
  withPgTransaction,
  type PgPoolClient,
  type PgTransactionalPool,
} from "./types";

describe("transaction isolation opt-in", () => {
  function fixture(timeout: number | undefined = 15_000, failAt?: string, rollbackFailure?: Error) {
    const queries: { sql: string; values?: readonly unknown[] }[] = [];
    const failure = new Error("injected failure");
    const client = {
      async query(sql: string, values?: readonly unknown[]) {
        queries.push({ sql, ...(values ? { values } : {}) });
        if (sql === "ROLLBACK" && rollbackFailure) throw rollbackFailure;
        if (sql === failAt) throw failure;
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const pool: { -readonly [Key in keyof PgTransactionalPool]: PgTransactionalPool[Key] } = {
      ...client,
      connect: async () => client,
      idleInTransactionSessionTimeoutMillis: timeout,
    };
    return { pool, client, queries, failure };
  }

  it.each(["read committed", "repeatable read", "serializable"] as const)(
    "establishes %s before a snapshot-free timeout and work",
    async (isolationLevel) => {
      const { pool, client, queries } = fixture(14_999.1);
      const afterCommit = vi.fn(async (db: PgPoolClient, result: string) => {
        expect(db).toBe(client);
        expect(result).toBe("published");
        await db.query("AFTER COMMIT");
      });
      await expect(
        withPgTransaction(
          pool,
          async (db) => {
            await db.query("WORK");
            return "published";
          },
          { isolationLevel, afterCommit },
        ),
      ).resolves.toBe("published");
      expect(queries).toEqual([
        { sql: `BEGIN ISOLATION LEVEL ${isolationLevel.toUpperCase()}` },
        { sql: "SET LOCAL idle_in_transaction_session_timeout = '15000ms'" },
        { sql: "WORK" },
        { sql: "COMMIT" },
        { sql: "AFTER COMMIT" },
      ]);
      expect(afterCommit).toHaveBeenCalledOnce();
      expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
    },
  );

  it.each([undefined, 0, -1, NaN, Infinity, -Infinity])("omits an invalid or absent timeout: %s", async (timeout) => {
    const { pool, queries } = fixture();
    pool.idleInTransactionSessionTimeoutMillis = timeout;
    await withPgTransaction(pool, async () => 1, { isolationLevel: "repeatable read" });
    expect(queries).toEqual([{ sql: "BEGIN ISOLATION LEVEL REPEATABLE READ" }, { sql: "COMMIT" }]);
  });

  it.each([
    "BEGIN ISOLATION LEVEL REPEATABLE READ",
    "SET LOCAL idle_in_transaction_session_timeout = '15000ms'",
    "WORK",
    "COMMIT",
  ])("rolls back and releases when %s fails", async (failAt) => {
    const { pool, client, queries, failure } = fixture(15_000, failAt);
    const work = vi.fn(async (db: PgPoolClient) => db.query("WORK"));
    const afterCommit = vi.fn();
    await expect(withPgTransaction(pool, work, { isolationLevel: "repeatable read", afterCommit })).rejects.toBe(
      failure,
    );
    expect(queries.at(-1)).toEqual({ sql: "ROLLBACK" });
    expect(afterCommit).not.toHaveBeenCalled();
    if (failAt.startsWith("BEGIN") || failAt.startsWith("SET")) expect(work).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("keeps the original failure and discards a connection when rollback fails", async () => {
    const rollbackFailure = new Error("rollback failed");
    const { pool, client, failure } = fixture(15_000, "WORK", rollbackFailure);
    await expect(withPgTransaction(pool, (db) => db.query("WORK"), { isolationLevel: "repeatable read" })).rejects.toBe(
      failure,
    );
    expect(client.release).toHaveBeenCalledExactlyOnceWith(rollbackFailure);
  });

  it.each([false, true])(
    "does not roll back an afterCommit failure (connection failure: %s)",
    async (connectionFailure) => {
      const { pool, client, queries } = fixture();
      const failure = Object.assign(new Error("afterCommit failed"), { code: connectionFailure ? "08006" : "23505" });
      await expect(
        withPgTransaction(pool, async () => 1, {
          isolationLevel: "repeatable read",
          afterCommit: async () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(queries.at(-1)).toEqual({ sql: "COMMIT" });
      expect(queries.some(({ sql }) => sql === "ROLLBACK")).toBe(false);
      expect(client.release).toHaveBeenCalledExactlyOnceWith(connectionFailure ? failure : undefined);
    },
  );
});

describe("postgres error classification", () => {
  it("classifies retryable Postgres and connection-level failures as transient", () => {
    expect(isPgRetryableTransientError({ code: "40001" })).toBe(true);
    expect(isPgRetryableTransientError({ code: "40P01" })).toBe(true);
    expect(isPgRetryableTransientError({ code: "55P03" })).toBe(true);
    expect(isPgRetryableTransientError({ code: "57014" })).toBe(true);
    expect(isPgRetryableTransientError({ code: "ECONNRESET" })).toBe(true);
    expect(isPgRetryableTransientError(new Error("connection terminated unexpectedly"))).toBe(true);
  });

  it("keeps deterministic constraint errors off the transient path", () => {
    expect(isPgRetryableTransientError({ code: "23505" })).toBe(false);
    expect(isPgConnectionLevelError({ code: "23505" })).toBe(false);
  });
});
