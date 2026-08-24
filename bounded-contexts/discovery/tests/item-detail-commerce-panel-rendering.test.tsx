// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";
import {
  ItemCommercePanel,
  BuyActionCard,
  CheckoutPurchaseIntentSection,
  MarketplaceListingSubmissionSection,
  MarketplaceOfferMatchSection,
  MarketplaceSellerRegistrationSection,
  ProductSellListIntentSection,
  SellActionCard,
  WatchActionCard,
} from "../routes/item-detail";
import {
  alternateListing,
  alternateOffer,
  baseAccountOfferMatch,
  baseListing,
  baseOffer,
  captureItemDetailRailAnalytics,
  createItem,
  expansionReference,
  renderItemDetailRoute,
  renderWithDataRouter,
  requiredSchema,
} from "./item-detail-commerce-panel-test-harness";

vi.mock("@chase-sets/platform-runtime/realtime-react", () => ({
  useRealtimePatchedSnapshot: ({ initialSnapshot }: { initialSnapshot: unknown }) => initialSnapshot,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("item detail commerce panel rendering and mobile sections", () => {
  it("resolved phone Product options collapse to one canonical summary", () => {
    const rawListing = {
      ...baseListing,
      product_id: "cat_charizard::form:raw",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Raw",
    };
    const { container } = render(
      <ItemDetailPage
        data={createItem({ product_schema: requiredSchema, market_listings: [rawListing] })}
        initialSelectedOptions={[{ dimensionId: "form", optionId: "raw" }]}
        hasInitialSelectedOptionFilters
      />,
    );

    const surface = container.querySelector("[data-product-options-surface]") as HTMLElement;
    const mobile = within(surface.querySelector("[data-product-options-mobile]") as HTMLElement);
    const trigger = mobile.getByRole("button", { name: /Chosen options/ });
    const desktopPanel = surface.querySelector<HTMLElement>(
      "[data-product-options-desktop] .rounded-tokenLg.overflow-hidden",
    );

    expect(surface.getAttribute("data-product-id")).toBe("cat_charizard::form:raw");
    expect(desktopPanel?.classList.contains("bg-surface-2")).toBe(true);
    expect(desktopPanel?.classList.contains("shadow-tokenSm")).toBe(false);
    expect(desktopPanel?.classList.contains("ds-glass")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(mobile.getAllByLabelText("Product options: Form Raw")).toHaveLength(1);
    expect(mobile.queryByRole("radiogroup", { name: "Form" })).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(mobile.getByRole("radiogroup", { name: "Form" })).toBeTruthy();
  });

  it("shopper-action Product options stay expanded", () => {
    const { container } = render(
      <ItemDetailPage
        data={createItem({ product_schema: requiredSchema, market_listings: [], offer_demand_matches: [] })}
        initialSelectedOptions={[{ dimensionId: "form", optionId: "removed-required-option" }]}
        hasInitialSelectedOptionFilters
      />,
    );

    const surface = container.querySelector("[data-product-options-surface]") as HTMLElement;
    const mobile = within(surface.querySelector("[data-product-options-mobile]") as HTMLElement);
    const trigger = mobile.getByRole("button", { name: "Choose options" });

    expect(surface.getAttribute("data-product-id")).toBe("");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(mobile.getByRole("radiogroup", { name: "Form" })).toBeTruthy();
    expect(mobile.getByRole("radio", { name: "Any" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("uses Product Asset Set detail variants before compatibility image URLs", () => {
    renderWithDataRouter(
      <ItemDetailPage
        data={createItem({
          image_urls: ["/legacy-detail.webp"],
          product_asset_sets: [
            {
              kind: "product-image",
              sourceHash: "source_hash",
              source: {
                role: "source",
                width: 480,
                height: 672,
                density: null,
                mediaType: "image/webp",
                storageKey: "catalog/items/cat_test/product-image/source.webp",
                publicUrl: "/source.webp",
                byteSize: 100,
                generatedAt: "2026-05-20T00:00:00.000Z",
              },
              variants: [
                {
                  role: "catalog-detail",
                  width: 480,
                  height: 672,
                  density: 1,
                  mediaType: "image/webp",
                  storageKey: "catalog/items/cat_test/product-image/catalog-detail-480w-1x.webp",
                  publicUrl: "/catalog-detail-480w.webp",
                  byteSize: 80,
                  generatedAt: "2026-05-20T00:00:00.000Z",
                },
                {
                  role: "catalog-detail",
                  width: 960,
                  height: 1344,
                  density: 2,
                  mediaType: "image/webp",
                  storageKey: "catalog/items/cat_test/product-image/catalog-detail-960w-2x.webp",
                  publicUrl: "/catalog-detail-960w.webp",
                  byteSize: 120,
                  generatedAt: "2026-05-20T00:00:00.000Z",
                },
                {
                  role: "thumbnail",
                  width: 96,
                  height: 134,
                  density: 1,
                  mediaType: "image/webp",
                  storageKey: "catalog/items/cat_test/product-image/thumbnail-96w-1x.webp",
                  publicUrl: "/thumbnail-96w.webp",
                  byteSize: 40,
                  generatedAt: "2026-05-20T00:00:00.000Z",
                },
              ],
            },
          ],
        })}
      />,
    );

    const image = screen.getByRole("img", { name: "Charizard image 1" });
    expect(image.getAttribute("src")).toBe("/catalog-detail-480w.webp");
    expect(image.getAttribute("srcset")).toBe("/catalog-detail-480w.webp 480w, /catalog-detail-960w.webp 960w");
    expect(image.getAttribute("sizes")).toBe("(min-width: 768px) 308px, min(100vw, 276px)");
    expect(image.getAttribute("width")).toBe("480");
    expect(image.getAttribute("height")).toBe("672");
  });

  it("renders the empty-image well with the flush surface recipe", () => {
    const { container } = render(
      <ItemDetailPage
        data={createItem({
          image_urls: [],
          product_asset_sets: [],
          image_fallback: {
            url: "/loading-only-fallback.webp",
            alt: "Loading item image",
            usage: "loading-only",
            variants: {},
          },
        })}
      />,
    );

    expect(screen.getByText("Catalog imagery has not been added yet.")).toBeTruthy();
    const imageWell = container.querySelector<HTMLElement>(".modern-surface .min-w-0.max-w-full.rounded-tokenLg.p-4");

    expect(imageWell).not.toBeNull();
    expect(imageWell?.classList.contains("bg-surface-2")).toBe(false);
    expect(imageWell?.classList.contains("surface-border")).toBe(false);
    expect(imageWell?.classList.contains("shadow-tokenLg")).toBe(false);
  });

  it("renders item detail language codes as localized labels", async () => {
    renderWithDataRouter(<ItemDetailPage data={createItem({ language_code: "ja" })} />);

    fireEvent.click(screen.getByRole("tab", { name: "Details" }));

    await waitFor(() => expect(screen.getByText("Japanese")).toBeTruthy());
    expect(screen.queryByText("ja")).toBeNull();
  });

  it("renders inherited reference rows and opens reference details", async () => {
    renderWithDataRouter(
      <ItemDetailPage
        data={createItem({
          field_values: [
            {
              fieldId: "fld_seed_expansion",
              fieldName: "fld_seed_expansion",
              value: { referenceId: "ref_expansion" },
              reference: expansionReference(),
            },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Details" }));

    await waitFor(() => expect(screen.getByText("Expansion")).toBeTruthy());
    const referenceValueTrigger = screen.getAllByRole("button", {
      name: "View Expansion reference details for Perfect Order",
    })[0];

    expect(referenceValueTrigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(referenceValueTrigger.className).toContain("text-accent");
    expect(referenceValueTrigger.className).toContain("hover:underline");
    expect(referenceValueTrigger.className).not.toContain("min-h-8");
    expect(referenceValueTrigger.className).not.toContain("text-xs");
    expect(screen.getByText("Series")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "View Series reference details for Mega Evolution" })[0]).toBeTruthy();
    expect(screen.queryByText("fld_seed_expansion")).toBeNull();

    fireEvent.click(referenceValueTrigger);

    const dialog = screen.getByRole("dialog", { name: "Perfect Order" });
    expect(within(dialog).getByText("Reference type")).toBeTruthy();
    expect(within(dialog).getAllByText("Expansion")[0]).toBeTruthy();
    expect(within(dialog).getByText("tcgdex-set-id")).toBeTruthy();
    expect(within(dialog).getByText("me03")).toBeTruthy();
    expect(within(dialog).getByText("Part Of")).toBeTruthy();
    expect(within(dialog).getByText("Mega Evolution")).toBeTruthy();
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

    expect(screen.getByRole("radio", { name: "Buy" })).toBeTruthy();
    const sellOption = screen.getByRole("radio", { name: "Sell" });
    expect(sellOption).toBeTruthy();

    fireEvent.click(sellOption);

    expect(screen.getByText("List this product")).toBeTruthy();
    expect(screen.getByText("Product")).toBeTruthy();
    expect(screen.getByLabelText("Raw / Near Mint")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Continue to sell" }).getAttribute("href")).toBe(
      "/register?returnTo=%2Fitems%2Fcat_charizard",
    );
    expect(screen.queryByRole("link", { name: "Register to sell" })).toBeNull();
  });

  it("uses buyer demand in the signed-out sell registration module", () => {
    render(
      <MarketplaceSellerRegistrationSection
        productSummary="Raw / Near Mint"
        selectedOffer={{
          buyer_account_id: "buyer_1",
          buyer_display_name: "Top Loader Capital",
          buyer_slug: "top-loader-capital",
          buyer_average_rating: "4.80",
          buyer_review_count: 12,
          price_amount: "380.00",
          quantity_requested: 1,
          public_standard_terms_preview: {
            account_type: "personal",
            basis_amount: "380.00",
            marketplace_sales_fee_unit_amount: "34.35",
            seller_net_unit_amount: "345.65",
            shipping_allowance_percentage_bps: 500,
            source_kind: "public-standard-seller-terms",
            source_label: "Standard seller terms",
            schedule_label: "Personal Default",
            source_updated_at: "2026-05-05T16:36:36.000Z",
            resolved_at: "2026-05-05T16:36:36.000Z",
          },
        }}
        matchingOfferCount={5}
        registerHref="/register?returnTo=%2Fitems%2Fcat_charizard"
      />,
    );

    expect(screen.getByText("Selected offer")).toBeTruthy();
    expect(screen.getByText("$380.00 offer")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Top Loader Capital" }).getAttribute("href")).toBe(
      "/accounts/top-loader-capital#feedback",
    );
    expect(screen.getByText("4.8")).toBeTruthy();
    expect(screen.getByText("(12)")).toBeTruthy();
    expect(screen.getByText("5 offers")).toBeTruthy();
    expect(screen.getByText("1 requested")).toBeTruthy();
    expect(screen.getByText("$345.65")).toBeTruthy();
    expect(screen.queryByText("$345.65 after $34.35 fee")).toBeNull();
    expect(screen.queryByText("$34.35")).toBeNull();
    expect(screen.queryByText("$19.00 (5%)")).toBeNull();
    expect(screen.getAllByText("Raw / Near Mint")).toHaveLength(2);
    expect(screen.queryByText("Estimated payout uses Standard seller terms.")).toBeNull();
    expect(
      screen.queryByText("Register to confirm inventory, see seller payout, and accept matching offers."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View estimated payout details" }));
    const payoutDialog = screen.getByRole("dialog", { name: "Estimated payout" });
    expect(within(payoutDialog).getByText("Estimated payout uses Standard seller terms.")).toBeTruthy();
    expect(within(payoutDialog).getByText("Payout facts")).toBeTruthy();
    expect(within(payoutDialog).getByText("Marketplace sales fee")).toBeTruthy();
    expect(within(payoutDialog).getByText("$34.35")).toBeTruthy();
    expect(within(payoutDialog).getByText("Shipping allowance")).toBeTruthy();
    expect(within(payoutDialog).getByText("$19.00 (5%)")).toBeTruthy();
    expect(within(payoutDialog).getByText("Terms source")).toBeTruthy();
    expect(within(payoutDialog).getByText("Standard seller terms")).toBeTruthy();
    fireEvent.click(within(payoutDialog).getByRole("button", { name: "Close reference detail" }));
    expect(screen.getByRole("link", { name: "Continue to accept offer" }).getAttribute("href")).toBe(
      "/register?returnTo=%2Fitems%2Fcat_charizard",
    );
    expect(screen.getByText("Create listing")).toBeTruthy();
    expect(screen.queryByText("Create a listing for this product instead.")).toBeNull();
    expect(screen.getByText("Asking price")).toBeTruthy();
    expect(screen.getByText("Set before publishing")).toBeTruthy();
    expect(screen.getByText("Inventory")).toBeTruthy();
    expect(screen.getByText("Confirm before publishing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View creating a listing details" }));
    const createListingDialog = screen.getByRole("dialog", { name: "Creating a listing" });
    expect(
      within(createListingDialog).getByText("A listing publishes your price and quantity for this product."),
    ).toBeTruthy();
    expect(
      within(createListingDialog).getByText("Guests can draft the price and quantity before registration."),
    ).toBeTruthy();
    expect(
      within(createListingDialog).getByText(
        "Publication requires account, seller readiness, ship-from, and final validation.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(createListingDialog).getByRole("button", { name: "Close reference detail" }));
    expect(screen.getByRole("link", { name: "Continue to create listing" }).getAttribute("href")).toBe(
      "/register?returnTo=%2Fitems%2Fcat_charizard",
    );
  });

  it("tracks guest payout preview, reference info, and registration gates", async () => {
    const analytics = captureItemDetailRailAnalytics();

    render(
      <MarketplaceSellerRegistrationSection
        productSummary="Raw / Near Mint"
        selectedOffer={{
          buyer_account_id: "buyer_1",
          buyer_display_name: "Top Loader Capital",
          price_amount: "380.00",
          quantity_requested: 1,
          public_standard_terms_preview: {
            account_type: "personal",
            basis_amount: "380.00",
            marketplace_sales_fee_unit_amount: "34.35",
            seller_net_unit_amount: "345.65",
            shipping_allowance_percentage_bps: 500,
            source_kind: "public-standard-seller-terms",
            source_label: "Standard seller terms",
            resolved_at: "2026-05-05T16:36:36.000Z",
          },
        }}
        matchingOfferCount={5}
        registerHref="/register?returnTo=%2Fitems%2Fcat_charizard"
      />,
    );

    await waitFor(() =>
      expect(analytics.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "payout_preview_shown",
            intent: "sell",
            workflow: "selected_offer",
            topic: "estimated_payout",
            outcome: "shown",
            surface: "guest_registration",
          }),
          expect.objectContaining({
            event: "registration_gate_shown",
            intent: "sell",
            workflow: "selected_offer",
            gate: "accept_offer",
            viewer: "guest",
          }),
          expect.objectContaining({
            event: "registration_gate_shown",
            intent: "sell",
            workflow: "create_listing",
            gate: "create_listing",
            viewer: "guest",
          }),
        ]),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "View estimated payout details" }));
    expect(analytics.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "reference_info_opened",
          topic: "estimated_payout",
          outcome: "opened",
        }),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close reference detail" }));

    fireEvent.click(screen.getByRole("link", { name: "Continue to accept offer" }));
    expect(analytics.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "registration_started",
          intent: "sell",
          workflow: "selected_offer",
          gate: "accept_offer",
          viewer: "guest",
        }),
      ]),
    );

    analytics.stop();
  });

  it("does not invent a guest payout when the public standard terms preview is missing", async () => {
    const analytics = captureItemDetailRailAnalytics();

    render(
      <MarketplaceSellerRegistrationSection
        productSummary="Raw / Near Mint"
        selectedOffer={{
          buyer_account_id: "buyer_1",
          buyer_display_name: "Top Loader Capital",
          price_amount: "380.00",
          quantity_requested: 1,
          public_standard_terms_preview: null,
        }}
        matchingOfferCount={5}
        registerHref="/register?returnTo=%2Fitems%2Fcat_charizard"
      />,
    );

    expect(screen.queryByText(/after .* fee/)).toBeNull();
    expect(screen.queryByText("buyer_1")).toBeNull();
    expect(screen.getByText("Top Loader Capital")).toBeTruthy();
    expect(screen.getByText(/Estimated payout is temporarily unavailable/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View estimated payout details" })).toBeNull();
    expect(screen.getByRole("link", { name: "Continue to accept offer" }).getAttribute("href")).toBe(
      "/register?returnTo=%2Fitems%2Fcat_charizard",
    );
    await waitFor(() =>
      expect(analytics.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "standard_preview_unavailable",
            intent: "sell",
            workflow: "selected_offer",
            topic: "estimated_payout",
            outcome: "unavailable",
            surface: "guest_registration",
          }),
        ]),
      ),
    );
    analytics.stop();
  });

  it("shows a guest selected-offer payout preview without inventing seller availability", () => {
    render(
      <MarketplaceOfferMatchSection
        selectedOffer={{
          offer_id: "offer_charizard",
          buyer_account_id: "buyer_private_internal_id",
          buyer_display_name: "Top Loader Capital",
          price_amount: "380.00",
          quantity_requested: 1,
          product_summary: "Raw / Near Mint",
          buyer_slug: "top-loader-capital",
          buyer_average_rating: "4.80",
          buyer_review_count: 12,
          acceptance_terms: {
            account_type: "personal",
            basis_amount: "380.00",
            marketplace_sales_fee_unit_amount: "34.35",
            seller_net_unit_amount: "345.65",
            shipping_allowance_percentage_bps: 500,
            source_kind: "public-standard-seller-terms",
            source_label: "Standard seller terms",
            schedule_label: "Personal Default",
            source_updated_at: "2026-05-05T16:36:36.000Z",
            resolved_at: "2026-05-05T16:36:36.000Z",
          },
        }}
        selectedOfferSource="explicit"
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        matchingOfferCount={1}
      />,
    );

    expect(screen.getByText("Selected offer")).toBeTruthy();
    expect(screen.getByText("$380.00 offer")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Top Loader Capital" })).toBeTruthy();
    expect(screen.getByText("1 requested")).toBeTruthy();
    expect(screen.queryByText(/available/)).toBeNull();
    expect(screen.queryByText("Can fulfill")).toBeNull();
    expect(screen.getByText("$345.65 after $34.35 fee")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept offer" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Add offer to Sell List" })).toHaveProperty("disabled", false);
    expect(screen.queryByText("Estimated payout uses Standard seller terms.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View estimated payout details" }));
    const payoutDialog = screen.getByRole("dialog", { name: "Estimated payout" });
    expect(within(payoutDialog).getByText("Estimated payout uses Standard seller terms.")).toBeTruthy();
    expect(within(payoutDialog).getByText("Marketplace sales fee")).toBeTruthy();
    expect(within(payoutDialog).getByText("$34.35")).toBeTruthy();
    expect(within(payoutDialog).getByText("Shipping allowance")).toBeTruthy();
    expect(within(payoutDialog).getByText("$19.00 (5%)")).toBeTruthy();
    expect(
      within(payoutDialog).getByText(
        "Create an account or sign in when you are ready to review final terms and commit.",
      ),
    ).toBeTruthy();
  });

  it("uses a generic buyer label instead of raw account id when public display name is missing", () => {
    render(
      <MarketplaceSellerRegistrationSection
        productSummary="Raw / Near Mint"
        selectedOffer={{
          buyer_account_id: "buyer_private_internal_id",
          buyer_display_name: null,
          buyer_average_rating: "4.90",
          buyer_review_count: 3,
          price_amount: "380.00",
          quantity_requested: 1,
          public_standard_terms_preview: {
            account_type: "personal",
            basis_amount: "380.00",
            marketplace_sales_fee_unit_amount: "34.35",
            seller_net_unit_amount: "345.65",
            shipping_allowance_percentage_bps: 500,
            source_kind: "public-standard-seller-terms",
            source_label: "Standard seller terms",
            schedule_label: "Personal Default",
            source_updated_at: "2026-05-05T16:36:36.000Z",
            resolved_at: "2026-05-05T16:36:36.000Z",
          },
        }}
        matchingOfferCount={1}
        registerHref="/register?returnTo=%2Fitems%2Fcat_charizard"
      />,
    );

    expect(screen.getByText("Buyer")).toBeTruthy();
    expect(screen.getByText("4.9")).toBeTruthy();
    expect(screen.getByText("(3)")).toBeTruthy();
    expect(screen.queryByText("buyer_private_internal_id")).toBeNull();
  });

  it("shows listing price and quantity in the create listing workflow", () => {
    render(
      <MarketplaceListingSubmissionSection
        formId="list-at-price-form"
        productId="cat_charizard::"
        selectedOptions={[]}
        productSummary="Raw / Near Mint"
        bestListing={baseListing}
        ownListing={null}
        hasListingStockLocation
      />,
    );

    const listAction = screen.getByRole("button", { name: "Create listing" });
    expect(listAction.closest("form")?.id).toBe("list-at-price-form");
    expect(listAction).toHaveProperty("disabled", false);
    expect(screen.getByText("List this product")).toBeTruthy();
    expect(screen.getByText("Current best listing is 399.99.")).toBeTruthy();
    expect(screen.getByLabelText(/Listing price/)).toHaveProperty("value", "399.99");
    expect(screen.getByLabelText(/Quantity/)).toHaveProperty("value", "1");
    expect(screen.queryByText("Listing stock is created automatically.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View creating a listing details" }));
    expect(screen.getByRole("dialog", { name: "Creating a listing" })).toBeTruthy();
    expect(screen.queryByLabelText("Ship-from name")).toBeNull();
  });

  it("moves missing ship-from setup into a separate component", () => {
    const { container } = render(
      <MarketplaceListingSubmissionSection
        formId="list-at-price-form"
        productId="cat_charizard::"
        selectedOptions={[]}
        productSummary="Raw / Near Mint"
        bestListing={baseListing}
        ownListing={null}
        hasListingStockLocation={false}
      />,
    );

    const listAction = screen.getByRole("button", { name: "Create listing" });
    const listForm = listAction.closest("form") as HTMLFormElement;
    expect(listForm.id).toBe("list-at-price-form");
    expect(listAction).toHaveProperty("disabled", true);
    expect(screen.getByLabelText(/Listing price/)).toBeTruthy();
    expect(screen.getByLabelText(/Quantity/)).toBeTruthy();
    expect(listForm.querySelector("[name='shipFromName']")).toBeNull();

    const shipFromName = container.querySelector("[name='shipFromName']") as HTMLInputElement | null;
    expect(shipFromName?.closest("form")?.id).toBe("list-at-price-form-ship-from-setup");
    expect(screen.getByRole("button", { name: "Save ship-from setup" })).toBeTruthy();
  });

  it("shows ship-from setup recovery without re-opening setup inputs", () => {
    render(
      <MarketplaceListingSubmissionSection
        formId="list-at-price-form"
        productId="cat_charizard::"
        selectedOptions={[]}
        productSummary="Raw / Near Mint"
        bestListing={baseListing}
        ownListing={null}
        hasListingStockLocation={false}
        listingSetupLoadState="fresh-write-recovering"
        errorMessage="Ship-from setup is still updating. Refresh in a moment if it is not visible yet."
      />,
    );

    expect(screen.getByRole("button", { name: "Create listing" })).toHaveProperty("disabled", true);
    expect(
      screen.getByText("Ship-from setup is still updating. Refresh in a moment if it is not visible yet."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Ship-from name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save ship-from setup" })).toBeNull();
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

    expect(imageFrame?.className).toContain("max-w-[min(100%,17.25rem)]");
    expect(imageFrame?.className).toContain("md:max-w-[min(100%,19.25rem)]");
    expect(imageFrame?.className).toContain("[--gallery-max-height:27rem]");

    const galleryRoot = imageFrame?.parentElement;
    expect(galleryRoot?.className).toContain("flex items-start justify-center gap-3");
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
            sell: { content: <div>Mobile sell action</div> },
            watch: { content: <div>Mobile watch action</div> },
          },
        })}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Buy" })[0]);

    const buySheet = screen.getByRole("dialog", { name: "Best available listing" });
    expect(buySheet).toBeTruthy();
    expect(
      within(buySheet).getByText("Buy the current best listing, save this product to Buy Cart, or make an offer."),
    ).toBeTruthy();
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
                    selectedListingSource={context.selectedListingSource}
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

    const buySheet = screen.getByRole("dialog", { name: "Best available listing" });
    expect(
      within(buySheet).getByText("Buy the current best listing, save this product to Buy Cart, or make an offer."),
    ).toBeTruthy();
    expect(within(buySheet).getByRole("spinbutton", { name: /Quantity/ })).toBeTruthy();
    expect(within(buySheet).getByRole("button", { name: "Buy best available listing" })).not.toHaveProperty(
      "disabled",
      true,
    );
    expect(within(buySheet).getByRole("button", { name: "Add listing to Buy Cart" })).toBeTruthy();
    expect(within(buySheet).queryByRole("button", { name: "Add product to Buy Cart" })).toBeNull();
    expect(within(buySheet).getByRole("button", { name: "View buying this listing details" })).toBeTruthy();
    expect(within(buySheet).queryByText("Desktop buy rail")).toBeNull();
  });

  it("surfaces verified grading certificate facts without implying physical authentication", () => {
    const verifiedListing = {
      ...baseListing,
      product_summary: "PSA 10",
      graded_card: {
        gradingCompany: "PSA",
        grade: "10",
        certificationNumber: "81234567",
        population: null,
        conditionDescriptors: ["slabbed"],
        registryVerification: {
          state: "verified" as const,
          provider: "PSA",
          verifiedAt: "2026-07-07T12:00:00.000Z",
          lookupUrl: "https://www.psacard.com/cert/81234567",
        },
      },
    };

    renderWithDataRouter(
      <CheckoutPurchaseIntentSection
        catalogItemId="cat_charizard"
        productId="cat_charizard::graded:psa-10"
        selectedListing={verifiedListing}
        selectedListingSource="explicit"
        itemTitle="Charizard"
        selectedOptions={[]}
        productSummary="PSA 10"
        visibleListingCount={1}
      />,
    );

    expect(screen.getByText("Registry match")).toBeTruthy();
    expect(screen.getByText("PSA 10 cert 81234567")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View registry lookup" }).getAttribute("href")).toBe(
      "https://www.psacard.com/cert/81234567",
    );

    fireEvent.click(screen.getByRole("button", { name: "View grading certificate verification details" }));

    const dialog = screen.getByRole("dialog", { name: "Grading cert registry match" });
    expect(
      within(dialog).getByText(
        "The grading company registry returned card identity and grade data that matched this listing's catalog item and grade.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "This is a registry data match only. It is not Chase Sets authentication of the physical card or slab.",
      ),
    ).toBeTruthy();
  });

  it("disables purchase and surfaces at-capacity copy for an at-capacity selected listing (m127 #4883)", () => {
    const atCapacityListing = { ...baseListing, seller_at_capacity: true };

    renderWithDataRouter(
      <CheckoutPurchaseIntentSection
        catalogItemId="cat_charizard"
        productId="cat_charizard::"
        selectedListing={atCapacityListing}
        selectedListingSource="explicit"
        itemTitle="Charizard"
        selectedOptions={[]}
        productSummary="Raw / Near Mint"
        visibleListingCount={1}
      />,
    );

    // The listing stays visible (not hidden), but the buyer cannot purchase.
    expect(screen.getAllByText("Temporarily at capacity").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Temporarily at capacity" })).toHaveProperty("disabled", true);
  });

  it("keeps buy actions in one compact accordion section list", () => {
    const { container } = render(
      <BuyActionCard
        formIdPrefix="buy-card"
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        productSelectionDetails={[]}
        visibleListingCount={1}
        renderBuyNow={() => <div>Buy now form</div>}
        renderAddToCart={() => <div>Add to cart form</div>}
        renderOffer={() => <div>Make offer form</div>}
      />,
    );

    expect(screen.getByText("Buy options")).toBeTruthy();
    expect(screen.getByText("Choose a listing, product, or offer action.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Best available listing/ })).toBeTruthy();
    expect(screen.getByText("Start with the current best available listing.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Selected product/ })).toBeTruthy();
    expect(screen.getByText("Save the selected product for Buy Cart review.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Make an offer/ })).toBeTruthy();
    expect(screen.getByText("Offer your price and quantity for the selected product.")).toBeTruthy();
    expect(screen.queryByText(/product-wide demand/i)).toBeNull();
    expect(screen.queryByText(/Buy locked to this seller/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Set alert/ })).toBeNull();
    expect(screen.getByText("Buy now form")).toBeTruthy();
    expect(screen.queryByText("Make offer form")).toBeNull();
    expect(screen.queryByText("Selected product intent")).toBeNull();
    expect(screen.queryByText("Selected seller signal")).toBeNull();
    expect(container.querySelector(".modern-surface")).toBeNull();
    expect(container.querySelector('[class*="-mx-4"]')).toBeTruthy();
    expect(container.querySelector('[class*="before:absolute"]')).toBeTruthy();

    const makeOfferButton = screen.getByRole("button", { name: /Make an offer/ });
    fireEvent.click(makeOfferButton);

    expect(screen.getByText("Make offer form")).toBeTruthy();
    expect(screen.queryByText("Buy now form")).toBeNull();

    fireEvent.click(makeOfferButton);

    expect(makeOfferButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Make offer form")).toBeNull();
    expect(container.querySelector('[class*="before:absolute"]')).toBeNull();
  });

  it("lets mobile buy action accordions bleed to the sheet edge", () => {
    const { container } = render(
      <BuyActionCard
        formIdPrefix="mobile-buy-card"
        panelVariant="plain"
        accordionEdge="panel"
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        productSelectionDetails={[]}
        visibleListingCount={1}
        renderBuyNow={() => <div>Buy now form</div>}
        renderAddToCart={() => <div>Add to cart form</div>}
        renderOffer={() => <div>Make offer form</div>}
      />,
    );

    const accordion = container.querySelector('[class*="-mx-5"]');
    const activeTrigger = screen.getByRole("button", { name: /Best available listing/ });

    expect(accordion).toBeTruthy();
    expect(accordion?.className).toContain("w-[calc(100%+2.5rem)]");
    expect(accordion?.className).toContain("self-stretch");
    expect(accordion?.className).toContain("rounded-b-tokenXl");
    expect(activeTrigger.className).toContain("px-5");
    expect(container.querySelector('[class*="before:w-1"]')).toBeTruthy();
  });

  it("keeps sell actions in the same compact section-list pattern as buy actions", () => {
    const { container } = render(
      <SellActionCard
        formIdPrefix="sell-card"
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        productSelectionDetails={[]}
        hasMatchingOffer
        selectedOfferSource="explicit"
        renderSelectedOffer={() => <div>Selected offer form</div>}
        renderAddProductToSellList={() => <div>Add product to Sell List form</div>}
        renderListing={() => <div>Create listing form</div>}
      />,
    );

    expect(screen.getByText("Sell options")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Selected offer/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Selected product/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /List this product/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Set alert/ })).toBeNull();
    expect(screen.queryByText(/Same-buyer offer batching/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Sell now/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add offer to Sell List/ })).toBeNull();
    expect(container.querySelector(".modern-surface")).toBeNull();
    expect(container.querySelector('[class*="-mx-4"]')).toBeTruthy();
    expect(container.querySelector('[class*="before:absolute"]')).toBeTruthy();
    expect(screen.queryByText("Raw / Near Mint")).toBeNull();
    expect(screen.getByText("Selected offer form")).toBeTruthy();

    const selectedOfferButton = screen.getByRole("button", { name: /Selected offer/ });
    fireEvent.click(screen.getByRole("button", { name: /Selected product/ }));

    expect(screen.getByText("Add product to Sell List form")).toBeTruthy();
    expect(screen.queryByText("Selected offer form")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Selected product/ }));

    expect(screen.getByRole("button", { name: /Selected product/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Add product to Sell List form")).toBeNull();
    expect(container.querySelector('[class*="before:absolute"]')).toBeNull();

    fireEvent.click(selectedOfferButton);

    expect(screen.getByText("Selected offer form")).toBeTruthy();
  });

  it("can reopen the listing workflow after a listing submit error", () => {
    render(
      <SellActionCard
        formIdPrefix="sell-card"
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        productSelectionDetails={[]}
        hasMatchingOffer
        preferredAction="list-for-sale"
        selectedOfferSource="explicit"
        renderSelectedOffer={() => <div>Selected offer form</div>}
        renderAddProductToSellList={() => <div>Add product to Sell List form</div>}
        renderListing={() => <div>Create listing form</div>}
      />,
    );

    expect(screen.getByRole("button", { name: /List this product/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Create listing form")).toBeTruthy();
    expect(screen.queryByText("Selected offer form")).toBeNull();
  });

  it("opens owned listing controls after an explicit seller listing redirect", async () => {
    const ownedListing = {
      ...baseListing,
      listing_id: "listing_new_after_create",
      inventory_item_id: "inventory_new_after_create",
      account_id: "seller_1",
      price_amount: "375.00",
    };

    renderItemDetailRoute({
      item: createItem({
        market_listings: [ownedListing],
        offer_demand_matches: [baseOffer],
      }),
      accountOfferMatches: [baseAccountOfferMatch],
      sellerInventoryItems: [],
      sellerAccountId: "seller_1",
      hasListingStockLocation: true,
      listingSetupLoadState: "ready",
      viewerAccountId: "seller_1",
      initialMarketIntent: "sell",
      initialSelectedListingId: ownedListing.listing_id,
      initialSelectedOfferId: null,
      initialSelectedOptions: [],
      hasInitialSelectedOptionFilters: false,
      showSellerTab: true,
      canUseSellerFeatures: true,
      canUseListingFeatures: true,
      canUseGuestListingDraft: false,
      canSubmitOffers: true,
      registerToSellHref: "/register",
      notFound: false,
      error: null,
      canonicalUrl: null,
      productAlertClaimError: null,
      listingSetupLoadError: null,
    });

    const listForSaleAction = (await screen.findAllByRole("button", { name: /List this product/ }))[0];

    expect(listForSaleAction.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("Update your listing")).toBeTruthy();
    expect(screen.getByText("Your active listing is 375.00.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage listing" }).getAttribute("href")).toBe(
      `/account/listings/${ownedListing.listing_id}`,
    );
  });

  it("keeps product Sell List guidance in Reference Info", () => {
    renderWithDataRouter(
      <ProductSellListIntentSection
        catalogItemId="cat_charizard"
        productId="cat_charizard::"
        itemTitle="Charizard"
        selectedOptions={[]}
        productSelectionDetails={[
          { label: "Form", value: "Raw" },
          { label: "Condition", value: "Near Mint" },
        ]}
        productSummary="Raw / Near Mint"
      />,
    );

    expect(screen.getAllByText("Add product to Sell List").length).toBeGreaterThan(0);
    expect(screen.queryByText("Chase Sets can match buyer demand during Sell List review.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View product in Sell List details" }));
    const sellListDialog = screen.getByRole("dialog", { name: "Product in Sell List" });
    expect(within(sellListDialog).getByText("The Sell List saves this product and selected options.")).toBeTruthy();
    expect(within(sellListDialog).getByText("Chase Sets can match buyer demand during Sell List review.")).toBeTruthy();
    expect(
      within(sellListDialog).getByText("No offer is accepted and no listing is created until you review and confirm."),
    ).toBeTruthy();
  });

  it("disables product-level sell actions for offer-review accounts without listing capability", () => {
    render(
      <SellActionCard
        formIdPrefix="sell-card"
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        productSelectionDetails={[]}
        hasMatchingOffer
        canSelectListingAction={false}
        selectedOfferSource="explicit"
        renderSelectedOffer={() => <div>Selected offer form</div>}
        renderAddProductToSellList={() => <div>Add product to Sell List form</div>}
        renderListing={() => <div>Create listing form</div>}
      />,
    );

    expect(screen.getByRole("button", { name: /Selected offer/ }).getAttribute("data-disabled")).toBeNull();

    const productSellListAction = screen.getByRole("button", { name: /Selected product/ });
    const listForSaleAction = screen.getByRole("button", { name: /List this product/ });

    expect(productSellListAction.getAttribute("data-disabled")).toBe("");
    expect(listForSaleAction.getAttribute("data-disabled")).toBe("");

    fireEvent.click(productSellListAction);
    expect(screen.queryByText("Add product to Sell List form")).toBeNull();
    expect(screen.getByText("Selected offer form")).toBeTruthy();
  });

  it("keeps watch actions in the same compact section-list pattern", () => {
    render(
      <WatchActionCard
        formIdPrefix="watch-card"
        productId="cat_charizard::"
        productSummary="Raw / Near Mint"
        productSelectionDetails={[]}
        renderListingAlert={() => <div>Listing alert form</div>}
        renderOfferAlert={() => <div>Offer alert form</div>}
      />,
    );

    expect(screen.getByText("Watch")).toBeTruthy();
    expect(screen.getByText("Get notified without starting a buy or sell workflow.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Watch listings/ })).toBeTruthy();
    expect(screen.getByText("Listings at or below your target.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Watch offers/ })).toBeTruthy();
    expect(screen.getByText("Offers at or above your target.")).toBeTruthy();
    expect(screen.getByText("Listing alert form")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Watch offers/ }));

    expect(screen.getByText("Offer alert form")).toBeTruthy();
    expect(screen.queryByText("Listing alert form")).toBeNull();
  });

  it("opens Buy, Sell, and Watch directly from the mobile commerce action group", () => {
    render(
      <ItemDetailPage
        data={createItem()}
        renderCommerce={() => ({
          buy: <div>Mobile buy action</div>,
          offer: <div>Mobile offer action</div>,
          sell: <div>Desktop sell rail</div>,
          mobile: {
            sell: { content: <div>Mobile sell action</div> },
            watch: { content: <div>Mobile watch action</div> },
          },
        })}
      />,
    );

    expect(screen.queryByRole("radiogroup", { name: "Choose mobile market intent" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Buy" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Sell" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Watch" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Make offer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "List" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Buy" })[0]);

    const buySheet = screen.getByRole("dialog", { name: "Best available listing" });
    expect(
      within(buySheet).getByText("Buy the current best listing, save this product to Buy Cart, or make an offer."),
    ).toBeTruthy();
    expect(screen.getAllByText("Mobile buy action").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Sell" })[0]);

    const sellSheet = screen.getByRole("dialog", { name: "Best offer" });
    expect(
      within(sellSheet).getByText("Accept the best offer, save it to Sell List, or list this product."),
    ).toBeTruthy();
    expect(screen.getAllByText("Mobile sell action").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Watch" })[0]);

    const watchSheet = screen.getByRole("dialog", { name: "Watch this product" });
    expect(
      within(watchSheet).getByText("Track listing prices or buyer offers without starting checkout."),
    ).toBeTruthy();
    expect(screen.getAllByText("Mobile watch action").length).toBeGreaterThan(0);
  });

  it("uses explicit selected listing and offer titles in mobile commerce sheets", () => {
    render(
      <ItemDetailPage
        data={createItem({ market_listings: [baseListing, alternateListing] })}
        initialSelectedListingId={alternateListing.listing_id}
        renderCommerce={() => ({
          buy: <div>Mobile buy action</div>,
          offer: null,
          mobile: {
            buy: { content: <div>Mobile buy action</div> },
          },
        })}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Buy" })[0]);

    const selectedListingSheet = screen.getByRole("dialog", { name: "Selected listing" });
    expect(
      within(selectedListingSheet).getByText("Buy this listing, save it to Buy Cart, or make an offer."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    cleanup();

    render(
      <ItemDetailPage
        data={createItem({ offer_demand_matches: [baseOffer, alternateOffer] })}
        initialMarketIntent="sell"
        initialSelectedOfferId={alternateOffer.offer_id}
        renderCommerce={() => ({
          buy: <div>Mobile buy action</div>,
          offer: null,
          sell: <div>Mobile sell action</div>,
          mobile: {
            sell: { content: <div>Mobile sell action</div> },
          },
        })}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Sell" })[0]);

    const selectedOfferSheet = screen.getByRole("dialog", { name: "Selected offer" });
    expect(
      within(selectedOfferSheet).getByText("Accept this offer, save it to Sell List, or list this product."),
    ).toBeTruthy();
  });

  it("sends incomplete mobile selections back to the option chooser", () => {
    render(
      <ItemDetailPage
        data={createItem({
          product_schema: requiredSchema,
          market_listings: [],
          offer_demand_matches: [],
        })}
        renderCommerce={() => ({
          buy: <div>Mobile buy action</div>,
          offer: <div>Mobile offer action</div>,
          sell: <div>Mobile sell action</div>,
          mobile: {
            sell: { content: <div>Mobile sell action</div> },
            watch: { content: <div>Mobile watch action</div> },
          },
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Buy now" })).toBeNull();
    // Decision 3 (#5963): with no product selected, the mobile dock renders exactly one
    // full-width "Select options" action instead of repeating the same #select-options
    // anchor as three separate labels.
    expect(screen.getByRole("link", { name: "Select options" }).getAttribute("href")).toBe("#select-options");
    expect(screen.queryByRole("radiogroup", { name: "Choose mobile market intent" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Choose to sell" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Choose to watch" })).toBeNull();
  });

  it("keeps availability and selected Product options owned by the in-flow Market summary, not duplicated in the mobile dock (#5963 AC9)", () => {
    const { container } = renderWithDataRouter(
      <ItemDetailPage
        data={createItem({ market_listings: [baseListing] })}
        renderCommerce={() => ({
          buy: <div>Buy selected product</div>,
          offer: <div>Make an offer</div>,
        })}
      />,
    );

    const dock = container.querySelector(".sticky.z-sticky") as HTMLElement;
    expect(dock).toBeTruthy();
    expect(within(dock).getByText("$399.99")).toBeTruthy();
    expect(within(dock).queryByText(/available/i)).toBeNull();
    expect(within(dock).queryByText(/Near Mint/)).toBeNull();

    const selectedListingRow = screen.getByRole("article", { name: "Listing $399.99 from Chase Sets" });
    expect(within(selectedListingRow).getByText("2 available")).toBeTruthy();
    expect(within(selectedListingRow).getByText("Raw · Near Mint")).toBeTruthy();
  });
});
