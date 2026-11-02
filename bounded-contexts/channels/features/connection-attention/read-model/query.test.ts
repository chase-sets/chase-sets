import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { readConnectionAttention } from "./query";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const queryResult = <Row>(rows: Row[] = []): PgQueryResult<Row> => ({ rows });

function controlledReader(options: Readonly<{ synchronousFailureAt?: number }> = {}) {
  const pending = Array.from({ length: 5 }, () => deferred<PgQueryResult<Record<string, unknown>>>());
  const started: number[] = [];
  let queryCount = 0;
  const db: PgQueryable = {
    query: (sql: string) => {
      if (sql.includes("WITH manual AS")) return Promise.resolve(queryResult([{ connection_id: "connection" }]));
      const index = queryCount++;
      started.push(index);
      if (options.synchronousFailureAt === index) throw new Error(`synchronous-${index}`);
      return pending[index].promise;
    },
  };
  return { db, pending, started };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("readConnectionAttention reader lifetime", () => {
  it("starts all five readers concurrently and waits for every late result before success", async () => {
    const { db, pending, started } = controlledReader();
    const result = readConnectionAttention(db, { accountId: "account" });
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    pending.forEach((read) => read.resolve(queryResult()));
    await expect(result).resolves.toEqual([
      {
        connectionId: "connection",
        healthState: "unknown",
        health: [],
        manual: null,
        orders: undefined,
        connector: null,
      },
    ]);
  });

  it.each([0, 1, 2, 3, 4])("drains readers after failure at position %i", async (failureAt) => {
    const { db, pending, started } = controlledReader();
    const result = readConnectionAttention(db, { accountId: "account" });
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    const failure = new Error(`failure-${failureAt}`);
    pending[failureAt].reject(failure);
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flushMicrotasks();
    expect(settled).toBe(false);
    pending.forEach((read, index) => {
      if (index !== failureAt) read.resolve(queryResult());
    });
    await expect(result).rejects.toBe(failure);
  });

  it("keeps the first observed failure while draining a later failure", async () => {
    const { db, pending, started } = controlledReader();
    const result = readConnectionAttention(db, { accountId: "account" });
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    const first = new Error("first-observed");
    const later = new Error("later-observed");
    pending[3].reject(first);
    await flushMicrotasks();
    pending[1].reject(later);
    pending.forEach((read, index) => {
      if (index !== 1 && index !== 3) read.resolve(queryResult());
    });
    await expect(result).rejects.toBe(first);
  });

  it("starts siblings after a synchronous query throw and drains them", async () => {
    const { db, pending, started } = controlledReader({ synchronousFailureAt: 2 });
    const result = readConnectionAttention(db, { accountId: "account" });
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    pending[0].resolve(queryResult());
    pending[1].resolve(queryResult());
    pending[3].resolve(queryResult());
    pending[4].resolve(queryResult());
    await expect(result).rejects.toThrow("synchronous-2");
  });

  it("returns no rows without starting contribution readers", async () => {
    const calls: string[] = [];
    const db: PgQueryable = {
      query: async (sql: string) => {
        calls.push(sql);
        return queryResult<Record<string, unknown>>();
      },
    };
    await expect(readConnectionAttention(db, { accountId: "account" })).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("rejects a missing requested connection before contribution readers", async () => {
    const calls: string[] = [];
    const db: PgQueryable = {
      query: async (sql: string) => {
        calls.push(sql);
        return queryResult<Record<string, unknown>>();
      },
    };
    await expect(readConnectionAttention(db, { accountId: "account", connectionId: "missing" })).rejects.toMatchObject({
      code: "connection-not-found",
    });
    expect(calls).toHaveLength(1);
  });
});
