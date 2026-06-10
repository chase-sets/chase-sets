import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockAddCartLine,
  mockCreateCheckoutSession,
  mockCreateDiscoveryRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockAddSellListLine,
  mockAddGuestSellListLine,
  mockCreateProductAlert,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockCreateSubmittedOffer,
  mockAddGuestCartLine,
  mockGetOfferMatch,
  mockAcceptOfferMatch,
  mockAppendAnonymousCartCookie,
  mockAppendAnonymousSellListCookie,
  mockEnsureAnonymousCartId,
  mockEnsureAnonymousSellListId,
} = vi.hoisted(() => ({
  mockAddCartLine: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
  mockCreateDiscoveryRequestApiClient: vi.fn(),
  mockCreateMarketplaceRequestApiClient: vi.fn(),
  mockCreateCheckoutRequestApiClient: vi.fn(),
  mockAddSellListLine: vi.fn(),
  mockAddGuestSellListLine: vi.fn(),
  mockCreateProductAlert: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
  mockCreateSubmittedOffer: vi.fn(),
  mockAddGuestCartLine: vi.fn(),
  mockGetOfferMatch: vi.fn(),
  mockAcceptOfferMatch: vi.fn(),
  mockAppendAnonymousCartCookie: vi.fn((headers: Headers, anonymousCartId: string) => {
    headers.append("Set-Cookie", `chase_sets_anonymous_cart=${anonymousCartId}`);
  }),
  mockAppendAnonymousSellListCookie: vi.fn((headers: Headers, anonymousSellListId: string) => {
    headers.append("Set-Cookie", `chase_sets_anonymous_sell_list=${anonymousSellListId}`);
  }),
  mockEnsureAnonymousCartId: vi.fn(() => "anon_cart_1"),
  mockEnsureAnonymousSellListId: vi.fn(() => "anon_sell_1"),
}));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
    resolveActorFromAuthApi: mockResolveActorFromAuthApi,
  };
});

vi.mock("../support/request-support/api-client", () => ({
  DiscoveryApiError: class DiscoveryApiError extends Error {},
  createDiscoveryRequestApiClient: mockCreateDiscoveryRequestApiClient,
}));

vi.mock("@chase-sets/marketplace/server", () => ({
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
}));

vi.mock("@chase-sets/checkout/server", () => ({
  appendAnonymousCartCookie: mockAppendAnonymousCartCookie,
  appendAnonymousSellListCookie: mockAppendAnonymousSellListCookie,
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
  ensureAnonymousCartId: mockEnsureAnonymousCartId,
  ensureAnonymousSellListId: mockEnsureAnonymousSellListId,
}));

import { action, loader } from "../routes/item-detail";

describe("item detail buy now action", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("marks signed-in accounts as eligible to make offers without seller permissions", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_account",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [],
        offer_demand_matches: [
          {
            offer_id: "offer_charizard",
            catalog_catalog_item_id: "cat_charizard",
            status: "submitted",
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(result.canSubmitOffers).toBe(true);
    expect(result.viewerAccountId).toBe("acc_account");
    expect(result.item?.offer_demand_matches).toHaveLength(1);
  });

  it("keeps anonymous item detail offer viewing but with submission disabled", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [],
        offer_demand_matches: [
          {
            offer_id: "offer_charizard",
            catalog_catalog_item_id: "cat_charizard",
            status: "submitted",
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(result.canSubmitOffers).toBe(false);
    expect(result.viewerAccountId).toBeNull();
    expect(result.item?.offer_demand_matches).toHaveLength(1);
  });

  it("attaches display-safe public standard terms previews to item detail offers", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [],
        offer_demand_matches: [
          {
            offer_id: "offer_charizard",
            catalog_catalog_item_id: "cat_charizard",
            status: "submitted",
            price_amount: "380.00",
          },
        ],
      }),
    });
    const previewPublicStandardListingTerms = vi.fn().mockResolvedValue({
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
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewPublicStandardListingTerms,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(previewPublicStandardListingTerms).toHaveBeenCalledWith({ priceAmount: "380.00" });
    const preview = result.item?.offer_demand_matches[0]?.public_standard_terms_preview;
    expect(preview).toEqual(
      expect.objectContaining({
        seller_net_unit_amount: "345.65",
        marketplace_sales_fee_unit_amount: "34.35",
        source_label: "Standard seller terms",
      }),
    );
    expect("fee_quote_fingerprint" in (preview ?? {})).toBe(false);
    expect("schedule_id" in (preview ?? {})).toBe(false);
    expect("agreement_id" in (preview ?? {})).toBe(false);
  });

  it("skips public standard terms previews for registered viewers", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [],
        offer_demand_matches: [
          {
            offer_id: "offer_charizard",
            catalog_catalog_item_id: "cat_charizard",
            status: "submitted",
            price_amount: "380.00",
          },
        ],
      }),
    });
    const previewPublicStandardListingTerms = vi.fn();
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewPublicStandardListingTerms,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(previewPublicStandardListingTerms).not.toHaveBeenCalled();
    expect(result.item?.offer_demand_matches[0]?.public_standard_terms_preview).toBeUndefined();
  });

  it("hands product offer intent to checkout without seller permissions", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      createSubmittedOffer: mockCreateSubmittedOffer.mockResolvedValue({
        offer_id: "offer_charizard",
      }),
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "submit-offer");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("priceAmount", "350.00");
    form.set("quantityRequested", "1");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await action({
      request: new Request("http://localhost/items/charizard-base-set", {
        method: "POST",
        body: form,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }),
      params: { id: "charizard-base-set" },
      context: {},
    } as never)) as Response;

    expect(mockCreateSubmittedOffer).not.toHaveBeenCalled();
    expect(mockRequireActorFromAuthApi).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    const redirectUrl = new URL(response.headers.get("Location")!, "http://localhost");
    expect(redirectUrl.pathname).toBe("/checkout/start");
    expect(redirectUrl.searchParams.get("source")).toBe("offer-intent");
    expect(redirectUrl.searchParams.get("catalogItemId")).toBe("cat_charizard");
    expect(redirectUrl.searchParams.get("productId")).toBe("cat_charizard::form:raw");
    expect(redirectUrl.searchParams.get("itemTitle")).toBe("Charizard");
    expect(redirectUrl.searchParams.get("offerPriceAmount")).toBe("350.00");
    expect(redirectUrl.searchParams.get("quantity")).toBe("1");
  });

  it("lets signed-out buyers start purchase intent checkout with normalized draft values before registration", async () => {
    const signInRedirect = new Response(null, {
      status: 302,
      headers: { Location: "/sign-in?returnTo=%2Fitems%2Fcharizard-base-set" },
    });
    mockRequireActorFromAuthApi.mockRejectedValue(signInRedirect);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      createSubmittedOffer: mockCreateSubmittedOffer,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "submit-offer");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("priceAmount", "350");
    form.set("quantityRequested", "2");

    const response = (await action({
      request: new Request("http://localhost/items/charizard-base-set", {
        method: "POST",
        body: form,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }),
      params: { id: "charizard-base-set" },
      context: {},
    } as never)) as Response;

    expect(response.status).toBe(302);
    const redirectUrl = new URL(response.headers.get("Location")!, "http://localhost");
    expect(redirectUrl.pathname).toBe("/checkout/start");
    expect(redirectUrl.searchParams.get("source")).toBe("offer-intent");
    expect(redirectUrl.searchParams.get("offerPriceAmount")).toBe("350.00");
    expect(redirectUrl.searchParams.get("quantity")).toBe("2");
    expect(mockRequireActorFromAuthApi).not.toHaveBeenCalled();
    expect(mockCreateSubmittedOffer).not.toHaveBeenCalled();
  });

  it("creates a buy-now checkout session and redirects to checkout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession.mockResolvedValue({
        session_id: "chk_buy_now",
      }),
      addCartLine: mockAddCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-now");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");
    form.set("listingId", "lst_charizard");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "buy-now",
        listingId: "",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set 4/102 Holo Rare",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Raw",
        fulfillmentMode: "optimize",
        lockedListingId: null,
        quantity: 2,
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_buy_now");
    expect(mockAddCartLine).not.toHaveBeenCalled();
  });

  it("adds selected products to the checkout cart without creating a session", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine.mockResolvedValue({ id: "cli_1" }),
      createCheckoutSession: mockCreateCheckoutSession,
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-cart");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockAddCartLine).toHaveBeenCalledWith({
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      itemImageUrl: null,
      itemImageSrcSet: null,
      itemImageLoadingUrl: null,
      itemImageLoadingAlt: null,
      itemImageLoadingSrcSet: null,
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fulfillmentMode: "optimize",
      lockedListingId: null,
      sellerPreferenceId: null,
      quantity: 2,
    });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "added-to-cart",
      itemTitle: "Charizard",
      quantity: 2,
    });
  });

  it("adds explicit selected listings to Buy Cart as seller preferences instead of locked fulfillment", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [
          {
            listing_id: "lst_charizard",
            product_id: "cat_charizard::form:raw",
            status: "active",
            price_amount: "380.00",
            seller_display_name: "Card Vault",
            quantity_cap: 2,
            visible_quantity: 2,
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine.mockResolvedValue({ id: "cli_1" }),
      addGuestCartLine: mockAddGuestCartLine,
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-cart");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");
    form.set("sellerPreferenceId", "lst_charizard");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockAddCartLine).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "cat_charizard::form:raw",
        fulfillmentMode: "optimize",
        lockedListingId: null,
        sellerPreferenceId: "lst_charizard",
        quantity: 2,
      }),
    );
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("adds selected products to the Checkout-owned Sell List", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["listings.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addSellListLine: mockAddSellListLine.mockResolvedValue({ id: "sll_1" }),
    });

    const form = new URLSearchParams();
    form.set("intent", "add-product-to-sell-list");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "3");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockResolveActorFromAuthApi).toHaveBeenCalledWith({
      request: expect.any(Request),
    });
    expect(mockAddSellListLine).toHaveBeenCalledWith({
      lineType: "product",
      offerId: null,
      buyerAccountId: null,
      buyerDisplayName: null,
      offerPriceAmount: null,
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fallbackMode: "none",
      minimumListingPriceAmount: null,
      quantity: 3,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/sell-list");
  });

  it("adds signed-out product seller intent to an anonymous Sell List", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addGuestSellListLine: mockAddGuestSellListLine.mockResolvedValue({ id: "sll_1" }),
    });

    const form = new URLSearchParams();
    form.set("intent", "add-product-to-sell-list");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
    } as never)) as Response;

    expect(mockEnsureAnonymousSellListId).toHaveBeenCalledWith(expect.any(Request));
    expect(mockAddGuestSellListLine).toHaveBeenCalledWith("anon_sell_1", {
      lineType: "product",
      offerId: null,
      buyerAccountId: null,
      buyerDisplayName: null,
      offerPriceAmount: null,
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fallbackMode: "none",
      minimumListingPriceAmount: null,
      quantity: 2,
    });
    expect(mockAppendAnonymousSellListCookie).toHaveBeenCalledWith(expect.any(Headers), "anon_sell_1");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/sell-list");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_sell_list=anon_sell_1");
  });

  it("starts signed-out buy now at guest checkout contact instead of sign-in", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-now");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");
    form.set("listingId", "lst_charizard");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    const redirectUrl = new URL(location, "http://localhost");

    expect(response.status).toBe(302);
    expect(redirectUrl.pathname).toBe("/checkout/start");
    expect(redirectUrl.searchParams.get("source")).toBe("buy-now");
    expect(redirectUrl.searchParams.get("listingId")).toBe("");
    expect(redirectUrl.searchParams.get("fulfillmentMode")).toBe("optimize");
    expect(redirectUrl.searchParams.get("lockedListingId")).toBe("");
    expect(redirectUrl.searchParams.get("catalogItemId")).toBe("cat_charizard");
    expect(redirectUrl.searchParams.get("productId")).toBe("cat_charizard::form:raw");
    expect(redirectUrl.searchParams.get("itemTitle")).toBe("Charizard");
    expect(redirectUrl.searchParams.get("itemSubtitle")).toBe("Base Set 4/102 Holo Rare");
    expect(redirectUrl.searchParams.get("selectedOptions")).toBe(
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
    expect(redirectUrl.searchParams.get("productSummary")).toBe("Raw");
    expect(redirectUrl.searchParams.get("quantity")).toBe("2");
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("uses the fresh listing snapshot for signed-out locked-listing checkout handoffs", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [
          {
            listing_id: "lst_charizard",
            status: "active",
            price_amount: "380.00",
            seller_display_name: "Fresh Seller",
            quantity_cap: 2,
            visible_quantity: 2,
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-this-listing");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");
    form.set("lockedListingId", "lst_charizard");
    form.set("priceAmount", "1.00");
    form.set("sellerName", "Tampered Seller");
    form.set("availability", "999 available");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    const redirectUrl = new URL(response.headers.get("Location") ?? "", "http://localhost");
    expect(response.status).toBe(302);
    expect(redirectUrl.pathname).toBe("/checkout/start");
    expect(redirectUrl.searchParams.get("fulfillmentMode")).toBe("locked-listing");
    expect(redirectUrl.searchParams.get("lockedListingId")).toBe("lst_charizard");
    expect(redirectUrl.searchParams.get("priceAmount")).toBe("380.00");
    expect(redirectUrl.searchParams.get("sellerName")).toBe("Fresh Seller");
    expect(redirectUrl.searchParams.get("availability")).toBe("Raw - 2 available");
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("adds signed-out cart lines to the anonymous server cart", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine.mockResolvedValue({ id: "cli_1" }),
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-cart");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockAddGuestCartLine).toHaveBeenCalledWith("anon_cart_1", {
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      itemImageUrl: null,
      itemImageSrcSet: null,
      itemImageLoadingUrl: null,
      itemImageLoadingAlt: null,
      itemImageLoadingSrcSet: null,
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fulfillmentMode: "optimize",
      lockedListingId: null,
      sellerPreferenceId: null,
      quantity: 2,
    });
    expect(mockAppendAnonymousCartCookie).toHaveBeenCalledWith(response.headers, "anon_cart_1");
    expect(mockAddCartLine).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "added-to-cart",
      itemTitle: "Charizard",
      quantity: 2,
    });
  });

  it("adds signed-in buyer cart lines to the account cart without order-management permissions", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine.mockResolvedValue({ id: "cli_1" }),
      addGuestCartLine: mockAddGuestCartLine,
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-cart");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockAddCartLine).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "cat_charizard::form:raw",
        fulfillmentMode: "optimize",
        quantity: 1,
      }),
    );
    expect(mockAddGuestCartLine).not.toHaveBeenCalled();
    expect(mockAppendAnonymousCartCookie).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("creates optimized buy-now sessions for signed-in buyers without order-management permissions", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession.mockResolvedValue({
        session_id: "chk_buy_now",
      }),
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-now");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: expect.objectContaining({
        type: "buy-now",
        fulfillmentMode: "optimize",
        lockedListingId: null,
        quantity: 1,
      }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_buy_now");
    expect(mockAddGuestCartLine).not.toHaveBeenCalled();
  });

  it("creates seller-locked buy-now sessions for signed-in buyers without order-management permissions", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [
          {
            listing_id: "lst_charizard",
            status: "active",
            quantity_cap: 2,
            visible_quantity: 2,
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession.mockResolvedValue({
        session_id: "chk_locked",
      }),
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-this-listing");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");
    form.set("lockedListingId", "lst_charizard");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: expect.objectContaining({
        type: "buy-now",
        listingId: "lst_charizard",
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_charizard",
        quantity: 1,
      }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_locked");
    expect(mockAddGuestCartLine).not.toHaveBeenCalled();
  });

  it("rejects invalid offer prices before creating offer-intent checkout handoffs", async () => {
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "submit-offer");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("priceAmount", "free");
    form.set("quantityRequested", "1");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as { error: string };

    expect(result).toEqual({ error: "Enter a price greater than $0.00 using dollars and cents." });
  });

  it("rejects invalid cart quantities before adding cart lines", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-cart");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1.5");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as { error: string };

    expect(result).toEqual({ error: "Enter a quantity of 1 or more." });
    expect(mockAddCartLine).not.toHaveBeenCalled();
    expect(mockAddGuestCartLine).not.toHaveBeenCalled();
  });

  it("rejects selected-listing buy quantities above current availability", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [
          {
            listing_id: "lst_charizard",
            status: "active",
            quantity_cap: 1,
            visible_quantity: 1,
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-this-listing");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");
    form.set("lockedListingId", "lst_charizard");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as { error: string };

    expect(result).toEqual({
      error: "Only 1 available from this listing. Lower the quantity or choose another listing.",
    });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects stale selected listings before creating locked checkout sessions", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-this-listing");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");
    form.set("lockedListingId", "lst_missing");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as { error: string };

    expect(result).toEqual({ error: "This listing is no longer available. Choose another listing." });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects stale selected offers before acceptance", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["offers.manage", "offers.view", "listings.view"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
      }),
    });
    mockGetOfferMatch.mockResolvedValue(null);
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getOfferMatch: mockGetOfferMatch,
      acceptOfferMatch: mockAcceptOfferMatch,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "sell-now");
    form.set("offerId", "offer_missing");
    form.set("feeQuoteFingerprint", "fee_1");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as { error: string };

    expect(result).toEqual({ error: "This offer is no longer available. Choose another offer." });
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
  });

  it("rejects selected offers the seller can no longer fulfill before adding to Sell List", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["offers.manage", "offers.view", "listings.view"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
      }),
    });
    mockGetOfferMatch.mockResolvedValue({
      offer_id: "offer_charizard",
      buyer_account_id: "acc_buyer",
      buyer_display_name: "Buyer",
      catalog_catalog_item_id: "cat_charizard",
      product_id: "cat_charizard::form:raw",
      item_title: "Charizard",
      item_subtitle: "Base Set 4/102 Holo Rare",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Raw",
      price_amount: "350.00",
      quantity_requested: 2,
      status: "submitted",
      seller_available_quantity: 1,
      can_fulfill: false,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getOfferMatch: mockGetOfferMatch,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addSellListLine: mockAddSellListLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-sell-list");
    form.set("offerId", "offer_charizard");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as { error: string };

    expect(result).toEqual({
      error: "2 requested, but only 1 available. Choose another offer or add product to Sell List.",
    });
    expect(mockAddSellListLine).not.toHaveBeenCalled();
  });

  it("rejects invalid watch thresholds before creating product alerts", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["accounts.view"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
      }),
      createProductAlert: mockCreateProductAlert,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "create-product-alert");
    form.set("marketSide", "listing");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("thresholdAmount", "-1");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as { error: string };

    expect(result).toEqual({ error: "Enter a target price of $0.00 or more using dollars and cents." });
    expect(mockCreateProductAlert).not.toHaveBeenCalled();
  });

  it("rejects invalid listing prices before previewing listing terms", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["listings.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
      }),
    });
    const previewListingTerms = vi.fn();
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewListingTerms,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "list-at-price");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("priceAmount", "0");
    form.set("quantityCap", "1");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as { error: string };

    expect(result).toEqual({ error: "Enter a price greater than $0.00 using dollars and cents." });
    expect(previewListingTerms).not.toHaveBeenCalled();
  });

  it("rejects invalid listing quantities before previewing listing terms", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["listings.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
      }),
    });
    const previewListingTerms = vi.fn();
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewListingTerms,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "list-at-price");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("priceAmount", "350.00");
    form.set("quantityCap", "1.5");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as { error: string };

    expect(result).toEqual({ error: "Enter a quantity of 1 or more." });
    expect(previewListingTerms).not.toHaveBeenCalled();
  });
});
