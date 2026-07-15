import { describe, expect, it } from "vitest";
import { aggregateSellerAttentionQueue, type SellerAttentionContext } from "@chase-sets/seller-attention-queue";
import type { OfferMatchListItem } from "../../offers/ui/contracts";
import type { MarketplaceListingListItem } from "../../listings/ui/contracts";
import {
  createMarketplaceSellerAttentionSources,
  offerMatchesToAttentionRows,
  sellerListingsToAttentionRows,
} from "./seller-desk-attention";

const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: "2026-07-14T12:00:00.000Z" };

function offer(overrides: Partial<OfferMatchListItem> = {}): OfferMatchListItem {
  return {
    offer_id: "off-1",
    buyer_account_id: "buyer-1",
    catalog_catalog_item_id: "cat-1",
    product_id: "prod-1",
    item_title: "Charizard",
    item_subtitle: null,
    selected_options: [],
    product_summary: null,
    price_amount: "10.00",
    quantity_requested: 1,
    status: "submitted",
    accepted_seller_account_id: null,
    accepted_at: null,
    created_at: "2026-07-13T00:00:00.000Z",
    updated_at: "2026-07-13T00:00:00.000Z",
    listing_id: "lst-1",
    listing_price_amount: "12.00",
    listing_quantity_cap: 1,
    listing_visible_quantity: 1,
    offer_price_gap_amount: "2.00",
    offer_to_listing_price_bps: 8300,
    buyer_display_name: "Ash",
    seller_available_quantity: 1,
    seller_listing_availability_status: "available",
    can_fulfill: true,
    ...overrides,
  };
}

function listing(overrides: Partial<MarketplaceListingListItem> = {}): MarketplaceListingListItem {
  return {
    listing_id: "lst-1",
    account_id: "acct-1",
    inventory_item_id: "inv-1",
    catalog_catalog_item_id: "cat-1",
    product_id: "prod-1",
    item_language_code: null,
    item_title: "Blastoise",
    item_subtitle: null,
    selected_options: [],
    product_summary: null,
    product_measure_snapshot: null,
    graded_card: null,
    storage_location_name: null,
    ship_from_code: null,
    ship_from_address: {} as MarketplaceListingListItem["ship_from_address"],
    price_amount: "20.00",
    marketplace_sales_fee_unit_amount: "1.00",
    seller_net_unit_amount: "19.00",
    shipping_allowance_percentage_bps: 0,
    terms_schedule_id: null,
    terms_agreement_id: null,
    terms_resolved_at: null,
    fee_quote_fingerprint: "fp",
    fee_locks: [],
    quantity_cap: 1,
    evidence_requirements: null,
    evidence: [],
    status: "draft",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("offerMatchesToAttentionRows", () => {
  it("keeps only offers still awaiting the seller's response", () => {
    const rows = offerMatchesToAttentionRows([
      offer({ offer_id: "a", status: "submitted" }),
      offer({ offer_id: "b", status: "accepted" }),
    ]);
    expect(rows.map((row) => row.offerId)).toEqual(["a"]);
    expect(rows[0]).toMatchObject({ reference: "Charizard", expiresAt: null, observedAt: "2026-07-13T00:00:00.000Z" });
  });
});

describe("sellerListingsToAttentionRows", () => {
  it("keeps only actionable listing statuses and names the action", () => {
    const rows = sellerListingsToAttentionRows([
      listing({ listing_id: "a", status: "draft" }),
      listing({ listing_id: "b", status: "paused" }),
      listing({ listing_id: "c", status: "active" }),
    ]);
    expect(rows.map((row) => row.listingId)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ action: "draft", reference: "Blastoise", observedAt: "2026-07-11T00:00:00.000Z" });
  });

  it("falls back to the listing id when the title is missing", () => {
    const [row] = sellerListingsToAttentionRows([listing({ listing_id: "x", item_title: null, status: "draft" })]);
    expect(row?.reference).toBe("x");
  });
});

describe("createMarketplaceSellerAttentionSources", () => {
  it("composes offer and listing items into the queue, ordered by the blueprint policy", async () => {
    const sources = createMarketplaceSellerAttentionSources({
      loadOfferMatches: async () => [offer({ offer_id: "off-1", status: "submitted" })],
      loadSellerListings: async () => [listing({ listing_id: "lst-9", status: "draft" })],
    });

    const queue = await aggregateSellerAttentionQueue(sources, CONTEXT);

    expect(queue.rollup.total).toBe(2);
    // Offer (warning) outranks the listing action (info).
    expect(queue.items.map((item) => item.source)).toEqual(["offer-response", "listing-action"]);
    expect(queue.degraded).toBe(false);
    expect(queue.sources.map((source) => source.status)).toEqual(["available", "available"]);
  });

  it("degrades one source without blanking the other when its read fails", async () => {
    const sources = createMarketplaceSellerAttentionSources({
      loadOfferMatches: async () => {
        throw new Error("offers down");
      },
      loadSellerListings: async () => [listing({ listing_id: "lst-9", status: "draft" })],
    });

    const queue = await aggregateSellerAttentionQueue(sources, CONTEXT);

    expect(queue.degraded).toBe(true);
    expect(queue.items.map((item) => item.source)).toEqual(["listing-action"]);
    const offerHealth = queue.sources.find((source) => source.id === "offer-response");
    expect(offerHealth?.status).toBe("unavailable");
    expect(offerHealth?.reason).toBe("offers down");
  });
});
