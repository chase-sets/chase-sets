// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiscoveryPublicListing } from "../support/client-support/contracts";

vi.mock("@chase-sets/platform-runtime/realtime-react", () => ({
  useRealtimePatchedSnapshot: ({ initialSnapshot }: { initialSnapshot: unknown }) => initialSnapshot,
}));

vi.mock("../support/realtime-support/revalidation", () => ({
  useDiscoveryRealtimeRevalidation: () => vi.fn(),
}));

import PublicListingRoute from "../routes/public-listing";

afterEach(cleanup);

describe("public listing checkout start", () => {
  it("renders Buy as a server POST form to the complete Checkout source URL", async () => {
    const Stub = createRoutesStub([
      {
        path: "/listings/:listingSlug",
        Component: PublicListingRoute,
        loader: () => ({
          listing: publicListing(),
          notFound: false,
          canonicalUrl: "https://marketplace.chasesets.com/listings/charizard-lst_1",
        }),
      },
    ]);

    render(<Stub initialEntries={["/listings/charizard-lst_1"]} />);

    const buyButton = await screen.findByRole("button", { name: "Buy this listing" });
    const buyForm = buyButton.closest("form");
    expect(buyForm).not.toBeNull();
    expect(buyForm?.method).toBe("post");
    expect(screen.queryByRole("link", { name: "Buy this listing" })).toBeNull();

    const action = new URL(buyForm?.action ?? "", "http://localhost");
    expect(action.pathname).toBe("/checkout/buy/readiness");
    expect(Object.fromEntries(action.searchParams)).toMatchObject({
      source: "buy-now",
      listingId: "lst_1",
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_1",
      catalogItemId: "cit_1",
      productId: "prd_1",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set",
      selectedOptions: JSON.stringify([{ dimensionId: "condition", optionId: "near_mint" }]),
      productSummary: "Near Mint",
      quantity: "1",
      priceAmount: "42.00",
      sellerName: "Card Vault",
    });

    const reportButton = screen.getByRole("button", { name: "Report listing" });
    expect(reportButton.closest("form")).not.toBe(buyForm);
  });
});

function publicListing(): DiscoveryPublicListing {
  return {
    listing_id: "lst_1",
    listing_slug: "charizard-lst_1",
    product_slug: "charizard-prd_1",
    account_id: "acc_1",
    seller_slug: "card-vault-acc_1",
    seller_display_name: "Card Vault",
    seller_listing_availability_status: "available",
    seller_listing_availability_reason_category: null,
    seller_listing_available_again_on: null,
    seller_average_rating: "4.9",
    seller_review_count: 12,
    inventory_item_id: "inv_1",
    catalog_catalog_item_id: "cit_1",
    catalog_item_slug: "charizard-cit_1",
    product_id: "prd_1",
    item_title: "Charizard",
    item_subtitle: "Base Set",
    selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    product_summary: "Near Mint",
    storage_location_name: null,
    ship_from_code: "US",
    price_amount: "42.00",
    shipping_allowance_percentage_bps: 500,
    quantity_cap: 1,
    max_units_per_order: null,
    max_units_per_day: null,
    max_units_per_customer_account: null,
    status: "active",
    google_shopping_structured_data_payload: null,
    visible_quantity: 1,
    created_at: "2026-06-04T00:00:00.000Z",
    updated_at: "2026-06-04T00:00:00.000Z",
  };
}
