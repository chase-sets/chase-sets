import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { buildPricingMarketTradesProjectionHandlers } from "../../market-trades/integrations/source/source-projection";
import { buildPricingMarketTradesSettlementIntegrityProjectionHandlers } from "../../market-trades/integrations/integrity/integrity-projection";
import { buildPricingPriceSignalCatalogProjectionHandlers } from "../../price-signals/integrations/catalog/projection";
import { createPriceSignalRuntime } from "../../price-signals/api/runtime";
import { createMarketEstimatesRuntime, marketPriceEstimateStreamId } from "../api/runtime";
import { buildPricingMarketEstimateProjectionHandlers } from "../read-model/projection";
import { expireMarketPriceEstimate, getMarketPriceEstimateUpdatedAt } from "../read-model/queries";
import { marketPriceEstimatedEventType } from "../domain/domain";
import { MARKET_ESTIMATE_LAUNCH_POLICY_VALUE, type MarketEstimatePolicyValue } from "../domain/estimate-policy";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

const NOW = "2026-07-16T12:00:00.000Z";
// A product with no selected options: marketplace/ordering product ids and
// pricing's derived catalog product keys share the `${catalogItemId}::...` space.
const CATALOG_ITEM_ID = "cat_est_1";
const PRODUCT_ID = `${CATALOG_ITEM_ID}::`;

let nextEventStreamVersion = 0;
function event(type: string, data: Record<string, unknown>, recordedAt: string, streamId?: string) {
  nextEventStreamVersion += 1;
  return {
    type,
    streamId: streamId ?? `stream_${type}`,
    streamVersion: nextEventStreamVersion,
    data,
    timing: { recordedAt },
  } as never;
}

function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A one-value PolicyRuntime: exactly the `resolvePolicy` surface the closer consumes, without console machinery. */
function stubPolicies(value: MarketEstimatePolicyValue): PolicyRuntime {
  return { resolvePolicy: async () => ({ value }) } as unknown as PolicyRuntime;
}

describeDb("pricing market-estimates blended estimate publication (#4315)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "pricing_market_estimates");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function createRuntime(pool: PgTransactionalPool) {
    const eventStore = createPostgresEventStore({ pool });
    const policies = createPolicyRuntime({ eventStore, db: pool });
    return {
      eventStore,
      runtime: createMarketEstimatesRuntime({ eventStore, db: pool, policies }),
    };
  }

  /** Seeds one platform trade (order created + payment captured) for the shared test product. */
  async function seedTrade(
    pool: PgTransactionalPool,
    input: Readonly<{
      orderId: string;
      priceAmount: string;
      soldAt: string;
      productId?: string;
      buyerAccountId?: string;
      sellerAccountId?: string;
    }>,
  ) {
    const handlers = buildPricingMarketTradesProjectionHandlers(pool);
    await handlers["ordering.order.created"]!(
      event(
        "ordering.order.created",
        {
          orderId: input.orderId,
          sourceType: "cart-checkout",
          buyerAccountId: input.buyerAccountId ?? `buyer_${input.orderId}`,
          sellerAccountId: input.sellerAccountId ?? "seller_1",
          lines: [
            {
              lineId: "line_1",
              catalogItemId: CATALOG_ITEM_ID,
              productId: input.productId ?? PRODUCT_ID,
              unitPriceAmount: input.priceAmount,
              quantity: 1,
            },
          ],
        },
        daysBefore(input.soldAt, 0.01),
      ),
    );
    await handlers["ordering.order.ready-for-fulfillment-recorded"]!(
      event(
        "ordering.order.ready-for-fulfillment-recorded",
        { orderId: input.orderId, readyForFulfillmentAt: input.soldAt },
        input.soldAt,
      ),
    );
  }

  /**
   * Links a TCGplayer SKU reference and records one price signal as the
   * external comp. Current by default; `calculatedAt: null` records a
   * status-'stale' signal, and an old `observedAt` (beyond the default 24h
   * stale window) records a signal whose `stale_after` has already elapsed.
   */
  async function seedExternalComp(
    pool: PgTransactionalPool,
    input: Readonly<{ skuId: number; marketPrice: number; observedAt: string; calculatedAt?: string | null }>,
  ) {
    const catalogHandlers = buildPricingPriceSignalCatalogProjectionHandlers(pool);
    await catalogHandlers["catalog.catalog-item.external-product-reference-linked"]!(
      event(
        "catalog.catalog-item.external-product-reference-linked",
        { providerKey: "tcgplayer", externalKey: `sku:${input.skuId}`, selectedOptions: [] },
        input.observedAt,
        `catalog.item-${CATALOG_ITEM_ID}`,
      ),
    );
    const priceSignals = createPriceSignalRuntime({ db: pool });
    const recorded = await priceSignals.recordTcgplayerPriceSignal({
      skuId: input.skuId,
      observedAt: input.observedAt,
      pricePoint: {
        skuId: input.skuId,
        marketPrice: input.marketPrice,
        calculatedAt: input.calculatedAt === undefined ? input.observedAt : input.calculatedAt,
      },
    });
    expect(recorded.status).toBe("recorded");
  }

  it("publishes MarketPriceEstimated from blended platform trades + external comps and projects the read model", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, { orderId: "ord_1", priceAmount: "10.00", soldAt: daysBefore(NOW, 3) });
    await seedTrade(pool, { orderId: "ord_2", priceAmount: "12.00", soldAt: daysBefore(NOW, 2) });
    await seedTrade(pool, { orderId: "ord_3", priceAmount: "14.00", soldAt: daysBefore(NOW, 1) });
    // Half a day old: comfortably inside the signal's own 24h stale window.
    await seedExternalComp(pool, { skuId: 123, marketPrice: 13.5, observedAt: daysBefore(NOW, 0.5) });

    const { eventStore, runtime } = createRuntime(pool);
    const result = await runtime.runMarketPriceEstimateCloser({ now: NOW });

    expect(result.candidatesConsidered).toBe(1);
    expect(result.estimatesPublished).toBe(1);
    expect(result.belowGate).toBe(0);

    const stored = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.eventType).toBe(marketPriceEstimatedEventType);
    const payload = stored[0]!.payload as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.catalogItemId).toBe(CATALOG_ITEM_ID);
    expect(payload.productId).toBe(PRODUCT_ID);
    expect(payload.estimateVersion).toBe("1");
    expect(payload.currencyCode).toBe("usd");
    expect(payload.disclosure).toBe("account");
    expect(payload.previousAmount).toBeNull();
    expect(payload.inputs).toEqual({
      platformVerifiedTradeCount: 0,
      platformTradeCount: 3,
      externalCompCount: 1,
    });
    const amount = Number(payload.amount);
    const band = payload.band as { lowAmount: string; highAmount: string };
    expect(amount).toBeGreaterThanOrEqual(10);
    expect(amount).toBeLessThanOrEqual(14);
    expect(Number(band.lowAmount)).toBeLessThanOrEqual(amount);
    expect(Number(band.highAmount)).toBeGreaterThanOrEqual(amount);

    // Project the published fact into the current-estimate read model.
    const projectionHandlers = buildPricingMarketEstimateProjectionHandlers(pool);
    await projectionHandlers[marketPriceEstimatedEventType]!(
      event(marketPriceEstimatedEventType, payload, stored[0]!.recordedAt, stored[0]!.streamId),
    );
    const estimate = await runtime.getMarketPriceEstimate({ catalogItemId: CATALOG_ITEM_ID, productId: PRODUCT_ID });
    expect(estimate).not.toBeNull();
    expect(estimate!.amount).toBe(payload.amount);
    expect(estimate!.confidence).toBe(payload.confidence);
    expect(estimate!.freshUntil).toBe(payload.freshUntil);
    expect(estimate!.inputCounts.externalCompCount).toBe(1);
  });

  it("recompute is idempotent: an unchanged same-day closer pass appends nothing", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, { orderId: "ord_1", priceAmount: "10.00", soldAt: daysBefore(NOW, 3) });
    await seedTrade(pool, { orderId: "ord_2", priceAmount: "12.00", soldAt: daysBefore(NOW, 2) });
    await seedTrade(pool, { orderId: "ord_3", priceAmount: "14.00", soldAt: daysBefore(NOW, 1) });

    const { eventStore, runtime } = createRuntime(pool);
    const first = await runtime.runMarketPriceEstimateCloser({ now: NOW });
    expect(first.estimatesPublished).toBe(1);

    // Same inputs, later the same UTC day: the decider no-ops.
    const second = await runtime.runMarketPriceEstimateCloser({
      now: "2026-07-16T18:00:00.000Z",
    });
    expect(second.estimatesPublished).toBe(0);
    expect(second.unchanged).toBe(1);

    const stored = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    expect(stored).toHaveLength(1);
  });

  it("republishes on a later day (daily refresh) carrying previousAmount for downstream delta filtering", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, { orderId: "ord_1", priceAmount: "10.00", soldAt: daysBefore(NOW, 3) });
    await seedTrade(pool, { orderId: "ord_2", priceAmount: "12.00", soldAt: daysBefore(NOW, 2) });
    await seedTrade(pool, { orderId: "ord_3", priceAmount: "14.00", soldAt: daysBefore(NOW, 1) });

    const { eventStore, runtime } = createRuntime(pool);
    await runtime.runMarketPriceEstimateCloser({ now: NOW });
    const nextDay = await runtime.runMarketPriceEstimateCloser({ now: "2026-07-17T12:00:00.000Z" });
    expect(nextDay.estimatesPublished).toBe(1);

    const stored = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    expect(stored).toHaveLength(2);
    const payload = stored[1]!.payload as Record<string, unknown>;
    expect(payload.estimateVersion).toBe("2");
    expect(payload.previousAmount).toBe(stored[0]!.payload.amount);
  });

  it("below the minimum-input gate NO estimate is ever published", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, { orderId: "ord_1", priceAmount: "10.00", soldAt: daysBefore(NOW, 2) });
    await seedTrade(pool, { orderId: "ord_2", priceAmount: "12.00", soldAt: daysBefore(NOW, 1) });

    const { eventStore, runtime } = createRuntime(pool);
    const result = await runtime.runMarketPriceEstimateCloser({ now: NOW });

    expect(result.candidatesConsidered).toBe(1);
    expect(result.estimatesPublished).toBe(0);
    expect(result.belowGate).toBe(1);

    const stored = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    expect(stored).toHaveLength(0);
  });

  it("expires a current estimate on the next pass when linkage removes its final usable inputs", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, { orderId: "ord_expire_1", priceAmount: "10.00", soldAt: daysBefore(NOW, 3) });
    await seedTrade(pool, { orderId: "ord_expire_2", priceAmount: "12.00", soldAt: daysBefore(NOW, 2) });
    await seedTrade(pool, { orderId: "ord_expire_3", priceAmount: "14.00", soldAt: daysBefore(NOW, 1) });

    const { eventStore, runtime } = createRuntime(pool);
    expect(await runtime.runMarketPriceEstimateCloser({ now: NOW })).toMatchObject({
      candidatesConsidered: 1,
      estimatesPublished: 1,
    });

    const publishedEvents = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    const published = publishedEvents[0]!;
    await buildPricingMarketEstimateProjectionHandlers(pool)[marketPriceEstimatedEventType]!(
      event(marketPriceEstimatedEventType, published.payload, published.recordedAt, published.streamId),
    );

    const nextPassAt = "2026-07-16T14:00:00.000Z";
    const beforeExclusion = await runtime.getMarketPriceEstimate({
      catalogItemId: CATALOG_ITEM_ID,
      productId: PRODUCT_ID,
    });
    expect(Date.parse(beforeExclusion!.freshUntil)).toBeGreaterThan(Date.parse(nextPassAt));

    const linkageHandlers = buildPricingMarketTradesSettlementIntegrityProjectionHandlers(pool);
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        {
          clusterHash: "a".repeat(64),
          signalKind: "shared-instrument",
          accountIds: ["buyer_ord_expire_1", "buyer_ord_expire_2", "buyer_ord_expire_3", "seller_1"],
        },
        "2026-07-16T13:00:00.000Z",
      ),
    );
    const excludedTrades = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM pricing_market_trades
       WHERE catalog_catalog_item_id = $1 AND product_id = $2 AND excluded = true`,
      [CATALOG_ITEM_ID, PRODUCT_ID],
    );
    expect(excludedTrades.rows).toEqual([{ count: 3 }]);

    const excludedPass = await runtime.runMarketPriceEstimateCloser({ now: nextPassAt });
    expect(excludedPass).toMatchObject({ candidatesConsidered: 1, estimatesPublished: 0, belowGate: 1 });

    const expired = await runtime.getMarketPriceEstimate({ catalogItemId: CATALOG_ITEM_ID, productId: PRODUCT_ID });
    expect(Date.parse(expired!.freshUntil)).toBeLessThan(Date.parse(nextPassAt));
    expect(await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) })).toHaveLength(1);
  });

  it("does not expire a newer projection when the closer read the previous revision", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, { orderId: "ord_race_1", priceAmount: "10.00", soldAt: daysBefore(NOW, 3) });
    await seedTrade(pool, { orderId: "ord_race_2", priceAmount: "12.00", soldAt: daysBefore(NOW, 2) });
    await seedTrade(pool, { orderId: "ord_race_3", priceAmount: "14.00", soldAt: daysBefore(NOW, 1) });

    const { eventStore, runtime } = createRuntime(pool);
    await runtime.runMarketPriceEstimateCloser({ now: NOW });
    const projectionHandlers = buildPricingMarketEstimateProjectionHandlers(pool);
    const [first] = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    await projectionHandlers[marketPriceEstimatedEventType]!(
      event(marketPriceEstimatedEventType, first!.payload, first!.recordedAt, first!.streamId),
    );
    const readUpdatedAt = await getMarketPriceEstimateUpdatedAt(pool, {
      catalogItemId: CATALOG_ITEM_ID,
      productId: PRODUCT_ID,
    });
    expect(readUpdatedAt).not.toBeNull();

    await runtime.runMarketPriceEstimateCloser({ now: "2026-07-17T14:01:00.000Z" });
    const [, newer] = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    await projectionHandlers[marketPriceEstimatedEventType]!(
      event(marketPriceEstimatedEventType, newer!.payload, newer!.recordedAt, newer!.streamId),
    );
    const newerFreshUntil = (newer!.payload as { freshUntil: string }).freshUntil;

    const expiredRows = await expireMarketPriceEstimate(
      pool,
      { catalogItemId: CATALOG_ITEM_ID, productId: PRODUCT_ID },
      "2026-07-17T13:59:59.999Z",
      readUpdatedAt!,
    );

    expect(expiredRows).toBe(0);
    const current = await runtime.getMarketPriceEstimate({ catalogItemId: CATALOG_ITEM_ID, productId: PRODUCT_ID });
    expect(current!.freshUntil).toBe(newerFreshUntil);
  });

  it("loads participant identity from the Trades Tape and rejects three prints from one buyer", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_participant_1",
      priceAmount: "10.00",
      soldAt: daysBefore(NOW, 3),
      buyerAccountId: "buyer_repeat",
      sellerAccountId: "seller_1",
    });
    await seedTrade(pool, {
      orderId: "ord_participant_2",
      priceAmount: "11.00",
      soldAt: daysBefore(NOW, 2),
      buyerAccountId: "buyer_repeat",
      sellerAccountId: "seller_2",
    });
    await seedTrade(pool, {
      orderId: "ord_participant_3",
      priceAmount: "12.00",
      soldAt: daysBefore(NOW, 1),
      buyerAccountId: "buyer_repeat",
      sellerAccountId: "seller_3",
    });

    const { eventStore, runtime } = createRuntime(pool);
    const result = await runtime.runMarketPriceEstimateCloser({ now: NOW });

    expect(result.belowGate).toBe(1);
    expect(result.estimatesPublished).toBe(0);
    expect(await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) })).toHaveLength(0);
  });

  it("removes linked counterparties before pair deduplication, participant counting, and weight capping", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_linked_participant",
      priceAmount: "999.00",
      soldAt: daysBefore(NOW, 1),
      buyerAccountId: "acc_linked_buyer",
      sellerAccountId: "acc_linked_seller",
    });
    await seedTrade(pool, { orderId: "ord_honest_1", priceAmount: "10.00", soldAt: daysBefore(NOW, 3) });
    await seedTrade(pool, { orderId: "ord_honest_2", priceAmount: "11.00", soldAt: daysBefore(NOW, 2) });
    await seedTrade(pool, { orderId: "ord_honest_3", priceAmount: "12.00", soldAt: daysBefore(NOW, 1) });

    const clusterHash = "f".repeat(64);
    const linkageHandlers = buildPricingMarketTradesSettlementIntegrityProjectionHandlers(pool);
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        {
          clusterHash,
          signalKind: "shared-instrument",
          accountIds: ["acc_linked_buyer", "acc_linked_seller"],
        },
        daysBefore(NOW, 0.5),
      ),
    );

    const { eventStore, runtime } = createRuntime(pool);
    const result = await runtime.runMarketPriceEstimateCloser({ now: NOW });

    expect(result.estimatesPublished).toBe(1);
    const stored = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    const payload = stored[0]!.payload as Record<string, unknown>;
    expect(payload.amount).toBe("10.45");
    expect(payload.inputs).toEqual({
      platformVerifiedTradeCount: 0,
      platformTradeCount: 3,
      externalCompCount: 0,
    });
  });

  it("deduplicates a buyer-to-seller pair to its latest print before publication", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_pair_old",
      priceAmount: "100.00",
      soldAt: daysBefore(NOW, 2),
      buyerAccountId: "buyer_pair",
      sellerAccountId: "seller_pair",
    });
    await seedTrade(pool, {
      orderId: "ord_pair_latest",
      priceAmount: "10.00",
      soldAt: daysBefore(NOW, 1),
      buyerAccountId: "buyer_pair",
      sellerAccountId: "seller_pair",
    });
    await seedTrade(pool, { orderId: "ord_pair_honest_1", priceAmount: "10.00", soldAt: daysBefore(NOW, 1) });
    await seedTrade(pool, { orderId: "ord_pair_honest_2", priceAmount: "10.00", soldAt: daysBefore(NOW, 1) });

    const { eventStore, runtime } = createRuntime(pool);
    const result = await runtime.runMarketPriceEstimateCloser({ now: NOW });

    expect(result.estimatesPublished).toBe(1);
    const stored = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    const payload = stored[0]!.payload as Record<string, unknown>;
    expect(payload.amount).toBe("10.00");
    expect(payload.inputs).toEqual({
      platformVerifiedTradeCount: 0,
      platformTradeCount: 3,
      externalCompCount: 0,
    });
  });

  it("caps a wash buyer across distinct sellers against the post-cap blend total", async () => {
    const pool = pools.pricing;
    for (let seller = 1; seller <= 10; seller += 1) {
      await seedTrade(pool, {
        orderId: `ord_wash_${seller}`,
        priceAmount: "100.00",
        soldAt: NOW,
        buyerAccountId: "buyer_wash",
        sellerAccountId: `seller_wash_${seller}`,
      });
    }
    await seedTrade(pool, {
      orderId: "ord_wash_honest_1",
      priceAmount: "10.00",
      soldAt: NOW,
      buyerAccountId: "buyer_honest_1",
      sellerAccountId: "seller_honest_1",
    });
    await seedTrade(pool, {
      orderId: "ord_wash_honest_2",
      priceAmount: "10.00",
      soldAt: NOW,
      buyerAccountId: "buyer_honest_2",
      sellerAccountId: "seller_honest_2",
    });

    const { eventStore, runtime } = createRuntime(pool);
    const result = await runtime.runMarketPriceEstimateCloser({ now: NOW });

    expect(result.estimatesPublished).toBe(1);
    const stored = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    const payload = stored[0]!.payload as Record<string, unknown>;
    expect(payload.amount).toBe("10.00");
    expect(payload.amount).not.toBe("100.00");
    expect(payload.inputs).toEqual({
      platformVerifiedTradeCount: 0,
      platformTradeCount: 12,
      externalCompCount: 0,
    });
  });

  it("stale signals count toward NOTHING: three stale signals never clear the gate or publish", async () => {
    const pool = pools.pricing;
    // Two status-'stale' signals (recorded without a calculation time) plus
    // one recorded 'current' whose stale_after (observedAt + the 24h default
    // window) has since elapsed -- all three are dead per the signal store's
    // own lifecycle, so they are eligible inputs for neither the blend nor
    // the minimum-input gate.
    await seedExternalComp(pool, { skuId: 201, marketPrice: 10, observedAt: daysBefore(NOW, 5), calculatedAt: null });
    await seedExternalComp(pool, { skuId: 202, marketPrice: 11, observedAt: daysBefore(NOW, 4), calculatedAt: null });
    await seedExternalComp(pool, { skuId: 203, marketPrice: 12, observedAt: daysBefore(NOW, 2) });

    const { eventStore, runtime } = createRuntime(pool);
    const result = await runtime.runMarketPriceEstimateCloser({ now: NOW });

    expect(result.candidatesConsidered).toBe(0);
    expect(result.estimatesPublished).toBe(0);
    const stored = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    expect(stored).toHaveLength(0);
  });

  it("a newer stale observation silences its SKU: the older still-current signal never resurrects as a comp", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, { orderId: "ord_1", priceAmount: "10.00", soldAt: daysBefore(NOW, 3) });
    await seedTrade(pool, { orderId: "ord_2", priceAmount: "12.00", soldAt: daysBefore(NOW, 2) });
    await seedTrade(pool, { orderId: "ord_3", priceAmount: "14.00", soldAt: daysBefore(NOW, 1) });
    // Same SKU: first a current signal, then a NEWER stale observation --
    // the latest observation per reference always speaks for it.
    await seedExternalComp(pool, { skuId: 204, marketPrice: 13.5, observedAt: daysBefore(NOW, 0.5) });
    await seedExternalComp(pool, {
      skuId: 204,
      marketPrice: 13.5,
      observedAt: daysBefore(NOW, 0.2),
      calculatedAt: null,
    });

    const { eventStore, runtime } = createRuntime(pool);
    const result = await runtime.runMarketPriceEstimateCloser({ now: NOW });

    expect(result.estimatesPublished).toBe(1);
    const stored = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    const payload = stored[0]!.payload as Record<string, unknown>;
    expect(payload.inputs).toEqual({
      platformVerifiedTradeCount: 0,
      platformTradeCount: 3,
      externalCompCount: 0,
    });
  });

  it("covers every eligible product across successive closer passes (501 products vs the 500-per-pass default)", async () => {
    const pool = pools.pricing;
    // Bulk-seed 501 products x 3 fresh trades straight into the Trades Tape
    // read model -- the closer reads the tape, and event-by-event seeding of
    // 1503 trades proves nothing the other tests don't already.
    await pool.query(
      `INSERT INTO pricing_market_trades (
         order_id, line_id, seller_account_id, buyer_account_id,
         catalog_catalog_item_id, product_id, unit_price_amount, quantity,
         sale_channel, sold_at, updated_at
       )
       SELECT
         'ord_cov_' || item.i || '_' || line.j, 'line_1', 'seller_1', 'buyer_' || line.j,
         'cat_cov_' || lpad(item.i::text, 4, '0'),
         'cat_cov_' || lpad(item.i::text, 4, '0') || '::',
         10.00 + line.j, 1, 'listing',
         $1::timestamptz - (line.j || ' days')::interval, $1
       FROM generate_series(1, 501) AS item(i), generate_series(1, 3) AS line(j)`,
      [NOW],
    );

    const { eventStore, runtime } = createRuntime(pool);
    const first = await runtime.runMarketPriceEstimateCloser({ now: NOW });
    expect(first.candidatesConsidered).toBe(500);
    expect(first.estimatesPublished).toBe(500);

    // The second pass resumes AFTER the persisted cursor and reaches the
    // tail the old ORDER BY + LIMIT approach revisited-forever past.
    const second = await runtime.runMarketPriceEstimateCloser({ now: NOW });
    expect(second.candidatesConsidered).toBe(1);
    expect(second.estimatesPublished).toBe(1);
    const tail = await eventStore.readStream({ streamId: marketPriceEstimateStreamId("cat_cov_0501::") });
    expect(tail).toHaveLength(1);

    // Drained past the end: the cursor reset, so a third same-day pass
    // starts over from the beginning -- and dedupes every unchanged estimate.
    const third = await runtime.runMarketPriceEstimateCloser({ now: NOW });
    expect(third.candidatesConsidered).toBe(500);
    expect(third.estimatesPublished).toBe(0);
    expect(third.unchanged).toBe(500);
  });

  it("a same-day freshness-policy revision (48h -> 1h) republishes immediately, not at the next UTC day", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, { orderId: "ord_1", priceAmount: "10.00", soldAt: daysBefore(NOW, 3) });
    await seedTrade(pool, { orderId: "ord_2", priceAmount: "12.00", soldAt: daysBefore(NOW, 2) });
    await seedTrade(pool, { orderId: "ord_3", priceAmount: "14.00", soldAt: daysBefore(NOW, 1) });

    const eventStore = createPostgresEventStore({ pool });
    const launch = createMarketEstimatesRuntime({
      eventStore,
      db: pool,
      policies: stubPolicies(MARKET_ESTIMATE_LAUNCH_POLICY_VALUE),
    });
    const first = await launch.runMarketPriceEstimateCloser({ now: NOW });
    expect(first.estimatesPublished).toBe(1);

    // The console revises freshness 48h -> 1h two hours later the same day.
    const revised = createMarketEstimatesRuntime({
      eventStore,
      db: pool,
      policies: stubPolicies({ ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE, freshForHours: 1 }),
    });
    const second = await revised.runMarketPriceEstimateCloser({ now: "2026-07-16T14:00:00.000Z" });
    expect(second.estimatesPublished).toBe(1);

    const stored = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    expect(stored).toHaveLength(2);
    const payload = stored[1]!.payload as Record<string, unknown>;
    expect(payload.freshUntil).toBe("2026-07-16T15:00:00.000Z");
    expect(payload.previousAmount).toBe(stored[0]!.payload.amount);
  });

  it("excluded trades never comp: a cancelled order drops the product below the gate", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, { orderId: "ord_1", priceAmount: "10.00", soldAt: daysBefore(NOW, 3) });
    await seedTrade(pool, { orderId: "ord_2", priceAmount: "12.00", soldAt: daysBefore(NOW, 2) });
    await seedTrade(pool, { orderId: "ord_3", priceAmount: "99.00", soldAt: daysBefore(NOW, 1) });
    const handlers = buildPricingMarketTradesProjectionHandlers(pool);
    await handlers["ordering.order.cancelled"]!(
      event("ordering.order.cancelled", { orderId: "ord_3", cancelledAt: daysBefore(NOW, 0.5) }, daysBefore(NOW, 0.5)),
    );

    const { eventStore, runtime } = createRuntime(pool);
    const result = await runtime.runMarketPriceEstimateCloser({ now: NOW });

    expect(result.estimatesPublished).toBe(0);
    expect(result.belowGate).toBe(1);
    const stored = await eventStore.readStream({ streamId: marketPriceEstimateStreamId(PRODUCT_ID) });
    expect(stored).toHaveLength(0);
  });
});
