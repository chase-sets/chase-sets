// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketHistoryResponse } from "../domain/item-detail-market-history";
import { useItemDetailMarketHistory } from "./use-item-detail-market-history";

vi.mock("@chase-sets/platform-runtime/realtime-web", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/platform-runtime/realtime-web")>()),
  subscribeRealtimePatches: vi.fn(),
}));

function response(currencies: string[]): MarketHistoryResponse {
  return {
    range: "90d",
    minimumSample: 5,
    showVerifiedMarkers: false,
    series: currencies.map((currencyCode) => ({ currencyCode, points: [] })),
    stats: {
      aggregates: currencies.map((currencyCode) => ({
        currencyCode,
        lastSoldAt: null,
        lastSoldPriceAmount: null,
        medianPrice30d: null,
        volume30d: 0,
        tradeCount30d: 0,
        medianPrice90d: null,
        volume90d: 0,
        tradeCount90d: 0,
      })),
      marketState: null,
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("useItemDetailMarketHistory", () => {
  it("passes every currency through and refetches exactly once for a matching market-stats patch", async () => {
    const initial = response(["EUR", "USD"]);
    const updated = response(["EUR", "USD", "GBP"]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initial })
      .mockResolvedValueOnce({ ok: true, json: async () => updated });
    vi.stubGlobal("fetch", fetchMock);
    const close = vi.fn();
    vi.mocked(subscribeRealtimePatches).mockReturnValue({ close });
    const { result, unmount } = renderHook(() => useItemDetailMarketHistory("cat", "prod"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({
      series: initial.series,
      stats: initial.stats,
      minimumSample: 5,
      showVerifiedMarkers: false,
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/items/cat/market-history?productId=prod&range=90d", {
      headers: { Accept: "application/json" },
    });
    const options = vi.mocked(subscribeRealtimePatches).mock.calls[0]![0];
    expect(options.topics).toEqual(["public:market", "item:cat"]);

    await act(async () =>
      options.onPatch({
        kind: "projection.patch",
        context: "pricing",
        projection: "market-rollups",
        topics: ["item:cat"],
        changes: [
          { op: "remove", entity: "pricing.productMarketStats", id: "cat:other" },
          { op: "remove", entity: "pricing.other", id: "cat:prod" },
        ],
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () =>
      options.onPatch({
        kind: "projection.patch",
        context: "pricing",
        projection: "market-rollups",
        topics: ["item:cat"],
        changes: [
          { op: "upsert", entity: "pricing.productMarketStats", id: "cat:prod", value: { currencyCode: "EUR" } },
          { op: "upsert", entity: "pricing.productMarketStats", id: "cat:prod", value: { currencyCode: "USD" } },
        ],
      }),
    );
    await waitFor(() => expect(result.current.stats).toEqual(updated.stats));
    expect(result.current.series).toEqual(updated.series);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not fetch or subscribe without a selected product", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useItemDetailMarketHistory("cat", null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.series).toEqual([]);
    expect(result.current.stats).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(subscribeRealtimePatches).not.toHaveBeenCalled();
  });
});
