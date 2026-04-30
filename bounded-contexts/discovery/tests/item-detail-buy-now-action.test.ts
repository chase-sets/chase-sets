import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockAddCartLine,
  mockCreateCheckoutSession,
  mockCreateDiscoveryRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockRequireActorFromAuthApi,
} = vi.hoisted(() => ({
  mockAddCartLine: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
  mockCreateDiscoveryRequestApiClient: vi.fn(),
  mockCreateMarketplaceRequestApiClient: vi.fn(),
  mockCreateCheckoutRequestApiClient: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
}));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
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
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
}));

import { action } from "../routes/item-detail";

describe("item detail buy now action", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a buy-now checkout session and redirects to checkout", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
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
        listingId: "lst_charizard",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set 4/102 Holo Rare",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Raw",
        quantity: 2,
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_buy_now");
    expect(mockAddCartLine).not.toHaveBeenCalled();
  });

  it("adds selected products to the checkout cart without creating a session", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
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
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      quantity: 2,
    });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/cart");
  });
});
