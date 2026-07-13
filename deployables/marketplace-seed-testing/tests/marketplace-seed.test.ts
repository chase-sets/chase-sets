import { expect, it } from "vitest";
import { escapeLikePattern } from "@chase-sets/event-core-postgres";
import { describeWithMarketplaceSeedDatabase, useMarketplaceSeedRuntime } from "../index";

const seedIds = {
  demoAccountId: "acc_seed_demo_account",
  supportRequests: {
    activeProductNotReceived: "sup_seed_active_product_not_received",
    resolvedPartialRefund: "sup_seed_resolved_partial_refund",
  },
} as const;

describeWithMarketplaceSeedDatabase("marketplace development seed", () => {
  const seedRuntime = useMarketplaceSeedRuntime("marketplace-development-seed");

  it("creates deterministic cross-context lifecycle coverage idempotently", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();
    await seedRuntime.seed();

    const paymentStatuses = await pools.payments.query<{ status: string }>(
      "SELECT status FROM payments_payment_pages ORDER BY payment_id ASC",
    );
    expect(new Set(paymentStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["pending-confirmation", "captured", "failed", "cancelled"]),
    );

    const refundStatuses = await pools.payments.query<{ status: string }>(
      "SELECT status FROM payments_refund_pages ORDER BY refund_id ASC",
    );
    expect(new Set(refundStatuses.rows.map((row) => row.status))).toEqual(new Set(["requested", "issued", "failed"]));

    const readyOrders = await pools.ordering.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM ordering_order_pages WHERE status = 'ready-for-fulfillment'",
    );
    expect(Number(readyOrders.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const publishedListingsMissingMeasures = await pools.marketplace.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_listing_pages
       WHERE status <> 'draft'
         AND product_measure_snapshot IS NULL`,
    );
    expect(Number(publishedListingsMissingMeasures.rows[0]?.count ?? 0)).toBe(0);

    const checkoutCartLines = await pools.checkout.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM checkout_cart_line_pages",
    );
    expect(Number(checkoutCartLines.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const checkoutSessions = await pools.checkout.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM checkout_session_pages WHERE session_id = 'chk_seed_started_cart'",
    );
    expect(Number(checkoutSessions.rows[0]?.count ?? 0)).toBe(1);

    const shipmentStatuses = await pools.fulfillment.query<{ status: string }>(
      "SELECT status FROM fulfillment_shipment_pages ORDER BY shipment_id ASC",
    );
    expect(new Set(shipmentStatuses.rows.map((row) => row.status))).toEqual(
      new Set([
        "awaiting-package",
        "awaiting-label",
        "label-attached",
        "dispatched",
        "delivered",
        "returned",
        "exception",
      ]),
    );

    const reviewStatuses = await pools.marketplace.query<{ status: string }>(
      "SELECT status FROM marketplace_review_pages ORDER BY review_id ASC",
    );
    expect(new Set(reviewStatuses.rows.map((row) => row.status))).toEqual(new Set(["active", "withdrawn"]));

    // The seed's active review is authored by the buyer about the demo
    // account acting as a seller, so it lands in the as-seller dimension
    // (m108 role split); the seller-to-buyer review is withdrawn and
    // contributes to neither dimension's count.
    const summary = await pools.marketplace.query<{
      review_count_as_seller: number;
      average_rating_as_seller: string | null;
    }>(
      "SELECT review_count_as_seller, average_rating_as_seller::text AS average_rating_as_seller FROM marketplace_review_summary_pages WHERE review_count_as_seller > 0",
    );
    expect(summary.rows[0]).toMatchObject({
      review_count_as_seller: 1,
      average_rating_as_seller: "5.00",
    });

    const wallet = await pools.settlement.query<{
      pending_balance_amount: string;
      available_balance_amount: string;
    }>(
      `SELECT pending_balance_amount, available_balance_amount
       FROM settlement_wallet_pages
       WHERE account_id = $1`,
      [seedIds.demoAccountId],
    );
    // Pending balance covers both seeded captured payments after their Order
    // Protection allowance shares fund the reserve: the accepted-offer order
    // that receives support requests and the review-eligible delivered order
    // that stays support-free.
    expect(wallet.rows[0]).toMatchObject({
      pending_balance_amount: "106.96",
      available_balance_amount: "36.83",
    });

    const payoutStatuses = await pools.settlement.query<{ status: string }>(
      "SELECT status FROM settlement_payout_pages ORDER BY payout_id ASC",
    );
    expect(new Set(payoutStatuses.rows.map((row) => row.status))).toEqual(new Set(["completed", "failed"]));

    const payoutEmails = await pools.settlement.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM notification_outbox
       WHERE message_type = 'settlement.payout.completed'
         AND idempotency_key LIKE 'settlement:payout_completed:%'`,
    );
    expect(Number(payoutEmails.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const supportRequests = await pools["platform-operations"].query<{
      support_request_id: string;
      status: string;
      flow_type: string;
    }>(
      `SELECT support_request_id, status, flow_type
       FROM support_request_pages
       WHERE support_request_id = ANY($1::text[])
       ORDER BY support_request_id ASC`,
      [[seedIds.supportRequests.activeProductNotReceived, seedIds.supportRequests.resolvedPartialRefund]],
    );
    expect(supportRequests.rows).toHaveLength(2);
    expect(new Set(supportRequests.rows.map((row) => row.status))).toEqual(new Set(["waiting-on-seller", "resolved"]));

    const refundEffect = await pools.payments.query<{
      status: string;
      requested_amount: string;
    }>(
      `SELECT status, requested_amount::text AS requested_amount
       FROM payments_support_refund_effects
       WHERE support_request_id = $1`,
      [seedIds.supportRequests.resolvedPartialRefund],
    );
    expect(refundEffect.rows[0]).toMatchObject({
      status: "refund-requested",
      requested_amount: "5.00",
    });

    const activeHolds = await pools.settlement.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM settlement_support_holds
       WHERE support_request_id = ANY($1::text[])
         AND active = TRUE`,
      [[seedIds.supportRequests.activeProductNotReceived, seedIds.supportRequests.resolvedPartialRefund]],
    );
    expect(Number(activeHolds.rows[0]?.count ?? 0)).toBe(2);

    const eventCountsBefore = await readSeedEventCounts(pools);
    await seedRuntime.seed();
    await expect(readSeedEventCounts(pools)).resolves.toEqual(eventCountsBefore);
  }, 300_000);
});

async function readSeedEventCounts(pools: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]) {
  // Support streams keep their durable "support." prefix but live in the
  // platform-operations context database after the context merge.
  const seedEventSources = [
    ["ordering", "ordering"],
    ["payments", "payments"],
    ["fulfillment", "fulfillment"],
    ["reputation", "marketplace"],
    ["settlement", "settlement"],
    ["support", "platform-operations"],
  ] as const;
  const entries = await Promise.all(
    seedEventSources.map(async ([streamContextName, poolName]) => {
      const result = await pools[poolName].query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1 ESCAPE '\\'",
        [`${escapeLikePattern(`${streamContextName}.`)}%`],
      );
      return [streamContextName, result.rows[0]?.count ?? "0"] as const;
    }),
  );

  return Object.fromEntries(entries);
}
