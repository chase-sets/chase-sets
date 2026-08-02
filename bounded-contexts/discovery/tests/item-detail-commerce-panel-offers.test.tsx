// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";
import { BuyActionCard, CheckoutPurchaseIntentSection, MarketplaceOfferMatchSection } from "../routes/item-detail";
import type { DiscoveryMarketListing, DiscoveryOffer } from "../support/client-support/contracts";
import {
  alternateAccountOfferMatch,
  alternateListing,
  alternateOffer,
  baseAccountOfferMatch,
  baseListing,
  baseOffer,
  captureItemDetailRailAnalytics,
  createItem,
  renderItemDetailRoute,
  renderWithDataRouter,
  variantSchema,
} from "./item-detail-commerce-panel-test-harness";

vi.mock("@chase-sets/platform-runtime/realtime-react", () => ({
  useRealtimePatchedSnapshot: ({ initialSnapshot }: { initialSnapshot: unknown }) => initialSnapshot,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("item detail commerce panel purchase workflows and offers", () => {
  it("uses accordion headers as purchase workflow selectors", () => {
    const analytics = captureItemDetailRailAnalytics();

    render(
      <BuyActionCard
        formIdPrefix="buy-card"
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        productSelectionDetails={[]}
        visibleListingCount={1}
        renderBuyNow={() => <div>Buy now workflow body</div>}
        renderAddToCart={() => <div>Add to cart workflow body</div>}
        renderOffer={() => <div>Make offer workflow body</div>}
      />,
    );

    const buyNowHeader = screen.getByRole("button", {
      name: /Best available listing/i,
    });
    const makeOfferHeader = screen.getByRole("button", {
      name: /Offer your price and quantity/i,
    });

    expect(buyNowHeader.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Buy now workflow body")).toBeTruthy();

    fireEvent.click(makeOfferHeader);

    expect(buyNowHeader.getAttribute("aria-expanded")).toBe("false");
    expect(makeOfferHeader.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Make offer workflow body")).toBeTruthy();
    expect(analytics.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "workflow_selected",
          intent: "buy",
          workflow: "make_offer",
          selection: "none",
          surface: "action_rail",
        }),
      ]),
    );
    analytics.stop();
  });

  it("keeps offer details in Buy and listing alerts in Watch", async () => {
    const analytics = captureItemDetailRailAnalytics();

    renderItemDetailRoute({
      item: createItem(),
      accountOfferMatches: [],
      sellerInventoryItems: [],
      sellerAccountId: null,
      hasListingStockLocation: false,
      listingSetupLoadState: "not-applicable",
      viewerAccountId: "buyer_1",
      initialMarketIntent: "buy",
      initialSelectedOptions: [],
      hasInitialSelectedOptionFilters: false,
      showSellerTab: false,
      canUseSellerFeatures: false,
      canUseListingFeatures: false,
      canSubmitOffers: true,
      registerToSellHref: "/register",
      notFound: false,
      error: null,
      canonicalUrl: null,
    });

    expect(await screen.findByText("Selected product")).toBeTruthy();
    const commercePanel = screen.getByRole("complementary", { name: "Commerce options" });
    expect(commercePanel.querySelectorAll(".ds-glass")).toHaveLength(1);
    expect(commercePanel.querySelector('[class*="-mx-3"]')).toBeTruthy();
    expect(commercePanel.querySelector(".modern-surface")).toBeNull();
    expect(screen.queryByText("Offer details")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Make an offer/ }));

    expect(screen.getAllByText("Make an offer").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Selected product").length).toBeGreaterThan(0);
    expect(screen.getByText("Current lowest listing is $399.99.")).toBeTruthy();
    expect(screen.queryByText("1 listing matches this selection.")).toBeNull();
    expect(screen.queryByText("Sellers can review this offer for the selected product.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View making an offer details" }));
    expect(analytics.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "reference_info_opened",
          topic: "make_offer",
          outcome: "opened",
        }),
      ]),
    );
    const offerDialog = screen.getByRole("dialog", { name: "Making an offer" });
    expect(
      within(offerDialog).getByText("Your offer is for the selected product and eligible sellers can review it."),
    ).toBeTruthy();
    expect(within(offerDialog).getByText("You choose price and quantity before submitting.")).toBeTruthy();
    fireEvent.click(within(offerDialog).getByRole("button", { name: "Close reference detail" }));
    expect(screen.getByLabelText(/Offer price/)).toBeTruthy();
    expect(screen.getByLabelText(/Quantity/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make offer" })).toBeTruthy();
    expect(screen.queryByText("Selected seller")).toBeNull();
    expect(screen.queryByText("Selected seller signal")).toBeNull();

    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Choose market intent" })).getByRole("radio", {
        name: "Watch",
      }),
    );

    expect((await screen.findAllByText("Watch listings")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Get notified when matching supply appears at or below your target.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View listing alert details" }));
    expect(analytics.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "reference_info_opened",
          topic: "listing_alert",
          outcome: "opened",
        }),
      ]),
    );
    const listingAlertDialog = screen.getByRole("dialog", { name: "Listing alert" });
    expect(
      within(listingAlertDialog).getByText("Watch listings saves the selected product and target price."),
    ).toBeTruthy();
    expect(
      within(listingAlertDialog).getByText(
        "Alerts are created after account registration so notifications have an account destination.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(listingAlertDialog).getByRole("button", { name: "Close reference detail" }));
    expect(screen.getByLabelText("Maximum listing price")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set listing alert" })).toBeTruthy();
    expect(screen.queryByText("Offer details")).toBeNull();
    analytics.stop();
  });

  it("renders buy now as a single final CTA when selected as a workflow", () => {
    renderWithDataRouter(
      <CheckoutPurchaseIntentSection
        catalogItemId="cat_charizard"
        productId="cat_charizard::"
        selectedListing={baseListing}
        itemTitle="Charizard"
        selectedOptions={[]}
        productSelectionDetails={[
          { label: "Form", value: "Raw" },
          { label: "Condition", value: "Excellent" },
        ]}
        productSummary="Raw / Near Mint"
        visibleListingCount={1}
        actionMode="buy-now"
      />,
    );

    expect(screen.getByText("Selected listing")).toBeTruthy();
    expect(screen.queryByText("Check out with the selected listing.")).toBeNull();
    expect(screen.getByText("Selected price")).toBeTruthy();
    expect(screen.getByText("$399.99")).toBeTruthy();
    expect(screen.getByText("Chase Sets")).toBeTruthy();
    const availabilityLine = screen.getByText("2 available");
    expect(availabilityLine).toBeTruthy();
    expect(screen.getByLabelText("Product options: Form Raw, Condition Excellent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View buying this listing details" }));
    const buyListingDialog = screen.getByRole("dialog", { name: "Buying this listing" });
    expect(
      within(buyListingDialog).getByText("Buy this listing keeps checkout focused on this seller's listing."),
    ).toBeTruthy();
    expect(
      within(buyListingDialog).getByText("Quantity, price, and availability are checked again before payment."),
    ).toBeTruthy();
    fireEvent.click(within(buyListingDialog).getByRole("button", { name: "Close reference detail" }));
    const productQuantitySummary = availabilityLine.parentElement;
    expect(productQuantitySummary?.className).toContain("flex-col");
    expect(productQuantitySummary?.lastElementChild).toBe(availabilityLine);
    const productQuantityText = productQuantitySummary?.textContent ?? "";
    expect(productQuantityText.indexOf("Raw")).toBeGreaterThanOrEqual(0);
    expect(productQuantityText.indexOf("Raw")).toBeLessThan(productQuantityText.indexOf("2 available"));
    expect(screen.getByRole("button", { name: "Buy this listing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add listing to Buy Cart" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Buy optimized" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add product to cart" })).toBeNull();
  });

  it("labels implicit listing defaults as the best available listing", () => {
    renderWithDataRouter(
      <CheckoutPurchaseIntentSection
        catalogItemId="cat_charizard"
        productId="cat_charizard::"
        selectedListing={baseListing}
        selectedListingSource="implicit"
        itemTitle="Charizard"
        selectedOptions={[]}
        productSummary="Raw / Near Mint"
        visibleListingCount={1}
        actionMode="buy-now"
      />,
    );

    expect(screen.getByText("Best available listing")).toBeTruthy();
    expect(screen.getByText("Best available price")).toBeTruthy();
    expect(screen.queryByText("Selected listing")).toBeNull();
    expect(screen.getByRole("button", { name: "Buy best available listing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add listing to Buy Cart" })).toBeTruthy();
    expect(document.querySelector<HTMLInputElement>('input[name="sellerPreferenceId"]')?.value).toBe(
      "listing_charizard",
    );
  });

  it("keeps product Buy Cart adds product-level when a listing is selected", () => {
    renderWithDataRouter(
      <CheckoutPurchaseIntentSection
        catalogItemId="cat_charizard"
        productId="cat_charizard::"
        selectedListing={baseListing}
        selectedListingSource="explicit"
        itemTitle="Charizard"
        selectedOptions={[]}
        productSummary="Raw / Near Mint"
        visibleListingCount={1}
        actionMode="add-to-cart"
      />,
    );

    expect(screen.getByText("Selected product")).toBeTruthy();
    expect(screen.getByText("Product criteria")).toBeTruthy();
    expect(screen.getByText("1 listing matches this selection.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add product to Buy Cart" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buy best match" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add listing to Buy Cart" })).toBeNull();
    expect(screen.queryByText("Selected price")).toBeNull();
    expect(screen.queryByText("Chase Sets")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View buying this product details" }));
    const listingCartDialog = screen.getByRole("dialog", { name: "Buying this product" });
    expect(within(listingCartDialog).getByText("The Buy Cart saves the product and selected options.")).toBeTruthy();
    expect(
      within(listingCartDialog).getByText("Chase Sets finds an available listing during cart review."),
    ).toBeTruthy();
    expect(
      within(listingCartDialog).getByText("Buy best match opens Buy Cart with the selected product ready for review."),
    ).toBeTruthy();
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

    expect(screen.getByRole("button", { name: "Buy this listing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add listing to Buy Cart" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add product to Buy Cart" })).toBeNull();
    expect(screen.getByText("Selected price")).toBeTruthy();
    expect(screen.getByText("$399.99")).toBeTruthy();
    expect(screen.getByText("Chase Sets")).toBeTruthy();
    expect(screen.getByText("2 available")).toBeTruthy();
    expect(screen.queryByText("Selected seller")).toBeNull();
    expect(screen.queryByText("Availability")).toBeNull();
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
          buyer_slug: "top-loader-capital",
          buyer_average_rating: "4.60",
          buyer_review_count: 8,
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
        productSelectionDetails={[
          { label: "Form", value: "Raw" },
          { label: "Condition", value: "Near Mint" },
        ]}
        productSummary="Raw / Near Mint"
        matchingOfferCount={1}
      />,
    );

    expect(screen.getByText("$380.00 offer")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Top Loader Capital" }).getAttribute("href")).toBe(
      "/accounts/top-loader-capital#feedback",
    );
    expect(screen.getByText("4.6")).toBeTruthy();
    expect(screen.getByText("(8)")).toBeTruthy();
    expect(screen.getByLabelText("Product options: Form Raw, Condition Near Mint")).toBeTruthy();
    expect(screen.getByText("$353.35 after $26.65 fee")).toBeTruthy();
    expect(screen.getByText("$19.00 (5%)")).toBeTruthy();
    expect(screen.queryByText(/Seller-specific terms/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View estimated payout details" }));
    const payoutDialog = screen.getByRole("dialog", { name: "Estimated payout" });
    expect(within(payoutDialog).getByText("Estimated payout uses Seller-specific terms.")).toBeTruthy();
    expect(within(payoutDialog).getByText("Seller-specific terms")).toBeTruthy();
    expect(within(payoutDialog).getByText("Marketplace sales fee")).toBeTruthy();
    expect(within(payoutDialog).getByText("$26.65")).toBeTruthy();
    expect(
      within(payoutDialog).getByText(
        "Accepting creates a seller commitment after registration, inventory/readiness checks, and final terms review.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/csg_seller_override/)).toBeNull();
  });

  it("can route guest Accept offer through the Sell List handoff intent", () => {
    render(
      <MarketplaceOfferMatchSection
        selectedOffer={{
          ...baseAccountOfferMatch,
          price_amount: "380.00",
        }}
        sellNowIntent="add-to-sell-list"
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        matchingOfferCount={1}
      />,
    );

    const acceptOffer = screen.getByRole("button", { name: "Accept offer" });

    expect(acceptOffer.getAttribute("name")).toBe("intent");
    expect(acceptOffer.getAttribute("value")).toBe("add-to-sell-list");
    expect(screen.getByRole("button", { name: "Add offer to Sell List" }).getAttribute("value")).toBe(
      "add-to-sell-list",
    );
  });

  it("labels implicit offer defaults as the best offer", () => {
    render(
      <MarketplaceOfferMatchSection
        selectedOffer={{
          ...baseAccountOfferMatch,
          price_amount: "380.00",
        }}
        selectedOfferSource="implicit"
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        matchingOfferCount={1}
      />,
    );

    expect(screen.getByText("Best offer")).toBeTruthy();
    expect(screen.queryByText("Selected offer")).toBeNull();
  });

  it("keeps the sell rail offer action reachable when account offer enrichment is unavailable", async () => {
    renderItemDetailRoute({
      item: createItem({
        offer_demand_matches: [{ ...baseOffer, price_amount: "380.00" }],
      }),
      accountOfferMatches: [],
      sellerInventoryItems: [],
      sellerAccountId: "seller_1",
      hasListingStockLocation: true,
      listingSetupLoadState: "ready",
      viewerAccountId: "seller_1",
      initialMarketIntent: "sell",
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
      productAlertClaimError: null,
      listingSetupLoadError: null,
    });

    const selectedOfferAction = (await screen.findAllByRole("button", { name: /Best offer/ }))[0];

    expect(selectedOfferAction.getAttribute("data-disabled")).not.toBe("true");
    expect(selectedOfferAction.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("routes signed-out sell rail Accept offer through the Sell List handoff intent", async () => {
    renderItemDetailRoute({
      item: createItem({
        offer_demand_matches: [{ ...baseOffer, price_amount: "380.00" }],
      }),
      accountOfferMatches: [],
      sellerInventoryItems: [],
      sellerAccountId: null,
      hasListingStockLocation: false,
      listingSetupLoadState: "not-applicable",
      viewerAccountId: null,
      initialMarketIntent: "sell",
      initialSelectedOptions: [],
      hasInitialSelectedOptionFilters: false,
      showSellerTab: true,
      canUseSellerFeatures: false,
      canUseListingFeatures: false,
      canSubmitOffers: true,
      registerToSellHref: "/register",
      notFound: false,
      error: null,
      canonicalUrl: null,
      productAlertClaimError: null,
      listingSetupLoadError: null,
    });

    const acceptOffer = await screen.findByRole("button", { name: "Accept offer" });

    expect(acceptOffer.getAttribute("value")).toBe("add-to-sell-list");
  });

  it("does not show raw buyer ids in selected offer match fallback identity", () => {
    render(
      <MarketplaceOfferMatchSection
        selectedOffer={{
          ...baseAccountOfferMatch,
          buyer_account_id: "buyer_private_internal_id",
          buyer_display_name: null,
          buyer_average_rating: "4.20",
          buyer_review_count: 5,
          price_amount: "380.00",
        }}
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        matchingOfferCount={1}
      />,
    );

    expect(screen.getByText("Buyer")).toBeTruthy();
    expect(screen.getByText("4.2")).toBeTruthy();
    expect(screen.getByText("(5)")).toBeTruthy();
    expect(screen.queryByText("buyer_private_internal_id")).toBeNull();
  });

  it("keeps offer Sell List guidance in Reference Info", () => {
    render(
      <MarketplaceOfferMatchSection
        selectedOffer={{
          ...baseAccountOfferMatch,
          price_amount: "380.00",
          buyer_display_name: "Top Loader Capital",
          in_sell_list: false,
          acceptance_terms: {
            account_type: "personal",
            basis_amount: "380.00",
            marketplace_sales_fee_unit_amount: "26.65",
            seller_net_unit_amount: "353.35",
            shipping_allowance_percentage_bps: 500,
            schedule_id: null,
            agreement_id: null,
            resolved_at: "2026-05-05T16:36:36.000Z",
            fee_quote_fingerprint: "380.00|26.65|353.35|500|||",
          },
        }}
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        matchingOfferCount={1}
        actionMode="add-to-sell-list"
      />,
    );

    expect(screen.getByText("$353.35 after $26.65 fee")).toBeTruthy();
    expect(screen.queryByText("Saving is not acceptance and does not create a sale.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View offer in Sell List details" }));
    const offerSellListDialog = screen.getByRole("dialog", { name: "Offer in Sell List" });
    expect(within(offerSellListDialog).getByText("The Sell List saves this offer for review.")).toBeTruthy();
    expect(within(offerSellListDialog).getByText("Saving is not acceptance and does not create a sale.")).toBeTruthy();
    expect(
      within(offerSellListDialog).getByText(
        "Create an account or sign in when you are ready to review final terms and commit.",
      ),
    ).toBeTruthy();
  });

  it("uses explicit offer URL state instead of the implicit best offer default", () => {
    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [baseListing],
          offer_demand_matches: [baseOffer, alternateOffer],
        })}
        accountOfferMatches={[baseAccountOfferMatch, alternateAccountOfferMatch]}
        initialMarketIntent="sell"
        initialSelectedOfferId="offer_charizard"
        renderCommerce={(context) => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: (
            <form>
              <input
                data-testid="selected-offer-id"
                readOnly
                value={context.selectedAccountOfferMatch?.offer_id ?? ""}
              />
              <input data-testid="selected-offer-source" readOnly value={context.selectedOfferSource} />
            </form>
          ),
        })}
      />,
    );

    expect(screen.getByTestId("selected-offer-id")).toHaveProperty("value", "offer_charizard");
    expect(screen.getByTestId("selected-offer-source")).toHaveProperty("value", "explicit");
    const selectedOfferRow = screen.getByRole("article", { name: "Offer $350.00 from Ash Ketchum" });
    const selectedOfferQuantity = within(selectedOfferRow).getByText("1 requested");
    expect(selectedOfferQuantity.parentElement?.className).toContain("flex-col");
    expect(selectedOfferQuantity.parentElement?.lastElementChild).toBe(selectedOfferQuantity);
    expect(screen.getByRole("button", { name: "Selected Ash Ketchum offer at $350.00" })).toBeTruthy();
  });

  it("recovers stale explicit offer URL state to the implicit default", () => {
    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [baseListing],
          offer_demand_matches: [baseOffer, alternateOffer],
        })}
        accountOfferMatches={[baseAccountOfferMatch, alternateAccountOfferMatch]}
        initialMarketIntent="sell"
        initialSelectedOfferId="offer_missing"
        renderCommerce={(context) => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
          sell: (
            <form>
              <input
                data-testid="selected-offer-id"
                readOnly
                value={context.selectedAccountOfferMatch?.offer_id ?? ""}
              />
              <input data-testid="selected-offer-source" readOnly value={context.selectedOfferSource} />
              <input data-testid="stale-offer-id" readOnly value={context.staleSelectedOfferId ?? ""} />
            </form>
          ),
        })}
      />,
    );

    expect(screen.getByText("Offer unavailable")).toBeTruthy();
    expect(
      screen.getByText("That offer is no longer available. Showing the best offer for this product instead."),
    ).toBeTruthy();
    expect(screen.getByTestId("selected-offer-id")).toHaveProperty("value", "offer_charizard_alt");
    expect(screen.getByTestId("selected-offer-source")).toHaveProperty("value", "implicit");
    expect(screen.getByTestId("stale-offer-id")).toHaveProperty("value", "offer_missing");
  });

  it("changes the selected offer when another offer is clicked", async () => {
    window.history.replaceState(null, "", "/items/charizard-base-set?market=sell");

    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [baseListing],
          offer_demand_matches: [baseOffer, alternateOffer],
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
              <input data-testid="selected-offer-source" readOnly value={context.selectedOfferSource} />
            </form>
          ),
        })}
      />,
    );

    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Choose market intent" })).getByRole("radio", {
        name: "Sell",
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Misty/ }).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(screen.getByTestId("selected-offer-id")).toHaveProperty("value", "offer_charizard_alt");

    fireEvent.click(screen.getByRole("button", { name: /Ash Ketchum/ }));

    expect(screen.getByRole("button", { name: /Ash Ketchum/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("selected-offer-id")).toHaveProperty("value", "offer_charizard");
    expect(screen.getByTestId("selected-offer-source")).toHaveProperty("value", "explicit");
    const url = new URL(window.location.href);
    expect(url.searchParams.get("offer")).toBe("offer_charizard");
    expect(url.searchParams.get("listing")).toBeNull();
  });

  it("shows the viewer's own offer without selecting it for seller acceptance", async () => {
    render(
      <ItemDetailPage
        data={createItem({
          market_listings: [baseListing],
          offer_demand_matches: [baseOffer, alternateOffer],
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
      within(screen.getByRole("radiogroup", { name: "Choose market intent" })).getByRole("radio", {
        name: "Sell",
      }),
    );

    expect(await screen.findByRole("button", { name: /Misty/ })).toBeTruthy();
    expect(screen.getByText("Your offer")).toBeTruthy();
    expect(screen.getByText("Visible to eligible sellers. You cannot accept your own offer.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ash Ketchum/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("selected-offer-id")).toHaveProperty("value", "offer_charizard");
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

    const { container } = render(
      <ItemDetailPage
        data={createItem({
          product_schema: variantSchema,
          market_listings: [rawListing],
          offer_demand_matches: [gradedOffer],
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
              <input data-testid="selected-options" readOnly value={JSON.stringify(context.selectedProductOptions)} />
            </form>
          ),
        })}
      />,
    );

    const mobileProductOptions = within(container.querySelector("[data-product-options-mobile]") as HTMLElement);
    expect(screen.getByTestId("sell-product-summary").textContent).toBe("Selected sell product Graded");
    expect(mobileProductOptions.getByText("Graded · 1 requested from $360.00")).toBeTruthy();
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
          offer_demand_matches: [],
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
          offer_demand_matches: [],
        })}
        renderCommerce={(context) => ({
          buy: (
            <form>
              <div>Selected product {context.selectedProductSummary ?? "none"}</div>
              <input data-testid="selected-options" readOnly value={JSON.stringify(context.selectedProductOptions)} />
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

    expect(screen.getByText("Selected product Graded")).toBeTruthy();
    expect(screen.getByTestId("selected-options")).toHaveProperty(
      "value",
      JSON.stringify([{ dimensionId: "form", optionId: "graded" }]),
    );
  });
});
