import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as marketplaceModule } from "../../../index";
import { syncReviewEligibilityForOrder } from "../integrations/source/eligibility-sync";
import {
  buildReviewOrderSourceProjectionHandlers,
  buildReviewShipmentSourceProjectionHandlers,
  buildReviewSupportSourceProjectionHandlers,
} from "../integrations/source/source-projection";
import { buildReviewProjectionHandlers } from "../read-model/projection";
import { getReviewEligibility, listWrittenReviews } from "../read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["marketplace"] as const;

let sequence = 0;

function event(type: string, data: Record<string, unknown>): TransportEvent {
  sequence += 1;
  return {
    id: `evt_${sequence}` as never,
    type,
    streamId: `stream_${sequence}` as never,
    streamVersion: 1 as never,
    globalPosition: sequence as never,
    tenantId: "tnt_test" as never,
    data: data as never,
    metadata: {},
    audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_buyer" as never },
    trace: {},
    timing: {
      occurredAt: "2026-04-02T00:00:00.000Z" as never,
      recordedAt: "2026-04-02T00:00:00.000Z" as never,
    },
  };
}

describeDb("marketplace review eligibility SQL persistence boundary", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "marketplace_review_eligibility",
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
      order: buildReviewOrderSourceProjectionHandlers(pool),
      shipment: buildReviewShipmentSourceProjectionHandlers(pool, {
        onDeliveredShipment: async ({ shipmentId, deliveredAt }) => {
          const shipment = await pool.query<{ order_id: string }>(
            `SELECT order_id
             FROM marketplace_review_shipment_sources
             WHERE shipment_id = $1
               AND status = 'delivered'`,
            [shipmentId],
          );
          const orderId = shipment.rows[0]?.order_id;
          if (orderId) {
            await syncReviewEligibilityForOrder(pool, orderId, deliveredAt);
          }
        },
      }),
      support: buildReviewSupportSourceProjectionHandlers(pool),
      review: buildReviewProjectionHandlers(pool),
    };
  }

  it("restores only the buyer direction with the refund marker on a full-refund resolution", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    await handlers.order["ordering.order.created"]!(
      event("ordering.order.created", { orderId: "ord_1", buyerAccountId: "acc_buyer", sellerAccountId: "acc_seller" }),
    );
    await handlers.shipment["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        createdAt: "2026-04-02T00:00:00.000Z",
      }),
    );
    await handlers.shipment["fulfillment.shipment.delivered"]!(
      event("fulfillment.shipment.delivered", { shipmentId: "shp_1", deliveredAt: "2026-04-03T00:00:00.000Z" }),
    );

    const delivered = await pool.query(`SELECT author_role FROM marketplace_review_eligibility_pages`);
    expect(delivered.rowCount).toBe(2);

    await handlers.support["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        openedAt: "2026-04-04T00:00:00.000Z",
      }),
    );
    const suspended = await pool.query(`SELECT 1 FROM marketplace_review_eligibility_pages`);
    expect(suspended.rowCount).toBe(0);

    await handlers.support["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        flowType: "product-not-as-described",
        resolution: { resolutionType: "full-refund", resolvedAt: "2026-04-06T00:00:00.000Z" },
      }),
    );

    const eligibility = await getReviewEligibility(pool, {
      orderId: "ord_1",
      authorAccountId: "acc_buyer",
      subjectAccountId: "acc_seller",
    });
    expect(eligibility).toMatchObject({
      author_role: "buyer",
      resolution_context: "resolved-via-refund",
    });

    const sellerDirection = await getReviewEligibility(pool, {
      orderId: "ord_1",
      authorAccountId: "acc_seller",
      subjectAccountId: "acc_buyer",
    });
    expect(sellerDirection).toBeNull();
  });

  it("restores the buyer without a delivery for a seller-caused cancellation", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    await handlers.order["ordering.order.created"]!(
      event("ordering.order.created", { orderId: "ord_2", buyerAccountId: "acc_buyer", sellerAccountId: "acc_seller" }),
    );
    await handlers.support["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_2",
        orderId: "ord_2",
        openedAt: "2026-04-02T12:00:00.000Z",
      }),
    );
    await handlers.support["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_2",
        orderId: "ord_2",
        flowType: "seller-cannot-fulfill",
        resolution: { resolutionType: "cancel-order", resolvedAt: "2026-04-04T00:00:00.000Z" },
      }),
    );

    const rows = await pool.query<{ author_role: string; resolution_context: string | null }>(
      `SELECT author_role, resolution_context
       FROM marketplace_review_eligibility_pages
       WHERE order_id = 'ord_2'`,
    );
    expect(rows.rows).toEqual([{ author_role: "buyer", resolution_context: "resolved-via-refund" }]);
  });

  it("persists the marker on review pages and surfaces it through the list queries", async () => {
    const pool = pools.marketplace;
    const handlers = buildHandlers(pool);

    await handlers.review["marketplace.review.submitted"]!(
      event("marketplace.review.submitted", {
        reviewId: "rev_1",
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 1,
        feedback: "Refunded after the card arrived misdescribed.",
        resolutionContext: "resolved-via-refund",
        submittedAt: "2026-04-07T00:00:00.000Z",
      }),
    );

    const written = await listWrittenReviews(pool, { authorAccountId: "acc_buyer" });
    expect(written.items).toHaveLength(1);
    expect(written.items[0]).toMatchObject({
      review_id: "rev_1",
      resolution_context: "resolved-via-refund",
    });

    // Summary math treats the refund-context review like any other review.
    const summary = await pool.query<{ review_count_as_seller: number; rating_1_count_as_seller: number }>(
      `SELECT review_count_as_seller, rating_1_count_as_seller
       FROM marketplace_review_summary_pages
       WHERE account_id = 'acc_seller'`,
    );
    expect(summary.rows[0]).toEqual({ review_count_as_seller: 1, rating_1_count_as_seller: 1 });
  });
});
