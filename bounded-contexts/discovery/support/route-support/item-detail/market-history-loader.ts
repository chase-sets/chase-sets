import type { LoaderFunctionArgs } from "react-router";
import { createPricingRequestApiClient } from "@chase-sets/pricing/server";
import {
  DEFAULT_MARKET_HISTORY_MINIMUM_SAMPLE,
  DEFAULT_SHOW_VERIFIED_MARKERS,
  isMarketHistoryRangeKey,
  resolveMarketHistoryRangeWindow,
  type MarketHistoryResponse,
} from "../../../features/item-detail/domain/item-detail-market-history";

/**
 * Cross-context read (see docs/architecture/cross-context-request-path-read-inventory.md
 * and scripts/check-structure/cross-context-read-baseline.json): pricing
 * owns the market-rollups query API; this loader reads it request-path
 * rather than projecting a Discovery-owned mirror of pricing's whole
 * time-series rollup store (the market-analytics epic's design pillar #1 --
 * pricing is the market-data authority; discovery displays via published
 * read contracts).
 *
 * `catalogItemId` (the `:id` route param here) is expected to be the
 * canonical catalog item id, not a display slug: the market panel only ever
 * calls this route client-side after the main item-detail page has already
 * resolved `data.catalog_item_id` from the primary `/items/:id` read, so no
 * second slug-redirect lookup is needed here.
 *
 * This is the single seam that reshapes pricing's response into Discovery's
 * local `MarketHistoryResponse` shape (item-detail/domain/item-detail-market-history.ts):
 * only route-support/request-support files may import `@chase-sets/pricing/server`
 * (see docs/architecture/bounded-context-structure.md), so the domain/ui
 * layers that render this data never import pricing directly.
 */
export async function loader({ request, params }: LoaderFunctionArgs): Promise<Response> {
  const catalogItemId = params.id;
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId")?.trim();
  const requestedRange = url.searchParams.get("range");
  const range = isMarketHistoryRangeKey(requestedRange) ? requestedRange : "90d";

  if (!catalogItemId || !productId) {
    return Response.json({ error: { code: "invalid_request", message: "productId is required." } }, { status: 400 });
  }

  const api = createPricingRequestApiClient(request);
  const window = resolveMarketHistoryRangeWindow(range);

  const statsResponse = await api.getProductMarketStatsSnapshot({ catalogItemId, productId });
  const series = await Promise.all(
    statsResponse.aggregates.map(async ({ currencyCode }) => {
      const response = await api.getProductRollupSeries({
        catalogItemId,
        productId,
        currencyCode,
        from: window.from,
        to: window.to,
        granularity: window.granularity,
      });
      return { currencyCode, points: response.items };
    }),
  );

  const data: MarketHistoryResponse = {
    range,
    minimumSample: statsResponse.statHygiene?.minimumTradeSample ?? DEFAULT_MARKET_HISTORY_MINIMUM_SAMPLE,
    showVerifiedMarkers: statsResponse.displayPolicy?.showVerifiedMarkers ?? DEFAULT_SHOW_VERIFIED_MARKERS,
    series,
    stats: {
      aggregates: statsResponse.aggregates.map((aggregate) => ({
        currencyCode: aggregate.currencyCode,
        lastSoldAt: aggregate.lastSoldAt,
        lastSoldPriceAmount: aggregate.lastSoldPriceAmount,
        medianPrice30d: aggregate.medianPrice30d,
        volume30d: aggregate.volume30d,
        tradeCount30d: aggregate.tradeCount30d,
        medianPrice90d: aggregate.medianPrice90d,
        volume90d: aggregate.volume90d,
        tradeCount90d: aggregate.tradeCount90d,
      })),
      marketState: statsResponse.marketState
        ? {
            minAskAmount: statsResponse.marketState.minAskAmount,
            maxBidAmount: statsResponse.marketState.maxBidAmount,
            spreadAmount: statsResponse.marketState.spreadAmount,
          }
        : null,
    },
  };

  return Response.json(data, {
    headers: { "Cache-Control": "private, max-age=30" },
  });
}
