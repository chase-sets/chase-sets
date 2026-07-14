import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as settlementModule } from "../../../index";
import { buildProtectionCoverageProjectionHandlers } from "./protection-coverage-projection";
import {
  getProtectionCoverage,
  getProtectionCoverageAvailability,
  getProtectionCoverageMetrics,
  listProtectionCoverageReconciliation,
} from "./protection-coverage-queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }
  return databaseBaseUrl;
}

const COVERAGE_ID = "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9";
const REMEDY_ID = "rmd_01JZ6DKP7S7Z4AZ5N5E6K7M8NA";
const SUPPORT_ID = "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8NB";

function reservedEvent(streamVersion: number) {
  return {
    type: "settlement.protection-coverage.reserved.v1",
    streamVersion,
    data: {
      factSchemaVersion: 1,
      supportRequestId: SUPPORT_ID,
      remedyId: REMEDY_ID,
      idempotencyKey: `coverage-reserve:${COVERAGE_ID}`,
      causationId: null,
      policyVersion: "coverage-policy-2026-07",
      occurredAt: "2026-07-14T00:00:00.000Z",
      coverageId: COVERAGE_ID,
      reservedAmount: "40.00",
      currencyCode: "usd",
    },
  };
}

function settledEvent(streamVersion: number) {
  return {
    type: "settlement.protection-coverage.settled.v1",
    streamVersion,
    data: {
      factSchemaVersion: 1,
      supportRequestId: SUPPORT_ID,
      remedyId: REMEDY_ID,
      idempotencyKey: `coverage-settle:${COVERAGE_ID}`,
      causationId: null,
      policyVersion: "coverage-policy-2026-07",
      occurredAt: "2026-07-14T01:00:00.000Z",
      coverageId: COVERAGE_ID,
      refundId: "rfd_1",
      allocation: {
        sellerFundedAmount: "0.00",
        platformFundedAmount: "40.00",
        currencyCode: "usd",
        fundingKind: "platform-funded",
      },
      currencyCode: "usd",
    },
  };
}

function rejectedEvent(streamVersion: number) {
  return {
    type: "settlement.protection-coverage.rejected.v1",
    streamVersion,
    data: {
      factSchemaVersion: 1,
      supportRequestId: SUPPORT_ID,
      remedyId: REMEDY_ID,
      idempotencyKey: "coverage-reserve:cov_rejected",
      causationId: null,
      policyVersion: "coverage-policy-2026-07",
      occurredAt: "2026-07-14T00:30:00.000Z",
      coverageId: "cov_rejected",
      requestedAmount: "999.00",
      currencyCode: "usd",
      reasonCode: "insufficient-reserve",
    },
  };
}

describeDb("settlement protection coverage projection persistence boundary", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "protection_coverage",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
    // Seed a 100.00 net protection pool (contribution) so availability has a ceiling.
    await pool.query(
      `INSERT INTO settlement_protection_reserve_facts
         (fact_id, fact_kind, order_id, payment_id, payment_stream_version, protection_amount, allowance_amount, overage_amount, recorded_at)
       VALUES ('fact_1', 'contribution', 'ord_1', 'pay_1', 1, 100.00, 100.00, 0.00, '2026-07-13T00:00:00.000Z')`,
    );
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  async function apply(events: readonly { type: string; streamVersion: number; data: unknown }[], times = 1) {
    const handlers = buildProtectionCoverageProjectionHandlers(pool);
    for (let i = 0; i < times; i += 1) {
      for (const event of events) {
        await handlers[event.type]?.(event as never, {} as never);
      }
    }
  }

  it("reconstructs the reservation lifecycle idempotently under replay", async () => {
    await apply([reservedEvent(1), settledEvent(2)], 2);

    const row = await getProtectionCoverage(pool, COVERAGE_ID);
    expect(row?.status).toBe("settled");
    expect(row?.reserved_amount).toBe("40.00");
    expect(row?.consumed_amount).toBe("40.00");
    expect(row?.refund_id).toBe("rfd_1");

    const availability = await getProtectionCoverageAvailability(pool);
    expect(availability.fundedAmount).toBe("100.00");
    expect(availability.consumedAmount).toBe("40.00");
    expect(availability.availableAmount).toBe("60.00");
  });

  it("rebuilds to the same state after a schema reset", async () => {
    await apply([reservedEvent(1)]);
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
    await apply([reservedEvent(1)]);
    const row = await getProtectionCoverage(pool, COVERAGE_ID);
    expect(row?.status).toBe("reserved");
  });

  it("treats a stale, lower-version redelivery as a no-op (out-of-order safe)", async () => {
    await apply([reservedEvent(1), settledEvent(2)]);
    // A late redelivery of the reserved event (version 1) must not revert the settled row.
    await apply([reservedEvent(1)]);
    const row = await getProtectionCoverage(pool, COVERAGE_ID);
    expect(row?.status).toBe("settled");
  });

  it("audits a rejected reservation and counts it in metrics without a lifecycle row", async () => {
    await apply([reservedEvent(1), rejectedEvent(2)], 2);
    const rejectedRow = await getProtectionCoverage(pool, "cov_rejected");
    expect(rejectedRow).toBeNull();

    const metrics = await getProtectionCoverageMetrics(pool);
    expect(metrics.reserved).toBe(1);
    expect(metrics.rejected).toBe(1);
    expect(metrics.requested).toBe(2);
  });

  it("exposes reconciliation status: a reserved coverage is pending until terminal", async () => {
    await apply([reservedEvent(1)]);
    const pending = await listProtectionCoverageReconciliation(pool, {});
    expect(pending[0]?.reconciliation_status).toBe("pending");
    expect(pending[0]?.blocking_reason).toBe("awaiting-settlement-or-release");

    await apply([settledEvent(2)]);
    const reconciled = await listProtectionCoverageReconciliation(pool, {});
    expect(reconciled[0]?.reconciliation_status).toBe("reconciled");
    expect(reconciled[0]?.blocking_reason).toBeNull();
  });
});
