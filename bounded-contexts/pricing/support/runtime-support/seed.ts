import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { marketPriceEstimatedEventType } from "../../features/market-estimates/domain/domain";
import { buildPricingMarketEstimateProjectionHandlers } from "../../features/market-estimates/read-model/projection";
import { loadBuyerOfferMarketPrices } from "../../features/offer-targets/read-model/queries";

const syntheticTradeOrderIds = (eventId: string) =>
  Array.from({ length: 4 }, (_, index) => `ord_synthetic_offer_${eventId}_${index}`);

export async function seedPricingDatabase(_pool: PgTransactionalPool) {
  return;
}

/** Explicit browser-test fixture only; the normal Pricing seed never fabricates estimates. */
export async function seedSyntheticOfferMarketPrice(
  pool: PgTransactionalPool,
  fixture: {
    catalogItemId: string;
    productId: string;
    estimateVersion: string;
    amount: string;
    previousEstimateVersion?: string;
  },
) {
  const streamId = "pricing.market-price-synthetic-e2e-offer-controls";
  const eventStore = createPostgresEventStore({ pool });
  const now = new Date();
  const data = {
    schemaVersion: 1,
    catalogItemId: fixture.catalogItemId,
    productId: fixture.productId,
    estimateVersion: fixture.estimateVersion,
    amount: fixture.amount,
    currencyCode: "USD",
    band: null,
    confidence: "low",
    window: { startedAt: new Date(now.getTime() - 3600000).toISOString(), endedAt: now.toISOString() },
    estimatedAt: now.toISOString(),
    freshUntil: new Date(now.getTime() + 3600000).toISOString(),
    disclosure: "internal",
    previousAmount: null as string | null,
    inputs: { platformVerifiedTradeCount: 0, platformTradeCount: 4, externalCompCount: 0 },
    syntheticFixture: "8346-browser-only",
  };
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic_e2e" as never,
    audit: { forAccountId: "acc_synthetic_e2e" as never, performedByUserId: "usr_synthetic_e2e" as never },
  };
  const existing = await pool.query<{ estimate_version: string }>(
    "SELECT estimate_version::text FROM pricing_market_price_estimates WHERE catalog_catalog_item_id=$1 AND product_id=$2",
    [fixture.catalogItemId, fixture.productId],
  );
  const history = await readCompleteStream(eventStore, { streamId, maxEvents: 100 });
  const previous = history.at(-1);
  if (fixture.previousEstimateVersion) {
    if (
      existing.rows[0]?.estimate_version !== fixture.previousEstimateVersion ||
      previous?.payload.syntheticFixture !== data.syntheticFixture ||
      previous.payload.catalogItemId !== fixture.catalogItemId ||
      previous.payload.productId !== fixture.productId ||
      previous.payload.estimateVersion !== fixture.previousEstimateVersion ||
      BigInt(fixture.estimateVersion) <= BigInt(fixture.previousEstimateVersion)
    )
      throw new Error("Synthetic update requires the exact previous owned estimate.");
    data.previousAmount = String(previous.payload.amount);
  } else if (existing.rows.length || history.length) {
    throw new Error("Synthetic fixture refuses to replace an existing estimate.");
  }
  const [stored] = await eventStore.appendToStream({
    streamId,
    expectedVersion: previous?.streamVersion ?? 0,
    context,
    events: [{ eventType: marketPriceEstimatedEventType, payload: data }],
  });
  const tradeOrderIds = syntheticTradeOrderIds(stored!.eventId);
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    await pool.query(
      "DELETE FROM event_store_streams WHERE stream_id=$1 AND EXISTS (SELECT 1 FROM event_store_events WHERE stream_id=$1 AND event_id=$2)",
      [streamId, stored!.eventId],
    );
    await pool.query(
      "DELETE FROM pricing_market_price_estimates WHERE catalog_catalog_item_id=$1 AND product_id=$2 AND estimate_version=$3 AND estimated_at=$4",
      [fixture.catalogItemId, fixture.productId, fixture.estimateVersion, data.estimatedAt],
    );
    await pool.query("DELETE FROM pricing_market_trades WHERE order_id = ANY($1::text[])", [tradeOrderIds]);
    const remaining = await pool.query(
      "SELECT 1 FROM pricing_market_price_estimates WHERE catalog_catalog_item_id=$1 AND product_id=$2 AND estimate_version=$3 UNION ALL SELECT 1 FROM event_store_events WHERE stream_id=$4 UNION ALL SELECT 1 FROM pricing_market_trades WHERE order_id = ANY($5::text[])",
      [fixture.catalogItemId, fixture.productId, fixture.estimateVersion, streamId, tradeOrderIds],
    );
    if (remaining.rows.length) throw new Error("Synthetic Market Price teardown left estimate evidence behind.");
    cleaned = true;
  };
  try {
    // The real closer expires unsupported estimates. Supply independent synthetic
    // participants before publishing, rather than bypassing that freshness rule.
    await pool.query(
      `INSERT INTO pricing_market_trades (
         order_id, line_id, seller_account_id, buyer_account_id, catalog_catalog_item_id,
         product_id, unit_price_amount, currency_code, quantity, sale_channel, sold_at, updated_at
       ) SELECT order_id, 'line_1', 'seller_' || order_id, 'buyer_' || order_id,
                $2, $3, $4::numeric, 'USD', 1, 'offer-accepted', $5::timestamptz, $5::timestamptz
           FROM unnest($1::text[]) AS orders(order_id)`,
      [tradeOrderIds, fixture.catalogItemId, fixture.productId, fixture.amount, data.estimatedAt],
    );
    // Prepare only this persisted fixture event, not the worker's stream or checkpoints.
    await buildPricingMarketEstimateProjectionHandlers(pool)[marketPriceEstimatedEventType]!(toTransportEvent(stored!));
    const [price] = await loadBuyerOfferMarketPrices(pool, [fixture]);
    if (
      !price ||
      price.catalogItemId !== fixture.catalogItemId ||
      price.productId !== fixture.productId ||
      price.estimateVersion !== fixture.estimateVersion ||
      price.amount !== fixture.amount ||
      price.currencyCode !== data.currencyCode ||
      price.estimatedAt !== data.estimatedAt ||
      price.freshUntil !== data.freshUntil ||
      Date.parse(price.freshUntil) <= Date.now()
    ) {
      throw new Error("Synthetic Market Price preparation did not produce the exact fresh estimate.");
    }
    if (previous) {
      await pool.query("DELETE FROM pricing_market_trades WHERE order_id = ANY($1::text[])", [
        syntheticTradeOrderIds(previous.eventId),
      ]);
    }
    return cleanup;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Synthetic Market Price preparation and cleanup failed.");
    }
    throw error;
  }
}
