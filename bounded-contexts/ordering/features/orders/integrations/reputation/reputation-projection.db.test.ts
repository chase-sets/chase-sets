import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as orderingModule } from "../../../../index";
import { buildOrderingReputationProjectionHandlers } from "./reputation-projection";
import { getOrderingOrderDeliverySummary } from "./reputation-queries";
import { createCheckpointStore, createOrderingOrderRuntimeForTest } from "../../api/runtime-test-harness";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["ordering"] as const;

let sequence = 0;

function event(type: string, data: Record<string, unknown>): TransportEvent {
  sequence += 1;
  return buildTransportEvent(type, data, {
    id: `evt_${sequence}`,
    streamId: `stream_${sequence}`,
    globalPosition: String(sequence),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_buyer" },
    timing: { occurredAt: "2026-04-02T00:00:00.000Z", recordedAt: "2026-04-02T00:00:00.000Z" },
  });
}

async function insertOrderPage(pool: PgTransactionalPool, orderId: string) {
  await pool.query(
    `INSERT INTO ordering_order_pages (
       order_id,
       source_type,
       buyer_account_id,
       seller_account_id,
       shipping_option,
       item_subtotal_amount,
       shipping_base_amount,
       shipping_discount_amount,
       shipping_charge_amount,
       total_amount,
       marketplace_sales_fee_amount,
       seller_net_amount,
       terms_resolved_at,
       status
     ) VALUES ($1, 'cart-checkout', 'acc_buyer', 'acc_seller', 'standard', 10, 0, 0, 0, 10, 1, 9, now(), 'paid')`,
    [orderId],
  );
}

describeDb("ordering reputation projection SQL persistence boundary", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "ordering_reputation");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.ordering.query(orderingModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("composes buyer delivery from only this order's mirrored shipments without changing stored status", async () => {
    const pool = pools.ordering;
    const handlers = buildOrderingReputationProjectionHandlers(pool);
    const runtime = createOrderingOrderRuntimeForTest({
      db: pool,
      eventStore: createPostgresEventStore({ pool }),
      checkpointStore: createCheckpointStore(),
      shippingQuotePolicy: {
        quote: () => ({ shippingOption: "standard", baseAmount: "0.00", discountAmount: "0.00", chargeAmount: "0.00" }),
      },
    });
    await insertOrderPage(pool, "ord_delivery");
    await pool.query("UPDATE ordering_order_pages SET status = 'ready-for-fulfillment' WHERE order_id = $1", [
      "ord_delivery",
    ]);
    await insertOrderPage(pool, "ord_unrelated");
    const created = async (shipmentId: string, orderId = "ord_delivery") =>
      handlers["fulfillment.shipment.created"]!(
        event("fulfillment.shipment.created", { shipmentId, orderId, createdAt: "2026-04-02T00:00:00.000Z" }),
      );
    const delivered = async (shipmentId: string, deliveredAt: string) =>
      handlers["fulfillment.shipment.delivered"]!(event("fulfillment.shipment.delivered", { shipmentId, deliveredAt }));
    const firstTime = "2026-04-03T10:15:00.000Z";
    const latestTime = "2026-04-09T17:42:00.000Z";
    // A later unrelated delivery exposes a missing order predicate in either COUNT or MAX.
    await created("shp_unrelated", "ord_unrelated");
    await delivered("shp_unrelated", "2026-04-20T22:30:00.000Z");

    async function expectSummary(shipment_count: number, delivered_count: number, latest: string | null) {
      const summary = await getOrderingOrderDeliverySummary(pool, "ord_delivery");
      expect(summary.shipment_count).toBe(shipment_count);
      expect(summary.delivered_count).toBe(delivered_count);
      expect(summary.latest_delivered_at === null ? null : new Date(summary.latest_delivered_at).toISOString()).toBe(
        latest,
      );
      const purchase = await runtime.getPurchase("ord_delivery", "acc_buyer");
      expect(purchase?.delivery_summary).toEqual(summary);
      expect(purchase?.status).toBe("ready-for-fulfillment");
    }

    await expectSummary(0, 0, null);
    await created("shp_first");
    await expectSummary(1, 0, null);
    await delivered("shp_first", firstTime);
    await expectSummary(1, 1, firstTime);
    await delivered("shp_first", firstTime);
    await expectSummary(1, 1, firstTime);
    await created("shp_second");
    await expectSummary(2, 1, firstTime);
    await delivered("shp_second", latestTime);
    await expectSummary(2, 2, latestTime);
    expect(await runtime.getPurchase("ord_delivery", "acc_foreign")).toBeNull();
    expect(await runtime.getPurchase("ord_missing", "acc_buyer")).toBeNull();
    const sale = await runtime.getSale("ord_delivery", "acc_seller");
    expect(sale?.status).toBe("ready-for-fulfillment");
    expect(sale).not.toHaveProperty("delivery_summary");
    const stored = await pool.query<{ status: string }>("SELECT status FROM ordering_order_pages WHERE order_id = $1", [
      "ord_delivery",
    ]);
    expect(stored.rows).toEqual([{ status: "ready-for-fulfillment" }]);
  });

  it("applies the refund-class eligibility matrix against the live schema", async () => {
    const pool = pools.ordering;
    const handlers = buildOrderingReputationProjectionHandlers(pool);
    await insertOrderPage(pool, "ord_1");

    await handlers["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        createdAt: "2026-04-02T00:00:00.000Z",
      }),
    );
    await handlers["fulfillment.shipment.delivered"]!(
      event("fulfillment.shipment.delivered", { shipmentId: "shp_1", deliveredAt: "2026-04-03T00:00:00.000Z" }),
    );

    const delivered = await pool.query(`SELECT 1 FROM ordering_order_review_eligibility_pages`);
    expect(delivered.rowCount).toBe(2);

    await handlers["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        openedAt: "2026-04-04T00:00:00.000Z",
      }),
    );
    const suspended = await pool.query(`SELECT 1 FROM ordering_order_review_eligibility_pages`);
    expect(suspended.rowCount).toBe(0);

    await handlers["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        flowType: "product-not-as-described",
        resolution: { resolutionType: "partial-refund", resolvedAt: "2026-04-06T00:00:00.000Z" },
      }),
    );

    const rows = await pool.query<{ author_account_id: string; author_role: string }>(
      `SELECT author_account_id, author_role
       FROM ordering_order_review_eligibility_pages
       WHERE order_id = 'ord_1'`,
    );
    expect(rows.rows).toEqual([{ author_account_id: "acc_buyer", author_role: "buyer" }]);

    const supportSource = await pool.query<{ flow_type: string | null }>(
      `SELECT flow_type
       FROM ordering_order_review_support_request_sources
       WHERE support_request_id = 'sup_1'`,
    );
    expect(supportSource.rows[0]).toEqual({ flow_type: "product-not-as-described" });
  });

  it("restores the buyer hint without a delivery for a seller-caused cancellation", async () => {
    const pool = pools.ordering;
    const handlers = buildOrderingReputationProjectionHandlers(pool);
    await insertOrderPage(pool, "ord_2");

    await handlers["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_2",
        orderId: "ord_2",
        openedAt: "2026-04-02T12:00:00.000Z",
      }),
    );
    await handlers["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_2",
        orderId: "ord_2",
        flowType: "seller-cannot-fulfill",
        resolution: { resolutionType: "cancel-order", resolvedAt: "2026-04-04T00:00:00.000Z" },
      }),
    );

    const rows = await pool.query<{ author_role: string; eligible_at: Date }>(
      `SELECT author_role, eligible_at
       FROM ordering_order_review_eligibility_pages
       WHERE order_id = 'ord_2'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.author_role).toBe("buyer");
  });
});
