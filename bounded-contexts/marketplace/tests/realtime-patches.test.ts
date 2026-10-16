import { describe, expect, it } from "vitest";
import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import { applyMarketplaceListPatch, applySubmittedOfferListPatch } from "../support/realtime-support/patches";
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

describe("filter-aware Submitted Offer list patches", () => {
  const offerPatch = (offerId: string, status: string) =>
    ({
      kind: "projection.patch",
      context: "marketplace",
      projection: "marketplace-offer-projection",
      topics: ["account:acc_buyer:offers"],
      changes: [{ op: "upsert", entity: "marketplace.offer", id: offerId, value: { offer_id: offerId, status } }],
    }) satisfies RealtimeProjectionPatch;
  const openOnly = {
    entity: "marketplace.offer",
    idField: "offer_id" as const,
    matches: (row: { status: string }) => row.status === "submitted",
  };

  it("removes a row whose new status leaves the active filter", () => {
    const data = { items: [{ offer_id: "off_1", status: "submitted" }], total: 1, count: 1 };
    expect(applyMarketplaceListPatch(data, offerPatch("off_1", "paused"), openOnly)).toEqual({
      items: [],
      total: 0,
      count: 0,
    });
  });

  it("adds a row that newly matches and ignores one that does not", () => {
    const data = { items: [] as { offer_id: string; status: string }[], total: 0, count: 0 };
    expect(applyMarketplaceListPatch(data, offerPatch("off_2", "withdrawn"), openOnly).items).toEqual([]);
    expect(applyMarketplaceListPatch(data, offerPatch("off_2", "submitted"), openOnly)).toEqual({
      items: [{ offer_id: "off_2", status: "submitted" }],
      total: 1,
      count: 1,
    });
  });

  it("keeps upserting every row when no filter applies", () => {
    const data = { items: [{ offer_id: "off_1", status: "submitted" }], total: 1, count: 1 };
    expect(
      applyMarketplaceListPatch(data, offerPatch("off_1", "paused"), {
        entity: "marketplace.offer",
        idField: "offer_id",
      }).items,
    ).toEqual([{ offer_id: "off_1", status: "paused" }]);
  });
});

describe("Submitted Offer list snapshot patches", () => {
  const patchOf = (offerId: string, status: string, priceAmount = "20.00") =>
    ({
      kind: "projection.patch",
      context: "marketplace",
      projection: "marketplace-offer-projection",
      topics: ["account:acc_buyer:offers"],
      changes: [
        { op: "upsert", entity: "marketplace.offer", id: offerId, value: { offer_id: offerId, status, priceAmount } },
      ],
    }) satisfies RealtimeProjectionPatch;
  const snapshot = {
    items: [{ offer_id: "off_1", status: "submitted", priceAmount: "20.00" }],
    total: 1,
    count: 1,
    statusCounts: { submitted: 1, paused: 0, withdrawn: 0, accepted: 0 },
    countRevision: 0,
  };

  it("moves a paused row out of Open and asks for fresh counts", () => {
    expect(applySubmittedOfferListPatch(snapshot, patchOf("off_1", "paused"), "submitted")).toMatchObject({
      items: [],
      total: 0,
      countRevision: 1,
    });
  });

  it("keeps counts when only a visible row's price changes", () => {
    expect(applySubmittedOfferListPatch(snapshot, patchOf("off_1", "submitted", "25.00"), "submitted")).toMatchObject({
      items: [{ offer_id: "off_1", priceAmount: "25.00" }],
      countRevision: 0,
    });
  });

  it("asks for fresh counts when an Offer outside the view changes", () => {
    expect(applySubmittedOfferListPatch(snapshot, patchOf("off_2", "withdrawn"), "submitted")).toMatchObject({
      items: [{ offer_id: "off_1" }],
      countRevision: 1,
    });
  });
});
