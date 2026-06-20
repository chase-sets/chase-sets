import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken, decodeFreshWriteReceipt } from "@chase-sets/http/responses";

import {
  mockAcceptOfferMatch,
  mockAddCartLine,
  mockAddGuestCartLine,
  mockAddSellListLine,
  mockAppendAnonymousCartCookie,
  mockAppendAnonymousListingDraftCookie,
  mockAppendAnonymousProductAlertCookie,
  mockAppendAnonymousSellListCookie,
  mockClaimAnonymousProductAlertIntent,
  mockCreateAnonymousProductAlertIntent,
  mockCreateCheckoutRequestApiClient,
  mockCreateCheckoutSession,
  mockCreateDiscoveryRequestApiClient,
  mockCreateInventoryRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateProductAlert,
  mockEnsureAnonymousCartId,
  mockEnsureAnonymousListingDraftOwnerId,
  mockEnsureAnonymousProductAlertOwnerId,
  mockEnsureAnonymousSellListId,
  mockEnsureListingStock,
  mockGetOfferMatch,
  mockReadAnonymousProductAlertOwnerId,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
} from "./item-detail-buy-now-test-harness";

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

vi.mock("../support/request-support/anonymous-product-alert", () => ({
  appendAnonymousProductAlertCookie: mockAppendAnonymousProductAlertCookie,
  ensureAnonymousProductAlertOwnerId: mockEnsureAnonymousProductAlertOwnerId,
  readAnonymousProductAlertOwnerId: mockReadAnonymousProductAlertOwnerId,
}));

vi.mock("@chase-sets/marketplace/server", () => ({
  appendAnonymousListingDraftCookie: mockAppendAnonymousListingDraftCookie,
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
  ensureAnonymousListingDraftOwnerId: mockEnsureAnonymousListingDraftOwnerId,
}));

vi.mock("@chase-sets/checkout/server", () => ({
  ACCOUNT_CART_ADD_LINE_HANDOFF: {
    kind: "checkout.cart.add-line",
    expectation: "collection-non-empty",
    surface: "account-cart",
  },
  ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF: {
    kind: "checkout.sell-list.add-line",
    expectation: "collection-non-empty",
    surface: "account-sell-list",
  },
  appendAnonymousCartCookie: mockAppendAnonymousCartCookie,
  appendAnonymousSellListCookie: mockAppendAnonymousSellListCookie,
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
  ensureAnonymousCartId: mockEnsureAnonymousCartId,
  ensureAnonymousSellListId: mockEnsureAnonymousSellListId,
}));

vi.mock("@chase-sets/inventory/server", () => ({
  createInventoryRequestApiClient: mockCreateInventoryRequestApiClient,
}));

import { action, loader } from "../routes/item-detail";

function commandResult<T extends { id?: string }>(value: T, sourceContextName = "inventory"): T {
  const id = value.id ?? "cmd_1";
  Object.defineProperty(value, "commandReceipt", {
    value: {
      mode: "eventual",
      commitEventIds: [`evt_${id}`],
      commitPositions: [
        {
          sourceContextName,
          maxGlobalPosition: "42",
          eventIds: [`evt_${id}`],
        },
      ],
    },
    enumerable: false,
  });
  return value;
}

describe("item detail buy now validation and watch intents", () => {
  afterEach(() => {
    vi.clearAllMocks();
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
    } as never)) as { error: string; intent: string };

    expect(result).toEqual({
      error: "Enter a price greater than $0.00 using dollars and cents.",
      intent: "submit-offer",
    });
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
    } as never)) as { error: string; intent: string };

    expect(result).toEqual({
      error: "Enter a quantity of 1 or more.",
      intent: "add-to-cart",
    });
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
    } as never)) as { error: string; intent: string };

    expect(result).toEqual({
      error: "Only 1 available from this listing. Lower the quantity or choose another listing.",
      intent: "buy-this-listing",
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
    } as never)) as { error: string; intent: string };

    expect(result).toEqual({
      error: "This listing is no longer available. Choose another listing.",
      intent: "buy-this-listing",
    });
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
    } as never)) as { error: string; intent: string };

    expect(result).toEqual({
      error: "This offer is no longer available. Choose another offer.",
      intent: "sell-now",
    });
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
  });

  it("rejects selected offers the seller can no longer fulfill before adding to Sell List", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["offers.manage", "offers.view", "listings.view"],
    });
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
    } as never)) as { error: string; intent: string };

    expect(result).toEqual({
      error: "2 requested, but only 1 available. Choose another offer or add product to Sell List.",
      intent: "add-to-sell-list",
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
    } as never)) as { error: string; intent: string };

    expect(result).toEqual({
      error: "Enter a target price of $0.00 or more using dollars and cents.",
      intent: "create-product-alert",
    });
    expect(mockCreateProductAlert).not.toHaveBeenCalled();
  });

  it("saves guest Watch intent before registration without exposing criteria in the return URL", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateAnonymousProductAlertIntent.mockResolvedValueOnce({
      intent_id: "pai_1",
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
      }),
      createAnonymousProductAlertIntent: mockCreateAnonymousProductAlertIntent,
      createProductAlert: mockCreateProductAlert,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "create-product-alert");
    form.set("marketSide", "listing");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Form: Raw");
    form.set("thresholdAmount", "20");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard?market=watch", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe(
      "/register?returnTo=%2Fitems%2Fcharizard-base-set%3Fmarket%3Dwatch%26claimProductAlertIntent%3Dpai_1",
    );
    expect(result.headers.get("Location")).not.toContain("cat_charizard::form:raw");
    expect(result.headers.get("Location")).not.toContain("threshold");
    expect(result.headers.get("Set-Cookie")).toContain("chase_sets_anonymous_product_alerts=anon_watch_1");
    expect(mockCreateAnonymousProductAlertIntent).toHaveBeenCalledWith("anon_watch_1", {
      sourcePath: "/items/charizard-base-set?market=watch",
      marketSide: "listing",
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Form: Raw",
      thresholdAmount: "20.00",
    });
    expect(mockRequireActorFromAuthApi).not.toHaveBeenCalled();
    expect(mockCreateProductAlert).not.toHaveBeenCalled();
  });

  it("claims guest Watch intent for signed-in registration return", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["accounts.view"],
    });
    mockClaimAnonymousProductAlertIntent.mockResolvedValueOnce({
      intent_id: "pai_1",
      status: "claimed",
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        market_listings: [],
        offer_demand_matches: [],
      }),
      claimAnonymousProductAlertIntent: mockClaimAnonymousProductAlertIntent,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({});
    mockCreateInventoryRequestApiClient.mockReturnValue({});

    let redirectResponse: Response | null = null;
    try {
      await loader({
        request: new Request("http://localhost/items/charizard-base-set?market=watch&claimProductAlertIntent=pai_1"),
        params: { id: "charizard-base-set" },
        context: {},
      } as never);
    } catch (error) {
      redirectResponse = error as Response;
    }

    expect(redirectResponse?.status).toBe(302);
    expect(redirectResponse?.headers.get("Location")).toBe(
      "/items/charizard-base-set?market=watch&productAlertCreated=1",
    );
    expect(mockClaimAnonymousProductAlertIntent).toHaveBeenCalledWith("anon_watch_1", "pai_1");
  });

  it("shows Watch claim recovery when the anonymous Product Alert cookie is missing", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["accounts.view"],
    });
    mockReadAnonymousProductAlertOwnerId.mockReturnValueOnce(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        market_listings: [],
        offer_demand_matches: [],
      }),
      claimAnonymousProductAlertIntent: mockClaimAnonymousProductAlertIntent,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({});
    mockCreateInventoryRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set?market=watch&claimProductAlertIntent=pai_1"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(result.productAlertClaimError).toBe(
      "Watch alert registration expired. Start a new alert from the item page.",
    );
    expect(result.initialMarketIntent).toBe("watch");
    expect(result.item?.catalog_item_id).toBe("cat_charizard");
    expect(mockClaimAnonymousProductAlertIntent).not.toHaveBeenCalled();
  });

  it("shows Watch claim recovery when the anonymous Product Alert intent is expired or replayed", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["accounts.view"],
    });
    mockClaimAnonymousProductAlertIntent.mockRejectedValueOnce(
      new Error("Watch alert is no longer available. Start a new alert from the item page."),
    );
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        market_listings: [],
        offer_demand_matches: [],
      }),
      claimAnonymousProductAlertIntent: mockClaimAnonymousProductAlertIntent,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({});
    mockCreateInventoryRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set?market=watch&claimProductAlertIntent=pai_1"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(result.productAlertClaimError).toBe(
      "Watch alert is no longer available. Start a new alert from the item page.",
    );
    expect(result.initialMarketIntent).toBe("watch");
    expect(result.item?.catalog_item_id).toBe("cat_charizard");
    expect(mockClaimAnonymousProductAlertIntent).toHaveBeenCalledWith("anon_watch_1", "pai_1");
  });

  it("keeps saved listing setup visible when seller inventory loading fails", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["listings.view", "listings.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        market_listings: [],
        offer_demand_matches: [],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListingInventory: vi.fn().mockRejectedValue(new Error("Marketplace inventory unavailable")),
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});
    mockCreateInventoryRequestApiClient.mockReturnValue({
      listStorageLocations: vi.fn().mockResolvedValue({
        items: [{ name: "Listing stock" }],
        count: 1,
        total: 1,
      }),
    });

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set?market=sell"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(result.hasListingStockLocation).toBe(true);
    expect(result.sellerInventoryItems).toEqual([]);
    expect(result.listingSetupLoadError).toBeNull();
  });

  it("recognizes saved listing setup by canonical ship-from code", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["listings.view", "listings.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        market_listings: [],
        offer_demand_matches: [],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListingInventory: vi.fn().mockResolvedValue({ items: [], count: 0, total: 0 }),
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});
    mockCreateInventoryRequestApiClient.mockReturnValue({
      listStorageLocations: vi.fn().mockResolvedValue({
        items: [
          {
            name: "Primary fulfillment",
            ship_from_code: "LISTING-STOCK",
          },
        ],
        count: 1,
        total: 1,
      }),
    });

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set?market=sell"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(result.hasListingStockLocation).toBe(true);
    expect(result.listingSetupLoadError).toBeNull();
  });

  it("surfaces temporary listing setup recovery while Inventory storage locations catch up", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["listings.view", "listings.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        market_listings: [],
        offer_demand_matches: [],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListingInventory: vi.fn().mockResolvedValue({ items: [], count: 0, total: 0 }),
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});
    mockCreateInventoryRequestApiClient.mockReturnValue({
      listStorageLocations: vi.fn().mockRejectedValue(
        Object.assign(new Error("Projection read model did not catch up before the freshness timeout."), {
          status: 503,
          body: {
            error: {
              code: "projection_freshness_timeout",
              message: "Projection read model did not catch up before the freshness timeout.",
            },
          },
        }),
      ),
    });

    const result = await loader({
      request: new Request(
        `http://localhost${appendFreshWriteToken(
          "/items/charizard-base-set?market=sell",
          commandResult({ id: "stl_1" }),
        )}`,
      ),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(result.hasListingStockLocation).toBe(false);
    expect(result.listingSetupLoadError).toBe(
      "Ship-from setup is still updating. Refresh in a moment if it is not visible yet.",
    );
  });

  it("saves listing ship-from setup and redirects with Inventory freshness", async () => {
    const createStorageLocation = vi.fn().mockResolvedValue(commandResult({ id: "stl_1" }));
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["listings.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({});
    mockCreateInventoryRequestApiClient.mockReturnValue({
      createStorageLocation,
    });

    const form = new URLSearchParams();
    form.set("intent", "create-listing-stock-location");
    form.set("shipFromName", "Seller Name");
    form.set("shipFromLine1", "123 Market St");
    form.set("shipFromCity", "Chicago");
    form.set("shipFromState", "IL");
    form.set("shipFromPostalCode", "60601");
    form.set("shipFromCountry", "US");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard?market=sell", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    const location = result.headers.get("Location") ?? "";
    const redirectUrl = new URL(location, "http://localhost");

    expect(result.status).toBe(302);
    expect(redirectUrl.pathname).toBe("/items/charizard-base-set");
    expect(redirectUrl.searchParams.get("market")).toBe("sell");
    expect(decodeFreshWriteReceipt(redirectUrl.searchParams.get("afterWrite"))?.sources).toEqual([
      {
        sourceContextName: "inventory",
        maxGlobalPosition: "42",
        eventIds: ["evt_stl_1"],
      },
    ]);
    expect(createStorageLocation).toHaveBeenCalledWith({
      name: "Listing stock",
      description: "Auto-managed stock backing standard marketplace listings.",
      shipFromCode: "LISTING-STOCK",
      shipFromAddress: {
        name: "Seller Name",
        line1: "123 Market St",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
    });
  });

  it("saves guest listing draft intent before seller registration", async () => {
    const createAnonymousListingDraftIntent = vi.fn().mockResolvedValue({
      intent_id: "ldi_1",
    });
    const createListing = vi.fn();
    const publishListing = vi.fn();
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      createAnonymousListingDraftIntent,
      createListing,
      publishListing,
    });
    mockCreateInventoryRequestApiClient.mockReturnValue({
      ensureListingStock: mockEnsureListingStock,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "list-at-price");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Form: Raw");
    form.set("priceAmount", "350.00");
    form.set("quantityCap", "1");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard?market=sell", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe(
      "/register?returnTo=%2Faccount%2Flistings%3FclaimListingIntent%3Dldi_1",
    );
    expect(result.headers.get("Set-Cookie")).toContain("chase_sets_anonymous_listing_drafts=anon_listing_draft_1");
    expect(createAnonymousListingDraftIntent).toHaveBeenCalledWith("anon_listing_draft_1", {
      sourcePath: "/items/charizard-base-set?market=sell",
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Form: Raw",
      priceAmount: "350.00",
      quantityCap: 1,
    });
    expect(mockRequireActorFromAuthApi).not.toHaveBeenCalled();
    expect(mockEnsureListingStock).not.toHaveBeenCalled();
    expect(createListing).not.toHaveBeenCalled();
    expect(publishListing).not.toHaveBeenCalled();
  });

  it("publishes an authenticated item-detail listing and redirects to the fresh sell listing", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["listings.view", "listings.manage"],
    });
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["listings.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
      }),
    });
    const createListing = vi.fn().mockResolvedValue(
      commandResult(
        {
          id: "lst_item_detail",
          version: 1,
          status: "draft",
          feeQuoteFingerprint: "quote_1",
        },
        "marketplace",
      ),
    );
    const publishListing = vi.fn().mockResolvedValue(
      commandResult(
        {
          id: "lst_item_detail",
          version: 2,
          status: "published",
        },
        "marketplace",
      ),
    );
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      createListing,
      publishListing,
    });
    mockEnsureListingStock.mockResolvedValue({
      snapshot: {
        inventoryItemId: "inv_listing_stock",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        totalQuantity: 1,
        storageLocationId: "stl_listing_stock",
        storageLocationName: "Listing stock",
        shipFromCode: "LISTING-STOCK",
        shipFromAddress: {
          name: "Seller Name",
          line1: "123 Market St",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
      },
    });
    mockCreateInventoryRequestApiClient.mockReturnValue({
      ensureListingStock: mockEnsureListingStock,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "list-at-price");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Form: Raw");
    form.set("priceAmount", "24.35");
    form.set("quantityCap", "1");

    const result = (await action({
      request: new Request("http://localhost/items/cat_charizard?market=sell", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    const location = result.headers.get("Location") ?? "";
    const redirectUrl = new URL(location, "http://localhost");
    const receipt = decodeFreshWriteReceipt(redirectUrl.searchParams.get("afterWrite"));

    expect(result.status).toBe(302);
    expect(redirectUrl.pathname).toBe("/items/charizard-base-set");
    expect(redirectUrl.searchParams.get("market")).toBe("sell");
    expect(redirectUrl.searchParams.get("listing")).toBe("lst_item_detail");
    expect(receipt?.sources).toEqual([
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "42",
        eventIds: ["evt_lst_item_detail"],
      },
    ]);
    expect(mockEnsureListingStock).toHaveBeenCalledWith({
      catalogItemId: "cat_charizard",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      quantity: 1,
    });
    expect(createListing).toHaveBeenCalledWith({
      inventoryItemId: "",
      priceAmount: "24.35",
      quantityCap: 1,
      inventorySnapshot: expect.anything(),
    });
    expect(publishListing).toHaveBeenCalledWith("lst_item_detail", {
      feeQuoteFingerprint: "quote_1",
    });
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
    } as never)) as { error: string; intent: string };

    expect(result).toEqual({
      error: "Enter a price greater than $0.00 using dollars and cents.",
      intent: "list-at-price",
    });
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
    } as never)) as { error: string; intent: string };

    expect(result).toEqual({
      error: "Enter a quantity of 1 or more.",
      intent: "list-at-price",
    });
    expect(previewListingTerms).not.toHaveBeenCalled();
  });
});
