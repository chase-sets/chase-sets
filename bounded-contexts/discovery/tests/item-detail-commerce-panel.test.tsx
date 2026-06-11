// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ReactElement } from "react";
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
import DiscoveryItemDetailRoute from "../routes/item-detail";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
  DiscoveryAccountOfferMatch,
  DiscoveryReferenceRecordRef,
  ProductSchema,
} from "../support/client-support/contracts";

vi.mock("@chase-sets/platform-runtime/realtime-react", () => ({
  useRealtimePatchedSnapshot: ({ initialSnapshot }: { initialSnapshot: unknown }) => initialSnapshot,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function captureItemDetailRailAnalytics() {
  const events: Array<Record<string, unknown>> = [];
  const handler = (event: Event) => {
    if (event instanceof CustomEvent && event.detail && typeof event.detail === "object") {
      events.push(event.detail as Record<string, unknown>);
    }
  };

  window.addEventListener("chase-sets:item-detail-rail-analytics", handler);

  return {
    events,
    stop: () => window.removeEventListener("chase-sets:item-detail-rail-analytics", handler),
  };
}

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

function renderItemDetailRoute(loaderData: Record<string, unknown>) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <DiscoveryItemDetailRoute />,
      loader: async () => loaderData,
      action: async () => ({ status: "ok" }),
    },
  ]);

  return render(<RouterProvider router={router} />);
}

function createItem(overrides: Partial<DiscoveryItemDetail> = {}): DiscoveryItemDetail {
  return {
    catalog_item_id: "cat_charizard",
    slug: "charizard-base-set-cat_charizard",
    language_code: "en",
    title_i18n: {},
    title: "Charizard",
    subtitle_i18n: {},
    subtitle: "Base Set 4/102 Holo Rare",
    description_i18n: {},
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
    offer_demand_matches: [baseOffer],
    updated_at: "2026-04-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("item detail commerce panel", () => {
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

    expect(screen.getByRole("tab", { name: "Buy" })).toBeTruthy();
    const sellTab = screen.getByRole("tab", { name: "Sell" });
    expect(sellTab).toBeTruthy();

    fireEvent.click(sellTab);

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
    expect(within(buySheet).queryByRole("button", { name: "Add product to Buy Cart" })).toBeNull();
    expect(within(buySheet).getByRole("button", { name: "View buying this listing details" })).toBeTruthy();
    expect(within(buySheet).queryByText("Desktop buy rail")).toBeNull();
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
    expect(screen.getByText("Check out with the current best available listing.")).toBeTruthy();
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

    expect(screen.queryByRole("tablist", { name: "Choose mobile market intent" })).toBeNull();
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
    expect(
      screen
        .getAllByRole("link", { name: "Select options" })
        .every((link) => link.getAttribute("href") === "#select-options"),
    ).toBe(true);
    expect(screen.queryByRole("tablist", { name: "Choose mobile market intent" })).toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: "Choose to sell" })
        .every((link) => link.getAttribute("href") === "#select-options"),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: "Choose to watch" })
        .every((link) => link.getAttribute("href") === "#select-options"),
    ).toBe(true);
  });

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

    const marketIntent = screen.getByRole("tablist", {
      name: "Choose market intent",
    });

    expect(within(marketIntent).getByRole("tab", { name: "Buy" })).toBeTruthy();

    fireEvent.click(within(marketIntent).getByRole("tab", { name: "Sell" }));

    expect(screen.getByText("Accept offer")).toBeTruthy();
    expect(await screen.findByText("1 matching offer")).toBeTruthy();
    expect(await screen.findByText("Ash Ketchum")).toBeTruthy();
    expect(screen.getAllByText("$350.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Raw · Near Mint")).toBeTruthy();
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByText("submitted")).toBeNull();
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

    const marketIntent = screen.getByRole("tablist", {
      name: "Choose market intent",
    });

    fireEvent.click(within(marketIntent).getByRole("tab", { name: "Sell" }));
    fireEvent.click(within(marketIntent).getByRole("tab", { name: "Watch product" }));

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
      within(screen.getByRole("tablist", { name: "Choose market intent" })).getByRole("tab", { name: "Watch" }),
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
      within(screen.getByRole("tablist", { name: "Choose market intent" })).getByRole("tab", { name: "Buy" }),
    );

    expect(new URL(window.location.href).searchParams.get("market")).toBe("buy");
    expect(screen.getByText("Buy selected product")).toBeTruthy();

    fireEvent.click(
      within(screen.getByRole("tablist", { name: "Choose market intent" })).getByRole("tab", { name: "Sell" }),
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
      within(screen.getByRole("tablist", { name: "Choose market intent" })).getByRole("tab", { name: "Sell" }),
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
      within(screen.getByRole("tablist", { name: "Choose market intent" })).getByRole("tab", { name: "Sell" }),
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
    expect(
      within(screen.getByRole("article", { name: "Listing $399.99 from Chase Sets" })).getByText("Raw · Near Mint"),
    ).toBeTruthy();
    const selectedListingText =
      screen.getByRole("article", { name: "Listing $399.99 from Chase Sets" }).textContent ?? "";
    expect(selectedListingText.indexOf("Raw · Near Mint")).toBeLessThan(selectedListingText.indexOf("2 available"));
    expect(screen.getByText("2 available · Raw · Near Mint")).toBeTruthy();
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
    expect(screen.getByText("1 available · Raw · Near Mint")).toBeTruthy();
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

    fireEvent.click(screen.getByRole("tab", { name: /^Graded/ }));

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
    expect(commercePanel.querySelectorAll(".glass-surface")).toHaveLength(1);
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
      within(screen.getByRole("tablist", { name: "Choose market intent" })).getByRole("tab", { name: "Watch" }),
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
    expect(screen.getByText("2 available")).toBeTruthy();
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
    const productQuantityText = screen.getByText("2 available").parentElement?.textContent ?? "";
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
    expect(screen.queryByRole("button", { name: "Add listing to Buy Cart" })).toBeNull();
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
      within(listingCartDialog).getByText("Buy best match starts checkout with the current best available listing."),
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
      within(screen.getByRole("tablist", { name: "Choose market intent" })).getByRole("tab", { name: "Sell" }),
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
      within(screen.getByRole("tablist", { name: "Choose market intent" })).getByRole("tab", { name: "Sell" }),
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

    render(
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

    expect(screen.getByTestId("sell-product-summary").textContent).toBe("Selected sell product Graded");
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

function expansionReference(): DiscoveryReferenceRecordRef {
  const manufacturer: DiscoveryReferenceRecordRef = {
    referenceId: "ref_manufacturer",
    typeKey: "manufacturer",
    key: "the-pokemon-company-international",
    name: "The Pokemon Company International",
    attributes: { "homepage-url": "https://www.pokemon.com/us" },
    relationships: [],
    status: "active",
  };
  const productLine: DiscoveryReferenceRecordRef = {
    referenceId: "ref_product_line",
    typeKey: "product-line",
    key: "pokemon-trading-card-game",
    name: "Pokemon Trading Card Game",
    attributes: { "short-name": "Pokemon TCG" },
    relationships: [
      {
        relationshipType: "published-by",
        referenceId: manufacturer.referenceId,
        reference: manufacturer,
      },
    ],
    status: "active",
  };
  const series: DiscoveryReferenceRecordRef = {
    referenceId: "ref_series",
    typeKey: "series",
    key: "mega-evolution",
    name: "Mega Evolution",
    attributes: { "tcgdex-series-id": "mega-evolution" },
    relationships: [
      {
        relationshipType: "part-of",
        referenceId: productLine.referenceId,
        reference: productLine,
      },
    ],
    status: "active",
  };

  return {
    referenceId: "ref_expansion",
    typeKey: "expansion",
    key: "perfect-order",
    name: "Perfect Order",
    attributes: { "tcgdex-set-id": "me03", "card-count": 88 },
    relationships: [
      {
        relationshipType: "part-of",
        referenceId: series.referenceId,
        reference: series,
      },
    ],
    status: "active",
  };
}
