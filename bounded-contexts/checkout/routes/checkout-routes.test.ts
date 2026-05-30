import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockCreateCheckoutRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateSettlementRequestApiClient,
  mockCreateOrderingRequestApiClient,
  mockCreatePaymentsRequestApiClient,
  mockCreateAuthRequestApiClient,
  mockCreateCheckoutSession,
  mockGetCheckoutSession,
  mockPreviewCheckoutFulfillment,
  mockPreviewCheckoutStatus,
  mockSelectShippingOption,
  mockSelectShippingAddress,
  mockConfirmCheckoutSession,
  mockStartGuestCheckout,
  mockMergeGuestCartToAccount,
  mockGetCart,
  mockGetGuestCart,
  mockGetGuestSellList,
  mockGetOfferMatch,
  mockListOfferMatches,
  mockPreviewOfferAcceptanceTerms,
  mockAcceptOfferMatch,
  mockCreateListing,
  mockGetPayoutReadiness,
  mockAddSellListLine,
  mockCheckoutSellList,
  mockRemoveGuestSellListLine,
  mockMergeGuestSellListToAccount,
} = vi.hoisted(() => ({
  mockRequireActorFromAuthApi: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
  mockCreateCheckoutRequestApiClient: vi.fn(),
  mockCreateMarketplaceRequestApiClient: vi.fn(),
  mockCreateSettlementRequestApiClient: vi.fn(),
  mockCreateOrderingRequestApiClient: vi.fn(),
  mockCreatePaymentsRequestApiClient: vi.fn(),
  mockCreateAuthRequestApiClient: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
  mockGetCheckoutSession: vi.fn(),
  mockPreviewCheckoutFulfillment: vi.fn(),
  mockPreviewCheckoutStatus: vi.fn(),
  mockSelectShippingOption: vi.fn(),
  mockSelectShippingAddress: vi.fn(),
  mockConfirmCheckoutSession: vi.fn(),
  mockStartGuestCheckout: vi.fn(),
  mockMergeGuestCartToAccount: vi.fn(),
  mockGetCart: vi.fn(),
  mockGetGuestCart: vi.fn(),
  mockGetGuestSellList: vi.fn(),
  mockGetOfferMatch: vi.fn(),
  mockListOfferMatches: vi.fn(),
  mockPreviewOfferAcceptanceTerms: vi.fn(),
  mockAcceptOfferMatch: vi.fn(),
  mockCreateListing: vi.fn(),
  mockGetPayoutReadiness: vi.fn(),
  mockAddSellListLine: vi.fn(),
  mockCheckoutSellList: vi.fn(),
  mockRemoveGuestSellListLine: vi.fn(),
  mockMergeGuestSellListToAccount: vi.fn(),
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

vi.mock("@chase-sets/auth/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/auth/server")>("@chase-sets/auth/server");

  return {
    ...actual,
    createAuthRequestApiClient: mockCreateAuthRequestApiClient,
  };
});

vi.mock("../support/request-support/api-client", () => ({
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
}));

vi.mock("@chase-sets/ordering/server", () => ({
  createOrderingRequestApiClient: mockCreateOrderingRequestApiClient,
}));

vi.mock("@chase-sets/payments/server", () => ({
  createPaymentsRequestApiClient: mockCreatePaymentsRequestApiClient,
  normalizeRequestedBalanceCreditAmount: (value: unknown) => {
    const text = String(value ?? "").trim();
    return text ? text : null;
  },
}));

vi.mock("@chase-sets/marketplace/server", () => ({
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
}));

vi.mock("@chase-sets/settlement/server", () => ({
  createSettlementRequestApiClient: mockCreateSettlementRequestApiClient,
}));

import { AuthApiError } from "@chase-sets/auth/server";
import {
  action as checkoutStartAction,
  checkoutStartBuyerProtectionItems,
  checkoutStartHeaderCopy,
  loader as checkoutStartLoader,
} from "./checkout-start";
import { action as checkoutSessionAction, loader as checkoutSessionLoader } from "./checkout-session";
import { loader as accountCartLoader } from "./account-cart";
import { action as accountSellListAction } from "./account-sell-list";

describe("checkout web routes", () => {
  beforeEach(() => {
    mockCreateSettlementRequestApiClient.mockReturnValue({
      getPayoutReadiness: mockGetPayoutReadiness.mockResolvedValue({
        account_id: "acc_seller",
        status: "ready",
        missing_requirements: [],
        provider_reference: "acct_1",
        onboarding_status: "complete",
        transfer_capability_status: "active",
        payout_capability_status: "active",
        payout_destination_status: "ready",
        updated_at: "2026-05-30T00:00:00.000Z",
      }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function guestCheckoutActor() {
    return {
      sessionId: "guest:tok_1",
      tenantId: "tnt_identity",
      userId: "usr_guest_checkout",
      accountId: "acc_guest",
      membershipId: "guest:tok_1",
      roleKey: "guest-buyer",
      permissions: ["guest-checkout.manage"],
    };
  }

  it("starts cart checkout through the canonical checkout session API", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_cart" });
    mockMergeGuestCartToAccount.mockResolvedValue({ status: "merged" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_cart=anon_cart_1",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockMergeGuestCartToAccount).toHaveBeenCalledWith("anon_cart_1");
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: { type: "cart" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_cart");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_cart=");
  });

  it("keeps signed-out buyers on the checkout start choice page with a checkout return target", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestCart.mockResolvedValue({ items: [], count: 2 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
    });

    const result = await checkoutStartLoader({
      request: new Request("http://localhost/checkout/start"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      isSignedIn: false,
      source: null,
      cartCount: 2,
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fstart",
    });
  });

  it("falls back to the anonymous cart when guest checkout returns to cart", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockGetGuestCart.mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
      getGuestCart: mockGetGuestCart,
    });

    const result = await accountCartLoader({
      request: new Request("http://localhost/account/cart", {
        headers: { cookie: "chase_sets_anonymous_cart=anon_cart_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({ cart: { items: [], count: 0 } });
    expect(mockGetGuestCart).toHaveBeenCalledWith("anon_cart_1");
    expect(mockGetCart).not.toHaveBeenCalled();
  });

  it("adds a Marketplace offer match to the Checkout-owned sell list", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetOfferMatch.mockResolvedValue({
      offer_id: "off_1",
      buyer_account_id: "acc_buyer",
      buyer_display_name: "Collector123",
      price_amount: "40.00",
      catalog_catalog_item_id: "cat_mewtwo",
      product_id: "cat_mewtwo::raw:nm",
      item_title: "Mewtwo",
      item_subtitle: "Black Star Promo 3",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Raw / Near Mint",
      quantity_requested: 2,
    });
    mockAddSellListLine.mockResolvedValue({ status: "added" });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getOfferMatch: mockGetOfferMatch,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addSellListLine: mockAddSellListLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-selected-offer");
    form.set("offerId", "off_1");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockGetOfferMatch).toHaveBeenCalledWith("off_1");
    expect(mockAddSellListLine).toHaveBeenCalledWith({
      lineType: "selected-offer",
      offerId: "off_1",
      buyerAccountId: "acc_buyer",
      buyerDisplayName: "Collector123",
      offerPriceAmount: "40.00",
      catalogItemId: "cat_mewtwo",
      productId: "cat_mewtwo::raw:nm",
      itemTitle: "Mewtwo",
      itemSubtitle: "Black Star Promo 3",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw / Near Mint",
      quantity: 2,
      fallbackMode: "none",
      minimumListingPriceAmount: null,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/sell-list");
  });

  it("records sale checkout review from the Sell List", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockCheckoutSellList.mockResolvedValue({ status: "reviewed" });
    mockAcceptOfferMatch.mockResolvedValue({ status: "accepted" });
    const sellListLine = {
      line_id: "sll_1",
      line_type: "selected-offer",
      offer_id: "off_1",
      item_title: "Mewtwo",
      quantity: 1,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 1 })),
      checkoutSellList: mockCheckoutSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("offerFeeQuoteFingerprint:sll_1", "quote_1");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_1", { feeQuoteFingerprint: "quote_1" });
    expect(mockCheckoutSellList).toHaveBeenCalledWith({
      completedLineIds: ["sll_1"],
      remainingLineQuantities: [],
      executionSummary: {
        acceptedOfferCount: 1,
        createdListingCount: 0,
        skippedLineCount: 0,
        skippedReasons: [],
        lineOutcomes: [
          expect.objectContaining({
            lineId: "sll_1",
            status: "completed",
            action: "accepted-offer",
            remainingQuantity: 0,
          }),
        ],
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/account/sell-list?review=completed&accepted=1&listings=0&skipped=0",
    );
  });

  it("accepts product-level Sell List Smart Match offers before fallback listings", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockCheckoutSellList.mockResolvedValue({ status: "reviewed" });
    mockGetOfferMatch.mockResolvedValue({
      offer_id: "off_product_1",
      product_id: "cat_mewtwo::raw:nm",
      quantity_requested: 2,
    });
    mockAcceptOfferMatch.mockResolvedValue({ status: "accepted" });
    const sellListLine = {
      line_id: "sll_product",
      line_type: "product",
      offer_id: null,
      product_id: "cat_mewtwo::raw:nm",
      item_title: "Mewtwo",
      quantity: 2,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 1 })),
      checkoutSellList: mockCheckoutSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getOfferMatch: mockGetOfferMatch,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("productOfferId:sll_product", "off_product_1");
    form.set("productOfferFeeQuoteFingerprint:sll_product:off_product_1", "quote_product_1");
    form.set("fallbackMode:sll_product", "none");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_product_1", { feeQuoteFingerprint: "quote_product_1" });
    expect(mockCreateListing).not.toHaveBeenCalled();
    expect(mockCheckoutSellList).toHaveBeenCalledWith({
      completedLineIds: ["sll_product"],
      remainingLineQuantities: [],
      executionSummary: {
        acceptedOfferCount: 1,
        createdListingCount: 0,
        skippedLineCount: 0,
        skippedReasons: [],
        lineOutcomes: [
          expect.objectContaining({
            lineId: "sll_product",
            status: "completed",
            action: "accepted-smart-match",
            remainingQuantity: 0,
          }),
        ],
      },
    });
    expect(response.status).toBe(302);
  });

  it("records partial Sell List execution with remaining quantity for recovery", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockCheckoutSellList.mockResolvedValue({ status: "reviewed" });
    mockGetOfferMatch.mockResolvedValue({
      offer_id: "off_product_1",
      product_id: "cat_mewtwo::raw:nm",
      quantity_requested: 2,
    });
    mockAcceptOfferMatch.mockResolvedValue({ status: "accepted" });
    const sellListLine = {
      line_id: "sll_product",
      line_type: "product",
      offer_id: null,
      product_id: "cat_mewtwo::raw:nm",
      item_title: "Mewtwo",
      quantity: 3,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 3 })),
      checkoutSellList: mockCheckoutSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getOfferMatch: mockGetOfferMatch,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("productOfferId:sll_product", "off_product_1");
    form.set("productOfferFeeQuoteFingerprint:sll_product:off_product_1", "quote_product_1");
    form.set("fallbackMode:sll_product", "create-listing");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_product_1", { feeQuoteFingerprint: "quote_product_1" });
    expect(mockCheckoutSellList).toHaveBeenCalledWith({
      completedLineIds: [],
      remainingLineQuantities: [{ lineId: "sll_product", quantity: 1 }],
      executionSummary: expect.objectContaining({
        acceptedOfferCount: 1,
        createdListingCount: 0,
        skippedLineCount: 1,
        lineOutcomes: [
          expect.objectContaining({
            lineId: "sll_product",
            status: "partial",
            remainingQuantity: 1,
          }),
        ],
      }),
    });
    expect(response.status).toBe(302);
  });

  it("keeps capped fallback listing remainder in the Sell List", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockCheckoutSellList.mockResolvedValue({ status: "reviewed" });
    mockGetOfferMatch.mockResolvedValue({
      offer_id: "off_product_1",
      product_id: "cat_mewtwo::raw:nm",
      quantity_requested: 1,
    });
    mockAcceptOfferMatch.mockResolvedValue({ status: "accepted" });
    mockCreateListing.mockResolvedValue({ listing_id: "lst_1" });
    const sellListLine = {
      line_id: "sll_product",
      line_type: "product",
      offer_id: null,
      product_id: "cat_mewtwo::raw:nm",
      item_title: "Mewtwo",
      quantity: 4,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 4 })),
      checkoutSellList: mockCheckoutSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getOfferMatch: mockGetOfferMatch,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("productOfferId:sll_product", "off_product_1");
    form.set("productOfferFeeQuoteFingerprint:sll_product:off_product_1", "quote_product_1");
    form.set("fallbackMode:sll_product", "create-listing");
    form.set("inventoryItemId:sll_product", "inv_1");
    form.set("priceAmount:sll_product", "12.00");
    form.set("quantityCap:sll_product", "1");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockCreateListing).toHaveBeenCalledWith({
      inventoryItemId: "inv_1",
      priceAmount: "12.00",
      quantityCap: 1,
    });
    expect(mockCheckoutSellList).toHaveBeenCalledWith({
      completedLineIds: [],
      remainingLineQuantities: [{ lineId: "sll_product", quantity: 2 }],
      executionSummary: expect.objectContaining({
        acceptedOfferCount: 1,
        createdListingCount: 1,
        skippedLineCount: 1,
        lineOutcomes: [
          expect.objectContaining({
            lineId: "sll_product",
            status: "partial",
            action: "mixed",
            remainingQuantity: 2,
          }),
        ],
      }),
    });
    expect(response.status).toBe(302);
  });

  it("blocks Sell List checkout when payout readiness is not ready", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetPayoutReadiness.mockResolvedValue({
      account_id: "acc_seller",
      status: "pending",
      missing_requirements: ["provider-onboarding"],
      provider_reference: null,
      onboarding_status: "pending",
      transfer_capability_status: "pending",
      payout_capability_status: "inactive",
      payout_destination_status: "missing",
      updated_at: "2026-05-30T00:00:00.000Z",
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [], count: 0 })),
      checkoutSellList: mockCheckoutSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");

    const result = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as { error: string };

    expect(result.error).toBe("Finish payout setup before committing sale checkout.");
    expect(mockCheckoutSellList).not.toHaveBeenCalled();
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
  });

  it("shows anonymous Sell List lines before account creation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestSellList.mockResolvedValue({ items: [{ line_id: "sll_1", quantity: 1 }], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
    });

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      isSignedIn: false,
      reviewCompleted: false,
      sellList: { items: [{ line_id: "sll_1", quantity: 1 }], count: 1 },
    });
    expect(mockGetGuestSellList).toHaveBeenCalledWith("anon_sell_1");
  });

  it("merges anonymous Sell List lines after sign-in returns to Sell List review", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockMergeGuestSellListToAccount.mockResolvedValue({ mergedLineCount: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [], count: 0 })),
      mergeGuestSellListToAccount: mockMergeGuestSellListToAccount,
    });

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result.isSignedIn).toBe(true);
    expect(mockMergeGuestSellListToAccount).toHaveBeenCalledWith("anon_sell_1");
  });

  it("passes sale checkout review completion to the Sell List page", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [], count: 0 })),
    });

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list?review=completed"),
      params: {},
      context: undefined,
    } as never);

    expect(result.reviewCompleted).toBe(true);
  });

  it("removes anonymous Sell List lines before sign-in", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockRemoveGuestSellListLine.mockResolvedValue({ status: "removed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      removeGuestSellListLine: mockRemoveGuestSellListLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "remove-sell-list-line");
    form.set("lineId", "sll_1");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_sell_list=anon_sell_1",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockRemoveGuestSellListLine).toHaveBeenCalledWith("anon_sell_1", "sll_1");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/sell-list");
  });

  it("preserves buy-now checkout intent in the sign-in return target", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await checkoutStartLoader({
      request: new Request(
        "http://localhost/checkout/start?source=buy-now&listingId=lst_1&catalogItemId=cat_1&productId=prod_1&itemTitle=Charizard&quantity=1",
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.isSignedIn).toBe(false);
    expect(result.source).toEqual(
      expect.objectContaining({
        type: "buy-now",
        listingId: "lst_1",
        catalogItemId: "cat_1",
      }),
    );
    expect(result.signInPath).toBe(
      "/sign-in?returnTo=%2Fcheckout%2Fstart%3Fsource%3Dbuy-now%26listingId%3Dlst_1%26catalogItemId%3Dcat_1%26productId%3Dprod_1%26itemTitle%3DCharizard%26quantity%3D1",
    );
  });

  it("shows a signed-in continuation state after sign-in returns to checkout start", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await checkoutStartLoader({
      request: new Request("http://localhost/checkout/start"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      isSignedIn: true,
      source: null,
      cartCount: 0,
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fstart",
    });
    expect(mockGetGuestCart).not.toHaveBeenCalled();
  });

  it("starts signed-in buy-now checkout from the preserved checkout start payload", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_buy_now" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "buy-now");
    form.set("listingId", "lst_1");
    form.set("catalogItemId", "cat_1");
    form.set("productId", "prod_1");
    form.set("itemTitle", "Charizard");
    form.set("itemSubtitle", "Base Set");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "condition", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/start", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "buy-now",
        listingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set",
        selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
        productSummary: "Raw",
        priceAmount: null,
        sellerName: null,
        availability: null,
        fulfillment: null,
        fulfillmentMode: "optimize",
        lockedListingId: null,
        quantity: 2,
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_buy_now");
  });

  it("starts signed-in purchase-intent checkout from the preserved checkout start payload", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_offer" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "offer-intent");
    form.set("catalogItemId", "cat_1");
    form.set("productId", "prod_1");
    form.set("itemTitle", "Charizard");
    form.set("itemSubtitle", "Base Set");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "condition", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("offerPriceAmount", "350.00");
    form.set("quantity", "2");

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/start", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "offer-intent",
        catalogItemId: "cat_1",
        productId: "prod_1",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set",
        selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
        productSummary: "Raw",
        offerPriceAmount: "350.00",
        quantity: 2,
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_offer");
  });

  it("keeps checkout visible when live fulfillment preview is temporarily unavailable", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetCheckoutSession.mockResolvedValue({
      session_id: "chk_1",
      source_type: "buy-now",
      payment_id: null,
      submitted_offer_id: null,
      shipping_option: "standard",
      optimization_goal: "lowest-total",
      fulfillment_preview_revision: null,
      order_ids: [],
      lines: [
        {
          listingId: null,
          cartLineId: null,
          catalogItemId: "cat_1",
          productId: "prd_1",
          itemTitle: "Test card",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
        },
      ],
    });
    mockPreviewCheckoutFulfillment.mockRejectedValue(new Error("preview unavailable"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });

    const result = await checkoutSessionLoader({
      request: new Request("http://localhost/checkout/chk_1"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        fulfillmentPreview: null,
        previewError:
          "Live fulfillment preview is temporarily unavailable. You can still review checkout and refresh before confirming.",
      }),
    );
    expect(mockPreviewCheckoutFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "chk_1",
        sourceType: "buy-now",
      }),
    );
  });

  it("loads a Payments-owned checkout fee preview before order creation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockGetCheckoutSession.mockResolvedValue({
      session_id: "chk_1",
      source_type: "buy-now",
      payment_id: null,
      submitted_offer_id: null,
      shipping_option: "standard",
      shipping_address: null,
      optimization_goal: "lowest-total",
      fulfillment_preview_revision: null,
      order_ids: [],
      lines: [
        {
          listingId: "lst_1",
          cartLineId: null,
          catalogItemId: "cat_1",
          productId: "prd_1",
          itemTitle: "Test card",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
        },
      ],
    });
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "rev_1",
      readyLineKeys: ["lst_1"],
      unavailableLineKeys: [],
      unavailableLines: [],
      materialChangeReasons: [],
      sellerGroups: [],
      totals: {
        itemSubtotalAmount: "20.00",
        shippingAmount: "4.00",
        salesTaxAmount: "2.00",
        totalAmount: "26.00",
        packageCount: 1,
      },
    });
    mockPreviewCheckoutStatus.mockResolvedValue({
      amount: "26.00",
      marketplace_checkout_fee: { total_amount: "27.10" },
      wallet_credit: { applied_amount: "0.00" },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });
    mockCreatePaymentsRequestApiClient.mockReturnValue({
      previewCheckoutStatus: mockPreviewCheckoutStatus,
    });

    const result = await checkoutSessionLoader({
      request: new Request("http://localhost/checkout/chk_1"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(mockPreviewCheckoutStatus).toHaveBeenCalledWith({
      amount: "26.00",
      currencyCode: "usd",
      requestedBalanceCreditAmount: "0.00",
      paymentMethodCategory: "card",
    });
    expect(result.paymentPreview).toEqual({
      amount: "26.00",
      marketplace_checkout_fee: { total_amount: "27.10" },
      wallet_credit: { applied_amount: "0.00" },
    });
  });

  it("starts signed-out cart checkout by creating a guest account and merging the anonymous cart", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockStartGuestCheckout.mockResolvedValue({
      accountId: "acc_guest",
      guestToken: "guest_token",
      expiresAt: "2026-04-02T00:00:00.000Z",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_guest" });
    mockMergeGuestCartToAccount.mockResolvedValue({ status: "merged" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("contactName", "Jane Smith");
    form.set("email", "jane@example.com");
    form.set("source", "cart");

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_cart=anon_cart_1",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockStartGuestCheckout).toHaveBeenCalledWith({
      displayName: "Jane Smith",
      email: "jane@example.com",
    });
    expect(mockMergeGuestCartToAccount).toHaveBeenCalledWith("anon_cart_1");
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: { type: "cart" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_guest");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_guest_checkout=guest_token");
  });

  it("returns a sign-in prompt when guest checkout uses an account email", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockStartGuestCheckout.mockRejectedValue(
      new AuthApiError(409, {
        error: {
          code: "account_sign_in_required",
          message: "Sign in to continue checkout with this email.",
        },
      }),
    );
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("contactName", "Jane Smith");
    form.set("email", "jane@example.com");
    form.set("source", "cart");

    const result = await checkoutStartAction({
      request: new Request("http://localhost/checkout/start", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      error: "Sign in to continue checkout with this email. Your Buy Cart will stay ready.",
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fstart",
    });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
  });

  it("requires registration or sign-in before starting purchase-intent checkout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("source", "offer-intent");

    const result = await checkoutStartAction({
      request: new Request("http://localhost/checkout/start?source=offer-intent", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      error: "Register or sign in to place purchase intent.",
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fstart%3Fsource%3Doffer-intent",
    });
    expect(mockStartGuestCheckout).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("uses purchase-intent account copy instead of guest checkout copy", () => {
    expect(checkoutStartHeaderCopy({ isSignedIn: false, isOfferIntent: true })).toEqual({
      title: "Register to place purchase intent",
      description:
        "Register or sign in to place your purchase intent. Sellers review the offer before any payment is collected.",
    });
    expect(checkoutStartHeaderCopy({ isSignedIn: true, isOfferIntent: true })).toEqual({
      title: "Place purchase intent",
      description: "Confirm shipping so the seller can review your purchase intent. No payment today.",
    });
    expect(
      checkoutStartBuyerProtectionItems(true)
        .map((item) => item.description)
        .join(" "),
    ).not.toContain("Guest");
  });

  it("confirms signed-in checkout and redirects to payment total review", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ order_ids: ["ord_1"], status: "orders-created" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "priority");
    form.set("paymentMethodCategory", "bank-account");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingLine2", "");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");
    form.set("previewPaymentMethodCategory", "bank-account");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(mockSelectShippingOption).toHaveBeenCalledWith("chk_1", {
      shippingOption: "priority",
    });
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith("chk_1", {
      requestedBalanceCreditAmount: null,
      paymentMethodCategory: "bank-account",
      marketplaceCheckoutFeeQuoteFingerprint: null,
      fulfillmentPreviewRevision: null,
      acknowledgedMaterialChanges: false,
      deferPayment: true,
      shippingAddress: {
        shippingAddressId: null,
        name: "Jane Smith",
        company: null,
        line1: "100 Market Street",
        line2: null,
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        phone: null,
        email: null,
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/payments/new?orderIds=ord_1");
  });

  it("refreshes checkout totals by saving the current shipping address without confirming", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectShippingAddress.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "refresh-checkout-preview");
    form.set("shippingOption", "expedited");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");
    form.set("previewPaymentMethodCategory", "bank-account");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(mockSelectShippingOption).toHaveBeenCalledWith("chk_1", {
      shippingOption: "expedited",
    });
    expect(mockSelectShippingAddress).toHaveBeenCalledWith("chk_1", {
      shippingAddress: expect.objectContaining({
        name: "Jane Smith",
        postalCode: "60601",
      }),
    });
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_1?paymentMethodCategory=bank-account");
  });

  it("refreshes checkout totals instead of confirming when the visible payment method changed", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectShippingAddress.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "bank-account");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
    expect(mockSelectShippingAddress).toHaveBeenCalledWith("chk_1", {
      shippingAddress: expect.objectContaining({ postalCode: "60601" }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_1?paymentMethodCategory=bank-account&review=updated");
  });

  it("refreshes checkout review instead of confirming when submitted shipping differs from the visible preview", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectShippingAddress.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "priority");
    form.set("reviewedShippingOption", "standard");
    form.set("reviewedShippingAddressSignature", "previous-preview");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(mockSelectShippingOption).toHaveBeenCalledWith("chk_1", {
      shippingOption: "priority",
    });
    expect(mockSelectShippingAddress).toHaveBeenCalledWith("chk_1", {
      shippingAddress: expect.objectContaining({
        name: "Jane Smith",
        postalCode: "60601",
      }),
    });
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_1?paymentMethodCategory=card&review=updated");
  });

  it("keeps guest checkout confirmation on the guest payment route", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"] });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "priority");
    form.set("paymentMethodCategory", "bank-account");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/payments/pay_1");
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        deferPayment: false,
      }),
    );
  });

  it("redirects confirmed purchase intent to the submitted offer", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ offer_id: "off_chk_1", status: "purchase-intent-submitted" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        paymentMethodCategory: "card",
        shippingAddress: expect.objectContaining({
          name: "Jane Smith",
          postalCode: "60601",
        }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/offers/submitted/off_chk_1?feedbackWorkflow=offer-submit");
  });

  it("redirects completed checkout sessions to payment detail", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => ({
        session_id: "chk_1",
        buyer_account_id: "acc_buyer",
        source_type: "cart",
        shipping_option: "standard",
        lines: [],
        order_ids: ["ord_1"],
        payment_id: "pay_1",
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      })),
    });

    let redirectResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      redirectResponse = error as Response;
    }

    expect(redirectResponse?.status).toBe(302);
    expect(redirectResponse?.headers.get("Location")).toBe("/account/payments/pay_1");
  });

  it("redirects submitted purchase-intent sessions to the submitted offer", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => ({
        session_id: "chk_1",
        buyer_account_id: "acc_buyer",
        source_type: "offer-intent",
        shipping_option: "standard",
        lines: [],
        order_ids: [],
        payment_id: null,
        submitted_offer_id: "off_chk_1",
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      })),
    });

    let redirectResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      redirectResponse = error as Response;
    }

    expect(redirectResponse?.status).toBe(302);
    expect(redirectResponse?.headers.get("Location")).toBe(
      "/account/offers/submitted/off_chk_1?feedbackWorkflow=offer-submit",
    );
  });

  it("keeps completed guest checkout sessions on the guest payment route", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => ({
        session_id: "chk_1",
        buyer_account_id: "acc_guest",
        source_type: "cart",
        shipping_option: "standard",
        lines: [],
        order_ids: ["ord_1"],
        payment_id: "pay_1",
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      })),
    });

    let redirectResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      redirectResponse = error as Response;
    }

    expect(redirectResponse?.status).toBe(302);
    expect(redirectResponse?.headers.get("Location")).toBe("/checkout/payments/pay_1");
  });
});
