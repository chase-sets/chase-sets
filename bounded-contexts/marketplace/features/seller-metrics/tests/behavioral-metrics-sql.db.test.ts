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
import { getSellerBehavioralMetricsChips, getSellerBehavioralMetricsSummary } from "../read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
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

  it("counts a refund-class support resolution against the seller but a no-action resolution for the seller", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    await createOrder(handlers, "ord_refunded");
    await handlers.support["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_refunded",
        orderId: "ord_refunded",
        sellerAccountId: "acc_seller",
        flowType: "product-not-as-described",
        resolution: { resolutionType: "full-refund", resolvedAt: "2026-07-02T00:00:00.000Z" },
      }),
    );

    await createOrder(handlers, "ord_no_action");
    await handlers.support["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_no_action",
        orderId: "ord_no_action",
        sellerAccountId: "acc_seller",
        flowType: "item-not-received",
        resolution: { resolutionType: "no-action", resolvedAt: "2026-07-02T00:00:00.000Z" },
      }),
    );

    await createOrder(handlers, "ord_seller_cannot_fulfill");
    await handlers.support["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_seller_cannot_fulfill",
        orderId: "ord_seller_cannot_fulfill",
        sellerAccountId: "acc_seller",
        flowType: "seller-cannot-fulfill",
        resolution: { resolutionType: "cancel-order", resolvedAt: "2026-07-02T00:00:00.000Z" },
      }),
    );

    await createOrder(handlers, "ord_buyer_cancel_request");
    await handlers.support["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_buyer_cancel_request",
        orderId: "ord_buyer_cancel_request",
        sellerAccountId: "acc_seller",
        flowType: "buyer-cancel-request",
        resolution: { resolutionType: "cancel-order", resolvedAt: "2026-07-02T00:00:00.000Z" },
      }),
    );

    const summary = await getSellerBehavioralMetricsSummary(pool, "acc_seller");
    expect(summary?.orders_created_count).toBe(4);
    expect(summary?.disputes_resolved_count).toBe(4);
    // Against seller: full-refund and the seller-cannot-fulfill cancel-order. Not against: no-action, buyer-cancel-request.
    expect(summary?.disputes_against_seller_count).toBe(2);
    expect(summary?.dispute_rate).toBe("0.5000");
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
