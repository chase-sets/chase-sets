import { expect, it } from "vitest";
import { escapeLikePattern } from "@chase-sets/event-core-postgres";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import {
  inspectMarketplaceSeedState,
  seedMarketplaceDatabase,
} from "../../../bounded-contexts/marketplace/support/runtime-support/seed";
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
      available_balance_amount: "26.83",
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

  it("reconciles legacy null-currency listings once and leaves the withdrawn seed untouched", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();

    await pools.marketplace.query(
      `UPDATE event_store_events
       SET payload = payload - 'priceCurrencyCode'
       WHERE event_type = 'marketplace.listing.created'
         AND stream_id LIKE 'marketplace.listing-%'`,
    );
    const before = await pools.marketplace.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type = 'marketplace.listing.price-updated'`,
    );

    await seedRuntime.seed();

    const after = await pools.marketplace.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type = 'marketplace.listing.price-updated'`,
    );
    expect(Number(after.rows[0]?.count ?? 0) - Number(before.rows[0]?.count ?? 0)).toBe(22);

    const withdrawn = await pools.marketplace.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE stream_id = 'marketplace.listing-lst_seed_surging_sparks_withdrawn'
         AND event_type = 'marketplace.listing.price-updated'`,
    );
    expect(Number(withdrawn.rows[0]?.count ?? 0)).toBe(0);
  }, 300_000);

  it("refuses AC1 listing drift before any append and reports non-exact inspection as draft", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();
    const listingId = marketplaceReservedSeedIds.listings.cardVaultCharizardNearMint;
    const streamId = listingStream(listingId);
    const before = await countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated");

    await updateCreatedPayload(pools.marketplace, streamId, "priceAmount", "1.00");
    await expect(seedRuntime.seed()).rejects.toThrow(/mismatched fields: price amount/);
    await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated")).resolves.toBe(
      before,
    );

    await updateCreatedPayload(pools.marketplace, streamId, "priceAmount", "389.00");
    await seedRuntime.seed();
    await replacePublishedEvent(pools.marketplace, streamId, "marketplace.listing.paused");
    const reports = await inspectMarketplaceSeedState(pools.marketplace);
    expect(reports.find((report) => report.id === listingId)).toMatchObject({ kind: "draft", status: "paused" });
  }, 300_000);

  it("reconciles a legacy active draft to exact and authors it in one real-DB seed", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();
    const listingId = marketplaceReservedSeedIds.listings.lugiaNeoGenesisBgs95;
    const streamId = listingStream(listingId);
    await stripCreatedCurrency(pools.marketplace, streamId);
    await pools.marketplace.query(
      `DELETE FROM event_store_events
       WHERE stream_id = $1 AND event_type = 'marketplace.listing.published'`,
      [streamId],
    );
    const before = await countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated");

    await seedRuntime.seed();

    await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated")).resolves.toBe(
      before + 1,
    );
    const published = await pools.marketplace.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM event_store_events
       WHERE stream_id = $1 AND event_type = 'marketplace.listing.published'`,
      [streamId],
    );
    expect(Number(published.rows[0]?.count ?? 0)).toBe(1);
    await seedRuntime.seed();
    await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated")).resolves.toBe(
      before + 1,
    );
  }, 300_000);

  it("refuses incomplete fee locks across accounts with zero price updates", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();
    const streams = [
      listingStream(marketplaceReservedSeedIds.listings.cardVaultCharizardNearMint),
      listingStream(marketplaceReservedSeedIds.listings.sealedStockroomSurgingSparksActive),
    ];
    await Promise.all(streams.map((streamId) => stripCreatedCurrency(pools.marketplace, streamId)));
    await pools.marketplace.query(
      `UPDATE event_store_events
       SET payload = payload || '{"feeLocks":[]}'::jsonb
       WHERE stream_id = $1 AND event_type = 'marketplace.listing.created'`,
      [streams[0]],
    );
    const before = await countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true);

    await expect(seedRuntime.seed()).rejects.toThrow(/mismatched fields: fee locks/);
    await expect(countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true)).resolves.toBe(
      before,
    );
  }, 300_000);

  it("keeps withdrawn legacy listings unchanged while reconciling active listings", async () => {
    const { pools } = seedRuntime;
    await seedRuntime.seed();
    const withdrawnId = marketplaceReservedSeedIds.listings.surgingSparksWithdrawn;
    const withdrawnStream = listingStream(withdrawnId);
    await stripCreatedCurrency(pools.marketplace, withdrawnStream);
    await replacePublishedEvent(pools.marketplace, withdrawnStream, "marketplace.listing.withdrawn");
    const before = await countListingEvents(pools.marketplace, withdrawnStream, "marketplace.listing.price-updated");

    await seedRuntime.seed();

    await expect(
      countListingEvents(pools.marketplace, withdrawnStream, "marketplace.listing.price-updated"),
    ).resolves.toBe(before);
    const state = await pools.marketplace.query<{ event_type: string }>(
      `SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version DESC LIMIT 1`,
      [withdrawnStream],
    );
    expect(state.rows[0]?.event_type).toBe("marketplace.listing.withdrawn");
  }, 300_000);

  it("survives an owner write between classify and append and converges on the next run", async () => {
    const { pools } = seedRuntime;
    const runtime = await seedRuntime.seed();
    const services = runtime.services.marketplace;
    await pools.marketplace.query(
      `UPDATE event_store_events
       SET payload = payload - 'priceCurrencyCode'
       WHERE event_type = 'marketplace.listing.created'
         AND stream_id LIKE 'marketplace.listing-%'`,
    );
    const offersBefore = await countStreamEvents(pools.marketplace, "marketplace.offer-%");
    const original = services.listings.applyBulkListingPriceUpdates;
    let ownerCalls = 0;
    let injected = false;
    const wrappedServices = {
      ...services,
      listings: {
        ...services.listings,
        applyBulkListingPriceUpdates: async (...args: Parameters<typeof original>) => {
          ownerCalls += 1;
          if (!injected) {
            injected = true;
            await original({ ...args[0], updates: [args[0].updates[0]!] }, args[1]);
          }
          return original(...args);
        },
      },
    } as typeof services;
    await expect(seedMarketplaceDatabase(pools.marketplace, wrappedServices)).rejects.toThrow(/reconciliation failed/);
    expect(ownerCalls).toBe(1);
    const firstListing = marketplaceReservedSeedIds.listings.charizardBaseSetNearMint;
    await expect(
      countListingEvents(pools.marketplace, listingStream(firstListing), "marketplace.listing.price-updated"),
    ).resolves.toBe(1);
    await seedMarketplaceDatabase(pools.marketplace, services);
    await expect(countStreamEvents(pools.marketplace, "marketplace.offer-%")).resolves.toBe(offersBefore);
    const allUpdates = await pools.marketplace.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM event_store_events
       WHERE event_type = 'marketplace.listing.price-updated'`,
    );
    expect(Number(allUpdates.rows[0]?.count ?? 0)).toBe(22);
  }, 300_000);

  it("refuses missing supply without creating the absent listing and remains idempotent across boots", async () => {
    const { pools } = seedRuntime;
    const runtime = await seedRuntime.seed();
    const listingId = marketplaceReservedSeedIds.listings.mewtwoBlackStarPromoPremium;
    const streamId = listingStream(listingId);
    const created = await pools.marketplace.query<{ inventory_item_id: string }>(
      `SELECT payload->>'inventoryItemId' AS inventory_item_id
       FROM event_store_events WHERE stream_id = $1 AND event_type = 'marketplace.listing.created'`,
      [streamId],
    );
    await pools.marketplace.query("DELETE FROM event_store_events WHERE stream_id = $1", [streamId]);
    await pools.inventory.query("DELETE FROM inventory_items WHERE item_id = $1", [created.rows[0]!.inventory_item_id]);

    await expect(seedMarketplaceDatabase(pools.marketplace, runtime.services.marketplace)).rejects.toThrow(
      /missing inventory supply/,
    );
    await expect(countStreamEvents(pools.marketplace, streamId)).resolves.toBe(0);
  }, 300_000);
});

const listingStream = (listingId: string) => `marketplace.listing-${listingId}`;

async function updateCreatedPayload(
  pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"],
  streamId: string,
  field: string,
  value: string,
) {
  await pool.query(
    `UPDATE event_store_events
     SET payload = jsonb_set(payload, ARRAY[$2], to_jsonb($3::text), false)
     WHERE stream_id = $1 AND event_type = 'marketplace.listing.created'`,
    [streamId, field, value],
  );
}

async function stripCreatedCurrency(
  pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"],
  streamId: string,
) {
  await pool.query(
    `UPDATE event_store_events
     SET payload = payload - 'priceCurrencyCode'
     WHERE stream_id = $1 AND event_type = 'marketplace.listing.created'`,
    [streamId],
  );
}

async function replacePublishedEvent(
  pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"],
  streamId: string,
  eventType: "marketplace.listing.paused" | "marketplace.listing.withdrawn",
) {
  const payload = eventType.endsWith("paused") ? '{"reason":"seller"}' : "{}";
  await pool.query(
    `UPDATE event_store_events
     SET event_type = $2, payload = $3::jsonb
     WHERE stream_id = $1 AND event_type = 'marketplace.listing.published'`,
    [streamId, eventType, payload],
  );
}

async function countListingEvents(
  pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"],
  streamId: string,
  eventType: string,
  streamPattern = false,
) {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM event_store_events
     WHERE stream_id ${streamPattern ? "LIKE" : "="} $1 AND event_type = $2`,
    [streamId, eventType],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function countStreamEvents(
  pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"],
  streamId: string,
) {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1",
    [streamId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

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
