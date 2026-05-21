import { describe, expect, it } from "vitest";
import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import { applyDiscoveryItemPatch, applyDiscoverySearchPatch } from "../support/client-support/realtime-market";
import { createDiscoveryOfferPatch } from "../support/realtime-support/patches";
import type { DiscoveryItemDetail, DiscoverySearchResponse } from "../support/client-support/contracts";

describe("discovery realtime market patches", () => {
  it("patches item detail listings and market summaries", () => {
    const item = {
      catalog_item_id: "item_1",
      market_listings: [],
      offer_demand_matches: [],
      market_summary: null,
    } as unknown as DiscoveryItemDetail;
    const patch = {
      kind: "projection.patch",
      context: "discovery",
      projection: "discovery-market-projection",
      topics: ["item:item_1"],
      changes: [
        {
          op: "upsert",
          entity: "discovery.marketListing",
          id: "listing_1",
          value: { listing_id: "listing_1", catalog_catalog_item_id: "item_1" },
        },
        {
          op: "summary",
          entity: "discovery.marketSummary",
          id: "item_1",
          value: {
            lowest_price_amount: "10.00",
            active_listing_count: 1,
            total_visible_quantity: 2,
          },
        },
      ],
    } satisfies RealtimeProjectionPatch;

    const next = applyDiscoveryItemPatch(item, patch);

    expect(next?.market_listings).toHaveLength(1);
    expect(next?.market_summary?.active_listing_count).toBe(1);
  });

  it("removes accepted offers from public item detail demand", () => {
    const item = {
      catalog_item_id: "item_1",
      market_listings: [],
      offer_demand_matches: [
        {
          offer_id: "offer_1",
          catalog_catalog_item_id: "item_1",
          status: "submitted",
        },
      ],
      market_summary: null,
    } as unknown as DiscoveryItemDetail;
    const patch = {
      kind: "projection.patch",
      context: "discovery",
      projection: "discovery-market-projection",
      topics: ["item:item_1"],
      changes: [
        {
          op: "remove",
          entity: "discovery.buyerOffer",
          id: "offer_1",
        },
      ],
    } satisfies RealtimeProjectionPatch;

    const next = applyDiscoveryItemPatch(item, patch);

    expect(next?.offer_demand_matches).toEqual([]);
  });

  it("emits accepted offer changes as public demand removals", () => {
    const patch = createDiscoveryOfferPatch(["item:item_1"], {
      offer_id: "offer_1",
      status: "accepted",
    });

    expect(patch.changes).toEqual([
      {
        op: "remove",
        entity: "discovery.buyerOffer",
        id: "offer_1",
      },
    ]);
  });

  it("patches search rows already present", () => {
    const search = {
      items: [{ catalog_item_id: "item_1", market_summary: null }],
      total: 1,
      count: 1,
    } as unknown as DiscoverySearchResponse;
    const patch = {
      kind: "projection.patch",
      context: "discovery",
      projection: "discovery-market-projection",
      topics: ["public:market"],
      changes: [
        {
          op: "summary",
          entity: "discovery.marketSummary",
          id: "item_1",
          value: {
            lowest_price_amount: "9.00",
            active_listing_count: 1,
            total_visible_quantity: 1,
          },
        },
      ],
    } satisfies RealtimeProjectionPatch;

    expect(applyDiscoverySearchPatch(search, patch)?.items[0].market_summary).toEqual({
      lowest_price_amount: "9.00",
      active_listing_count: 1,
      total_visible_quantity: 1,
    });
  });
});
