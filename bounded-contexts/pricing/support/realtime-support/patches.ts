import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import type { ProductMarketStatsSnapshot } from "../../features/market-rollups/read-model/queries";
import { pricingRealtimeTopics } from "./topics";

const PRICING_MARKET_ROLLUPS_PROJECTION = "pricing-market-rollups-closer";

/**
 * A rollup/aggregate-advance patch: emitted by the market-rollups closer job
 * whenever a product's trailing-window trade activity changes its
 * Product Market Aggregate / Market-State Snapshot. `id` composes
 * catalogItemId+productId (the query API's natural key) since a single
 * `item:{catalogItemId}` topic carries stats for every product/condition
 * sold under that catalog item.
 */
export function createPricingProductMarketStatsPatch(
  catalogItemId: string,
  productId: string,
  stats: ProductMarketStatsSnapshot,
): RealtimeProjectionPatch {
  return {
    kind: "projection.patch",
    context: "pricing",
    projection: PRICING_MARKET_ROLLUPS_PROJECTION,
    topics: [pricingRealtimeTopics.item(catalogItemId)],
    changes: [
      {
        op: "summary",
        entity: "pricing.productMarketStats",
        id: `${catalogItemId}:${productId}`,
        value: stats,
      },
    ],
  };
}
