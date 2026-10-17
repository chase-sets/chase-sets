import { describe, expect, it } from "vitest";
import type {
  DiscoveryAccountOfferMatch,
  DiscoveryMarketListing,
  DiscoveryOffer,
} from "../../../support/client-support/contracts";
import {
  getHighestOfferPrice,
  getLowestPrice,
  isBestOffer,
  isLowestPriceListing,
  sortAccountOfferMatchesForReview,
  sortListingsByBuyerPrice,
  sortOffersBySellerPrice,
} from "./item-detail-market";

function listing(id: string, price: string, overrides: Partial<DiscoveryMarketListing> = {}): DiscoveryMarketListing {
  return {
    listing_id: id,
    listing_slug: id,
    product_slug: "product",
    account_id: "acc_seller",
    inventory_item_id: "inv_1",
    catalog_catalog_item_id: "cat_1",
    product_id: "cat_1::",
    item_title: "Item",
    item_subtitle: null,
    selected_options: [],
    product_summary: null,
    storage_location_name: null,
    ship_from_code: null,
    price_amount: price,
    price_currency_code: "USD",
    listing_stream_version: 1,
    shipping_allowance_percentage_bps: 0,
    quantity_cap: 1,
    status: "active",
    seller_display_name: "Seller",
    visible_quantity: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function offer(
  id: string,
  price: string,
  overrides: Partial<DiscoveryAccountOfferMatch> = {},
): DiscoveryAccountOfferMatch {
  return {
    offer_id: id,
    buyer_account_id: "acc_buyer",
    buyer_display_name: "Buyer",
    catalog_catalog_item_id: "cat_1",
    product_id: "cat_1::",
    item_title: "Item",
    item_subtitle: null,
    selected_options: [],
    product_summary: null,
    price_amount: price,
    price_currency_code: "USD",
    offer_stream_version: 1,
    listing_price_amount: "10.00",
    listing_price_currency_code: "USD",
    listing_stream_version: 1,
    quantity_requested: 1,
    status: "submitted",
    accepted_seller_account_id: null,
    accepted_at: null,
    seller_available_quantity: 1,
    can_fulfill: true,
    in_sell_list: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// Independent float oracle frozen from 43d1c2614507b965089a649bf6e94831f417003e, for canonical rows only.
function baseListingOrder(left: DiscoveryMarketListing, right: DiscoveryMarketListing) {
  return (
    (left.price_currency_code ?? "").localeCompare(right.price_currency_code ?? "") ||
    Number.parseFloat(left.price_amount) - Number.parseFloat(right.price_amount) ||
    Date.parse(left.created_at) - Date.parse(right.created_at) ||
    left.listing_id.localeCompare(right.listing_id)
  );
}

function baseOfferOrder(left: DiscoveryOffer, right: DiscoveryOffer) {
  return (
    (left.price_currency_code ?? "").localeCompare(right.price_currency_code ?? "") ||
    Number.parseFloat(right.price_amount) - Number.parseFloat(left.price_amount) ||
    right.quantity_requested - left.quantity_requested ||
    Date.parse(left.created_at) - Date.parse(right.created_at) ||
    left.offer_id.localeCompare(right.offer_id)
  );
}

describe("market price ordering", () => {
  it("orders market prices by exact cents with unparseable prices last: canonical base oracle", () => {
    const listings = [
      listing("z", "10.00"),
      listing("a", "10.00"),
      listing("older", "10.00", { created_at: "2025-01-01T00:00:00Z" }),
      listing("low", "0.10"),
      listing("low-tie", "0.10"),
      listing("high", "9999999999.99"),
    ];
    const offers = [
      offer("z", "10.00"),
      offer("a", "10.00"),
      offer("older", "10.00", { created_at: "2025-01-01T00:00:00Z" }),
      offer("quantity", "10.00", { quantity_requested: 2 }),
      offer("low", "0.10"),
      offer("high", "9999999999.99"),
      offer("high-tie", "9999999999.99"),
    ];
    const lowest = listings.reduce((best, entry) =>
      Number.parseFloat(entry.price_amount) < Number.parseFloat(best.price_amount) ? entry : best,
    );
    const highest = offers.reduce((best, entry) =>
      Number.parseFloat(entry.price_amount) > Number.parseFloat(best.price_amount) ? entry : best,
    );
    expect(getLowestPrice(listings)).toBe(lowest.price_amount);
    expect(getHighestOfferPrice(offers)).toBe(highest.price_amount);
    for (const entry of listings)
      expect(isLowestPriceListing(entry, listings)).toBe(entry.price_amount === lowest.price_amount);
    for (const entry of offers) expect(isBestOffer(entry, offers)).toBe(entry.price_amount === highest.price_amount);
    expect(sortListingsByBuyerPrice(listings)).toEqual([...listings].sort(baseListingOrder));
    expect(sortOffersBySellerPrice(offers)).toEqual([...offers].sort(baseOfferOrder));
    expect(sortAccountOfferMatchesForReview(offers)).toEqual([...offers].sort(baseOfferOrder));
    expect(listings[0].listing_id).toBe("z");
    expect(offers[0].offer_id).toBe("z");

    const currencies = [...listings, listing("eur", "99.00", { price_currency_code: "EUR" })];
    expect(sortListingsByBuyerPrice(currencies)).toEqual([...currencies].sort(baseListingOrder));
    expect(getLowestPrice(currencies)).toBeNull();
    const groups = [
      ...offers,
      offer("eur", "0.01", { price_currency_code: "EUR" }),
      offer("unfulfillable", "9999999999.99", { can_fulfill: false, price_currency_code: "CAD" }),
    ];
    expect(sortOffersBySellerPrice(groups)).toEqual([...groups].sort(baseOfferOrder));
    expect(sortAccountOfferMatchesForReview(groups)).toEqual(
      [...groups].sort(
        (left, right) => Number(right.can_fulfill) - Number(left.can_fulfill) || baseOfferOrder(left, right),
      ),
    );
    expect(getHighestOfferPrice(groups)).toBeNull();
    expect(getLowestPrice([listing("missing", "1.00", { price_currency_code: null })])).toBeNull();
    expect(getHighestOfferPrice([{ ...offer("missing", "1.00"), price_currency_code: null }])).toBeNull();
  });

  it.each(["12abc", "1e3", "abc", "10000000000.00"])(
    "orders market prices by exact cents with unparseable prices last: %s",
    (malformed) => {
      const listings = [listing("bad", malformed), listing("good", "12.00")];
      const offers = [offer("bad", malformed), offer("good", "12.00")];
      expect.soft(sortListingsByBuyerPrice(listings).map((entry) => entry.listing_id)).toEqual(["good", "bad"]);
      expect.soft(sortOffersBySellerPrice(offers).map((entry) => entry.offer_id)).toEqual(["good", "bad"]);
      expect.soft(sortAccountOfferMatchesForReview(offers).map((entry) => entry.offer_id)).toEqual(["good", "bad"]);
      expect.soft(getLowestPrice(listings)).toBe("12.00");
      expect.soft(getHighestOfferPrice(offers)).toBe("12.00");
      expect.soft(isLowestPriceListing(listings[0], listings)).toBe(false);
      expect.soft(isLowestPriceListing(listings[1], listings)).toBe(true);
      expect.soft(isBestOffer(offers[0], offers)).toBe(false);
      expect.soft(isBestOffer(offers[1], offers)).toBe(true);
      expect.soft(getLowestPrice([listings[0], listing("also-bad", "abc")])).toBeNull();
      expect.soft(getHighestOfferPrice([offers[0], offer("also-bad", "abc")])).toBeNull();
      expect(getLowestPrice([])).toBeNull();
      expect(getHighestOfferPrice([])).toBeNull();
    },
  );

  it("orders market prices by exact cents with unparseable prices last: malformed group precedence", () => {
    const listings = [listing("bad-eur", "12abc", { price_currency_code: "EUR" }), listing("usd", "0.01")];
    expect(sortListingsByBuyerPrice(listings)).toEqual(listings);
    const offers = [
      offer("bad-eur", "12abc", { price_currency_code: "EUR" }),
      offer("usd", "999.00"),
      offer("bad-fulfillable", "abc"),
      offer("unfulfillable", "999.00", { can_fulfill: false }),
    ];
    expect(sortOffersBySellerPrice(offers).map((entry) => entry.offer_id)).toEqual([
      "bad-eur",
      "unfulfillable",
      "usd",
      "bad-fulfillable",
    ]);
    expect(sortAccountOfferMatchesForReview(offers).map((entry) => entry.offer_id)).toEqual([
      "bad-eur",
      "usd",
      "bad-fulfillable",
      "unfulfillable",
    ]);
  });
});
