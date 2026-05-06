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

import { action } from "../routes/item-detail";

describe("item detail buy now action", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns buyers to the item offer list after submitting an offer", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["offers.manage"],
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

    expect(mockCreateSubmittedOffer).toHaveBeenCalledWith({
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      priceAmount: "350.00",
      quantityRequested: 1,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/items/charizard-base-set?market=sell&offerSubmitted=1",
    );
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

  it("falls back to the anonymous cart when a resolved actor cannot manage checkout orders", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller_only",
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

    expect(mockAddGuestCartLine).toHaveBeenCalledWith(
      "anon_cart_1",
      expect.objectContaining({
        productId: "cat_charizard::form:raw",
        fulfillmentMode: "optimize",
        quantity: 1,
      }),
    );
    expect(mockAddCartLine).not.toHaveBeenCalled();
    expect(mockAppendAnonymousCartCookie).toHaveBeenCalledWith(
      response.headers,
      "anon_cart_1",
    );
    expect(response.status).toBe(200);
  });

  it("routes buy now through guest checkout when the actor cannot manage checkout orders", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller_only",
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

    const location = response.headers.get("Location") ?? "";
    const redirectUrl = new URL(location, "http://localhost");

    expect(response.status).toBe(302);
    expect(redirectUrl.pathname).toBe("/checkout/start");
    expect(redirectUrl.searchParams.get("fulfillmentMode")).toBe("optimize");
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });
});
