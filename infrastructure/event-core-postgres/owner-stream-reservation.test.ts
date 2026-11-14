import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestTerminalBinding, ReserveOwnerStreamInput } from "@chase-sets/event-core/owner-stream-reservation";
import { CONFIGURATION_EPOCH_STEP_TIMEOUT_MS } from "./configuration-epoch";
import { createPostgresEventStore } from "./event-store";
import { createPostgresOwnerStreamReservationStore } from "./owner-stream-reservation";
import type { PgPoolClient, PgQueryable, PgTransactionalPool } from "./types";

const reservation: ReserveOwnerStreamInput = {
  reservationId: "reservation",
  operationId: "operation",
  ownerStreamId: "owner",
  purpose: "activation",
  resourceKey: "stock",
  consumer: { storeId: "consumer", incarnation: "incarnation", requestId: "request" },
  seal: { version: 7, storeIncarnation: "owner-incarnation" },
  target: {},
  commandFingerprint: "command",
};
const binding: RequestTerminalBinding = {
  consumerStoreId: "consumer",
  consumerIncarnation: "incarnation",
  requestId: "request",
  target: {},
  commandFingerprint: "command",
  reservations: [reservation],
  preparationDeadline: "2030-01-01T00:00:00Z",
};
function store(pool: PgTransactionalPool) {
  return createPostgresOwnerStreamReservationStore({
    ownerPool: pool,
    consumerPool: pool,
    applyInvalidation: async () => {},
    applyInboundEvidence: async () => {},
  });
}
afterEach(() => vi.useRealTimers());

describe("bounded owner-stream participation", () => {
  it("bounds connection acquisition and discards a late connection without using it", async () => {
    vi.useFakeTimers();
    let connect!: (client: PgPoolClient) => void;
    const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const pool = {
      query,
      connect: () =>
        new Promise<PgPoolClient>((resolve) => {
          connect = resolve;
        }),
    };
    const result = expect(store(pool).abortRequestTerminal(binding)).rejects.toThrow("connection timed out");
    await vi.advanceTimersByTimeAsync(CONFIGURATION_EPOCH_STEP_TIMEOUT_MS);
    await result;
    connect({ query, release });
    await Promise.resolve();
    expect(release).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining("timed out") }),
    );
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["read", "abort", "append"])(
    "bounds %s queries, discards the client and never invents a terminal result",
    async (operation) => {
      vi.useFakeTimers();
      const query = vi.fn<PgQueryable["query"]>().mockImplementation(async (sql) => {
        if (sql.startsWith("SELECT store_id, incarnation"))
          return { rows: [{ store_id: "consumer", incarnation: "incarnation" }] };
        if (sql.includes("pg_advisory_xact_lock") || sql.startsWith("SELECT reservation_id,"))
          return new Promise(() => {});
        return { rows: [] };
      });
      const release = vi.fn();
      const direct = vi.fn<PgQueryable["query"]>().mockRejectedValue(new Error("unbounded query used"));
      const pool = { query: direct, connect: async () => ({ query, release }) };
      const promise =
        operation === "read"
          ? store(pool).getReservation("reservation")
          : operation === "abort"
            ? store(pool).abortRequestTerminal(binding)
            : createPostgresEventStore({ pool }).appendToStreams!([
                {
                  streamId: "test.stream",
                  expectedVersion: "no_stream",
                  requestTerminal: binding,
                  events: [{ eventType: "test.committed", payload: {} }],
                  context: {
                    tenantId: "tenant" as never,
                    audit: { performedByUserId: "user" as never, forAccountId: "account" as never },
                  },
                },
              ]);
      const result = expect(promise).rejects.toThrow("query timed out");
      await vi.advanceTimersByTimeAsync(CONFIGURATION_EPOCH_STEP_TIMEOUT_MS);
      await result;
      expect(direct).not.toHaveBeenCalled();
      expect(query.mock.calls.map(([sql]) => sql)).toEqual(
        expect.arrayContaining(["SET LOCAL statement_timeout = '5s'", "SET LOCAL lock_timeout = '5s'", "ROLLBACK"]),
      );
      expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|COMMIT)/.test(sql))).toBe(false);
      expect(release).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: expect.stringContaining("timed out") }),
      );
    },
  );
});
