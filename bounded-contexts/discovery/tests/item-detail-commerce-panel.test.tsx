// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";
import {
  ItemCommercePanel,
  MarketplaceSellerRegistrationSection,
} from "../routes/item-detail";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryBuyerOfferMatch,
  DiscoverySellerBuyerOfferMatch,
  ProductSchema,
} from "../support/client-support/contracts";

afterEach(() => cleanup());

const baseListing: DiscoveryMarketListing = {
  listing_id: "listing_charizard",
  account_id: "seller_1",
  inventory_item_id: "inventory_1",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [],
  product_summary: "Raw / Near Mint",
  storage_location_name: null,
  ship_from_code: null,
  price_amount: "399.99",
  quantity_cap: 2,
  status: "active",
  seller_display_name: "Chase Sets",
  visible_quantity: 2,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

const baseBuyerOfferMatch: DiscoveryBuyerOfferMatch = {
  offer_id: "offer_charizard",
  buyer_account_id: "buyer_1",
  buyer_display_name: "Ash Ketchum",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [],
  product_summary: "Raw / Near Mint",
  price_amount: "350.00",
  quantity_requested: 1,
  status: "submitted",
  accepted_seller_account_id: null,
  accepted_at: null,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

const baseSellerBuyerOfferMatch: DiscoverySellerBuyerOfferMatch = {
  ...baseBuyerOfferMatch,
  seller_available_quantity: 2,
  can_fulfill: true,
  in_sell_list: false,
};

const alternateListing: DiscoveryMarketListing = {
  ...baseListing,
  listing_id: "listing_charizard_alt",
  account_id: "seller_2",
  inventory_item_id: "inventory_2",
  seller_display_name: "Card Vault",
  price_amount: "410.00",
  visible_quantity: 1,
};

const alternateBuyerOfferMatch: DiscoveryBuyerOfferMatch = {
  ...baseBuyerOfferMatch,
  offer_id: "offer_charizard_alt",
  buyer_account_id: "buyer_2",
  buyer_display_name: "Misty",
  price_amount: "360.00",
};

const alternateSellerBuyerOfferMatch: DiscoverySellerBuyerOfferMatch = {
  ...alternateBuyerOfferMatch,
  seller_available_quantity: 1,
  can_fulfill: true,
  in_sell_list: false,
};

const requiredSchema: ProductSchema = {
  canonicalDimensionOrder: [{ dimensionId: "form", dimensionName: "Form" }],
  dimensions: [
    {
      dimensionId: "form",
      dimensionName: "Form",
      valueKind: "unordered",
      required: true,
      appliesWhen: [],
      allowedOptions: [
        {
          optionId: "raw",
          code: "raw",
          labels: [{ locale: "en", value: "Raw" }],
          displayOrder: 0,
          numericValue: null,
        },
      ],
    },
  ],
};

const variantSchema: ProductSchema = {
  ...requiredSchema,
  dimensions: [
    {
      ...requiredSchema.dimensions[0],
      allowedOptions: [
        ...requiredSchema.dimensions[0].allowedOptions,
        {
          optionId: "graded",
          code: "graded",
          labels: [{ locale: "en", value: "Graded" }],
          displayOrder: 1,
          numericValue: null,
        },
      ],
    },
  ],
};

function createItem(
  overrides: Partial<DiscoveryItemDetail> = {},
): DiscoveryItemDetail {
  return {
    catalog_item_id: "cat_charizard",
    title: "Charizard",
    subtitle: "Base Set 4/102 Holo Rare",
    description: "The iconic Base Set Charizard.",
    blueprint_id: null,
    blueprint: null,
    status: "active",
    field_values: [],
    categories: [],
    tags: [],
    image_urls: [],
    product_schema: null,
    market_summary: null,
    market_listings: [baseListing],
    buyer_offer_matches: [baseBuyerOfferMatch],
    updated_at: "2026-04-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("item detail commerce panel", () => {
  it("shows the sell tab when seller tools are represented by a registration CTA", () => {
    render(
      <ItemCommercePanel
        showSellerTab
        buyer={<div>Buy selected product</div>}
        seller={
          <MarketplaceSellerRegistrationSection
            productSummary="Raw / Near Mint"
            registerHref="/register?returnTo=%2Fitems%2Fcat_charizard"
          />
        }
      />,
    );

    expect(screen.getByRole("tab", { name: "Buy" })).toBeTruthy();
    const sellTab = screen.getByRole("tab", { name: "Sell" });
    expect(sellTab).toBeTruthy();

    fireEvent.click(sellTab);

    expect(screen.getByText("Sell on Chase Sets")).toBeTruthy();
    expect(screen.getByText("Start with: Raw / Near Mint")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Register to sell" }).getAttribute("href"))
      .toBe("/register?returnTo=%2Fitems%2Fcat_charizard");
  });

  it("opens the selected mobile commerce section in a drawer", () => {
    render(
      <ItemDetailPage
        data={createItem()}
        renderCommerce={() => ({
          buy: <div>Desktop buy rail</div>,
          offer: <div>Desktop offer rail</div>,
          sell: <div>Desktop sell rail</div>,
          mobile: {
            buy: {
              content: <div>Mobile buy action</div>,
              footer: <button type="button">Mobile footer buy</button>,
            },
            offer: { content: <div>Mobile offer action</div> },
            sell: { content: <div>Mobile sell action</div> },
            list: { content: <div>Mobile list action</div> },
          },
        })}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Buy" })[0]);

    const buyDrawer = screen.getByRole("dialog", { name: "Buy selected product" });
    expect(buyDrawer).toBeTruthy();
    expect(within(buyDrawer).getByText("Mobile buy action")).toBeTruthy();
    expect(within(buyDrawer).getByRole("button", { name: "Mobile footer buy" })).toBeTruthy();
    expect(within(buyDrawer).queryByText("Desktop buy rail")).toBeNull();
  });

  it("changes mobile commerce actions with the selected market intent", () => {
    render(
      <ItemDetailPage
        data={createItem()}
        renderCommerce={() => ({
          buy: <div>Mobile buy action</div>,
          offer: <div>Mobile offer action</div>,
          sell: <div>Desktop sell rail</div>,
          mobile: {
            sell: { content: <div>Mobile sell action</div> },
            list: { content: <div>Mobile list action</div> },
          },
        })}
      />,
    );

    expect(
      screen.getAllByRole("tablist", { name: "Choose mobile market intent" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Buy" }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "Make offer" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Sell" })).toBeNull();

    const mobileMarketIntent = screen.getAllByRole("tablist", {
      name: "Choose mobile market intent",
    })[0];

    fireEvent.click(within(mobileMarketIntent).getByRole("tab", { name: "Sell" }));

    expect(screen.queryByRole("button", { name: "Buy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make offer" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Sell" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "List" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Sell" })[0]);

    expect(screen.getByRole("dialog", { name: "Sell" })).toBeTruthy();
    expect(screen.getAllByText("Mobile sell action").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getAllByRole("button", { name: "List" })[0]);

    expect(screen.getByRole("dialog", { name: "List" })).toBeTruthy();
    expect(screen.getAllByText("Mobile list action").length).toBeGreaterThan(0);
  });

  it("sends incomplete mobile selections back to the option chooser", () => {
    render(
      <ItemDetailPage
        data={createItem({
          product_schema: requiredSchema,
          market_listings: [],
          buyer_offer_matches: [],
        })}
        renderCommerce={() => ({
          buy: <div>Mobile buy action</div>,
          offer: <div>Mobile offer action</div>,
          sell: <div>Mobile sell action</div>,
          mobile: {
            sell: { content: <div>Mobile sell action</div> },
            list: { content: <div>Mobile list action</div> },
          },
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Buy now" })).toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: "Select options" })
        .every((link) => link.getAttribute("href") === "#select-options"),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: "Choose to offer" })
        .every((link) => link.getAttribute("href") === "#select-options"),
    ).toBe(true);

    fireEvent.click(
      within(
        screen.getAllByRole("tablist", { name: "Choose mobile market intent" })[0],
      ).getByRole("tab", { name: "Sell" }),
    );

    expect(
      screen
        .getAllByRole("link", { name: "Choose to sell" })
        .every((link) => link.getAttribute("href") === "#select-options"),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: "Choose to list" })
        .every((link) => link.getAttribute("href") === "#select-options"),
    ).toBe(true);
  });

  it("switches market sections with the Buy and Sell intent", () => {
    render(
      <ItemDetailPage
        data={createItem()}
        renderCommerce={() => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: <div>Sell to buyer offer</div>,
        })}
      />,
    );

    expect(screen.getAllByText("1 active listing").length).toBeGreaterThan(0);
    expect(screen.queryByText("Ash Ketchum")).toBeNull();

    const marketIntent = screen.getByRole("tablist", {
      name: "Choose market intent",
    });

    expect(within(marketIntent).getByRole("tab", { name: "Buy" })).toBeTruthy();

    fireEvent.click(within(marketIntent).getByRole("tab", { name: "Sell" }));

    expect(screen.getByText("Sell to buyer offer")).toBeTruthy();
    expect(screen.getByText("1 matching offer")).toBeTruthy();
    expect(screen.getByText("Ash Ketchum")).toBeTruthy();
    expect(screen.queryByText("1 active listing")).toBeNull();
  });

  it("shows seller-specific fulfillment badges when eligible buyer offer match data is available", () => {
    render(
      <ItemDetailPage
        data={createItem()}
        sellerBuyerOfferMatches={[baseSellerBuyerOfferMatch]}
        renderCommerce={() => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: <div>Sell to buyer offer</div>,
        })}
      />,
    );

    fireEvent.click(
      within(
        screen.getByRole("tablist", { name: "Choose market intent" }),
      ).getByRole("tab", { name: "Sell" }),
    );

    expect(screen.getByText("Selected")).toBeTruthy();
    expect(screen.getByText("Can fulfill")).toBeTruthy();
  });

  it("highlights the initial selected listing and attributes the buy panel to it", () => {
    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [baseListing, alternateListing],
        })}
        renderCommerce={(context) => ({
          buy: (
            <form>
              <input
                data-testid="selected-listing-id"
                name="listingId"
                readOnly
                value={context.selectedListing?.listing_id ?? ""}
              />
            </form>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Chase Sets/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("selected-listing-id")).toHaveProperty(
      "value",
      "listing_charizard",
    );
  });

  it("changes the selected listing when another listing is clicked", () => {
    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [baseListing, alternateListing],
        })}
        renderCommerce={(context) => ({
          buy: (
            <form>
              <input
                data-testid="selected-listing-id"
                name="listingId"
                readOnly
                value={context.selectedListing?.listing_id ?? ""}
              />
            </form>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Card Vault/ }));

    expect(
      screen.getByRole("button", { name: /Card Vault/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("selected-listing-id")).toHaveProperty(
      "value",
      "listing_charizard_alt",
    );
  });

  it("keeps add to cart available for a selected product without a listing", () => {
    render(
      <ItemDetailPage
        data={createItem({ market_listings: [] })}
        renderCommerce={(context) => ({
          buy: (
            <form>
              <input
                data-testid="selected-listing-id"
                readOnly
                value={context.selectedListing?.listing_id ?? "none"}
              />
              <button type="submit" disabled={!context.selectedProductId}>
                Add to cart
              </button>
            </form>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    expect(screen.getByTestId("selected-listing-id")).toHaveProperty("value", "none");
    expect(screen.getByRole("button", { name: "Add to cart" })).not.toHaveProperty(
      "disabled",
      true,
    );
  });

  it("changes the selected offer when another offer is clicked", () => {
    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [baseListing],
          buyer_offer_matches: [baseBuyerOfferMatch, alternateBuyerOfferMatch],
        })}
        sellerBuyerOfferMatches={[baseSellerBuyerOfferMatch, alternateSellerBuyerOfferMatch]}
        renderCommerce={(context) => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: (
            <form>
              <input
                data-testid="selected-offer-id"
                name="offerId"
                readOnly
                value={context.selectedSellerBuyerOfferMatch?.offer_id ?? ""}
              />
            </form>
          ),
        })}
      />,
    );

    fireEvent.click(
      within(
        screen.getByRole("tablist", { name: "Choose market intent" }),
      ).getByRole("tab", { name: "Sell" }),
    );

    expect(
      screen.getByRole("button", { name: /Ash Ketchum/ }).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /Misty/ }));

    expect(
      screen.getByRole("button", { name: /Misty/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("selected-offer-id")).toHaveProperty(
      "value",
      "offer_charizard_alt",
    );
  });

  it("selecting a listing updates the selected product options", () => {
    const rawListing: DiscoveryMarketListing = {
      ...baseListing,
      product_id: "cat_charizard::form:raw",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Raw",
    };
    const gradedListing: DiscoveryMarketListing = {
      ...alternateListing,
      product_id: "cat_charizard::form:graded",
      selected_options: [{ dimensionId: "form", optionId: "graded" }],
      product_summary: "Graded / PSA 9",
    };

    render(
      <ItemDetailPage
        data={createItem({
          product_schema: variantSchema,
          market_listings: [rawListing, gradedListing],
          buyer_offer_matches: [],
        })}
        renderCommerce={(context) => ({
          buy: (
            <form>
              <div>Selected product {context.selectedProductSummary ?? "none"}</div>
              <input
                data-testid="selected-options"
                readOnly
                value={JSON.stringify(context.selectedProductOptions)}
              />
            </form>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Card Vault/ }));

    expect(screen.getByText("Selected product Graded")).toBeTruthy();
    expect(screen.getByTestId("selected-options")).toHaveProperty(
      "value",
      JSON.stringify([{ dimensionId: "form", optionId: "graded" }]),
    );
  });
});
