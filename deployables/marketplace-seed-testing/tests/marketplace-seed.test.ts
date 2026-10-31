import { expect, it } from "vitest";
import { escapeLikePattern } from "@chase-sets/event-core-postgres";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { createMarketplaceSeedRuntime, describeWithMarketplaceSeedDatabase, useMarketplaceSeedRuntime } from "../index";

const seedIds = {
  demoAccountId: "acc_seed_demo_account",
  supportRequests: {
    activeProductNotReceived: "sup_seed_active_product_not_received",
    resolvedPartialRefund: "sup_seed_resolved_partial_refund",
  },
} as const;

const marketplaceReservedSeedIds = {
  listings: {
    charizardBaseSetNearMint: "lst_seed_charizard_base_set_nm",
    cardVaultCharizardNearMint: "lst_seed_card_vault_charizard_nm",
    cardVaultCharizardPsa8: "lst_seed_card_vault_charizard_psa_8",
    cardVaultCharizardMarketMaker: "lst_seed_card_vault_charizard_market_maker",
    pikachuJungleValueCopy: "lst_seed_pikachu_jungle_value_copy",
    pikachuJunglePremiumCopy: "lst_seed_pikachu_jungle_premium_copy",
    lugiaNeoGenesisBgs95: "lst_seed_lugia_neo_genesis_bgs_95",
    mewtwoBlackStarPromoActive: "lst_seed_mewtwo_black_star_promo_active",
    mewtwoBlackStarPromoPremium: "lst_seed_mewtwo_black_star_promo_premium",
    prismaticEvolutionsPaused: "lst_seed_prismatic_evolutions_paused",
    surgingSparksWithdrawn: "lst_seed_surging_sparks_withdrawn",
    sealedStockroomSurgingSparksActive: "lst_seed_sealed_seller_surging_sparks_active",
  },
} as const;

type MarketplaceSeedServices = NonNullable<Parameters<NonNullable<typeof marketplaceModule.seed>>[1]>;

describeWithMarketplaceSeedDatabase("marketplace development seed", () => {
  const seedRuntime = useMarketplaceSeedRuntime("marketplace-development-seed", { resetSchemas: "beforeAll" });

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

    const originalPayloads = await pools.marketplace.query<{ stream_id: string; payload: unknown }>(
      `SELECT DISTINCT ON (stream_id) stream_id, payload
       FROM event_store_events
       WHERE event_type = 'marketplace.listing.created'
       ORDER BY stream_id, stream_version`,
    );
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

    const versionsBefore = await readListingStreamVersions(pools.marketplace);
    const knownUpdates = await pools.marketplace.query<{ event_id: string }>(
      "SELECT event_id FROM event_store_events WHERE event_type = 'marketplace.listing.price-updated'",
    );
    const { counted, counter } = countOwnerCalls(
      createMarketplaceSeedRuntime(pools).services.marketplace as MarketplaceSeedServices,
    );
    await marketplaceModule.seed!(pools.marketplace, counted);

    const after = await pools.marketplace.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type = 'marketplace.listing.price-updated'`,
    );
    expect(Number(after.rows[0]?.count ?? 0) - Number(before.rows[0]?.count ?? 0)).toBe(22);
    expect(counter.calls).toBe(3);
    const known = new Set(knownUpdates.rows.map((row) => row.event_id));
    const appended = (
      await pools.marketplace.query<{ stream_id: string; stream_version: string; event_id: string }>(
        `SELECT stream_id, stream_version, event_id FROM event_store_events
         WHERE event_type = 'marketplace.listing.price-updated' ORDER BY stream_id`,
      )
    ).rows.filter((row) => !known.has(row.event_id));
    expect(appended).toHaveLength(22);
    expect(new Set(appended.map((row) => row.stream_id)).size).toBe(22);
    const versionsAfter = await readListingStreamVersions(pools.marketplace);
    for (const row of appended) {
      const listingId = row.stream_id.slice("marketplace.listing-".length);
      const prior = versionsBefore.get(row.stream_id)!;
      expect(Number(row.stream_version)).toBe(prior + 1);
      expect(versionsAfter.get(row.stream_id)).toBe(prior + 1);
      expect(row.event_id).toMatch(new RegExp(`^seed:listing-denomination:${listingId}(:\\d+)?$`));
    }
    const withdrawnStreamId = listingStream(marketplaceReservedSeedIds.listings.surgingSparksWithdrawn);
    expect(versionsAfter.get(withdrawnStreamId)).toBe(versionsBefore.get(withdrawnStreamId));

    const withdrawn = await pools.marketplace.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE stream_id = 'marketplace.listing-lst_seed_surging_sparks_withdrawn'
         AND event_type = 'marketplace.listing.price-updated'`,
    );
    expect(Number(withdrawn.rows[0]?.count ?? 0)).toBe(0);

    await pools.marketplace.query(
      "DELETE FROM event_store_events WHERE event_type = 'marketplace.listing.price-updated'",
    );
    await repairListingStreamVersions(pools);
    for (const row of originalPayloads.rows) {
      await restoreCreatedPayload(pools.marketplace, row.stream_id, row.payload);
    }
  }, 300_000);

  it("refuses AC1 listing drift before any append and reports non-exact inspection as draft", async () => {
    const { pools } = seedRuntime;
    const listingId = marketplaceReservedSeedIds.listings.cardVaultCharizardNearMint;
    const streamId = listingStream(listingId);
    const before = await countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated");

    await updateCreatedPayload(pools.marketplace, streamId, "priceAmount", "1.00");
    await expect(runMarketplaceSeed(pools)).rejects.toThrow(/mismatched fields: price amount/);
    await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated")).resolves.toBe(
      before,
    );

    await updateCreatedPayload(pools.marketplace, streamId, "priceAmount", "389.00");
    await runMarketplaceSeed(pools);
    await replacePublishedEvent(pools.marketplace, streamId, "marketplace.listing.paused");
    const reports = await marketplaceModule.inspectSeedState!(pools.marketplace);
    expect(reports.find((report) => report.id === listingId)).toMatchObject({ kind: "draft", status: "paused" });
    await replacePublishedEvent(pools.marketplace, streamId, "marketplace.listing.published");
  }, 300_000);

  it("refuses each named AC1 field drift with zero appends", async () => {
    const { pools } = seedRuntime;
    const listingId = marketplaceReservedSeedIds.listings.cardVaultCharizardPsa8;
    const streamId = listingStream(listingId);
    const drifts = [
      ["accountId", "acc_seed_demo_account", "owner account"],
      ["inventoryItemId", "inv_seed_drift", "inventory item"],
      ["catalogItemId", "cat_seed_drift", "catalog item"],
      ["quantityCap", 99, "quantity cap"],
    ] as const;

    for (const [field, value, mismatch] of drifts) {
      const originalPayload = await readCreatedPayload(pools.marketplace, streamId);
      const before = await countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated");
      await updateCreatedJsonField(pools.marketplace, streamId, field, value);
      await expect(runMarketplaceSeed(pools)).rejects.toThrow(new RegExp(`mismatched fields: ${mismatch}`));
      await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated")).resolves.toBe(
        before,
      );
      await restoreCreatedPayload(pools.marketplace, streamId, originalPayload);
    }

    const originalPayload = await readCreatedPayload(pools.marketplace, streamId);
    const before = await countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated");
    await pools.marketplace.query(
      `UPDATE event_store_events
       SET payload = (payload - 'priceCurrencyCode') || '{"priceAmount":"1.00"}'::jsonb
       WHERE stream_id = $1 AND event_type = 'marketplace.listing.created'`,
      [streamId],
    );
    await expect(runMarketplaceSeed(pools)).rejects.toThrow(/mismatched fields: price amount/);
    await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated")).resolves.toBe(
      before,
    );
    await restoreCreatedPayload(pools.marketplace, streamId, originalPayload);

    await replacePublishedEvent(pools.marketplace, streamId, "marketplace.listing.paused");
    await expect(runMarketplaceSeed(pools)).rejects.toThrow(/mismatched fields: status/);
    await replacePublishedEvent(pools.marketplace, streamId, "marketplace.listing.published");

    const withdrawnId = marketplaceReservedSeedIds.listings.surgingSparksWithdrawn;
    const withdrawnStream = listingStream(withdrawnId);
    const withdrawnPayload = await readCreatedPayload(pools.marketplace, withdrawnStream);
    const withdrawnBefore = await countListingEvents(
      pools.marketplace,
      withdrawnStream,
      "marketplace.listing.price-updated",
    );
    await updateCreatedJsonField(pools.marketplace, withdrawnStream, "priceAmount", "1.00");
    await expect(runMarketplaceSeed(pools)).rejects.toThrow(/mismatched fields: price amount/);
    await expect(
      countListingEvents(pools.marketplace, withdrawnStream, "marketplace.listing.price-updated"),
    ).resolves.toBe(withdrawnBefore);
    await restoreCreatedPayload(pools.marketplace, withdrawnStream, withdrawnPayload);

    const inspectionId = marketplaceReservedSeedIds.listings.cardVaultCharizardMarketMaker;
    const inspectionStream = listingStream(inspectionId);
    const inspectionPayload = await readCreatedPayload(pools.marketplace, inspectionStream);
    await stripCreatedCurrency(pools.marketplace, inspectionStream);
    await replacePublishedEvent(pools.marketplace, inspectionStream, "marketplace.listing.paused");
    const reports = await marketplaceModule.inspectSeedState!(pools.marketplace);
    expect(reports.find((report) => report.id === inspectionId)).toMatchObject({ kind: "draft", status: "paused" });
    await replacePublishedEvent(pools.marketplace, inspectionStream, "marketplace.listing.published");
    await restoreCreatedPayload(pools.marketplace, inspectionStream, inspectionPayload);
  }, 300_000);

  it("inspects a final-status null-currency listing as non-active without status drift", async () => {
    const { pools } = seedRuntime;
    await runMarketplaceSeed(pools);
    const listingId = marketplaceReservedSeedIds.listings.cardVaultCharizardMarketMaker;
    const streamId = listingStream(listingId);
    const payload = await readCreatedPayload(pools.marketplace, streamId);
    const exact = await marketplaceModule.inspectSeedState!(pools.marketplace);
    expect(exact.find((report) => report.id === listingId)).toMatchObject({ kind: "active", status: "active" });
    try {
      await stripCreatedCurrency(pools.marketplace, streamId);
      const reports = await marketplaceModule.inspectSeedState!(pools.marketplace);
      expect(reports.find((report) => report.id === listingId)).toMatchObject({ kind: "draft", status: "active" });
    } finally {
      await restoreCreatedPayload(pools.marketplace, streamId, payload);
    }
  }, 300_000);

  it("refuses a final-active listing found withdrawn with zero appends", async () => {
    const { pools } = seedRuntime;
    await runMarketplaceSeed(pools);
    const listingId = marketplaceReservedSeedIds.listings.pikachuJungleValueCopy;
    const streamId = listingStream(listingId);
    const published = await readSingleEvent(pools.marketplace, streamId, "marketplace.listing.published");
    try {
      await setEventAtVersion(
        pools.marketplace,
        streamId,
        published.stream_version,
        "marketplace.listing.withdrawn",
        {},
      );
      const eventsBefore = await countStreamEvents(pools.marketplace, "marketplace.%");
      await expect(runMarketplaceSeed(pools)).rejects.toThrow(
        new RegExp(`Listing '${listingId}' rejected; .*mismatched fields: status; found status 'withdrawn'`),
      );
      await expect(countStreamEvents(pools.marketplace, "marketplace.%")).resolves.toBe(eventsBefore);
    } finally {
      await setEventAtVersion(
        pools.marketplace,
        streamId,
        published.stream_version,
        "marketplace.listing.published",
        published.payload,
      );
    }
  }, 300_000);

  it("authors an exact-field draft listing to exact without a price update", async () => {
    const { pools } = seedRuntime;
    await runMarketplaceSeed(pools);
    const listingId = marketplaceReservedSeedIds.listings.pikachuJunglePremiumCopy;
    const streamId = listingStream(listingId);
    const published = await readSingleEvent(pools.marketplace, streamId, "marketplace.listing.published");
    await setEventAtVersion(pools.marketplace, streamId, published.stream_version, "marketplace.listing.photos-added", {
      evidence: [],
    });
    const draft = await marketplaceModule.inspectSeedState!(pools.marketplace);
    expect(draft.find((report) => report.id === listingId)).toMatchObject({ kind: "draft", status: "draft" });
    const streamUpdatesBefore = await countListingEvents(
      pools.marketplace,
      streamId,
      "marketplace.listing.price-updated",
    );
    const updatesBefore = await countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true);

    await runMarketplaceSeed(pools);

    await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated")).resolves.toBe(
      streamUpdatesBefore,
    );
    await expect(countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true)).resolves.toBe(
      updatesBefore,
    );
    await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.published")).resolves.toBe(1);
    const reports = await marketplaceModule.inspectSeedState!(pools.marketplace);
    expect(reports.find((report) => report.id === listingId)).toMatchObject({ kind: "active", status: "active" });
    const eventsAfter = await countStreamEvents(pools.marketplace, streamId);
    await runMarketplaceSeed(pools);
    await expect(countStreamEvents(pools.marketplace, streamId)).resolves.toBe(eventsAfter);
  }, 300_000);

  it("reconciles a legacy active draft to exact and authors it in one real-DB seed", async () => {
    const { pools } = seedRuntime;
    const listingId = marketplaceReservedSeedIds.listings.lugiaNeoGenesisBgs95;
    const streamId = listingStream(listingId);
    await resetListingStream(pools, streamId);
    await stripCreatedCurrency(pools.marketplace, streamId);
    await replacePublishedEvent(pools.marketplace, streamId, "marketplace.listing.photos-added");
    const before = await countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated");

    await runMarketplaceSeed(pools);

    await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated")).resolves.toBe(
      before + 1,
    );
    const published = await pools.marketplace.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM event_store_events
       WHERE stream_id = $1 AND event_type = 'marketplace.listing.published'`,
      [streamId],
    );
    expect(Number(published.rows[0]?.count ?? 0)).toBe(1);
    await runMarketplaceSeed(pools);
    await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated")).resolves.toBe(
      before + 1,
    );
  }, 300_000);

  it("refuses an incomplete fee lock in a later account before any account's price update", async () => {
    const { pools } = seedRuntime;
    await runMarketplaceSeed(pools);
    const earlierStream = listingStream(marketplaceReservedSeedIds.listings.cardVaultCharizardNearMint);
    const laterId = marketplaceReservedSeedIds.listings.sealedStockroomSurgingSparksActive;
    const laterStream = listingStream(laterId);
    const streams = [earlierStream, laterStream];
    const originalPayloads = await Promise.all(
      streams.map((streamId) => readCreatedPayload(pools.marketplace, streamId)),
    );
    expect(originalPayloads.map((payload) => (payload as { priceCurrencyCode?: unknown }).priceCurrencyCode)).toEqual([
      "USD",
      "USD",
    ]);
    try {
      await stripCreatedCurrency(pools.marketplace, earlierStream);
      await stripCreatedCurrency(pools.marketplace, laterStream);
      await pools.marketplace.query(
        `UPDATE event_store_events SET payload = payload || '{"feeLocks":[]}'::jsonb
         WHERE stream_id = $1 AND event_type = 'marketplace.listing.created'`,
        [laterStream],
      );
      const updatesBefore = await countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true);
      const eventsBefore = await countStreamEvents(pools.marketplace, "marketplace.%");
      await expect(runMarketplaceSeed(pools)).rejects.toThrow(
        new RegExp(`Listing '${laterId}' rejected; .*mismatched fields: fee locks`),
      );
      await expect(countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true)).resolves.toBe(
        updatesBefore,
      );
      await expect(countStreamEvents(pools.marketplace, "marketplace.%")).resolves.toBe(eventsBefore);
    } finally {
      for (const [index, streamId] of streams.entries()) {
        await restoreCreatedPayload(pools.marketplace, streamId, originalPayloads[index]);
      }
    }
  }, 300_000);

  it("withdraws a legacy withdrawn seed found active without a price update", async () => {
    const { pools } = seedRuntime;
    const withdrawnId = marketplaceReservedSeedIds.listings.surgingSparksWithdrawn;
    const withdrawnStream = listingStream(withdrawnId);
    await resetListingStream(pools, withdrawnStream);
    const withdrawnPayload = await readCreatedPayload(pools.marketplace, withdrawnStream);
    try {
      await stripCreatedCurrency(pools.marketplace, withdrawnStream);
      await deleteLatestEvent(pools, withdrawnStream, "marketplace.listing.withdrawn");
      const found = await marketplaceModule.inspectSeedState!(pools.marketplace);
      expect(found.find((report) => report.id === withdrawnId)).toMatchObject({ kind: "draft", status: "active" });
      const streamUpdatesBefore = await countListingEvents(
        pools.marketplace,
        withdrawnStream,
        "marketplace.listing.price-updated",
      );
      const updatesBefore = await countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true);
      await runMarketplaceSeed(pools);
      await expect(
        countListingEvents(pools.marketplace, withdrawnStream, "marketplace.listing.price-updated"),
      ).resolves.toBe(streamUpdatesBefore);
      await expect(countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true)).resolves.toBe(
        updatesBefore,
      );
      const latest = await pools.marketplace.query<{ event_type: string }>(
        "SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version DESC LIMIT 1",
        [withdrawnStream],
      );
      expect(latest.rows[0]?.event_type).toBe("marketplace.listing.withdrawn");
      const reports = await marketplaceModule.inspectSeedState!(pools.marketplace);
      expect(reports.find((report) => report.id === withdrawnId)).toMatchObject({
        kind: "active",
        status: "withdrawn",
      });
    } finally {
      await restoreCreatedPayload(pools.marketplace, withdrawnStream, withdrawnPayload);
    }
  }, 300_000);

  it("reconciles a paused legacy listing once and leaves it exact", async () => {
    const { pools } = seedRuntime;
    const streamId = listingStream(marketplaceReservedSeedIds.listings.prismaticEvolutionsPaused);
    await resetListingStream(pools, streamId);
    await stripCreatedCurrency(pools.marketplace, streamId);
    const before = await countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated");

    await runMarketplaceSeed(pools);
    await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated")).resolves.toBe(
      before + 1,
    );
    await runMarketplaceSeed(pools);
    await expect(countListingEvents(pools.marketplace, streamId, "marketplace.listing.price-updated")).resolves.toBe(
      before + 1,
    );
    await clearListingStream(pools, streamId);
    await runMarketplaceSeed(pools);
  }, 300_000);

  it("converges after an interruption between owner calls, in the same boot and a second boot", async () => {
    const { pools } = seedRuntime;
    await runMarketplaceSeed(pools);
    const later = await pools.marketplace.query<{ stream_id: string; payload: unknown }>(
      `SELECT stream_id, payload FROM event_store_events
       WHERE event_type = 'marketplace.listing.created'
         AND stream_id LIKE 'marketplace.listing-lst\\_seed\\_%'
         AND payload->>'accountId' <> $1`,
      [seedIds.demoAccountId],
    );
    expect(later.rows).toHaveLength(10);
    try {
      for (const row of later.rows) await stripCreatedCurrency(pools.marketplace, row.stream_id);
      const updatesBefore = await countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true);
      const perStreamBefore = await Promise.all(
        later.rows.map((row) =>
          countListingEvents(pools.marketplace, row.stream_id, "marketplace.listing.price-updated"),
        ),
      );
      const { counted, counter } = countOwnerCalls(
        createMarketplaceSeedRuntime(pools).services.marketplace as MarketplaceSeedServices,
      );
      const original = counted.listings.applyBulkListingPriceUpdates;
      let completed = 0;
      const interrupted = {
        ...counted,
        listings: {
          ...counted.listings,
          applyBulkListingPriceUpdates: async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            completed += 1;
            if (completed === 1) throw new Error("synthetic interruption between owner calls");
            return result;
          },
        },
      } as typeof counted;
      await expect(marketplaceModule.seed!(pools.marketplace, interrupted)).rejects.toThrow(
        "synthetic interruption between owner calls",
      );
      expect(counter.calls).toBe(1);
      expect(completed).toBe(1);
      await expect(countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true)).resolves.toBe(
        updatesBefore + 7,
      );
      await marketplaceModule.seed!(pools.marketplace, interrupted);
      expect(counter.calls).toBe(2);
      await expect(countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true)).resolves.toBe(
        updatesBefore + 10,
      );
      for (const [index, row] of later.rows.entries()) {
        await expect(
          countListingEvents(pools.marketplace, row.stream_id, "marketplace.listing.price-updated"),
        ).resolves.toBe(perStreamBefore[index]! + 1);
      }
      await marketplaceModule.seed!(pools.marketplace, interrupted);
      expect(counter.calls).toBe(2);
      await runMarketplaceSeed(pools);
      await expect(countListingEvents(pools.marketplace, "%", "marketplace.listing.price-updated", true)).resolves.toBe(
        updatesBefore + 10,
      );
    } finally {
      for (const row of later.rows) await restoreCreatedPayload(pools.marketplace, row.stream_id, row.payload);
    }
  }, 300_000);

  it("survives an owner write between classify and append and converges on the next run", async () => {
    const { pools } = seedRuntime;
    const runtime = createMarketplaceSeedRuntime(pools);
    const services = runtime.services.marketplace as MarketplaceSeedServices;
    await resetAllListingStreams(pools);
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
            await original(
              {
                ...args[0],
                updates: [{ ...args[0].updates[0]!, idempotencyKey: "owner-write:marketplace-seed" }],
              },
              args[1],
            );
          }
          return original(...args);
        },
      },
    } as typeof services;
    await expect(marketplaceModule.seed!(pools.marketplace, wrappedServices)).rejects.toThrow(/reconciliation failed/);
    expect(ownerCalls).toBe(1);
    const firstListing = marketplaceReservedSeedIds.listings.charizardBaseSetNearMint;
    await expect(
      countListingEvents(pools.marketplace, listingStream(firstListing), "marketplace.listing.price-updated"),
    ).resolves.toBe(1);
    await marketplaceModule.seed!(pools.marketplace, services);
    await expect(countStreamEvents(pools.marketplace, "marketplace.offer-%")).resolves.toBe(offersBefore);
    const allUpdates = await pools.marketplace.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM event_store_events
       WHERE event_type = 'marketplace.listing.price-updated'`,
    );
    expect(Number(allUpdates.rows[0]?.count ?? 0)).toBe(22);
  }, 300_000);

  it("creates an absent exact listing among unrelated rows", async () => {
    const { pools } = seedRuntime;
    const listingId = marketplaceReservedSeedIds.listings.mewtwoBlackStarPromoActive;
    const streamId = listingStream(listingId);
    await clearListingStream(pools, streamId);

    await runMarketplaceSeed(pools);

    await expect(countStreamEvents(pools.marketplace, streamId)).resolves.toBeGreaterThan(0);
    const latest = await pools.marketplace.query<{ event_type: string }>(
      `SELECT event_type FROM event_store_events
       WHERE stream_id = $1 ORDER BY stream_version DESC LIMIT 1`,
      [streamId],
    );
    expect(latest.rows[0]?.event_type).toBe("marketplace.listing.published");
  }, 300_000);

  it("refuses missing supply without creating the absent listing", async () => {
    const { pools } = seedRuntime;
    const runtime = createMarketplaceSeedRuntime(pools);
    const services = runtime.services.marketplace as MarketplaceSeedServices;
    const listingId = marketplaceReservedSeedIds.listings.mewtwoBlackStarPromoPremium;
    const streamId = listingStream(listingId);
    const created = await pools.marketplace.query<{ inventory_item_id: string }>(
      `SELECT payload->>'inventoryItemId' AS inventory_item_id
       FROM event_store_events WHERE stream_id = $1 AND event_type = 'marketplace.listing.created'`,
      [streamId],
    );
    await clearListingStream(pools, streamId);
    await pools.marketplace.query("DELETE FROM marketplace_supply_items WHERE item_id = $1", [
      created.rows[0]!.inventory_item_id,
    ]);

    await expect(marketplaceModule.seed!(pools.marketplace, services)).rejects.toThrow(/missing inventory supply/);
    await expect(countStreamEvents(pools.marketplace, streamId)).resolves.toBe(0);
  }, 300_000);
});

const listingStream = (listingId: string) => `marketplace.listing-${listingId}`;

function countOwnerCalls(services: MarketplaceSeedServices) {
  const original = services.listings.applyBulkListingPriceUpdates;
  const counter = { calls: 0 };
  const counted = {
    ...services,
    listings: {
      ...services.listings,
      applyBulkListingPriceUpdates: async (...args: Parameters<typeof original>) => {
        counter.calls += 1;
        return original(...args);
      },
    },
  } as typeof services;
  return { counted, counter };
}

async function readSingleEvent(
  pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"],
  streamId: string,
  eventType: string,
) {
  const result = await pool.query<{ stream_version: string; payload: unknown }>(
    "SELECT stream_version, payload FROM event_store_events WHERE stream_id = $1 AND event_type = $2",
    [streamId, eventType],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function setEventAtVersion(
  pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"],
  streamId: string,
  streamVersion: string,
  eventType: string,
  payload: unknown,
) {
  const updated = await pool.query<{ stream_id: string }>(
    `UPDATE event_store_events SET event_type = $3, payload = $4::jsonb
     WHERE stream_id = $1 AND stream_version = $2
     RETURNING stream_id`,
    [streamId, streamVersion, eventType, JSON.stringify(payload)],
  );
  expect(updated.rows).toHaveLength(1);
}

async function deleteLatestEvent(
  pools: ReturnType<typeof useMarketplaceSeedRuntime>["pools"],
  streamId: string,
  eventType: string,
) {
  const deleted = await pools.marketplace.query<{ stream_version: string }>(
    `DELETE FROM event_store_events
     WHERE stream_id = $1 AND event_type = $2
       AND stream_version = (SELECT MAX(stream_version) FROM event_store_events WHERE stream_id = $1)
     RETURNING stream_version`,
    [streamId, eventType],
  );
  expect(deleted.rows).toHaveLength(1);
  await repairListingStreamVersions(pools);
}

async function readListingStreamVersions(pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"]) {
  const result = await pool.query<{ stream_id: string; current_version: string }>(
    "SELECT stream_id, current_version FROM event_store_streams WHERE stream_id LIKE 'marketplace.listing-%'",
  );
  return new Map(result.rows.map((row) => [row.stream_id, Number(row.current_version)]));
}

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

async function updateCreatedJsonField(
  pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"],
  streamId: string,
  field: string,
  value: string | number,
) {
  await pool.query(
    `UPDATE event_store_events
     SET payload = jsonb_set(payload, ARRAY[$2], $3::jsonb, false)
     WHERE stream_id = $1 AND event_type = 'marketplace.listing.created'`,
    [streamId, field, JSON.stringify(value)],
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

async function restoreCreatedPayload(
  pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"],
  streamId: string,
  payload: unknown,
) {
  await pool.query(
    `UPDATE event_store_events
     SET payload = $2::jsonb
     WHERE stream_id = $1 AND event_type = 'marketplace.listing.created'`,
    [streamId, JSON.stringify(payload)],
  );
}

async function readCreatedPayload(
  pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"],
  streamId: string,
) {
  const result = await pool.query<{ payload: unknown }>(
    `SELECT payload FROM event_store_events
     WHERE stream_id = $1 AND event_type = 'marketplace.listing.created'`,
    [streamId],
  );
  return result.rows[0]?.payload;
}

async function replacePublishedEvent(
  pool: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]["marketplace"],
  streamId: string,
  eventType:
    | "marketplace.listing.paused"
    | "marketplace.listing.withdrawn"
    | "marketplace.listing.published"
    | "marketplace.listing.photos-added",
) {
  const payload = eventType.endsWith("paused")
    ? '{"reason":"seller"}'
    : eventType.endsWith("photos-added")
      ? '{"evidence":[]}'
      : "{}";
  const fromType =
    eventType === "marketplace.listing.published" ? "marketplace.listing.paused" : "marketplace.listing.published";
  await pool.query(
    `UPDATE event_store_events
     SET event_type = $2, payload = $3::jsonb
     WHERE stream_id = $1 AND event_type = $4`,
    [streamId, eventType, payload, fromType],
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

async function resetListingStream(pools: ReturnType<typeof useMarketplaceSeedRuntime>["pools"], streamId: string) {
  await clearListingStream(pools, streamId);
  await runMarketplaceSeed(pools);
}

async function resetAllListingStreams(pools: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]) {
  await clearListingStreams(pools);
  await runMarketplaceSeed(pools);
}

async function clearListingStream(pools: ReturnType<typeof useMarketplaceSeedRuntime>["pools"], streamId: string) {
  await pools.marketplace.query("DELETE FROM event_store_events WHERE stream_id = $1", [streamId]);
  await pools.marketplace.query("DELETE FROM event_store_streams WHERE stream_id = $1", [streamId]);
}

async function clearListingStreams(pools: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]) {
  await pools.marketplace.query("DELETE FROM event_store_events WHERE stream_id LIKE 'marketplace.listing-%'");
  await pools.marketplace.query("DELETE FROM event_store_streams WHERE stream_id LIKE 'marketplace.listing-%'");
}

async function repairListingStreamVersions(pools: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]) {
  await pools.marketplace.query(
    `UPDATE event_store_streams AS streams
     SET current_version = COALESCE(events.max_version, 0), updated_at = NOW()
     FROM (
       SELECT stream_id, MAX(stream_version) AS max_version
       FROM event_store_events
       WHERE stream_id LIKE 'marketplace.listing-%'
       GROUP BY stream_id
     ) AS events
     WHERE streams.stream_id = events.stream_id`,
  );
}

async function runMarketplaceSeed(pools: ReturnType<typeof useMarketplaceSeedRuntime>["pools"]) {
  const runtime = createMarketplaceSeedRuntime(pools);
  return marketplaceModule.seed!(pools.marketplace, runtime.services.marketplace as MarketplaceSeedServices);
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
