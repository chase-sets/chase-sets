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
import {
  findPendingCounterpartReview,
  getAccountReview,
  getOrderReviewOpportunity,
  getReviewEligibility,
  listPendingCounterpartPairs,
  listPendingReviewsPastWindow,
  listPublicAccountReviews,
  listReceivedReviews,
  listWrittenReviews,
} from "../read-model/queries";

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
        reviewWindowExpiresAt: "2026-06-06T00:00:00.000Z",
      }),
    );

    const written = await listWrittenReviews(pool, { authorAccountId: "acc_buyer" });
    expect(written.items).toHaveLength(1);
    expect(written.items[0]).toMatchObject({
      review_id: "rev_1",
      resolution_context: "resolved-via-refund",
    });

    // Double-blind reveal (m108 #4267): the resolution-context review is a
    // review like any other for reveal purposes -- no counterpart, so it
    // reveals on window expiry.
    await handlers.review["marketplace.review.revealed"]!(
      event("marketplace.review.revealed", {
        reviewId: "rev_1",
        revealedAt: "2026-04-08T00:00:00.000Z",
        reason: "window-expired",
      }),
    );

    // Summary math treats the refund-context review like any other review.
    const summary = await pool.query<{ review_count_as_seller: number; rating_1_count_as_seller: number }>(
      `SELECT review_count_as_seller, rating_1_count_as_seller
       FROM marketplace_review_summary_pages
       WHERE account_id = 'acc_seller'`,
    );
    expect(summary.rows[0]).toEqual({ review_count_as_seller: 1, rating_1_count_as_seller: 1 });
  });
});

describeDb("marketplace review double-blind reveal SQL persistence boundary (m108 #4267)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "marketplace_review_reveal",
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

  function submittedEvent(params: {
    reviewId: string;
    orderId: string;
    authorAccountId: string;
    subjectAccountId: string;
    authorRole: string;
    rating: number;
    feedback: string | null;
    submittedAt: string;
    reviewWindowExpiresAt: string;
  }) {
    return event("marketplace.review.submitted", {
      reviewId: params.reviewId,
      orderId: params.orderId,
      authorAccountId: params.authorAccountId,
      subjectAccountId: params.subjectAccountId,
      authorRole: params.authorRole,
      rating: params.rating,
      feedback: params.feedback,
      submittedAt: params.submittedAt,
      reviewWindowExpiresAt: params.reviewWindowExpiresAt,
    });
  }

  function revealedEvent(reviewId: string, revealedAt: string, reason: string) {
    return event("marketplace.review.revealed", { reviewId, revealedAt, reason });
  }

  it("hides a review from public lists and the summary until it is revealed", async () => {
    const pool = pools.marketplace;
    const handlers = buildReviewProjectionHandlers(pool);

    await handlers["marketplace.review.submitted"]!(
      submittedEvent({
        reviewId: "rev_hidden",
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 1,
        feedback: "Trying to extort a refund.",
        submittedAt: "2026-04-02T00:00:00.000Z",
        reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
      }),
    );

    const publicBeforeReveal = await listPublicAccountReviews(pool, { accountId: "acc_seller" });
    expect(publicBeforeReveal.items).toHaveLength(0);

    const summaryBeforeReveal = await pool.query<{ review_count_as_seller: number }>(
      `SELECT review_count_as_seller FROM marketplace_review_summary_pages WHERE account_id = 'acc_seller'`,
    );
    expect(summaryBeforeReveal.rows[0]?.review_count_as_seller ?? 0).toBe(0);

    await handlers["marketplace.review.revealed"]!(
      revealedEvent("rev_hidden", "2026-04-05T00:00:00.000Z", "counterpart-submitted"),
    );

    const publicAfterReveal = await listPublicAccountReviews(pool, { accountId: "acc_seller" });
    expect(publicAfterReveal.items).toHaveLength(1);
    expect(publicAfterReveal.items[0]).toMatchObject({ review_id: "rev_hidden", rating: 1 });

    const summaryAfterReveal = await pool.query<{ review_count_as_seller: number; rating_1_count_as_seller: number }>(
      `SELECT review_count_as_seller, rating_1_count_as_seller FROM marketplace_review_summary_pages WHERE account_id = 'acc_seller'`,
    );
    expect(summaryAfterReveal.rows[0]).toEqual({ review_count_as_seller: 1, rating_1_count_as_seller: 1 });
  });

  it("redacts rating and feedback for the subject before reveal, but never for the author", async () => {
    const pool = pools.marketplace;
    const handlers = buildReviewProjectionHandlers(pool);

    await handlers["marketplace.review.submitted"]!(
      submittedEvent({
        reviewId: "rev_pending",
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 2,
        feedback: "Confidential until reveal.",
        submittedAt: "2026-04-02T00:00:00.000Z",
        reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
      }),
    );

    const asAuthor = await getAccountReview(pool, "rev_pending", "acc_buyer");
    expect(asAuthor).toMatchObject({ rating: 2, feedback: "Confidential until reveal." });

    const asSubject = await getAccountReview(pool, "rev_pending", "acc_seller");
    expect(asSubject).toMatchObject({ rating: null, feedback: null, revealed_at: null });

    const received = await listReceivedReviews(pool, { subjectAccountId: "acc_seller" });
    expect(received.items).toHaveLength(1);
    expect(received.items[0]).toMatchObject({ rating: null, feedback: null });

    await handlers["marketplace.review.revealed"]!(
      revealedEvent("rev_pending", "2026-04-05T00:00:00.000Z", "counterpart-submitted"),
    );

    const asSubjectAfterReveal = await getAccountReview(pool, "rev_pending", "acc_seller");
    expect(asSubjectAfterReveal).toMatchObject({ rating: 2, feedback: "Confidential until reveal." });

    const receivedAfterReveal = await listReceivedReviews(pool, { subjectAccountId: "acc_seller" });
    expect(receivedAfterReveal.items[0]).toMatchObject({ rating: 2, feedback: "Confidential until reveal." });
  });

  it("finds a pending counterpart review and pending counterpart pairs", async () => {
    const pool = pools.marketplace;
    const handlers = buildReviewProjectionHandlers(pool);

    await handlers["marketplace.review.submitted"]!(
      submittedEvent({
        reviewId: "rev_a",
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 5,
        feedback: null,
        submittedAt: "2026-04-02T00:00:00.000Z",
        reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
      }),
    );

    const noCounterpartYet = await findPendingCounterpartReview(pool, {
      orderId: "ord_1",
      counterpartAuthorAccountId: "acc_seller",
      counterpartSubjectAccountId: "acc_buyer",
    });
    expect(noCounterpartYet).toBeNull();
    expect(await listPendingCounterpartPairs(pool, {})).toEqual([]);

    await handlers["marketplace.review.submitted"]!(
      submittedEvent({
        reviewId: "rev_b",
        orderId: "ord_1",
        authorAccountId: "acc_seller",
        subjectAccountId: "acc_buyer",
        authorRole: "seller",
        rating: 4,
        feedback: null,
        submittedAt: "2026-04-03T00:00:00.000Z",
        reviewWindowExpiresAt: "2026-06-02T00:00:00.000Z",
      }),
    );

    const counterpart = await findPendingCounterpartReview(pool, {
      orderId: "ord_1",
      counterpartAuthorAccountId: "acc_seller",
      counterpartSubjectAccountId: "acc_buyer",
    });
    expect(counterpart).toEqual({ review_id: "rev_b" });

    const pairs = await listPendingCounterpartPairs(pool, {});
    expect(pairs).toEqual([{ review_id: "rev_a", counterpart_review_id: "rev_b" }]);

    // Once revealed, neither the counterpart lookup nor the pairs query sees it anymore.
    await handlers["marketplace.review.revealed"]!(
      revealedEvent("rev_a", "2026-04-04T00:00:00.000Z", "counterpart-submitted"),
    );
    await handlers["marketplace.review.revealed"]!(
      revealedEvent("rev_b", "2026-04-04T00:00:00.000Z", "counterpart-submitted"),
    );
    expect(await listPendingCounterpartPairs(pool, {})).toEqual([]);
  });

  it("lists hidden reviews past their window for the expiry sweep", async () => {
    const pool = pools.marketplace;
    const handlers = buildReviewProjectionHandlers(pool);

    await handlers["marketplace.review.submitted"]!(
      submittedEvent({
        reviewId: "rev_expired",
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 3,
        feedback: null,
        submittedAt: "2026-04-02T00:00:00.000Z",
        reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.review.submitted"]!(
      submittedEvent({
        reviewId: "rev_not_yet",
        orderId: "ord_2",
        authorAccountId: "acc_buyer_2",
        subjectAccountId: "acc_seller_2",
        authorRole: "buyer",
        rating: 5,
        feedback: null,
        submittedAt: "2026-04-02T00:00:00.000Z",
        reviewWindowExpiresAt: "2026-08-01T00:00:00.000Z",
      }),
    );

    const candidates = await listPendingReviewsPastWindow(pool, { now: "2026-06-15T00:00:00.000Z" });
    expect(candidates).toEqual([{ review_id: "rev_expired" }]);
  });

  it("marks a review opportunity as window-expired once eligible_at + the review window has elapsed", async () => {
    const pool = pools.marketplace;
    const handlers = {
      order: buildReviewOrderSourceProjectionHandlers(pool),
    };

    await handlers.order["ordering.order.created"]!(
      event("ordering.order.created", { orderId: "ord_1", buyerAccountId: "acc_buyer", sellerAccountId: "acc_seller" }),
    );
    // A far-past eligible_at so eligible_at + REVIEW_WINDOW_DAYS is already behind `now()`.
    await pool.query(
      `INSERT INTO marketplace_review_eligibility_pages (
         order_id, author_account_id, subject_account_id, author_role, eligible_at, updated_at
       ) VALUES ('ord_1', 'acc_buyer', 'acc_seller', 'buyer', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`,
    );

    const opportunity = await getOrderReviewOpportunity(pool, { orderId: "ord_1", authorAccountId: "acc_buyer" });
    expect(opportunity?.window_expired).toBe(true);
    expect(opportunity?.active_review_id).toBeNull();
  });
});
