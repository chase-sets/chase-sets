// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ReactElement } from "react";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";
import {
  ItemCommercePanel,
  CheckoutPurchaseIntentSection,
  MarketplaceOfferMatchSection,
  MarketplaceSellerRegistrationSection,
} from "../routes/item-detail";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
  DiscoveryAccountOfferMatch,
  ProductSchema,
} from "../support/client-support/contracts";

afterEach(() => cleanup());

const baseListing: DiscoveryMarketListing = {
  listing_id: "listing_charizard",
  listing_slug: "charizard-base-set-listingcharizard",
  product_slug: "charizard-base-set-cat_charizard",
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
  shipping_allowance_percentage_bps: 500,
  quantity_cap: 2,
  status: "active",
  seller_display_name: "Chase Sets",
  visible_quantity: 2,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

const baseOffer: DiscoveryOffer = {
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

const baseAccountOfferMatch: DiscoveryAccountOfferMatch = {
  ...baseOffer,
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

const alternateOffer: DiscoveryOffer = {
  ...baseOffer,
  offer_id: "offer_charizard_alt",
  buyer_account_id: "buyer_2",
  buyer_display_name: "Misty",
  price_amount: "360.00",
};

const alternateAccountOfferMatch: DiscoveryAccountOfferMatch = {
  ...alternateOffer,
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
          label: "Raw",
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
          label: "Graded",
          displayOrder: 1,
          numericValue: null,
        },
      ],
    },
  ],
};

function renderWithDataRouter(element: ReactElement) {
  const router = createMemoryRouter([
    {
      path: "/",
      element,
      action: async () => ({ status: "ok" }),
    },
  ]);

  return render(<RouterProvider router={router} />);
}

function createItem(
  overrides: Partial<DiscoveryItemDetail> = {},
): DiscoveryItemDetail {
  return {
    catalog_item_id: "cat_charizard",
    slug: "charizard-base-set-cat_charizard",
    language_code: "en",
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
    product_asset_sets: [],
    image_fallback: null,
    product_schema: null,
    market_summary: null,
    market_listings: [baseListing],
    buyer_offer_matches: [baseOffer],
    updated_at: "2026-04-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("item detail commerce panel", () => {
  it("renders item detail language codes as localized labels", () => {
    renderWithDataRouter(<ItemDetailPage data={createItem({ language_code: "ja" })} />);

    expect(screen.getByText("Japanese")).toBeTruthy();
    expect(screen.queryByText("ja")).toBeNull();
  });

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

  it("uses buyer demand in the signed-out sell registration module", () => {
    render(
      <MarketplaceSellerRegistrationSection
        productSummary="Raw / Near Mint"
        selectedOffer={{
          buyer_account_id: "buyer_1",
          buyer_display_name: "Top Loader Capital",
          price_amount: "380.00",
          quantity_requested: 1,
        }}
        matchingOfferCount={5}
        registerHref="/register?returnTo=%2Fitems%2Fcat_charizard"
      />,
    );

    expect(screen.getByText("Accept offer after registration")).toBeTruthy();
    expect(screen.getByText("$380.00 offer")).toBeTruthy();
    expect(screen.getByText("From Top Loader Capital")).toBeTruthy();
    expect(screen.getByText("5 offers")).toBeTruthy();
    expect(screen.getByText("1 requested")).toBeTruthy();
    expect(screen.getByText("$353.35 after $26.65 fee")).toBeTruthy();
    expect(screen.getByText("$19.00 (5%)")).toBeTruthy();
    expect(screen.getAllByText("Raw / Near Mint")).toHaveLength(2);
    expect(screen.getByText("Quote preview uses Standard seller terms; final account terms are confirmed after registration.")).toBeTruthy();
    expect(
      screen.getByText("Register to confirm inventory, see seller payout, and accept matching offers."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in or register to accept offer" }).getAttribute("href"))
      .toBe("/register?returnTo=%2Fitems%2Fcat_charizard");
    expect(screen.getByText("Create a listing after registration")).toBeTruthy();
    expect(
      screen.getByText("If this offer does not meet your price, sign in or register to list this item instead."),
    ).toBeTruthy();
    expect(screen.getByText("Asking price")).toBeTruthy();
    expect(screen.getByText("Set after registration")).toBeTruthy();
    expect(screen.getByText("Inventory")).toBeTruthy();
    expect(screen.getByText("Confirm after registration")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in or register to list" }).getAttribute("href"))
      .toBe("/register?returnTo=%2Fitems%2Fcat_charizard");
  });

  it("keeps item media constrained on narrow item-detail screens", () => {
    renderWithDataRouter(
      <ItemDetailPage
        data={createItem({
          image_urls: ["/demo-assets/pokemon-card-back.png"],
        })}
      />,
    );

    const imageFrame = screen.getByAltText("Charizard image 1").parentElement;

    expect(imageFrame?.className).toContain("max-w-[min(100%,22rem)]");
    expect(imageFrame?.className).toContain("md:max-w-[min(100%,24rem)]");
    expect(imageFrame?.className).toContain("[--gallery-max-height:32rem]");
  });

  it("opens the selected mobile commerce section in a bottom sheet", () => {
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

    const buySheet = screen.getByRole("dialog", { name: "Buy selected product" });
    expect(buySheet).toBeTruthy();
    expect(within(buySheet).getByText("Mobile buy action")).toBeTruthy();
    expect(within(buySheet).getByRole("button", { name: "Mobile footer buy" })).toBeTruthy();
    expect(within(buySheet).queryByText("Desktop buy rail")).toBeNull();
  });

  it("keeps checkout purchase actions available in the mobile buy sheet", () => {
    renderWithDataRouter(
      <ItemDetailPage
        data={createItem()}
        renderCommerce={(context) => {
          return {
            buy: <div>Desktop buy rail</div>,
            offer: <div>Make an offer</div>,
            mobile: {
              buy: {
                content: (
                  <CheckoutPurchaseIntentSection
                    formId="mobile-buy-box"
                    panelVariant="plain"
                    catalogItemId={context.itemId}
                    productId={context.selectedProductId}
                    selectedListing={context.selectedListing}
                    itemTitle={context.itemTitle}
                    selectedOptions={context.selectedProductOptions}
                    productSummary={context.selectedProductSummary}
                    visibleListingCount={context.visibleListings.length}
                  />
                ),
              },
            },
          };
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Buy" })[0]);

    const buySheet = screen.getByRole("dialog", { name: "Buy selected product" });
    expect(within(buySheet).getByRole("spinbutton", { name: /Quantity/ }))
      .toBeTruthy();
    expect(within(buySheet).getByRole("button", { name: "Buy optimized" }))
      .not.toHaveProperty("disabled", true);
    expect(within(buySheet).getByRole("button", { name: "Add product to cart" }))
      .not.toHaveProperty("disabled", true);
    expect(within(buySheet).queryByText("Desktop buy rail")).toBeNull();
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
          sell: <div>Accept offer</div>,
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

    expect(screen.getByText("Accept offer")).toBeTruthy();
    expect(screen.getByText("1 matching offer")).toBeTruthy();
    expect(screen.getByText("Ash Ketchum")).toBeTruthy();
    expect(screen.getAllByText("$350.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Raw / Near Mint")).toBeTruthy();
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByText("submitted")).toBeNull();
    expect(screen.queryByText("1 active listing")).toBeNull();
  });

  it("keeps the market intent URL in sync when switching tabs", () => {
    window.history.pushState(null, "", "/items/charizard-base-set?market=sell");

    render(
      <ItemDetailPage
        data={createItem()}
        initialMarketIntent="sell"
        renderCommerce={() => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: <div>Accept offer</div>,
        })}
      />,
    );

    fireEvent.click(
      within(
        screen.getByRole("tablist", { name: "Choose market intent" }),
      ).getByRole("tab", { name: "Buy" }),
    );

    expect(new URL(window.location.href).searchParams.get("market")).toBe("buy");
    expect(screen.getByText("Buy selected product")).toBeTruthy();

    fireEvent.click(
      within(
        screen.getByRole("tablist", { name: "Choose market intent" }),
      ).getByRole("tab", { name: "Sell" }),
    );

    expect(new URL(window.location.href).searchParams.get("market")).toBe("sell");
    expect(screen.getByText("Accept offer")).toBeTruthy();
  });

  it("keeps public offer cards focused on listing-equivalent information for selling accounts", () => {
    render(
      <ItemDetailPage
        data={createItem()}
        accountOfferMatches={[baseAccountOfferMatch]}
        renderCommerce={() => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: <div>Accept offer</div>,
        })}
      />,
    );

    fireEvent.click(
      within(
        screen.getByRole("tablist", { name: "Choose market intent" }),
      ).getByRole("tab", { name: "Sell" }),
    );

    expect(screen.getByText("Selected")).toBeTruthy();
    expect(screen.getByText("Ash Ketchum")).toBeTruthy();
    expect(screen.getAllByText("$350.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Raw / Near Mint")).toBeTruthy();
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByText("submitted")).toBeNull();
    expect(screen.queryByText("Can fulfill")).toBeNull();
  });

  it("shows account reputation on listing and offer rows", () => {
    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [{
            ...baseListing,
            seller_slug: "chase-sets-seller",
            seller_average_rating: "4.80",
            seller_review_count: 12,
          }],
          buyer_offer_matches: [{
            ...baseOffer,
            buyer_slug: "ash-ketchum",
            buyer_average_rating: "4.20",
            buyer_review_count: 5,
          }],
        })}
        renderCommerce={() => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: <div>Accept offer</div>,
        })}
      />,
    );

    expect(screen.getByText("Seller reputation")).toBeTruthy();
    expect(screen.getByText("4.8")).toBeTruthy();
    expect(screen.getByText("(12)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View feedback" }).getAttribute("href"))
      .toBe("/sellers/chase-sets-seller#feedback");

    fireEvent.click(
      within(
        screen.getByRole("tablist", { name: "Choose market intent" }),
      ).getByRole("tab", { name: "Sell" }),
    );

    expect(screen.getByText("Buyer reputation")).toBeTruthy();
    expect(screen.getByText("4.2")).toBeTruthy();
    expect(screen.getByText("(5)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View feedback" }).getAttribute("href"))
      .toBe("/sellers/ash-ketchum#feedback");
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

  it("initializes product selection from dimension filters carried by search", () => {
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
      product_summary: "Graded",
    };

    renderWithDataRouter(
      <ItemDetailPage
        data={createItem({
          product_schema: variantSchema,
          market_listings: [rawListing, gradedListing],
        })}
        initialSelectedOptions={[{ dimensionId: "form", optionId: "graded" }]}
        renderCommerce={(context) => ({
          buy: (
            <>
              <input
                data-testid="selected-product-id"
                readOnly
                value={context.selectedProductId ?? ""}
              />
              <input
                data-testid="selected-options"
                readOnly
                value={JSON.stringify(context.selectedProductOptions)}
              />
              <input
                data-testid="visible-listing-count"
                readOnly
                value={String(context.visibleListings.length)}
              />
            </>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    expect(screen.getByTestId("selected-product-id")).toHaveProperty(
      "value",
      "cat_charizard::form:graded",
    );
    expect(screen.getByTestId("selected-options")).toHaveProperty(
      "value",
      JSON.stringify([{ dimensionId: "form", optionId: "graded" }]),
    );
    expect(screen.getByTestId("visible-listing-count")).toHaveProperty("value", "1");
    expect(screen.getByText("1 of 2 listings")).toBeTruthy();
  });

  it("does not fall back to single-listing selection when URL dimension filters were ambiguous", () => {
    renderWithDataRouter(
      <ItemDetailPage
        data={createItem({
          product_schema: requiredSchema,
          market_listings: [{
            ...baseListing,
            product_id: "cat_charizard::form:raw",
            selected_options: [{ dimensionId: "form", optionId: "raw" }],
            product_summary: "Raw",
          }],
        })}
        initialSelectedOptions={[]}
        hasInitialSelectedOptionFilters
        renderCommerce={(context) => ({
          buy: (
            <input
              data-testid="selected-product-id"
              readOnly
              value={context.selectedProductId ?? ""}
            />
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    expect(screen.getByTestId("selected-product-id")).toHaveProperty("value", "");
  });

  it("orders listings by lowest price and selects the cheapest listing by default", () => {
    const cheaperListing: DiscoveryMarketListing = {
      ...alternateListing,
      listing_id: "listing_charizard_cheapest",
      seller_display_name: "Best Price Cards",
      price_amount: "300.00",
    };

    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [baseListing, cheaperListing, alternateListing],
        })}
        renderCommerce={(context) => (
          {
            buy: (
              <form>
                <input
                  data-testid="selected-listing-id"
                  name="listingId"
                  readOnly
                  value={context.selectedListing?.listing_id ?? ""}
                />
                <input
                  data-testid="best-listing-id"
                  name="bestListingId"
                  readOnly
                  value={context.bestListing?.listing_id ?? ""}
                />
              </form>
            ),
            offer: <div>Make an offer</div>,
          }
        )}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Best Price Cards/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("selected-listing-id")).toHaveProperty(
      "value",
      "listing_charizard_cheapest",
    );
    expect(screen.getByTestId("best-listing-id")).toHaveProperty(
      "value",
      "listing_charizard_cheapest",
    );
    expect(
      screen.getAllByRole("button", { name: /\$/ }).map((button) => button.textContent),
    ).toEqual([
      expect.stringContaining("$300.00"),
      expect.stringContaining("$399.99"),
      expect.stringContaining("$410.00"),
    ]);
  });

  it("ignores listings from other catalog items when selecting the buy listing", () => {
    const foreignListing: DiscoveryMarketListing = {
      ...alternateListing,
      listing_id: "listing_pikachu_wrong_item",
      catalog_catalog_item_id: "cat_pikachu",
      product_id: "cat_pikachu::",
      item_title: "Pikachu",
      price_amount: "1.00",
      seller_display_name: "Wrong Item Seller",
    };

    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [foreignListing, baseListing],
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
              <input
                data-testid="selected-product-id"
                name="productId"
                readOnly
                value={context.selectedProductId ?? ""}
              />
            </form>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    expect(screen.queryByText("Wrong Item Seller")).toBeNull();
    expect(screen.getByTestId("selected-listing-id")).toHaveProperty(
      "value",
      "listing_charizard",
    );
    expect(screen.getByTestId("selected-product-id")).toHaveProperty(
      "value",
      "cat_charizard::",
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

  it("keeps shipping out of the item buy panel", () => {
    renderWithDataRouter(
      <CheckoutPurchaseIntentSection
        catalogItemId="cat_charizard"
        productId="cat_charizard::"
        selectedListing={baseListing}
        itemTitle="Charizard"
        selectedOptions={[]}
        productSummary="Raw / Near Mint"
        visibleListingCount={1}
      />,
    );

    expect(screen.getByRole("button", { name: "Buy optimized" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buy locked to this seller" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add product to cart" })).toBeTruthy();
    expect(screen.getByText("Selected seller signal")).toBeTruthy();
    expect(screen.getByText("$399.99")).toBeTruthy();
    expect(screen.getByText("Selected seller")).toBeTruthy();
    expect(screen.getByText("Chase Sets")).toBeTruthy();
    expect(screen.getByText("Availability")).toBeTruthy();
    expect(screen.getByText("2 available")).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /Quantity/ })).toBeTruthy();
    expect(screen.queryByLabelText("Shipping")).toBeNull();
    expect(screen.queryByRole("combobox", { name: /shipping/i })).toBeNull();
  });

  it("summarizes offer acceptance around payout, fulfillment, and readable terms", () => {
    render(
      <MarketplaceOfferMatchSection
        selectedOffer={{
          ...baseAccountOfferMatch,
          price_amount: "380.00",
          buyer_display_name: "Top Loader Capital",
          acceptance_terms: {
            account_type: "personal",
            basis_amount: "380.00",
            marketplace_sales_fee_unit_amount: "26.65",
            seller_net_unit_amount: "353.35",
            shipping_allowance_percentage_bps: 500,
            schedule_id: null,
            agreement_id: "csg_seller_override",
            resolved_at: "2026-05-05T16:36:36.000Z",
            fee_quote_fingerprint: "380.00|26.65|353.35|500||csg_seller_override",
          },
        }}
        productId="cat_charizard::"
        matchingOfferCount={1}
      />,
    );

    expect(screen.getByText("$380.00 offer")).toBeTruthy();
    expect(screen.getByText("From Top Loader Capital")).toBeTruthy();
    expect(screen.getByText("$353.35 after $26.65 fee")).toBeTruthy();
    expect(screen.getByText("$19.00 (5%)")).toBeTruthy();
    expect(screen.getByText(/Seller-specific terms/)).toBeTruthy();
    expect(screen.queryByText(/csg_seller_override/)).toBeNull();
  });

  it("changes the selected offer when another offer is clicked", () => {
    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [baseListing],
          buyer_offer_matches: [baseOffer, alternateOffer],
        })}
        accountOfferMatches={[baseAccountOfferMatch, alternateAccountOfferMatch]}
        renderCommerce={(context) => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: (
            <form>
              <input
                data-testid="selected-offer-id"
                name="offerId"
                readOnly
                value={context.selectedAccountOfferMatch?.offer_id ?? ""}
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
      screen.getByRole("button", { name: /Misty/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("selected-offer-id")).toHaveProperty(
      "value",
      "offer_charizard_alt",
    );

    fireEvent.click(screen.getByRole("button", { name: /Ash Ketchum/ }));

    expect(
      screen.getByRole("button", { name: /Ash Ketchum/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("selected-offer-id")).toHaveProperty(
      "value",
      "offer_charizard",
    );
  });

  it("shows the viewer's own offer without selecting it for seller acceptance", () => {
    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [baseListing],
          buyer_offer_matches: [baseOffer, alternateOffer],
        })}
        accountOfferMatches={[baseAccountOfferMatch]}
        viewerAccountId="buyer_2"
        renderCommerce={(context) => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: (
            <form>
              <input
                data-testid="selected-offer-id"
                name="offerId"
                readOnly
                value={context.selectedAccountOfferMatch?.offer_id ?? ""}
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

    expect(screen.getByRole("button", { name: /Misty/ })).toBeTruthy();
    expect(screen.getByText("Your offer")).toBeTruthy();
    expect(
      screen.getByText("Visible to eligible sellers. You cannot accept your own offer."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ash Ketchum/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId("selected-offer-id")).toHaveProperty(
      "value",
      "offer_charizard",
    );
  });

  it("uses buyer offer demand for option summaries and product selection in sell mode", () => {
    const rawListing: DiscoveryMarketListing = {
      ...baseListing,
      product_id: "cat_charizard::form:raw",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Raw",
      price_amount: "300.00",
    };
    const gradedOffer: DiscoveryOffer = {
      ...alternateOffer,
      product_id: "cat_charizard::form:graded",
      selected_options: [{ dimensionId: "form", optionId: "graded" }],
      product_summary: "Graded / PSA 9",
      price_amount: "360.00",
      quantity_requested: 1,
    };

    render(
      <ItemDetailPage
        data={createItem({
          product_schema: variantSchema,
          market_listings: [rawListing],
          buyer_offer_matches: [gradedOffer],
        })}
        initialMarketIntent="sell"
        renderCommerce={(context) => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: (
            <form>
              <div data-testid="sell-product-summary">
                Selected sell product {context.selectedProductSummary ?? "none"}
              </div>
              <input
                data-testid="selected-options"
                readOnly
                value={JSON.stringify(context.selectedProductOptions)}
              />
            </form>
          ),
        })}
      />,
    );

    expect(screen.getByTestId("sell-product-summary").textContent).toBe(
      "Selected sell product Graded",
    );
    expect(screen.getByText("Graded · 1 requested from $360.00")).toBeTruthy();
    expect(screen.queryByText("Selected offer product")).toBeNull();
    expect(screen.queryByText(/Matched listing:/)).toBeNull();
    expect(screen.getByTestId("selected-options")).toHaveProperty(
      "value",
      JSON.stringify([{ dimensionId: "form", optionId: "graded" }]),
    );
  });

  it("separates current option filters from the selected listing summary", () => {
    const rawListing: DiscoveryMarketListing = {
      ...baseListing,
      product_id: "cat_charizard::form:raw",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Raw",
      ship_from_code: "STL-VAULT-4",
      quantity_cap: 2,
      visible_quantity: Number.NaN,
    };
    const gradedListing: DiscoveryMarketListing = {
      ...alternateListing,
      product_id: "cat_charizard::form:graded",
      selected_options: [{ dimensionId: "form", optionId: "graded" }],
      product_summary: "Graded / PSA 9",
      quantity_cap: 1,
      visible_quantity: 1,
    };

    render(
      <ItemDetailPage
        data={createItem({
          product_schema: variantSchema,
          market_listings: [rawListing, gradedListing],
          buyer_offer_matches: [],
        })}
        renderCommerce={() => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    expect(screen.getByText("Chosen options")).toBeTruthy();
    expect(screen.getByText("All listings")).toBeTruthy();
    expect(screen.queryByText("Selected listing product")).toBeNull();
    expect(screen.queryByText("Fulfillment")).toBeNull();
    expect(screen.queryByText("Confirmed at checkout")).toBeNull();
    expect(screen.queryByText("STL-VAULT-4")).toBeNull();
    expect(screen.queryByText("Shipping credit")).toBeNull();
    expect(screen.queryByText("Unavailable")).toBeNull();
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
