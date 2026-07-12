import { useEffect, useState } from "react";
import { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import { useFetch } from "../../../support/client-support/use-fetch";
import { discoveryRealtimeRouteTopics } from "../../../support/realtime-support/topics";
import {
  DEFAULT_MARKET_HISTORY_MINIMUM_SAMPLE,
  isMarketHistoryRangeKey,
  type MarketHistoryResponse,
  type MarketHistoryRangeKey,
  type MarketHistorySeriesPoint,
  type MarketHistoryStats,
} from "../domain/item-detail-market-history";

async function fetchMarketHistory(
  catalogItemId: string,
  productId: string,
  range: MarketHistoryRangeKey,
): Promise<MarketHistoryResponse> {
  const url = `/items/${encodeURIComponent(catalogItemId)}/market-history?productId=${encodeURIComponent(productId)}&range=${range}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });

  if (!response.ok) {
    throw new Error(`Market history request failed with status ${response.status}.`);
  }

  const body = (await response.json()) as MarketHistoryResponse;
  return isMarketHistoryRangeKey(body.range) ? body : { ...body, range };
}

export type UseItemDetailMarketHistoryResult = Readonly<{
  range: MarketHistoryRangeKey;
  setRange: (range: MarketHistoryRangeKey) => void;
  series: readonly MarketHistorySeriesPoint[];
  stats: MarketHistoryStats | null;
  minimumSample: number;
  loading: boolean;
  error: string | null;
}>;

/**
 * Fetches the market-rollups series + stats snapshot for the currently
 * selected product/condition via Discovery's `items/:id/market-history`
 * resource route (../../../routes/item-detail-market-history.tsx), and
 * refetches when a `pricing.productMarketStats` realtime patch lands for
 * this product on the item-detail page's existing `item:{catalogItemId}`
 * SSE subscription (m106 hook) -- a staged sale advances the panel without a
 * page refresh. `subscribeRealtimePatches` shares its underlying EventSource
 * per topic set, so this reuses the same connection the market book/rail
 * already opens rather than adding a second one.
 */
export function useItemDetailMarketHistory(
  catalogItemId: string | null,
  productId: string | null,
): UseItemDetailMarketHistoryResult {
  const [range, setRange] = useState<MarketHistoryRangeKey>("90d");
  const { data, loading, error, refresh } = useFetch(
    () => (catalogItemId && productId ? fetchMarketHistory(catalogItemId, productId, range) : Promise.resolve(null)),
    [catalogItemId, productId, range],
  );

  useEffect(() => {
    if (!catalogItemId || !productId) {
      return;
    }

    const entityId = `${catalogItemId}:${productId}`;
    const subscription = subscribeRealtimePatches({
      topics: discoveryRealtimeRouteTopics.itemDetail(catalogItemId).topics,
      onPatch: (patch) => {
        const advanced = patch.changes.some(
          (change) => change.entity === "pricing.productMarketStats" && change.id === entityId,
        );

        if (advanced) {
          refresh();
        }
      },
      onSyncRequired: () => refresh(),
    });

    return () => subscription.close();
  }, [catalogItemId, productId, refresh]);

  return {
    range,
    setRange,
    series: data?.series ?? [],
    stats: data?.stats ?? null,
    minimumSample: data?.minimumSample ?? DEFAULT_MARKET_HISTORY_MINIMUM_SAMPLE,
    loading,
    error,
  };
}
