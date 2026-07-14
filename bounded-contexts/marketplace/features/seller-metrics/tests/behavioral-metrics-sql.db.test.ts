import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as marketplaceModule } from "../../../index";
import {
  buildSellerMetricsOrderSourceProjectionHandlers,
  buildSellerMetricsShipmentSourceProjectionHandlers,
  buildSellerMetricsSupportSourceProjectionHandlers,
} from "../integrations/source/source-projection";
import {
  getSellerBehavioralMetricsChips,
  getSellerBehavioralMetricsSummary,
  listSellersWithMissingResponsibility,
} from "../read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["marketplace"] as const;

let sequence = 0;

function event(type: string, data: Record<string, unknown>): TransportEvent {
  sequence += 1;
  return buildTransportEvent(type, data, {
    id: `evt_${sequence}`,
    streamId: `stream_${sequence}`,
    globalPosition: String(sequence),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_buyer" },
    timing: { occurredAt: "2026-07-01T00:00:00.000Z", recordedAt: "2026-07-01T00:00:00.000Z" },
  });
}

describeDb("marketplace seller behavioral-metrics SQL persistence boundary", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "marketplace_seller_behavioral_metrics",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.marketplace.query(marketplaceModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function buildHandlers(pool: PgTransactionalPool) {
    return {
      order: buildSellerMetricsOrderSourceProjectionHandlers(pool),
      shipment: buildSellerMetricsShipmentSourceProjectionHandlers(pool),
      support: buildSellerMetricsSupportSourceProjectionHandlers(pool),
    };
  }

  async function createOrder(
    handlers: ReturnType<typeof buildHandlers>,
    orderId: string,
    sellerAccountId = "acc_seller",
  ) {
    await handlers.order["ordering.order.created"]!(event("ordering.order.created", { orderId, sellerAccountId }));
  }

  async function resolveSupport(
    handlers: ReturnType<typeof buildHandlers>,
    input: Readonly<{
      supportRequestId: string;
      orderId: string;
      flowType: string;
      resolutionType: string;
      responsibility?: string;
      resolvedAt?: string;
      sellerAccountId?: string;
    }>,
  ) {
    await handlers.support["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: input.supportRequestId,
        orderId: input.orderId,
        sellerAccountId: input.sellerAccountId ?? "acc_seller",
        flowType: input.flowType,
        resolution: {
          resolutionType: input.resolutionType,
          // `responsibility` intentionally omitted when undefined -- mirrors a
          // legacy pre-responsibility resolved event carrying no fact.
          ...(input.responsibility === undefined ? {} : { responsibility: input.responsibility }),
          resolvedAt: input.resolvedAt ?? "2026-07-02T00:00:00.000Z",
        },
      }),
    );
  }

  it("computes on-time-shipment rate from ready-for-fulfillment to dispatch against the policy's dispatch window", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    // Order A: ready at T0, dispatched 24h later -- within the 48h default window (on time).
    await createOrder(handlers, "ord_a");
    await handlers.order["ordering.order.ready-for-fulfillment-recorded"]!(
      event("ordering.order.ready-for-fulfillment-recorded", {
        orderId: "ord_a",
        readyForFulfillmentAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await handlers.shipment["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", {
        shipmentId: "shp_a",
        orderId: "ord_a",
        sellerAccountId: "acc_seller",
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await handlers.shipment["fulfillment.shipment.dispatched"]!(
      event("fulfillment.shipment.dispatched", { shipmentId: "shp_a", dispatchedAt: "2026-07-02T00:00:00.000Z" }),
    );

    // Order B: ready at T0, dispatched 72h later -- past the 48h default window (late).
    await createOrder(handlers, "ord_b");
    await handlers.order["ordering.order.ready-for-fulfillment-recorded"]!(
      event("ordering.order.ready-for-fulfillment-recorded", {
        orderId: "ord_b",
        readyForFulfillmentAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await handlers.shipment["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", {
        shipmentId: "shp_b",
        orderId: "ord_b",
        sellerAccountId: "acc_seller",
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await handlers.shipment["fulfillment.shipment.dispatched"]!(
      event("fulfillment.shipment.dispatched", { shipmentId: "shp_b", dispatchedAt: "2026-07-04T00:00:00.000Z" }),
    );

    const summary = await getSellerBehavioralMetricsSummary(pool, "acc_seller");
    expect(summary?.shipments_dispatched_count).toBe(2);
    expect(summary?.shipments_on_time_count).toBe(1);
    expect(summary?.on_time_shipment_rate).toBe("0.5000");
  });

  it("attributes cancellation rate only to seller-cancelled orders, not buyer- or system-cancelled ones", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    await createOrder(handlers, "ord_seller_cancel");
    await handlers.order["ordering.order.cancelled"]!(
      event("ordering.order.cancelled", {
        orderId: "ord_seller_cancel",
        cancelledAt: "2026-07-02T00:00:00.000Z",
        reason: "seller-cancelled",
      }),
    );

    await createOrder(handlers, "ord_buyer_cancel");
    await handlers.order["ordering.order.cancelled"]!(
      event("ordering.order.cancelled", {
        orderId: "ord_buyer_cancel",
        cancelledAt: "2026-07-02T00:00:00.000Z",
        reason: "buyer-cancelled",
      }),
    );

    await createOrder(handlers, "ord_payment_deadline");
    await handlers.order["ordering.order.cancelled"]!(
      event("ordering.order.cancelled", {
        orderId: "ord_payment_deadline",
        cancelledAt: "2026-07-02T00:00:00.000Z",
        reason: "payment-deadline",
      }),
    );

    await createOrder(handlers, "ord_not_cancelled");

    const summary = await getSellerBehavioralMetricsSummary(pool, "acc_seller");
    expect(summary?.orders_created_count).toBe(4);
    expect(summary?.seller_cancelled_count).toBe(1);
    expect(summary?.cancellation_rate).toBe("0.2500");
  });

  it("counts only seller-responsible outcomes, excluding carrier, buyer, and undetermined causes regardless of remedy", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    // Seller-misdescription refund -- seller responsible, counts.
    await createOrder(handlers, "ord_seller_refund");
    await resolveSupport(handlers, {
      supportRequestId: "sup_seller_refund",
      orderId: "ord_seller_refund",
      flowType: "product-not-as-described",
      resolutionType: "full-refund",
      responsibility: "seller",
    });

    // Carrier-loss refund -- carrier responsible, excluded even though a refund was issued.
    await createOrder(handlers, "ord_carrier_refund");
    await resolveSupport(handlers, {
      supportRequestId: "sup_carrier_refund",
      orderId: "ord_carrier_refund",
      flowType: "product-not-received",
      resolutionType: "full-refund",
      responsibility: "carrier",
    });

    // Buyer-remorse return refund -- buyer responsible, excluded.
    await createOrder(handlers, "ord_buyer_remorse");
    await resolveSupport(handlers, {
      supportRequestId: "sup_buyer_remorse",
      orderId: "ord_buyer_remorse",
      flowType: "return-request",
      resolutionType: "return-for-refund",
      responsibility: "buyer",
    });

    // Undetermined outcome -- excluded.
    await createOrder(handlers, "ord_undetermined");
    await resolveSupport(handlers, {
      supportRequestId: "sup_undetermined",
      orderId: "ord_undetermined",
      flowType: "product-damaged",
      resolutionType: "partial-refund",
      responsibility: "undetermined",
    });

    const summary = await getSellerBehavioralMetricsSummary(pool, "acc_seller");
    expect(summary?.orders_created_count).toBe(4);
    expect(summary?.disputes_resolved_count).toBe(4);
    expect(summary?.disputes_against_seller_count).toBe(1);
    expect(summary?.dispute_rate).toBe("0.2500");
    expect(summary?.missing_responsibility_count).toBe(0);
  });

  it("counts a seller-responsible outcome once whether the remedy is refund, replacement, or no monetary remedy", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    await createOrder(handlers, "ord_replacement");
    await resolveSupport(handlers, {
      supportRequestId: "sup_replacement",
      orderId: "ord_replacement",
      flowType: "product-not-as-described",
      resolutionType: "replacement",
      responsibility: "seller",
    });

    await createOrder(handlers, "ord_no_remedy");
    await resolveSupport(handlers, {
      supportRequestId: "sup_no_remedy",
      orderId: "ord_no_remedy",
      flowType: "product-not-as-described",
      resolutionType: "no-action",
      responsibility: "seller",
    });

    const summary = await getSellerBehavioralMetricsSummary(pool, "acc_seller");
    expect(summary?.disputes_against_seller_count).toBe(2);
  });

  it("counts an order at most once even with multiple seller-responsible resolved requests", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    await createOrder(handlers, "ord_multi");
    await resolveSupport(handlers, {
      supportRequestId: "sup_multi_a",
      orderId: "ord_multi",
      flowType: "product-not-as-described",
      resolutionType: "full-refund",
      responsibility: "seller",
    });
    await resolveSupport(handlers, {
      supportRequestId: "sup_multi_b",
      orderId: "ord_multi",
      flowType: "product-damaged",
      resolutionType: "partial-refund",
      responsibility: "seller",
    });

    const summary = await getSellerBehavioralMetricsSummary(pool, "acc_seller");
    expect(summary?.orders_created_count).toBe(1);
    expect(summary?.disputes_resolved_count).toBe(2);
    expect(summary?.disputes_against_seller_count).toBe(1);
    expect(summary?.dispute_rate).toBe("1.0000");
  });

  it("excludes legacy resolutions with no responsibility fact and reports them as a missing-responsibility signal", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    // A pre-responsibility (legacy) refund carrying no responsibility fact.
    await createOrder(handlers, "ord_legacy_refund");
    await resolveSupport(handlers, {
      supportRequestId: "sup_legacy_refund",
      orderId: "ord_legacy_refund",
      flowType: "product-not-as-described",
      resolutionType: "full-refund",
      // responsibility omitted
    });

    const summary = await getSellerBehavioralMetricsSummary(pool, "acc_seller");
    expect(summary?.disputes_against_seller_count).toBe(0);
    expect(summary?.dispute_rate).toBe("0.0000");
    expect(summary?.missing_responsibility_count).toBe(1);

    const health = await listSellersWithMissingResponsibility(pool);
    expect(health).toEqual([
      { seller_account_id: "acc_seller", missing_responsibility_count: 1, computed_at: expect.any(String) },
    ]);
  });

  it("converges to the same buckets across duplicate delivery and an authorized responsibility correction", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    await createOrder(handlers, "ord_correct");

    // Initial resolution attributes the seller.
    await resolveSupport(handlers, {
      supportRequestId: "sup_correct",
      orderId: "ord_correct",
      flowType: "product-not-received",
      resolutionType: "full-refund",
      responsibility: "seller",
    });
    // Duplicate delivery of the same event -- must not double-count.
    await resolveSupport(handlers, {
      supportRequestId: "sup_correct",
      orderId: "ord_correct",
      flowType: "product-not-received",
      resolutionType: "full-refund",
      responsibility: "seller",
    });

    let summary = await getSellerBehavioralMetricsSummary(pool, "acc_seller");
    expect(summary?.disputes_resolved_count).toBe(1);
    expect(summary?.disputes_against_seller_count).toBe(1);

    // An authorized correction re-attributes the same request to the carrier.
    await resolveSupport(handlers, {
      supportRequestId: "sup_correct",
      orderId: "ord_correct",
      flowType: "product-not-received",
      resolutionType: "full-refund",
      responsibility: "carrier",
    });

    summary = await getSellerBehavioralMetricsSummary(pool, "acc_seller");
    expect(summary?.disputes_resolved_count).toBe(1);
    expect(summary?.disputes_against_seller_count).toBe(0);
    expect(summary?.dispute_rate).toBe("0.0000");
  });

  it("rebuilds identical buckets when the same source events are replayed after a schema reset", async () => {
    const pool = pools.marketplace;

    async function project(handlers: ReturnType<typeof buildHandlers>) {
      await createOrder(handlers, "ord_r1");
      await resolveSupport(handlers, {
        supportRequestId: "sup_r1",
        orderId: "ord_r1",
        flowType: "product-not-as-described",
        resolutionType: "full-refund",
        responsibility: "seller",
      });
      await createOrder(handlers, "ord_r2");
      await resolveSupport(handlers, {
        supportRequestId: "sup_r2",
        orderId: "ord_r2",
        flowType: "product-not-received",
        resolutionType: "full-refund",
        responsibility: "carrier",
      });
    }

    await project(buildHandlers(pool));
    const first = await getSellerBehavioralMetricsSummary(pool, "acc_seller");

    await resetMultiContextTestSchemas(pools);
    await pool.query(marketplaceModule.schemaSql);

    await project(buildHandlers(pool));
    const rebuilt = await getSellerBehavioralMetricsSummary(pool, "acc_seller");

    expect(rebuilt?.orders_created_count).toBe(first?.orders_created_count);
    expect(rebuilt?.disputes_resolved_count).toBe(first?.disputes_resolved_count);
    expect(rebuilt?.disputes_against_seller_count).toBe(first?.disputes_against_seller_count);
    expect(rebuilt?.dispute_rate).toBe(first?.dispute_rate);
    expect(rebuilt?.disputes_against_seller_count).toBe(1);
  });

  it("gates buyer-facing chips to null under the display threshold and returns booleans once past it", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    for (let index = 0; index < 5; index += 1) {
      await createOrder(handlers, `ord_low_${index}`);
    }

    const belowThreshold = await getSellerBehavioralMetricsChips(pool, "acc_seller", 10);
    expect(belowThreshold).toEqual({
      sellerAccountId: "acc_seller",
      shipsOnTime: null,
      lowCancellationRate: null,
      lowDisputeRate: null,
    });

    for (let index = 5; index < 12; index += 1) {
      await createOrder(handlers, `ord_low_${index}`);
    }

    const aboveThreshold = await getSellerBehavioralMetricsChips(pool, "acc_seller", 10);
    expect(aboveThreshold.sellerAccountId).toBe("acc_seller");
    expect(aboveThreshold.lowCancellationRate).toBe(true);
    expect(aboveThreshold.lowDisputeRate).toBe(true);
    // No shipments dispatched at all yet -- ships-on-time stays gated on its own (shipment) denominator.
    expect(aboveThreshold.shipsOnTime).toBeNull();
  });
});
