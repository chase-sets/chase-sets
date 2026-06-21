import { describe, expect, it } from "vitest";
import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import { applyMarketplaceListPatch } from "../support/realtime-support/patches";
import {
  createMarketplaceOfferMatchPatch,
  createMarketplaceOfferPatch,
} from "../support/realtime-support/projection-patches";
import { listOfferMatchesForSellers } from "../features/offers/read-model/queries";

describe("marketplace realtime list patches", () => {
  it("updates rows that are already present", () => {
    const data = {
      items: [{ listing_id: "listing_1", price_amount: "10.00" }],
      total: 1,
      count: 1,
    };
    const patch = {
      kind: "projection.patch",
      context: "marketplace",
      projection: "marketplace-listing-projection",
      topics: ["account:account_1:listings"],
      changes: [
        {
          op: "upsert",
          entity: "marketplace.sellerListing",
          id: "listing_1",
          value: { listing_id: "listing_1", price_amount: "9.00" },
        },
      ],
    } satisfies RealtimeProjectionPatch;

    expect(
      applyMarketplaceListPatch(data, patch, {
        entity: "marketplace.sellerListing",
        idField: "listing_id",
      }).items[0].price_amount,
    ).toBe("9.00");
  });

  it("does not insert rows into paged server data", () => {
    const data = {
      items: [{ listing_id: "listing_1" }],
      total: 2,
      count: 1,
    };
    const patch = {
      kind: "projection.patch",
      context: "marketplace",
      projection: "marketplace-listing-projection",
      topics: ["account:account_1:listings"],
      changes: [
        {
          op: "upsert",
          entity: "marketplace.sellerListing",
          id: "listing_2",
          value: { listing_id: "listing_2" },
        },
      ],
    } satisfies RealtimeProjectionPatch;

    expect(
      applyMarketplaceListPatch(data, patch, {
        entity: "marketplace.sellerListing",
        idField: "listing_id",
      }).items.map((item) => item.listing_id),
    ).toEqual(["listing_1"]);
  });
});

describe("marketplace realtime offer-match patch payloads", () => {
  it("omits private shipping destination snapshots from offer patches", () => {
    const offer = {
      offer_id: "offer_1",
      shipping_destination_snapshot: {
        name: "Private Buyer",
        line1: "100 Market Street",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        email: "alternate-contact@example.test",
      },
    };

    const offerPatch = createMarketplaceOfferPatch(["account:buyer:offers"], offer);
    const offerMatchPatch = createMarketplaceOfferMatchPatch(["account:seller:offers"], "offer_1", offer);

    expect(JSON.stringify({ offerPatch, offerMatchPatch })).not.toContain("shipping_destination_snapshot");
    expect(JSON.stringify({ offerPatch, offerMatchPatch })).not.toContain("alternate-contact@example.test");
  });

  it("loads seller-specific offer match rows for multiple sellers in one query", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              seller_account_id: "seller_1",
              offer_id: "offer_1",
              buyer_account_id: "buyer_1",
              buyer_display_name: "Buyer One",
              catalog_catalog_item_id: "item_1",
              product_id: "item_1::raw",
              item_title: "Charizard",
              item_subtitle: "Base Set",
              selected_options: [{ dimensionId: "form", optionId: "raw" }],
              product_summary: "Raw",
              price_amount: "10.00",
              quantity_requested: 1,
              status: "submitted",
              accepted_seller_account_id: null,
              accepted_at: null,
              created_at: "2026-04-28T00:00:00.000Z",
              updated_at: "2026-04-28T00:00:00.000Z",
              listing_id: "listing_1",
              listing_price_amount: "12.00",
              listing_quantity_cap: 2,
              listing_visible_quantity: 2,
              offer_price_gap_amount: "2.00",
              offer_to_listing_price_bps: 8333,
              seller_available_quantity: 2,
              seller_listing_availability_status: "available",
            },
          ],
        };
      },
    };

    const rows = await listOfferMatchesForSellers(db, "offer_1", ["seller_1", "seller_2", "seller_1"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("WITH seller_accounts");
    expect(calls[0].params).toEqual(["offer_1", ["seller_1", "seller_2"]]);
    expect(rows.get("seller_1")).toEqual(
      expect.objectContaining({
        offer_id: "offer_1",
        buyer_display_name: "Buyer One",
        listing_price_amount: "12.00",
        offer_to_listing_price_bps: 8333,
        seller_available_quantity: 2,
        can_fulfill: true,
      }),
    );
    expect(rows.has("seller_2")).toBe(false);
  });
});
