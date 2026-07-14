import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createProtectionCoverageRuntime } from "./protection-coverage-runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_operator" as never,
    forAccountId: "acc_platform" as never,
  },
};

/**
 * A fake db that answers only the funded-pool query the reserve path issues
 * (`getProtectionReservePoolBalance`). The runtime tests exercise the aggregate
 * and its concurrency/idempotency behavior, not the projection; projection SQL
 * is covered by the `.db.test.ts`.
 */
function fakeDb(fundedAmount: string): PgQueryable {
  return {
    query: async (sql: string) => {
      if (sql.includes("settlement_protection_reserve_facts")) {
        return { rows: [{ funded_amount: fundedAmount }] };
      }
      return { rows: [] };
    },
  } as unknown as PgQueryable;
}

function reserveInput(overrides: Record<string, unknown> = {}) {
  return {
    coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    remedyId: "rmd_01JZ6DKP7S7Z4AZ5N5E6K7M8NA",
    supportRequestId: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8NB",
    requestedAmount: "40.00",
    currencyCode: "usd",
    policyVersion: "coverage-policy-2026-07",
    reasonCode: "fault-indeterminate",
    ...overrides,
  };
}

describe("protection coverage runtime", () => {
  it("reserves against the funded pool and reports the reserved amount", async () => {
    const runtime = createProtectionCoverageRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      db: fakeDb("100.00"),
    });
    const result = await runtime.reserve(reserveInput(), context);
    expect(result).toMatchObject({ outcome: "reserved", reservedAmount: "40.00", currencyCode: "usd" });
  });

  it("rejects a request that exceeds the funded pool", async () => {
    const runtime = createProtectionCoverageRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      db: fakeDb("30.00"),
    });
    const result = await runtime.reserve(reserveInput(), context);
    expect(result).toMatchObject({ outcome: "rejected", rejectionReason: "insufficient-reserve" });
  });

  it("is idempotent for an identical retry of the same coverage id", async () => {
    const runtime = createProtectionCoverageRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      db: fakeDb("100.00"),
    });
    await runtime.reserve(reserveInput(), context);
    const retry = await runtime.reserve(reserveInput(), context);
    expect(retry.outcome).toBe("already-reserved");
  });

  it("rejects conflicting terms on a reused coverage id", async () => {
    const runtime = createProtectionCoverageRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      db: fakeDb("100.00"),
    });
    await runtime.reserve(reserveInput(), context);
    const conflict = await runtime.reserve(reserveInput({ requestedAmount: "41.00" }), context);
    expect(conflict).toMatchObject({ outcome: "rejected", rejectionReason: "conflicting-terms" });
  });

  it("serializes racing reservations so they cannot overdraw the pool", async () => {
    // Two 60.00 reservations race against a 100.00 pool: exactly one wins, the
    // other loses the optimistic-concurrency contest, retries, and is rejected.
    const runtime = createProtectionCoverageRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      db: fakeDb("100.00"),
    });
    const [a, b] = await Promise.all([
      runtime.reserve(reserveInput({ coverageId: "cov_a", remedyId: "rmd_a", requestedAmount: "60.00" }), context),
      runtime.reserve(reserveInput({ coverageId: "cov_b", remedyId: "rmd_b", requestedAmount: "60.00" }), context),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["rejected", "reserved"]);
    const rejected = [a, b].find((r) => r.outcome === "rejected");
    expect(rejected?.rejectionReason).toBe("insufficient-reserve");
  });

  it("settles a reserved coverage exactly once and rejects a conflicting resettle", async () => {
    const runtime = createProtectionCoverageRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      db: fakeDb("100.00"),
    });
    await runtime.reserve(reserveInput(), context);
    const settled = await runtime.settle(
      {
        coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
        currencyCode: "usd",
        refundId: "rfd_1",
        platformFundedAmount: "40.00",
        sellerFundedAmount: "0.00",
        policyVersion: "coverage-policy-2026-07",
      },
      context,
    );
    expect(settled.outcome).toBe("applied");
    const resettle = await runtime.settle(
      {
        coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
        currencyCode: "usd",
        refundId: "rfd_1",
        platformFundedAmount: "40.00",
        sellerFundedAmount: "0.00",
        policyVersion: "coverage-policy-2026-07",
      },
      context,
    );
    expect(resettle.outcome).toBe("noop");
  });

  it("releases a reserved coverage once and returns the funds for a later reservation", async () => {
    const runtime = createProtectionCoverageRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      db: fakeDb("40.00"),
    });
    await runtime.reserve(reserveInput(), context);
    const released = await runtime.release(
      {
        coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
        currencyCode: "usd",
        releaseReason: "case-cancelled",
        policyVersion: "coverage-policy-2026-07",
      },
      context,
    );
    expect(released.outcome).toBe("applied");
    const noop = await runtime.release(
      {
        coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
        currencyCode: "usd",
        releaseReason: "case-cancelled",
        policyVersion: "coverage-policy-2026-07",
      },
      context,
    );
    expect(noop.outcome).toBe("noop");
    // The released funds are available again.
    const reReserve = await runtime.reserve(
      reserveInput({ coverageId: "cov_2", remedyId: "rmd_2", requestedAmount: "40.00" }),
      context,
    );
    expect(reReserve.outcome).toBe("reserved");
  });

  it("records operation signals for reserve/reject/settle", async () => {
    const signals: string[] = [];
    const runtime = createProtectionCoverageRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      db: fakeDb("100.00"),
      operationsRecorder: { record: (event) => void signals.push(event.kind) },
    });
    await runtime.reserve(reserveInput(), context);
    await runtime.settle(
      {
        coverageId: "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
        currencyCode: "usd",
        refundId: "rfd_1",
        platformFundedAmount: "40.00",
        sellerFundedAmount: "0.00",
        policyVersion: "coverage-policy-2026-07",
      },
      context,
    );
    expect(signals).toContain("protection-coverage-reserved");
    expect(signals).toContain("protection-coverage-settled");
  });
});
