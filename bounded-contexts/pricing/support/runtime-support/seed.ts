import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

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
  await eventStore.appendToStream({
    streamId,
    expectedVersion: 0,
    context,
    events: [{ eventType: "pricing.market-price.estimated", payload: data }],
  });
  return async () => {
    await pool.query("DELETE FROM event_store_streams WHERE stream_id=$1", [streamId]);
    await pool.query(
      "DELETE FROM pricing_market_price_estimates WHERE catalog_catalog_item_id=$1 AND product_id=$2 AND estimate_version=$3",
      [fixture.catalogItemId, fixture.productId, fixture.estimateVersion],
    );
    const remaining = await pool.query(
      "SELECT 1 FROM pricing_market_price_estimates WHERE catalog_catalog_item_id=$1 AND product_id=$2 AND estimate_version=$3 UNION ALL SELECT 1 FROM event_store_events WHERE stream_id=$4",
      [fixture.catalogItemId, fixture.productId, fixture.estimateVersion, streamId],
    );
    if (remaining.rows.length) throw new Error("Synthetic Market Price teardown left estimate evidence behind.");
  };
}
