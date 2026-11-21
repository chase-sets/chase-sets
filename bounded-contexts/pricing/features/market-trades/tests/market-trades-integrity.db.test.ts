import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapContextDatabase,
  compactRuntimeSubscriptionLedgers,
  composeModuleSchemaSql,
  createProjectionAwarePool,
  createSubscriptionRunner,
} from "@chase-sets/bounded-context-runtime";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { payoutReviewHoldFactTypes } from "@chase-sets/event-core/payout-review-hold-facts";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { buildPricingMarketTradesProjectionHandlers } from "../integrations/source/source-projection";
import {
  buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers,
  buildPricingMarketTradesIdentityIntegrityProjectionHandlers,
  buildPricingMarketTradesPaymentsIntegrityProjectionHandlers,
  buildPricingMarketTradesSettlementIntegrityProjectionHandlers,
} from "../integrations/integrity/integrity-projection";
import { listExcludedMarketTrades } from "../read-model/queries";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

let nextStreamVersion = 0;
function event(type: string, data: Record<string, unknown>, recordedAt: string, streamId?: string) {
  return {
    type,
    streamId: streamId ?? `stream_${type}`,
    streamVersion: ++nextStreamVersion,
    data,
    timing: { recordedAt },
  } as never;
}

describeDb("pricing market-trades tape-integrity SQL persistence boundary (#4304)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "pricing_market_trades_integrity",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(composeModuleSchemaSql(pricingModule));
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function seedTrade(
    pool: PgTransactionalPool,
    params: Readonly<{
      orderId: string;
      lineId: string;
      buyerAccountId: string;
      sellerAccountId: string;
      createdAt?: string;
    }>,
  ) {
    const tradeHandlers = buildPricingMarketTradesProjectionHandlers(pool);
    await tradeHandlers["ordering.order.created"]!(
      event(
        "ordering.order.created",
        {
          orderId: params.orderId,
          sourceType: "cart-checkout",
          buyerAccountId: params.buyerAccountId,
          sellerAccountId: params.sellerAccountId,
          lines: [
            {
              lineId: params.lineId,
              catalogItemId: "cat_1",
              productId: "prod_1",
              unitPriceAmount: "10.00",
              quantity: 1,
            },
          ],
        },
        params.createdAt ?? "2026-07-01T00:00:00.000Z",
      ),
    );
  }

  async function markTradeSold(pool: PgTransactionalPool, orderId: string, soldAt = "2026-07-02T00:00:00.000Z") {
    const tradeHandlers = buildPricingMarketTradesProjectionHandlers(pool);
    await tradeHandlers["ordering.order.ready-for-fulfillment-recorded"]!(
      event("ordering.order.ready-for-fulfillment-recorded", { orderId, readyForFulfillmentAt: soldAt }, soldAt),
    );
  }

  it("retroactively excludes a flagged account's historical trades on both the buyer and seller side (AC1)", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });
    await seedTrade(pool, {
      orderId: "ord_2",
      lineId: "line_1",
      buyerAccountId: "buyer_2",
      sellerAccountId: "buyer_1",
    });
    await seedTrade(pool, {
      orderId: "ord_3",
      lineId: "line_1",
      buyerAccountId: "buyer_3",
      sellerAccountId: "seller_3",
    });

    const identityHandlers = buildPricingMarketTradesIdentityIntegrityProjectionHandlers(pool);
    await identityHandlers["identity.account.badge-assigned"]!(
      event(
        "identity.account.badge-assigned",
        { badgeKey: "manual-payout-review" },
        "2026-07-06T00:00:00.000Z",
        "identity.account-buyer_1",
      ),
    );

    const rows = await pool.query<{ order_id: string; excluded: boolean; exclusion_reason: string | null }>(
      `SELECT order_id, excluded, exclusion_reason FROM pricing_market_trades ORDER BY order_id`,
    );

    expect(rows.rows).toEqual([
      { order_id: "ord_1", excluded: true, exclusion_reason: "fraud-flagged" },
      { order_id: "ord_2", excluded: true, exclusion_reason: "fraud-flagged" },
      { order_id: "ord_3", excluded: false, exclusion_reason: null },
    ]);
  });

  it("does not exclude trades when a non-review badge is assigned", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });

    const identityHandlers = buildPricingMarketTradesIdentityIntegrityProjectionHandlers(pool);
    await identityHandlers["identity.account.badge-assigned"]!(
      event(
        "identity.account.badge-assigned",
        { badgeKey: "trusted-seller" },
        "2026-07-06T00:00:00.000Z",
        "identity.account-seller_1",
      ),
    );

    const rows = await pool.query<{ excluded: boolean }>(
      `SELECT excluded FROM pricing_market_trades WHERE order_id = 'ord_1'`,
    );
    expect(rows.rows[0]?.excluded).toBe(false);
  });

  it.each(["orders-first", "hold-first", "retained"] as const)(
    "applies the placement cutoff independently of delivery order: %s",
    async (delivery) => {
      const pool = pools.pricing;
      const accountId = "acc_synthetic_cutoff";
      const prePlacement = "2026-07-01T00:00:00.000Z";
      const preSold = "2026-07-02T00:00:00.000Z";
      const placedAt = "2026-07-03T00:00:00.000Z";
      const postRelease = "2026-07-05T00:00:00.000Z";
      const postSold = "2026-07-06T00:00:00.000Z";
      const seedOrders = async () => {
        await seedTrade(pool, {
          orderId: "ord_before",
          lineId: "line_1",
          buyerAccountId: accountId,
          sellerAccountId: "acc_other_seller",
          createdAt: prePlacement,
        });
        await seedTrade(pool, {
          orderId: "ord_after",
          lineId: "line_1",
          sellerAccountId: accountId,
          buyerAccountId: "acc_other_buyer",
          createdAt: postRelease,
        });
      };
      const sellOrders = async () => {
        await markTradeSold(pool, "ord_before", preSold);
        await markTradeSold(pool, "ord_after", postSold);
      };
      const settlement = buildPricingMarketTradesSettlementIntegrityProjectionHandlers(pool);
      const place = () =>
        settlement[payoutReviewHoldFactTypes.placed]!(
          event(
            payoutReviewHoldFactTypes.placed,
            {
              accountId,
              reason: "Synthetic review",
              source: "operator",
              sourceReference: null,
            },
            placedAt,
          ),
        );
      if (delivery !== "hold-first") {
        await seedOrders();
        await sellOrders();
        await pool.query("TRUNCATE pricing_market_trade_rollup_rederive_queue");
      }
      if (delivery === "retained") {
        await pool.query("UPDATE pricing_market_trades SET order_created_at = NULL, updated_at = $1", [postSold]);
      }
      await place();
      if (delivery !== "orders-first") await seedOrders();
      if (delivery === "hold-first") await sellOrders();

      const snapshot = async () => ({
        trades: (
          await pool.query(
            "SELECT order_id, order_created_at, sold_at, exclusion_reason FROM pricing_market_trades ORDER BY order_id",
          )
        ).rows,
        queue: (
          await pool.query(
            "SELECT day::text, generation::int FROM pricing_market_trade_rollup_rederive_queue ORDER BY day",
          )
        ).rows,
      });
      const first = await snapshot();
      expect(first.trades).toEqual([
        {
          order_id: "ord_after",
          order_created_at: new Date(postRelease),
          sold_at: new Date(postSold),
          exclusion_reason: null,
        },
        {
          order_id: "ord_before",
          order_created_at: new Date(prePlacement),
          sold_at: new Date(preSold),
          exclusion_reason: "fraud-flagged",
        },
      ]);
      expect(first.queue).toEqual([
        { day: "2026-07-02", generation: 1 },
        ...(delivery === "hold-first" ? [{ day: "2026-07-06", generation: 1 }] : []),
      ]);
      await place();
      await seedOrders();
      expect(await snapshot()).toEqual(first);
    },
  );

  it("replays hold placement and deferred linkage without repeating compacted v1 linkage", async () => {
    const pool = pools.pricing;
    await bootstrapContextDatabase(pricingModule, pool);
    const held = "acc_synthetic_held";
    const linked = "acc_synthetic_linked";
    const historical = "acc_synthetic_historical_badge";
    for (const [orderId, buyerAccountId, sellerAccountId] of [
      ["ord_buyer", held, linked],
      ["ord_seller", "acc_other_buyer", held],
      ["ord_history", historical, "acc_other_seller"],
      ["ord_linkage_only", "acc_linkage_left", "acc_linkage_right"],
      ["ord_control", "acc_unrelated_buyer", "acc_unrelated_seller"],
      ["ord_post_release", held, "acc_unrelated_seller"],
    ] as const) {
      await seedTrade(pool, {
        orderId,
        lineId: "line_1",
        buyerAccountId,
        sellerAccountId,
        ...(orderId === "ord_post_release" ? { createdAt: "2026-07-13T00:00:00.000Z" } : {}),
      });
      await markTradeSold(
        pool,
        orderId,
        orderId === "ord_seller"
          ? "2026-07-03T00:00:00.000Z"
          : orderId === "ord_linkage_only"
            ? "2026-07-04T00:00:00.000Z"
            : orderId === "ord_post_release"
              ? "2026-07-14T00:00:00.000Z"
              : undefined,
      );
    }
    await pool.query("TRUNCATE pricing_market_trade_rollup_rederive_queue");

    const services = pricingModule.createServices(createProjectionAwarePool(pool), {
      commercialTermsResolver: createNoopCommercialTermsResolver(),
      channelConnectionIdentityReader: { resolve: async () => null },
    });
    const subscriptions = pricingModule.buildSubscriptions!(services);
    const integrity = (source: string) =>
      subscriptions.find(
        (subscription) =>
          subscription.sourceContextName === source &&
          subscription.projectionName === "pricing-market-trades-projection",
      )!;
    const declared = integrity("settlement");
    const clusterHash = "a".repeat(64);
    const placedAt = "2026-07-08T00:00:00.000Z";
    const linkage = { clusterHash, signalKind: "shared-instrument", accountIds: [held, linked] };
    const hold = {
      factSchemaVersion: 1,
      accountId: held,
      source: "operator",
      reason: "Synthetic review",
      sourceReference: null,
    };
    const append = async (
      eventType: string,
      streamId: string,
      expectedVersion: "no_stream" | number,
      payload: typeof linkage | typeof hold,
      recordedAt: string,
    ) => {
      await createPostgresEventStore({ pool, now: () => recordedAt as never }).appendToStream({
        streamId: streamId as never,
        expectedVersion,
        context: {
          tenantId: "tnt_synthetic",
          audit: { performedByUserId: "usr_synthetic", forAccountId: held },
        } as never,
        events: [
          {
            eventId: `evt_${streamId}_${expectedVersion}` as never,
            eventType,
            payload,
            occurredAt: recordedAt as never,
          },
        ],
      });
    };
    const linkageStream = `settlement.account-linkage-${clusterHash}`;
    const holdStream = `settlement.payout-review-hold-${held}`;
    const flagged = "settlement.account-linkage.flagged";
    const cleared = "settlement.account-linkage.cleared";
    const linkageOnlyHash = "b".repeat(64);
    const linkageOnlyStream = `settlement.account-linkage-${linkageOnlyHash}`;
    const linkageOnly = {
      ...linkage,
      clusterHash: linkageOnlyHash,
      accountIds: ["acc_linkage_left", "acc_linkage_right"],
    };
    await append(flagged, linkageStream, "no_stream", linkage, "2026-07-06T00:00:00.000Z");
    await append(flagged, linkageOnlyStream, "no_stream", linkageOnly, "2026-07-06T01:00:00.000Z");
    const clearedAt = "2026-07-07T00:00:00.000Z";
    await append(cleared, linkageOnlyStream, 1, linkageOnly, clearedAt);

    const deferredHash = "c".repeat(64);
    const deferredStream = `settlement.account-linkage-${deferredHash}`;
    const deferredLinkage = {
      ...linkage,
      clusterHash: deferredHash,
      accountIds: ["acc_deferred_left", "acc_deferred_right"],
    };
    await append(flagged, deferredStream, "no_stream", deferredLinkage, "2026-07-06T00:00:00.000Z");
    await append(flagged, deferredStream, 1, deferredLinkage, "2026-07-06T01:00:00.000Z");
    await append(cleared, deferredStream, 2, deferredLinkage, clearedAt);

    // Advance beyond the runtime's 10,000-position receipt window without inserting filler events.
    const placementPosition = 10_007;
    await pool.query("SELECT setval('event_store_events_global_position_seq', $1::bigint, true)", [
      placementPosition - 1,
    ]);
    await append(payoutReviewHoldFactTypes.placed, holdStream, "no_stream", hold, placedAt);

    // The v1 worker already saw the placement but had no handler for it.
    const v1 = createSubscriptionRunner("pricing", pool, pool, {
      ...declared,
      subscriptionVersion: 1,
      eventTypes: [flagged, cleared],
      handlers: {
        [flagged]: async (event, context) => {
          if (event.streamId === deferredStream && event.streamVersion === 2) {
            throw new Error("Synthetic v1 poison: defer the following clear");
          }
          await declared.handlers[flagged]!(event, context);
        },
        [cleared]: declared.handlers[cleared]!,
      },
    });
    expect(await v1.runOnce({ settleIdleCheckpoints: true })).toMatchObject({
      processed: 6,
      lastGlobalPosition: String(placementPosition),
      blockedStreams: 1,
      poisonEvents: 1,
    });
    const applications = async () =>
      (
        await pool.query(
          "SELECT event_id, status FROM event_subscription_applications WHERE projection_key = $1 ORDER BY global_position",
          [v1.checkpointKey],
        )
      ).rows;
    expect((await applications()).map(({ status }) => status)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
      "poison",
    ]);
    expect(
      await compactRuntimeSubscriptionLedgers({
        mountedContexts: [{ contextName: "pricing", module: pricingModule, services, pool, projectionHandlerSets: [] }],
        subscriptionRunners: [v1],
      }),
    ).toBe(1);
    expect(await applications()).toEqual([{ event_id: `evt_${deferredStream}_1`, status: "poison" }]);

    // The deployed v1 handlers did not stamp a version on the cluster itself.
    await pool.query("UPDATE pricing_market_trade_linkage_clusters SET stream_version = 0");
    const trades = async () =>
      (await pool.query<{ order_id: string }>("SELECT * FROM pricing_market_trades ORDER BY order_id")).rows;
    const retainedTrades = await trades();
    expect(retainedTrades).toEqual([
      expect.objectContaining({ order_id: "ord_buyer", exclusion_reason: "self-dealing" }),
      expect.objectContaining({ order_id: "ord_control", exclusion_reason: null }),
      expect.objectContaining({ order_id: "ord_history", exclusion_reason: null }),
      expect.objectContaining({ order_id: "ord_linkage_only", exclusion_reason: null }),
      expect.objectContaining({ order_id: "ord_post_release", exclusion_reason: null }),
      expect.objectContaining({ order_id: "ord_seller", exclusion_reason: null }),
    ]);
    const queue = async () =>
      (
        await pool.query(
          "SELECT day::text, queued_at, generation::int FROM pricing_market_trade_rollup_rederive_queue ORDER BY day",
        )
      ).rows;
    const clusters = async () =>
      (await pool.query("SELECT * FROM pricing_market_trade_linkage_clusters ORDER BY cluster_hash")).rows;
    const retainedClusters = await clusters();
    expect(retainedClusters).toMatchObject([
      { cluster_hash: clusterHash, flagged: true, stream_version: "0" },
      { cluster_hash: linkageOnlyHash, flagged: false, stream_version: "0", updated_at: new Date(clearedAt) },
      { cluster_hash: deferredHash, flagged: true, stream_version: "0" },
    ]);
    const runV2 = () => createSubscriptionRunner("pricing", pool, pool, declared);
    const v2 = runV2();
    expect(v2.checkpointKey).toBe("pricing-market-trades-projection:settlement:v2");
    expect(await v2.runOnce()).toMatchObject({ processed: 7, lastGlobalPosition: String(placementPosition) });
    const replayedTrades = await trades();
    expect(replayedTrades).toEqual([
      expect.objectContaining({ order_id: "ord_buyer", excluded: true, exclusion_reason: "fraud-flagged" }),
      expect.objectContaining({ order_id: "ord_control", excluded: false, exclusion_reason: null }),
      expect.objectContaining({ order_id: "ord_history", excluded: false, exclusion_reason: null }),
      expect.objectContaining({ order_id: "ord_linkage_only", excluded: false, exclusion_reason: null }),
      expect.objectContaining({ order_id: "ord_post_release", excluded: false, exclusion_reason: null }),
      expect.objectContaining({ order_id: "ord_seller", excluded: true, exclusion_reason: "fraud-flagged" }),
    ]);
    const notHeld = ({ order_id }: { order_id: string }) => order_id !== "ord_buyer" && order_id !== "ord_seller";
    expect(replayedTrades.filter(notHeld)).toEqual(retainedTrades.filter(notHeld));
    expect(await queue()).toEqual([
      { day: "2026-07-02", queued_at: new Date(placedAt), generation: 2 },
      { day: "2026-07-03", queued_at: new Date(placedAt), generation: 1 },
      { day: "2026-07-04", queued_at: new Date(clearedAt), generation: 2 },
    ]);
    expect(await clusters()).toEqual([
      ...retainedClusters.slice(0, 2),
      expect.objectContaining({ cluster_hash: deferredHash, flagged: false, stream_version: "3" }),
    ]);
    const placed = { trades: await trades(), clusters: await clusters(), queue: await queue() };

    await append(payoutReviewHoldFactTypes.released, holdStream, 1, hold, "2026-07-09T00:00:00.000Z");
    expect(await v2.runOnce()).toMatchObject({ processed: 0, lastGlobalPosition: String(placementPosition + 1) });
    expect({ trades: await trades(), clusters: await clusters(), queue: await queue() }).toEqual(placed);

    const badgeAssigned = "identity.account.badge-assigned";
    await integrity("identity").handlers[badgeAssigned]!(
      event(
        badgeAssigned,
        { badgeKey: "manual-payout-review" },
        "2026-07-07T00:00:00.000Z",
        `identity.account-${historical}`,
      ),
    );
    expect(await trades()).toContainEqual(
      expect.objectContaining({ order_id: "ord_history", exclusion_reason: "fraud-flagged" }),
    );
    const beforeReflag = await queue();
    await append(cleared, linkageStream, 1, linkage, "2026-07-10T00:00:00.000Z");
    const reflaggedAt = "2026-07-11T00:00:00.000Z";
    await append(flagged, linkageOnlyStream, 2, linkageOnly, reflaggedAt);
    expect(await v2.runOnce()).toMatchObject({ processed: 2, lastGlobalPosition: String(placementPosition + 3) });
    expect(await queue()).toEqual([
      ...beforeReflag.slice(0, 2),
      { day: "2026-07-04", queued_at: new Date(reflaggedAt), generation: 3 },
    ]);
    expect(await trades()).toContainEqual(
      expect.objectContaining({ order_id: "ord_linkage_only", exclusion_reason: "self-dealing" }),
    );
    expect(await trades()).toContainEqual(
      expect.objectContaining({ order_id: "ord_buyer", exclusion_reason: "fraud-flagged" }),
    );

    await append(cleared, linkageOnlyStream, 3, linkageOnly, "2026-07-12T00:00:00.000Z");
    expect(await v2.runOnce()).toMatchObject({ processed: 1, lastGlobalPosition: String(placementPosition + 4) });
    expect(await clusters()).toMatchObject([
      { cluster_hash: clusterHash, flagged: false, stream_version: "2" },
      { cluster_hash: linkageOnlyHash, flagged: false, stream_version: "4" },
      { cluster_hash: deferredHash, flagged: false, stream_version: "3" },
    ]);
    expect(await queue()).toContainEqual({
      day: "2026-07-04",
      generation: 4,
      queued_at: new Date("2026-07-12T00:00:00.000Z"),
    });
    const final = { trades: await trades(), clusters: await clusters(), queue: await queue() };

    await pool.query("DELETE FROM event_subscription_applications WHERE projection_key = $1", [v2.checkpointKey]);
    await pool.query("DELETE FROM event_subscription_checkpoints WHERE checkpoint_key = $1", [v2.checkpointKey]);
    expect(await runV2().runOnce()).toMatchObject({ processed: 10, lastGlobalPosition: String(placementPosition + 4) });
    expect({ trades: await trades(), clusters: await clusters(), queue: await queue() }).toEqual(final);
  });

  it("excludes every trade line on a Stripe fraud-flagged order (AC1)", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });
    await seedTrade(pool, {
      orderId: "ord_2",
      lineId: "line_1",
      buyerAccountId: "buyer_2",
      sellerAccountId: "seller_2",
    });

    const paymentsHandlers = buildPricingMarketTradesPaymentsIntegrityProjectionHandlers(pool);
    await paymentsHandlers["payments.payment-fraud-warning-received"]!(
      event(
        "payments.payment-fraud-warning-received",
        { orderIds: ["ord_1"], receivedAt: "2026-07-06T00:00:00.000Z" },
        "2026-07-06T00:00:00.000Z",
      ),
    );

    const rows = await pool.query<{ order_id: string; exclusion_reason: string | null }>(
      `SELECT order_id, exclusion_reason FROM pricing_market_trades ORDER BY order_id`,
    );
    expect(rows.rows).toEqual([
      { order_id: "ord_1", exclusion_reason: "fraud-flagged" },
      { order_id: "ord_2", exclusion_reason: null },
    ]);
  });

  it("sets the verified marker on every line of an order whose authenticity case passes (AC2)", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });

    const authenticityHandlers = buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers(pool);
    await authenticityHandlers["authenticity.case.opened"]!(
      event(
        "authenticity.case.opened",
        { caseId: "case_1", orderId: "ord_1", openedAt: "2026-07-02T00:00:00.000Z" },
        "2026-07-02T00:00:00.000Z",
      ),
    );

    let rows = await pool.query<{ verified: boolean }>(
      `SELECT verified FROM pricing_market_trades WHERE order_id = 'ord_1'`,
    );
    expect(rows.rows[0]?.verified).toBe(false);

    await authenticityHandlers["authenticity.case.verdict-recorded"]!(
      event(
        "authenticity.case.verdict-recorded",
        {
          caseId: "case_1",
          verdict: "passed",
          reasonCodes: [],
          checklistResults: [],
          evidencePhotoRefs: [],
          lineNotes: [],
          inspectorAccountId: "inspector_1",
          decidedAt: "2026-07-03T00:00:00.000Z",
        },
        "2026-07-03T00:00:00.000Z",
      ),
    );

    rows = await pool.query<{ verified: boolean }>(
      `SELECT verified FROM pricing_market_trades WHERE order_id = 'ord_1'`,
    );
    expect(rows.rows[0]?.verified).toBe(true);
  });

  it("does not set verified when the authenticity case verdict fails", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });

    const authenticityHandlers = buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers(pool);
    await authenticityHandlers["authenticity.case.opened"]!(
      event(
        "authenticity.case.opened",
        { caseId: "case_1", orderId: "ord_1", openedAt: "2026-07-02T00:00:00.000Z" },
        "2026-07-02T00:00:00.000Z",
      ),
    );
    await authenticityHandlers["authenticity.case.verdict-recorded"]!(
      event(
        "authenticity.case.verdict-recorded",
        {
          caseId: "case_1",
          verdict: "failed",
          reasonCodes: ["counterfeit-suspected"],
          checklistResults: [],
          evidencePhotoRefs: [],
          lineNotes: [],
          inspectorAccountId: "inspector_1",
          decidedAt: "2026-07-03T00:00:00.000Z",
        },
        "2026-07-03T00:00:00.000Z",
      ),
    );

    const rows = await pool.query<{ verified: boolean }>(
      `SELECT verified FROM pricing_market_trades WHERE order_id = 'ord_1'`,
    );
    expect(rows.rows[0]?.verified).toBe(false);
  });

  it("exposes excluded trades with reasons for ops audit while public rollups would omit them (AC4)", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });
    await seedTrade(pool, {
      orderId: "ord_2",
      lineId: "line_1",
      buyerAccountId: "buyer_2",
      sellerAccountId: "seller_2",
    });

    const orderingFulfillmentHandlers = buildPricingMarketTradesProjectionHandlers(pool);
    await orderingFulfillmentHandlers["ordering.order.cancelled"]!(
      event(
        "ordering.order.cancelled",
        { orderId: "ord_1", cancelledAt: "2026-07-04T00:00:00.000Z" },
        "2026-07-04T00:00:00.000Z",
      ),
    );

    const paymentsHandlers = buildPricingMarketTradesPaymentsIntegrityProjectionHandlers(pool);
    await paymentsHandlers["payments.payment-fraud-warning-received"]!(
      event(
        "payments.payment-fraud-warning-received",
        { orderIds: ["ord_2"], receivedAt: "2026-07-05T00:00:00.000Z" },
        "2026-07-05T00:00:00.000Z",
      ),
    );

    const excluded = await listExcludedMarketTrades(pool);
    expect(excluded).toHaveLength(2);
    expect(
      excluded
        .map((row) => ({ orderId: row.orderId, exclusionReason: row.exclusionReason }))
        .sort((a, b) => a.orderId.localeCompare(b.orderId)),
    ).toEqual([
      { orderId: "ord_1", exclusionReason: "cancelled" },
      { orderId: "ord_2", exclusionReason: "fraud-flagged" },
    ]);

    const fraudOnly = await listExcludedMarketTrades(pool, { exclusionReason: "fraud-flagged" });
    expect(fraudOnly).toHaveLength(1);
    expect(fraudOnly[0]?.orderId).toBe("ord_2");
  });

  it("projects linkage flags as pair-scoped retroactive exclusions and excludes new prints while the flag stands", async () => {
    const pool = pools.pricing;
    const clusterHash = "a".repeat(64);
    await seedTrade(pool, {
      orderId: "ord_linked",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_b",
    });
    await seedTrade(pool, {
      orderId: "ord_one_sided",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_unrelated",
    });
    await markTradeSold(pool, "ord_linked");
    await markTradeSold(pool, "ord_one_sided");

    const linkageHandlers = buildPricingMarketTradesSettlementIntegrityProjectionHandlers(pool);
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        { clusterHash, signalKind: "shared-instrument", accountIds: ["acc_a", "acc_b"] },
        "2026-07-06T00:00:00.000Z",
      ),
    );

    await seedTrade(pool, {
      orderId: "ord_new_linked",
      lineId: "line_1",
      buyerAccountId: "acc_b",
      sellerAccountId: "acc_a",
    });

    const rows = await pool.query<{ order_id: string; excluded: boolean; exclusion_reason: string | null }>(
      `SELECT order_id, excluded, exclusion_reason
       FROM pricing_market_trades
       ORDER BY order_id`,
    );
    expect(rows.rows).toEqual([
      { order_id: "ord_linked", excluded: true, exclusion_reason: "self-dealing" },
      { order_id: "ord_new_linked", excluded: true, exclusion_reason: "self-dealing" },
      { order_id: "ord_one_sided", excluded: false, exclusion_reason: null },
    ]);

    const queued = await pool.query<{ day: string }>(
      `SELECT day::text FROM pricing_market_trade_rollup_rederive_queue ORDER BY day`,
    );
    expect(queued.rows).toEqual([{ day: "2026-07-02" }]);

    const auditRows = await listExcludedMarketTrades(pool, { exclusionReason: "self-dealing" });
    expect(auditRows.map((row) => row.orderId).sort()).toEqual(["ord_linked", "ord_new_linked"]);
  });

  it("replaces revised linkage sets and clears only after every overlapping active flag is gone", async () => {
    const pool = pools.pricing;
    const firstClusterHash = "b".repeat(64);
    const overlappingClusterHash = "c".repeat(64);
    await seedTrade(pool, {
      orderId: "ord_ab",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_b",
    });
    await seedTrade(pool, {
      orderId: "ord_ac",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_c",
    });

    const linkageHandlers = buildPricingMarketTradesSettlementIntegrityProjectionHandlers(pool);
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        { clusterHash: firstClusterHash, signalKind: "shared-address", accountIds: ["acc_a", "acc_b"] },
        "2026-07-06T00:00:00.000Z",
      ),
    );
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        { clusterHash: overlappingClusterHash, signalKind: "shared-address", accountIds: ["acc_a", "acc_b"] },
        "2026-07-06T01:00:00.000Z",
      ),
    );

    // Re-flagging replaces the first cluster's set. The overlapping cluster
    // keeps A/B excluded while the replacement newly excludes A/C.
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        { clusterHash: firstClusterHash, signalKind: "shared-address", accountIds: ["acc_a", "acc_c"] },
        "2026-07-07T00:00:00.000Z",
      ),
    );
    await linkageHandlers["settlement.account-linkage.cleared"]!(
      event(
        "settlement.account-linkage.cleared",
        { clusterHash: overlappingClusterHash, signalKind: "shared-address", accountIds: ["acc_a", "acc_b"] },
        "2026-07-08T00:00:00.000Z",
      ),
    );

    let rows = await pool.query<{ order_id: string; excluded: boolean }>(
      `SELECT order_id, excluded FROM pricing_market_trades ORDER BY order_id`,
    );
    expect(rows.rows).toEqual([
      { order_id: "ord_ab", excluded: false },
      { order_id: "ord_ac", excluded: true },
    ]);

    await linkageHandlers["settlement.account-linkage.cleared"]!(
      event(
        "settlement.account-linkage.cleared",
        { clusterHash: firstClusterHash, signalKind: "shared-address", accountIds: ["acc_a", "acc_c"] },
        "2026-07-09T00:00:00.000Z",
      ),
    );
    rows = await pool.query<{ order_id: string; excluded: boolean }>(
      `SELECT order_id, excluded FROM pricing_market_trades ORDER BY order_id`,
    );
    expect(rows.rows).toEqual([
      { order_id: "ord_ab", excluded: false },
      { order_id: "ord_ac", excluded: false },
    ]);
  });

  it("lets terminal reasons replace self-dealing and never resurrects them on clear", async () => {
    const pool = pools.pricing;
    const clusterHash = "d".repeat(64);
    const tradeHandlers = buildPricingMarketTradesProjectionHandlers(pool);
    const linkageHandlers = buildPricingMarketTradesSettlementIntegrityProjectionHandlers(pool);
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        { clusterHash, signalKind: "shared-instrument", accountIds: ["acc_a", "acc_b"] },
        "2026-07-06T00:00:00.000Z",
      ),
    );
    await seedTrade(pool, {
      orderId: "ord_cancelled",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_b",
    });
    await seedTrade(pool, {
      orderId: "ord_refunded",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_b",
    });
    await seedTrade(pool, {
      orderId: "ord_fraud",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_b",
    });

    await tradeHandlers["ordering.order.cancelled"]!(
      event(
        "ordering.order.cancelled",
        { orderId: "ord_cancelled", cancelledAt: "2026-07-07T00:00:00.000Z" },
        "2026-07-07T00:00:00.000Z",
      ),
    );
    await tradeHandlers["fulfillment.shipment.created"]!(
      event(
        "fulfillment.shipment.created",
        {
          shipmentId: "ship_refund",
          orderId: "ord_refunded",
          lines: [{ orderLineId: "line_1" }],
          createdAt: "2026-07-07T00:00:00.000Z",
        },
        "2026-07-07T00:00:00.000Z",
      ),
    );
    await tradeHandlers["fulfillment.shipment.returned"]!(
      event(
        "fulfillment.shipment.returned",
        { shipmentId: "ship_refund", returnedAt: "2026-07-08T00:00:00.000Z" },
        "2026-07-08T00:00:00.000Z",
      ),
    );
    const paymentsHandlers = buildPricingMarketTradesPaymentsIntegrityProjectionHandlers(pool);
    await paymentsHandlers["payments.payment-fraud-warning-received"]!(
      event(
        "payments.payment-fraud-warning-received",
        { orderIds: ["ord_fraud"], receivedAt: "2026-07-08T00:00:00.000Z" },
        "2026-07-08T00:00:00.000Z",
      ),
    );

    await linkageHandlers["settlement.account-linkage.cleared"]!(
      event(
        "settlement.account-linkage.cleared",
        { clusterHash, signalKind: "shared-instrument", accountIds: ["acc_a", "acc_b"] },
        "2026-07-09T00:00:00.000Z",
      ),
    );

    const rows = await pool.query<{ order_id: string; excluded: boolean; exclusion_reason: string }>(
      `SELECT order_id, excluded, exclusion_reason FROM pricing_market_trades ORDER BY order_id`,
    );
    expect(rows.rows).toEqual([
      { order_id: "ord_cancelled", excluded: true, exclusion_reason: "cancelled" },
      { order_id: "ord_fraud", excluded: true, exclusion_reason: "fraud-flagged" },
      { order_id: "ord_refunded", excluded: true, exclusion_reason: "refunded" },
    ]);
  });
});
