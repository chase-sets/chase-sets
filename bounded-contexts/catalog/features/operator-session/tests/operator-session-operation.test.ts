import { afterEach, describe, expect, it, vi } from "vitest";
import { withPgTransaction, type PgPoolClient, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { withOperatorSessionBackend } from "../api/operation";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function connection() {
  const query = vi.fn<PgPoolClient["query"]>().mockResolvedValue({ rows: [{ locked: true, unlocked: true }] });
  const release = vi.fn<PgPoolClient["release"]>();
  const client: PgPoolClient = { query, release };
  const connect = vi.fn(async () => client);
  const pool: PgTransactionalPool = {
    connect,
    query: vi.fn(async () => {
      throw new Error("unbound query");
    }),
  };
  return { client, pool, query, release, connect };
}
describe("operation-local physical backend ownership", () => {
  it.each(["22P02", "23505", "synthetic-secret-code", undefined])(
    "logs only a bounded SQLSTATE for a poisoned query (%s)",
    async (code) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const c = connection();
      c.query.mockResolvedValueOnce({ rows: [{ locked: true }] }).mockRejectedValueOnce(
        Object.assign(new Error("synthetic-sensitive-cookie"), {
          code,
          detail: "synthetic-token-hash",
          query: "SELECT synthetic-secret-value",
        }),
      );
      await expect(
        withOperatorSessionBackend(c.pool, async (pool) => {
          await expect(pool.query("synthetic-secret SQL", ["synthetic-session"])).rejects.toMatchObject({
            code: "custody-unavailable",
          });
          await expect(pool.query("retry")).rejects.toMatchObject({ code: "custody-unavailable" });
        }),
      ).rejects.toMatchObject({ code: "custody-unavailable", status: 503 });
      expect(warn.mock.calls).toEqual([
        [
          JSON.stringify({
            operation: "operator-session.query",
            sqlstate: code === "22P02" || code === "23505" ? code : "unknown",
          }),
        ],
      ]);
    },
  );
  it("one checkout holds the lock across sequential transactions; inner releases retain the session", async () => {
    const c = connection();
    await withOperatorSessionBackend(c.pool, async (pool) => {
      await withPgTransaction(pool, async (client) => {
        await client.query("first");
      });
      expect(c.release).not.toHaveBeenCalled();
      await withPgTransaction(pool, async (client) => {
        await client.query("second");
      });
      expect(c.release).not.toHaveBeenCalled();
    });
    expect(c.connect).toHaveBeenCalledOnce();
    expect(c.query.mock.calls.map(([sql]) => sql)).toEqual([
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      "BEGIN",
      "first",
      "COMMIT",
      "BEGIN",
      "second",
      "COMMIT",
      "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
    ]);
    expect(c.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("known logical refusal rolls back on the bound connection before unlock", async () => {
    const c = connection();
    await expect(
      withOperatorSessionBackend(c.pool, (pool) =>
        withPgTransaction(pool, async () => {
          throw new Error("refusal");
        }),
      ),
    ).rejects.toThrow("refusal");
    expect(c.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(c.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("a sanitised SQL failure poisons the binding before the store can swallow it", async () => {
    const c = connection();
    c.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockRejectedValueOnce(new Error("hostile SQL exception"));
    await expect(
      withOperatorSessionBackend(c.pool, async (pool) => {
        await expect(pool.query("custody read")).rejects.toMatchObject({ code: "custody-unavailable" });
        await expect(pool.connect()).rejects.toMatchObject({ code: "custody-unavailable" });
        await expect(pool.query("detached renewal")).rejects.toMatchObject({ code: "custody-unavailable" });
      }),
    ).rejects.toMatchObject({ code: "custody-unavailable" });
    expect(c.query).toHaveBeenCalledTimes(2);
    expect(c.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "custody-unavailable" }));
  });
  it("lost COMMIT acknowledgement destroys instead of pretending ROLLBACK proves no write", async () => {
    const c = connection();
    c.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("ack lost"));
    await expect(
      withOperatorSessionBackend(c.pool, (pool) => withPgTransaction(pool, async () => "not acknowledged")),
    ).rejects.toMatchObject({ code: "custody-unavailable" });
    expect(c.query.mock.calls.map(([sql]) => sql)).toEqual([
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      "BEGIN",
      "COMMIT",
    ]);
    expect(c.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "custody-unavailable" }));
  });
  it("checkout deadline rejects, releases a late checkout destroyed, and never starts work", async () => {
    vi.useFakeTimers();
    const c = connection();
    let complete!: (client: PgPoolClient) => void;
    c.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const work = vi.fn();
    const result = expect(withOperatorSessionBackend(c.pool, work)).rejects.toMatchObject({
      code: "custody-unavailable",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    complete(c.client);
    await vi.advanceTimersByTimeAsync(0);
    expect(work).not.toHaveBeenCalled();
    expect(c.query).not.toHaveBeenCalled();
    expect(c.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "custody-unavailable" }));
  });
  it("five-second lock deadline destroys its backend and never executes custody", async () => {
    vi.useFakeTimers();
    const c = connection();
    c.query.mockResolvedValue({ rows: [{ locked: false }] });
    const work = vi.fn();
    const result = expect(withOperatorSessionBackend(c.pool, work)).rejects.toMatchObject({
      code: "custody-unavailable",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(work).not.toHaveBeenCalled();
    expect(c.release).toHaveBeenCalledOnce();
    const calls = c.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.query).toHaveBeenCalledTimes(calls);
  });
  it("unlock refusal destroys the session and cannot return an acknowledged outcome", async () => {
    const c = connection();
    c.query.mockResolvedValueOnce({ rows: [{ locked: true }] }).mockResolvedValueOnce({ rows: [{ unlocked: false }] });
    await expect(withOperatorSessionBackend(c.pool, async () => "done")).rejects.toMatchObject({
      code: "custody-unavailable",
    });
    expect(c.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "custody-unavailable" }));
  });
});
