// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";
import type { DiscoveryMarketListing } from "../support/client-support/contracts";
import {
  alternateListing,
  baseAccountOfferMatch,
  baseListing,
  baseOffer,
  captureItemDetailRailAnalytics,
  createItem,
  renderItemDetailRoute,
  renderWithDataRouter,
  requiredSchema,
  variantSchema,
} from "./item-detail-commerce-panel-test-harness";

vi.mock("@chase-sets/platform-runtime/realtime-react", () => ({
  useRealtimePatchedSnapshot: ({ initialSnapshot }: { initialSnapshot: unknown }) => initialSnapshot,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("item detail commerce panel market intents and listing selection", () => {
  it("switches market sections with the Buy and Sell intent", async () => {
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

    const marketIntent = screen.getByRole("radiogroup", {
      name: "Choose market intent",
    });

    expect(within(marketIntent).getByRole("radio", { name: "Buy" })).toBeTruthy();

    fireEvent.click(within(marketIntent).getByRole("radio", { name: "Sell" }));

    expect(screen.getByText("Accept offer")).toBeTruthy();
    expect(await screen.findByText("1 matching offer")).toBeTruthy();
    expect(await screen.findByText("Ash Ketchum")).toBeTruthy();
    expect(screen.getAllByText("$350.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Raw · Near Mint")).toBeTruthy();
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByText("submitted")).toBeNull();
  });

  it("keeps the Market book selected tab and tabpanel content in sync when returning to Listings", () => {
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

    expect(screen.getByRole("tab", { name: "Offers" }).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tabpanel", { name: "Offers" })).getByText("Ash Ketchum")).toBeTruthy();

    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Choose market intent" })).getByRole("radio", {
        name: "Buy",
      }),
    );

    const listingsPanel = screen.getByRole("tabpanel", { name: "Listings" });
    expect(screen.getByRole("tab", { name: "Listings" }).getAttribute("aria-selected")).toBe("true");
    expect(within(listingsPanel).getByText("Chase Sets")).toBeTruthy();
    expect(within(listingsPanel).queryByText("Ash Ketchum")).toBeNull();
    expect(screen.queryByRole("tabpanel", { name: "Offers" })).toBeNull();
  });

  it("tracks desktop rail intent selection with implicit workflow context", async () => {
    const analytics = captureItemDetailRailAnalytics();

    render(
      <ItemDetailPage
        data={createItem()}
        renderCommerce={() => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: <div>Accept offer</div>,
          watch: <div>Watch this product</div>,
        })}
      />,
    );

    const marketIntent = screen.getByRole("radiogroup", {
      name: "Choose market intent",
    });

    fireEvent.click(within(marketIntent).getByRole("radio", { name: "Sell" }));
    fireEvent.click(within(marketIntent).getByRole("radio", { name: "Watch product" }));

    await waitFor(() =>
      expect(analytics.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "rail_intent_selected",
            intent: "sell",
            workflow: "best_offer",
            selection: "implicit",
            viewer: "guest",
            surface: "desktop_rail",
          }),
          expect.objectContaining({
            event: "rail_intent_selected",
            intent: "watch",
            workflow: "watch",
            selection: "none",
            viewer: "guest",
            surface: "desktop_rail",
          }),
        ]),
      ),
    );
    analytics.stop();
  });

  it("places listing and offer watches in the Watch intent", async () => {
    renderItemDetailRoute({
      item: createItem(),
      accountOfferMatches: [baseAccountOfferMatch],
      sellerInventoryItems: [],
      sellerAccountId: "seller_1",
      hasListingStockLocation: false,
      listingSetupLoadState: "missing",
      viewerAccountId: "seller_1",
      initialMarketIntent: "buy",
      initialSelectedOptions: [],
      hasInitialSelectedOptionFilters: false,
      showSellerTab: true,
      canUseSellerFeatures: true,
      canUseListingFeatures: true,
      canSubmitOffers: true,
      registerToSellHref: "/register",
      notFound: false,
      error: null,
      canonicalUrl: null,
    });

    expect(await screen.findByText("Selected product")).toBeTruthy();
    expect(screen.queryByLabelText("Maximum listing price")).toBeNull();
    expect(screen.queryByLabelText("Minimum offer price")).toBeNull();

    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Choose market intent" })).getByRole("radio", {
        name: "Watch",
      }),
    );

    expect(await screen.findByRole("button", { name: /Watch listings/ })).toBeTruthy();

    expect(await screen.findByLabelText("Maximum listing price")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set listing alert" })).toBeTruthy();
    expect(screen.queryByLabelText("Minimum offer price")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Watch offers/ }));

    expect(await screen.findByLabelText("Minimum offer price")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set offer alert" })).toBeTruthy();
    expect(screen.queryByLabelText("Maximum listing price")).toBeNull();
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
      within(screen.getByRole("radiogroup", { name: "Choose market intent" })).getByRole("radio", { name: "Buy" }),
    );

    expect(new URL(window.location.href).searchParams.get("market")).toBe("buy");
    expect(screen.getByText("Buy selected product")).toBeTruthy();

    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Choose market intent" })).getByRole("radio", {
        name: "Sell",
      }),
    );

    expect(new URL(window.location.href).searchParams.get("market")).toBe("sell");
    expect(screen.getByText("Accept offer")).toBeTruthy();
  });

  it("keeps public offer cards focused on listing-equivalent information for selling accounts", async () => {
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
      within(screen.getByRole("radiogroup", { name: "Choose market intent" })).getByRole("radio", {
        name: "Sell",
      }),
    );

    expect(await screen.findByText("Selected")).toBeTruthy();
    expect(screen.getAllByText("Best offer").length).toBeGreaterThan(0);
    expect(await screen.findByText("Ash Ketchum")).toBeTruthy();
    expect(screen.getAllByText("$350.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Raw · Near Mint")).toBeTruthy();
    expect(screen.getByText("1 requested")).toBeTruthy();
    expect(
      within(screen.getByRole("article", { name: "Offer $350.00 from Ash Ketchum" }))
        .getByRole("button", { name: "Selected Ash Ketchum offer at $350.00" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByText("submitted")).toBeNull();
    expect(screen.queryByText("Can fulfill")).toBeNull();
  });

  it("shows account reputation on listing and offer rows", async () => {
    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [
            {
              ...baseListing,
              seller_slug: "chase-sets-seller",
              seller_average_rating: "4.80",
              seller_review_count: 12,
            },
          ],
          offer_demand_matches: [
            {
              ...baseOffer,
              buyer_slug: "ash-ketchum",
              buyer_average_rating: "4.20",
              buyer_review_count: 5,
            },
          ],
        })}
        renderCommerce={() => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: <div>Accept offer</div>,
        })}
      />,
    );

    const sellerListingRow = screen.getByRole("article", {
      name: "Listing $399.99 from Chase Sets",
    });
    expect(within(sellerListingRow).getByText("4.8")).toBeTruthy();
    expect(within(sellerListingRow).getByText("(12)")).toBeTruthy();
    const sellerReputationLink = within(sellerListingRow).getByRole("link", {
      name: "Chase Sets",
    });
    expect(sellerReputationLink.getAttribute("href")).toBe("/accounts/chase-sets-seller#feedback");

    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Choose market intent" })).getByRole("radio", {
        name: "Sell",
      }),
    );

    const buyerReputationLink = await screen.findByRole("link", { name: /Ash Ketchum/ });
    expect(screen.getByText("4.2")).toBeTruthy();
    expect(screen.getByText("(5)")).toBeTruthy();
    expect(buyerReputationLink.getAttribute("href")).toBe("/accounts/ash-ketchum#feedback");
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
      screen
        .getByRole("button", {
          name: "Selected Chase Sets listing at $399.99",
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("Lowest price")).toBeTruthy();
    expect(screen.queryByText("Selected for checkout")).toBeNull();
    expect(screen.getAllByText("New")).toHaveLength(2);
    expect(screen.getByText("2 available")).toBeTruthy();
    const selectedListingRow = screen.getByRole("article", { name: "Listing $399.99 from Chase Sets" });
    expect(within(selectedListingRow).getByText("Raw · Near Mint")).toBeTruthy();
    const selectedListingAvailability = within(selectedListingRow).getByText("2 available");
    expect(selectedListingAvailability.parentElement?.className).toContain("flex-col");
    expect(selectedListingAvailability.parentElement?.lastElementChild).toBe(selectedListingAvailability);
    const selectedListingText = selectedListingRow.textContent ?? "";
    expect(selectedListingText.indexOf("Raw · Near Mint")).toBeLessThan(selectedListingText.indexOf("2 available"));
    expect(screen.queryByText("2 available · Raw · Near Mint")).toBeNull();
    expect(screen.getAllByText("$399.99").length).toBeGreaterThan(0);
    expect(screen.getByTestId("selected-listing-id")).toHaveProperty("value", "listing_charizard");
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
              <input data-testid="selected-product-id" readOnly value={context.selectedProductId ?? ""} />
              <input data-testid="selected-options" readOnly value={JSON.stringify(context.selectedProductOptions)} />
              <input data-testid="visible-listing-count" readOnly value={String(context.visibleListings.length)} />
            </>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    expect(screen.getByTestId("selected-product-id")).toHaveProperty("value", "cat_charizard::form:graded");
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
          market_listings: [
            {
              ...baseListing,
              product_id: "cat_charizard::form:raw",
              selected_options: [{ dimensionId: "form", optionId: "raw" }],
              product_summary: "Raw",
            },
          ],
        })}
        initialSelectedOptions={[]}
        hasInitialSelectedOptionFilters
        renderCommerce={(context) => ({
          buy: <input data-testid="selected-product-id" readOnly value={context.selectedProductId ?? ""} />,
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
                data-testid="best-listing-id"
                name="bestListingId"
                readOnly
                value={context.bestListing?.listing_id ?? ""}
              />
            </form>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    expect(
      screen
        .getByRole("button", {
          name: "Selected Best Price Cards listing at $300.00",
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("selected-listing-id")).toHaveProperty("value", "listing_charizard_cheapest");
    expect(screen.getByTestId("best-listing-id")).toHaveProperty("value", "listing_charizard_cheapest");
    expect(
      screen.getAllByRole("button", { name: /listing at \$/ }).map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Selected Best Price Cards listing at $300.00",
      "Select Chase Sets listing at $399.99",
      "Select Card Vault listing at $410.00",
    ]);
  });

  it("uses explicit listing URL state instead of the implicit cheapest default", () => {
    const cheaperListing: DiscoveryMarketListing = {
      ...baseListing,
      listing_id: "listing_charizard_cheapest",
      seller_display_name: "Best Price Cards",
      price_amount: "300.00",
    };

    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [cheaperListing, alternateListing],
        })}
        initialSelectedListingId="listing_charizard_alt"
        renderCommerce={(context) => ({
          buy: (
            <form>
              <input data-testid="selected-listing-id" readOnly value={context.selectedListing?.listing_id ?? ""} />
              <input data-testid="selected-listing-source" readOnly value={context.selectedListingSource} />
            </form>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    expect(screen.getByTestId("selected-listing-id")).toHaveProperty("value", "listing_charizard_alt");
    expect(screen.getByTestId("selected-listing-source")).toHaveProperty("value", "explicit");
    expect(screen.getByRole("button", { name: "Selected Card Vault listing at $410.00" })).toBeTruthy();
  });

  it("uses an explicit owned listing as the sell-side product selection", () => {
    const ownedListing: DiscoveryMarketListing = {
      ...baseListing,
      account_id: "seller_1",
      product_id: "cat_charizard::form:raw",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Raw",
    };
    const gradedOffer = {
      ...baseOffer,
      product_id: "cat_charizard::form:graded",
      selected_options: [{ dimensionId: "form", optionId: "graded" }],
      product_summary: "Graded",
    };

    render(
      <ItemDetailPage
        data={createItem({
          product_schema: variantSchema,
          market_listings: [ownedListing],
          offer_demand_matches: [gradedOffer],
        })}
        viewerAccountId="seller_1"
        initialMarketIntent="sell"
        initialSelectedListingId={ownedListing.listing_id}
        renderCommerce={(context) => ({
          buy: <div>Buy selected product</div>,
          sell: (
            <form>
              <input data-testid="selected-product-id" readOnly value={context.selectedProductId ?? ""} />
              <input data-testid="selected-product-summary" readOnly value={context.selectedProductSummary ?? ""} />
              <input data-testid="selected-options" readOnly value={JSON.stringify(context.selectedProductOptions)} />
              <input data-testid="selected-listing-id" readOnly value={context.selectedListing?.listing_id ?? ""} />
              <input data-testid="selected-offer-id" readOnly value={context.selectedOffer?.offer_id ?? ""} />
            </form>
          ),
        })}
      />,
    );

    expect(screen.getByTestId("selected-product-id")).toHaveProperty("value", "cat_charizard::form:raw");
    expect(screen.getByTestId("selected-product-summary")).toHaveProperty("value", "Raw");
    expect(screen.getByTestId("selected-options")).toHaveProperty(
      "value",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
    expect(screen.getByTestId("selected-listing-id")).toHaveProperty("value", ownedListing.listing_id);
    expect(screen.getByTestId("selected-offer-id")).toHaveProperty("value", "");
  });

  it("recovers stale explicit listing URL state to the implicit default", () => {
    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [baseListing, alternateListing],
        })}
        initialSelectedListingId="listing_missing"
        renderCommerce={(context) => ({
          buy: (
            <form>
              <input data-testid="selected-listing-id" readOnly value={context.selectedListing?.listing_id ?? ""} />
              <input data-testid="selected-listing-source" readOnly value={context.selectedListingSource} />
              <input data-testid="stale-listing-id" readOnly value={context.staleSelectedListingId ?? ""} />
            </form>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    expect(screen.getByText("Listing unavailable")).toBeTruthy();
    expect(
      screen.getByText("That listing is no longer available. Showing the best available listing instead."),
    ).toBeTruthy();
    expect(screen.getByTestId("selected-listing-id")).toHaveProperty("value", "listing_charizard");
    expect(screen.getByTestId("selected-listing-source")).toHaveProperty("value", "implicit");
    expect(screen.getByTestId("stale-listing-id")).toHaveProperty("value", "listing_missing");
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
    expect(screen.getByTestId("selected-listing-id")).toHaveProperty("value", "listing_charizard");
    expect(screen.getByTestId("selected-product-id")).toHaveProperty("value", "cat_charizard::");
  });

  it("changes the selected listing when another listing is clicked", () => {
    const analytics = captureItemDetailRailAnalytics();

    window.history.replaceState(null, "", "/items/charizard-base-set?market=buy");

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
              <input data-testid="selected-listing-source" readOnly value={context.selectedListingSource} />
            </form>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Select Card Vault listing at $410.00",
      }),
    );

    expect(
      screen
        .getByRole("button", {
          name: "Selected Card Vault listing at $410.00",
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByText("1 available · Raw · Near Mint")).toBeNull();
    expect(screen.getAllByText("$410.00").length).toBeGreaterThan(0);
    expect(screen.getByTestId("selected-listing-id")).toHaveProperty("value", "listing_charizard_alt");
    expect(screen.getByTestId("selected-listing-source")).toHaveProperty("value", "explicit");
    const url = new URL(window.location.href);
    expect(url.searchParams.get("listing")).toBe("listing_charizard_alt");
    expect(url.searchParams.get("offer")).toBeNull();
    expect(analytics.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "workflow_selected",
          intent: "buy",
          workflow: "selected_listing",
          selection: "explicit",
          viewer: "guest",
          surface: "market_book",
        }),
      ]),
    );
    analytics.stop();
  });

  it("restores explicit listing selection from browser history state", async () => {
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
    window.history.replaceState(null, "", "/items/charizard-base-set?market=buy&listing=listing_charizard");

    render(
      <ItemDetailPage
        data={createItem({
          product_schema: variantSchema,
          market_listings: [rawListing, gradedListing],
        })}
        initialSelectedListingId="listing_charizard"
        renderCommerce={(context) => ({
          buy: (
            <form>
              <input data-testid="selected-listing-id" readOnly value={context.selectedListing?.listing_id ?? ""} />
              <input data-testid="selected-options" readOnly value={JSON.stringify(context.selectedProductOptions)} />
            </form>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    expect(screen.getByTestId("selected-listing-id")).toHaveProperty("value", "listing_charizard");
    expect(screen.getByTestId("selected-options")).toHaveProperty(
      "value",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );

    window.history.pushState(null, "", "/items/charizard-base-set?market=buy&listing=listing_charizard_alt");
    fireEvent(window, new PopStateEvent("popstate"));

    await waitFor(() =>
      expect(screen.getByTestId("selected-listing-id")).toHaveProperty("value", "listing_charizard_alt"),
    );
    expect(screen.getByTestId("selected-options")).toHaveProperty(
      "value",
      JSON.stringify([{ dimensionId: "form", optionId: "graded" }]),
    );
  });

  it("clears explicit listing URL state when product filters change", async () => {
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
    window.history.replaceState(null, "", "/items/charizard-base-set?market=buy&listing=listing_charizard");

    render(
      <ItemDetailPage
        data={createItem({
          product_schema: variantSchema,
          market_listings: [rawListing, gradedListing],
        })}
        initialSelectedListingId="listing_charizard"
        renderCommerce={(context) => ({
          buy: (
            <form>
              <input data-testid="selected-listing-id" readOnly value={context.selectedListing?.listing_id ?? ""} />
              <input data-testid="selected-listing-source" readOnly value={context.selectedListingSource} />
              <input data-testid="selected-options" readOnly value={JSON.stringify(context.selectedProductOptions)} />
            </form>
          ),
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /^Graded/ }));

    await waitFor(() =>
      expect(screen.getByTestId("selected-listing-id")).toHaveProperty("value", "listing_charizard_alt"),
    );
    expect(screen.getByTestId("selected-listing-source")).toHaveProperty("value", "implicit");
    expect(screen.getByTestId("selected-options")).toHaveProperty(
      "value",
      JSON.stringify([{ dimensionId: "form", optionId: "graded" }]),
    );
    expect(new URL(window.location.href).searchParams.get("listing")).toBeNull();
  });

  it("keeps add to cart available for a selected product without a listing", () => {
    render(
      <ItemDetailPage
        data={createItem({ market_listings: [] })}
        renderCommerce={(context) => ({
          buy: (
            <form>
              <input data-testid="selected-listing-id" readOnly value={context.selectedListing?.listing_id ?? "none"} />
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
    expect(screen.getByRole("button", { name: "Add to cart" })).not.toHaveProperty("disabled", true);
  });
});
