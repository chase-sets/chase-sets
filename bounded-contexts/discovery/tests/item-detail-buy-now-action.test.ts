import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockAddCartLine,
  mockCreateCheckoutSession,
  mockCreateDiscoveryRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockCreateSubmittedOffer,
  mockAddGuestCartLine,
  mockAppendAnonymousCartCookie,
  mockEnsureAnonymousCartId,
} = vi.hoisted(() => ({
  mockAddCartLine: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
  mockCreateDiscoveryRequestApiClient: vi.fn(),
  mockCreateMarketplaceRequestApiClient: vi.fn(),
  mockCreateCheckoutRequestApiClient: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
  mockCreateSubmittedOffer: vi.fn(),
  mockAddGuestCartLine: vi.fn(),
  mockAppendAnonymousCartCookie: vi.fn((headers: Headers, anonymousCartId: string) => {
    headers.append("Set-Cookie", `chase_sets_anonymous_cart=${anonymousCartId}`);
  }),
  mockEnsureAnonymousCartId: vi.fn(() => "anon_cart_1"),
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
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
  ensureAnonymousCartId: mockEnsureAnonymousCartId,
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
        buyer_offer_matches: [
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
    });

    expect(result.canSubmitOffers).toBe(true);
    expect(result.viewerAccountId).toBe("acc_account");
    expect(result.item?.buyer_offer_matches).toHaveLength(1);
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
        buyer_offer_matches: [
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
    });

    expect(result.canSubmitOffers).toBe(false);
    expect(result.viewerAccountId).toBeNull();
    expect(result.item?.buyer_offer_matches).toHaveLength(1);
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
    form.set(
      "selectedOptions",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
    form.set("productSummary", "Raw");
    form.set("priceAmount", "350.00");
    form.set("quantityRequested", "1");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = await action({
      request: new Request("http://localhost/items/charizard-base-set", {
        method: "POST",
        body: form,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }),
      params: { id: "charizard-base-set" },
      context: {},
    });

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

  it("lets signed-out buyers start purchase intent checkout before registration", async () => {
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

    const response = await action({
      request: new Request("http://localhost/items/charizard-base-set", {
        method: "POST",
        body: form,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }),
      params: { id: "charizard-base-set" },
      context: {},
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/checkout/start?source=offer-intent");
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
    form.set(
      "selectedOptions",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
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
    form.set(
      "selectedOptions",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
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
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fulfillmentMode: "optimize",
      lockedListingId: null,
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
    form.set(
      "selectedOptions",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
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
    form.set(
      "selectedOptions",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
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
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fulfillmentMode: "optimize",
      lockedListingId: null,
      quantity: 2,
    });
    expect(mockAppendAnonymousCartCookie).toHaveBeenCalledWith(
      response.headers,
      "anon_cart_1",
    );
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
    form.set(
      "selectedOptions",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
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

    expect(mockAddCartLine).toHaveBeenCalledWith(expect.objectContaining({
      productId: "cat_charizard::form:raw",
      fulfillmentMode: "optimize",
      quantity: 1,
    }));
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
    form.set(
      "selectedOptions",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
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
    form.set(
      "selectedOptions",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
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
});
