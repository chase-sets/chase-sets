import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { marketPriceEstimatedEventType } from "../../features/market-estimates/domain/domain";
import { buildPricingMarketEstimateProjectionHandlers } from "../../features/market-estimates/read-model/projection";
import { loadBuyerOfferMarketPrices } from "../../features/offer-targets/read-model/queries";

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
    previousAmount: null,
    inputs: { platformVerifiedTradeCount: 0, platformTradeCount: 0, externalCompCount: 0 },
    syntheticFixture: "8346-browser-only",
  };
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic_e2e" as never,
    audit: { forAccountId: "acc_synthetic_e2e" as never, performedByUserId: "usr_synthetic_e2e" as never },
  };
  const existing = await pool.query(
    "SELECT 1 FROM pricing_market_price_estimates WHERE catalog_catalog_item_id=$1 AND product_id=$2",
    [fixture.catalogItemId, fixture.productId],
  );
  if (existing.rows.length) throw new Error("Synthetic fixture refuses to replace an existing estimate.");
  const [stored] = await eventStore.appendToStream({
    streamId,
    expectedVersion: 0,
    context,
    events: [{ eventType: marketPriceEstimatedEventType, payload: data }],
  });
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
    const remaining = await pool.query(
      "SELECT 1 FROM pricing_market_price_estimates WHERE catalog_catalog_item_id=$1 AND product_id=$2 AND estimate_version=$3 UNION ALL SELECT 1 FROM event_store_events WHERE stream_id=$4",
      [fixture.catalogItemId, fixture.productId, fixture.estimateVersion, streamId],
    );
    if (remaining.rows.length) throw new Error("Synthetic Market Price teardown left estimate evidence behind.");
    cleaned = true;
  };
  try {
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
