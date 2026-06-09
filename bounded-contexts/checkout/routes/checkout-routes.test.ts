import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";

const {
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockCreateCheckoutRequestApiClient,
  MockCheckoutApiError,
  mockCreateMarketplaceRequestApiClient,
  mockCreateSettlementRequestApiClient,
  mockCreateOrderingRequestApiClient,
  mockCreatePaymentsRequestApiClient,
  mockCreateAuthRequestApiClient,
  mockCreateCheckoutSession,
  mockCreateCartReadiness,
  mockCreateSellListReadiness,
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
  mockUpdateCartLineQuantity,
  mockRemoveCartLine,
  mockGetGuestSellList,
  mockGetOfferMatch,
  mockListOfferMatches,
  mockPreviewOfferAcceptanceTerms,
  mockAcceptOfferMatch,
  mockCreateListing,
  mockGetPayoutReadiness,
  mockAddSellListLine,
  mockStartSellListExecution,
  mockRecordSellListExecutionProgress,
  mockCheckoutSellList,
  mockRemoveGuestSellListLine,
  mockMergeGuestSellListToAccount,
} = vi.hoisted(() => ({
  mockRequireActorFromAuthApi: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
  mockCreateCheckoutRequestApiClient: vi.fn(),
  MockCheckoutApiError: class CheckoutApiError extends Error {
    public constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`Checkout API error ${status}`);
    }
  },
  mockCreateMarketplaceRequestApiClient: vi.fn(),
  mockCreateSettlementRequestApiClient: vi.fn(),
  mockCreateOrderingRequestApiClient: vi.fn(),
  mockCreatePaymentsRequestApiClient: vi.fn(),
  mockCreateAuthRequestApiClient: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
  mockCreateCartReadiness: vi.fn(),
  mockCreateSellListReadiness: vi.fn(),
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
  mockUpdateCartLineQuantity: vi.fn(),
  mockRemoveCartLine: vi.fn(),
  mockGetGuestSellList: vi.fn(),
  mockGetOfferMatch: vi.fn(),
  mockListOfferMatches: vi.fn(),
  mockPreviewOfferAcceptanceTerms: vi.fn(),
  mockAcceptOfferMatch: vi.fn(),
  mockCreateListing: vi.fn(),
  mockGetPayoutReadiness: vi.fn(),
  mockAddSellListLine: vi.fn(),
  mockStartSellListExecution: vi.fn(),
  mockRecordSellListExecutionProgress: vi.fn(),
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
  CheckoutApiError: MockCheckoutApiError,
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
import { action as accountCartAction, loader as accountCartLoader } from "./account-cart";
import { action as accountSellListAction } from "./account-sell-list";

describe("checkout web routes", () => {
  beforeEach(() => {
    mockStartSellListExecution.mockImplementation(async (body: { executionPlan: unknown }) => ({
      status: "pending",
      executionPlan: body.executionPlan,
      executionProgress: { completedActionKeys: [] },
      executionSummary: null,
    }));
    mockRecordSellListExecutionProgress.mockResolvedValue({
      status: "pending",
      executionProgress: { completedActionKeys: [] },
    });
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
    mockCreateCartReadiness.mockResolvedValue(readyCartReadinessResponse());
    mockCreateSellListReadiness.mockResolvedValue(readySellListReadinessResponse());
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

  function checkoutCommit(position: string, eventId: string) {
    return {
      commitPosition: position,
      commitEventIds: [eventId],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: position,
          eventIds: [eventId],
        },
      ],
    };
  }

  function readyCartReadinessResponse() {
    return {
      readiness: {
        schemaVersion: "checkout.cart-readiness.v1",
        source: "cart",
        sourceRevision: "cr_source",
        snapshotId: "cr_ready",
        status: "ready",
        lineCount: 1,
        includedLineIds: ["cart_line_1"],
        unresolvedLineIds: [],
        lineOutcomes: [{ lineId: "cart_line_1", outcome: "checkout", reason: "ready" }],
        optimization: {
          available: false,
          decision: "none",
          proposedLineId: null,
          proposedListingId: null,
          currentListingId: null,
          savingsAmount: null,
          currency: "USD",
        },
        customerSafeFacts: ["Ready for checkout."],
      },
    };
  }

  function readySellListReadinessResponse() {
    return {
      readiness: {
        schemaVersion: "checkout.sell-list-readiness.v1",
        source: "sell-list",
        sourceRevision: "slr_source",
        snapshotId: "slr_ready",
        status: "ready",
        lineCount: 1,
        includedLineIds: ["sll_1"],
        unresolvedLineIds: [],
        lineOutcomes: [{ lineId: "sll_1", outcome: "checkout", reason: "ready", action: "selected-offer" }],
        sellerReadiness: {
          payout: "not-evaluated",
          shipFrom: "not-evaluated",
          label: "not-evaluated",
        },
        customerSafeFacts: ["Ready for seller checkout."],
      },
    };
  }

  function freshCheckoutRequest(path = "/checkout/chk_1") {
    return new Request(`http://localhost${appendFreshWriteToken(path, checkoutCommit("42", "evt_checkout"))}`);
  }

  it("starts cart checkout through the canonical checkout session API", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_cart" });
    mockMergeGuestCartToAccount.mockResolvedValue({ status: "merged" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");
    form.set("readinessSnapshotId", "cr_ready");
    form.set("readinessSourceRevision", "cr_source");
    form.set(
      "readinessDecisions",
      JSON.stringify({ optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" } }),
    );

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
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({
      lineOutcomes: [],
      optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" },
    });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "cart",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: {
          lineOutcomes: [],
          optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" },
        },
      },
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
      isGuestBuyer: false,
      source: null,
      cartCount: 2,
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fstart",
    });
  });

  it("marks guest checkout actors separately from registered signed-in accounts on checkout start", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await checkoutStartLoader({
      request: new Request("http://localhost/checkout/start"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      isSignedIn: false,
      isGuestBuyer: true,
      source: null,
      cartCount: 0,
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fstart",
    });
  });

  it("returns checkout-owned recovery instead of creating a guest account for an empty signed-out cart", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestCart.mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
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
      recovery: expect.objectContaining({
        kind: "cart-empty",
        title: "Your Buy Cart is empty",
        primaryAction: expect.objectContaining({ href: "/account/cart" }),
        secondaryAction: expect.objectContaining({ href: "/search" }),
      }),
    });
    expect(mockStartGuestCheckout).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns checkout-owned recovery when guest-buyer checkout reentry starts from an empty cart", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutSession.mockRejectedValue(
      new MockCheckoutApiError(400, {
        error: {
          code: "cart_empty",
          message: "Cart must contain at least one line.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");

    const result = await checkoutStartAction({
      request: new Request("http://localhost/checkout/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_guest_checkout=guest_token",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      recovery: expect.objectContaining({
        kind: "cart-empty",
        description: "Add items to your Buy Cart before starting checkout.",
      }),
    });
    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
  });

  it("still throws unknown checkout-start failures", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutSession.mockRejectedValue(new Error("database unavailable"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");

    await expect(
      checkoutStartAction({
        request: new Request("http://localhost/checkout/start", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toThrow("database unavailable");
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

  it("updates the primary grouped cart line and removes duplicate line ids", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockUpdateCartLineQuantity.mockResolvedValue(checkoutCommit("43", "evt_quantity"));
    mockRemoveCartLine.mockResolvedValue(checkoutCommit("44", "evt_duplicate_removed"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      updateCartLineQuantity: mockUpdateCartLineQuantity,
      removeCartLine: mockRemoveCartLine,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("quantity", "2");
    form.set("quantityDelta", "1");
    form.set("intent", "update-cart-line");

    const response = (await accountCartAction({
      request: new Request("http://localhost/account/cart", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockUpdateCartLineQuantity).toHaveBeenCalledWith("cli_primary", { quantity: 3 });
    expect(mockRemoveCartLine).toHaveBeenCalledWith("cli_duplicate");
    expect(response.status).toBe(302);
    expect(readFreshWriteToken(response.headers.get("Location") ?? "")).toMatchObject({
      commitPosition: "44",
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "44", eventIds: ["evt_duplicate_removed"] }],
    });
  });

  it("removes every grouped cart line id from the simplified cart page", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockRemoveCartLine
      .mockResolvedValueOnce(checkoutCommit("45", "evt_primary_removed"))
      .mockResolvedValueOnce(checkoutCommit("46", "evt_duplicate_removed"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      removeCartLine: mockRemoveCartLine,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("intent", "remove-cart-line");

    const response = (await accountCartAction({
      request: new Request("http://localhost/account/cart", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockRemoveCartLine).toHaveBeenCalledWith("cli_primary");
    expect(mockRemoveCartLine).toHaveBeenCalledWith("cli_duplicate");
    expect(response.status).toBe(302);
    expect(readFreshWriteToken(response.headers.get("Location") ?? "")).toMatchObject({
      commitPosition: "46",
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "46", eventIds: ["evt_duplicate_removed"] }],
    });
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
      startSellListExecution: mockStartSellListExecution,
      recordSellListExecutionProgress: mockRecordSellListExecutionProgress,
      createSellListReadiness: mockCreateSellListReadiness,
      checkoutSellList: mockCheckoutSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("sellListExecutionId", "sle_1");
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

    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_1", {
      feeQuoteFingerprint: "quote_1",
      sourceActionKey: "sle_1:selected-offer:sll_1:off_1",
    });
    expect(mockStartSellListExecution).toHaveBeenCalledWith({
      executionId: "sle_1",
      executionPlan: expect.objectContaining({ version: 1 }),
    });
    expect(mockCheckoutSellList).toHaveBeenCalledWith({
      executionId: "sle_1",
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
      readinessDecisions: {
        lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
        lineOutcomes: [],
      },
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
      "/account/sell-list?review=completed&accepted=1&listings=0&skipped=0&execution=sle_1",
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
      startSellListExecution: mockStartSellListExecution,
      recordSellListExecutionProgress: mockRecordSellListExecutionProgress,
      createSellListReadiness: mockCreateSellListReadiness,
      checkoutSellList: mockCheckoutSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getOfferMatch: mockGetOfferMatch,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("sellListExecutionId", "sle_1");
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

    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_product_1", {
      feeQuoteFingerprint: "quote_product_1",
      sourceActionKey: "sle_1:smart-match:sll_product:off_product_1",
    });
    expect(mockCreateListing).not.toHaveBeenCalled();
    expect(mockCheckoutSellList).toHaveBeenCalledWith({
      executionId: "sle_1",
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
      readinessDecisions: {
        lineActions: [{ lineId: "sll_product", action: "smart-match" }],
        lineOutcomes: [],
      },
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
      startSellListExecution: mockStartSellListExecution,
      recordSellListExecutionProgress: mockRecordSellListExecutionProgress,
      createSellListReadiness: mockCreateSellListReadiness,
      checkoutSellList: mockCheckoutSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getOfferMatch: mockGetOfferMatch,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("sellListExecutionId", "sle_1");
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

    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_product_1", {
      feeQuoteFingerprint: "quote_product_1",
      sourceActionKey: "sle_1:smart-match:sll_product:off_product_1",
    });
    expect(mockCheckoutSellList).toHaveBeenCalledWith({
      executionId: "sle_1",
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
      readinessDecisions: {
        lineActions: [{ lineId: "sll_product", action: "smart-match" }],
        lineOutcomes: [],
      },
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

  it("keeps unresolved Sell List readiness out of seller checkout side effects", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        status: "needs-resolution",
        unresolvedLineIds: ["sll_product"],
      },
    });
    const sellListLine = {
      line_id: "sll_product",
      line_type: "product",
      offer_id: null,
      product_id: "cat_mewtwo::raw:nm",
      item_title: "Mewtwo",
      quantity: 1,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 1 })),
      startSellListExecution: mockStartSellListExecution,
      recordSellListExecutionProgress: mockRecordSellListExecutionProgress,
      createSellListReadiness: mockCreateSellListReadiness,
      checkoutSellList: mockCheckoutSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("sellListExecutionId", "sle_1");

    const result = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as { error: string };

    expect(result.error).toBe("Sell List readiness must be resolved before seller checkout starts.");
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
    expect(mockCheckoutSellList).not.toHaveBeenCalled();
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
      startSellListExecution: mockStartSellListExecution,
      recordSellListExecutionProgress: mockRecordSellListExecutionProgress,
      createSellListReadiness: mockCreateSellListReadiness,
      checkoutSellList: mockCheckoutSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getOfferMatch: mockGetOfferMatch,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("sellListExecutionId", "sle_1");
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
      listingIdOverride: "lst_sle1fallbacklistingsllproductinv112001",
      priceAmount: "12.00",
      quantityCap: 1,
      sourceActionKey: "sle_1:fallback-listing:sll_product:inv_1:12.00:1",
    });
    expect(mockCheckoutSellList).toHaveBeenCalledWith({
      executionId: "sle_1",
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
      readinessDecisions: {
        lineActions: [{ lineId: "sll_product", action: "smart-match" }],
        lineOutcomes: [],
      },
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
      startSellListExecution: mockStartSellListExecution,
      recordSellListExecutionProgress: mockRecordSellListExecutionProgress,
      createSellListReadiness: mockCreateSellListReadiness,
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
      isGuestBuyer: false,
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
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
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
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "cart",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: null,
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_guest");
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_guest_checkout=guest_token");
  });

  it("marks guest checkout and cleared anonymous cart cookies secure on HTTPS handoff", async () => {
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
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("contactName", "Jane Smith");
    form.set("email", "jane@example.com");
    form.set("source", "cart");

    const response = (await checkoutStartAction({
      request: new Request("https://staging.chasesets.com/checkout/start", {
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
    const cookies = response.headers.getSetCookie();

    expect(cookies.find((cookie) => cookie.startsWith("chase_sets_guest_checkout="))).toContain("Secure");
    expect(cookies.find((cookie) => cookie.startsWith("chase_sets_anonymous_cart="))).toContain("Secure");
  });

  it("loads the checkout session after a fresh signed-out guest checkout handoff", async () => {
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
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("contactName", "Jane Smith");
    form.set("email", "jane@example.com");
    form.set("source", "cart");

    const checkoutStartResponse = (await checkoutStartAction({
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
    const guestCheckoutCookie = checkoutStartResponse.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("chase_sets_guest_checkout="));

    expect(checkoutStartResponse.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(guestCheckoutCookie).toContain("chase_sets_guest_checkout=guest_token");

    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockGetCheckoutSession.mockResolvedValue({
      session_id: "chk_guest",
      buyer_account_id: "acc_guest",
      source_type: "cart",
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
          cartLineId: "cart_line_1",
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

    const checkoutSessionResult = await checkoutSessionLoader({
      request: new Request("http://localhost/checkout/chk_guest", {
        headers: {
          cookie: guestCheckoutCookie ?? "",
        },
      }),
      params: { sessionId: "chk_guest" },
      context: undefined,
    } as never);

    expect(mockGetCheckoutSession).toHaveBeenCalledWith("chk_guest");
    expect(checkoutSessionResult).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          session_id: "chk_guest",
          buyer_account_id: "acc_guest",
        }),
        paymentPreview: expect.objectContaining({
          amount: "26.00",
        }),
      }),
    );
  });

  function checkoutSessionPageRow(overrides: Record<string, unknown> = {}) {
    return {
      session_id: "chk_guest",
      buyer_account_id: "acc_guest",
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
          productId: "cat_1::form:raw",
          itemTitle: "Test card",
          itemSubtitle: null,
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Raw",
          quantity: 1,
        },
      ],
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      ...overrides,
    };
  }

  function mockCheckoutPreviewApis() {
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
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });
    mockCreatePaymentsRequestApiClient.mockReturnValue({
      previewCheckoutStatus: mockPreviewCheckoutStatus,
    });
  }

  it("keeps signed-out Buy Now guest checkout fresh during projection lag", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockStartGuestCheckout.mockResolvedValue({
      accountId: "acc_guest",
      guestToken: "guest_token",
      expiresAt: "2026-04-02T00:00:00.000Z",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockCreateCheckoutSession.mockResolvedValue({
      session_id: "chk_guest",
      commitPosition: "42",
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "42",
          eventIds: ["evt_checkout_session_started"],
        },
      ],
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("contactName", "Jane Smith");
    form.set("email", "jane@example.com");
    form.set("source", "buy-now");
    form.set("listingId", "lst_1");
    form.set("fulfillmentMode", "locked-listing");
    form.set("lockedListingId", "lst_1");
    form.set("catalogItemId", "cat_1");
    form.set("productId", "cat_1::form:raw");
    form.set("itemTitle", "Test card");
    form.set("itemSubtitle", "");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");

    const checkoutStartResponse = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;
    const guestCheckoutCookie = checkoutStartResponse.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("chase_sets_guest_checkout="));
    const checkoutLocation = checkoutStartResponse.headers.get("Location") ?? "";
    const freshReceipt = readFreshWriteToken(new Request(`http://localhost${checkoutLocation}`));

    expect(checkoutStartResponse.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(guestCheckoutCookie).toContain("chase_sets_guest_checkout=guest_token");
    expect(checkoutLocation).toContain("/checkout/chk_guest?afterWrite=");
    expect(freshReceipt).toMatchObject({
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "42",
          eventIds: ["evt_checkout_session_started"],
        },
      ],
    });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: expect.objectContaining({
        type: "buy-now",
        listingId: "lst_1",
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "cat_1::form:raw",
        itemTitle: "Test card",
      }),
    });
    expect(mockCreateCheckoutRequestApiClient).toHaveBeenLastCalledWith(
      expect.any(Request),
      expect.objectContaining({
        headers: {
          cookie: "chase_sets_guest_checkout=guest_token",
        },
      }),
    );
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();

    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockGetCheckoutSession
      .mockRejectedValueOnce(
        new MockCheckoutApiError(404, {
          error: { code: "not_found", message: "Checkout session not found." },
        }),
      )
      .mockResolvedValueOnce(checkoutSessionPageRow())
      .mockRejectedValueOnce(
        new MockCheckoutApiError(503, {
          error: {
            code: "projection_freshness_timeout",
            message: "Projection read model did not catch up before the freshness timeout.",
            waitMode: "exact-dependency",
            dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
          },
        }),
      )
      .mockResolvedValueOnce(checkoutSessionPageRow());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });
    mockCheckoutPreviewApis();

    const checkoutRequest = new Request(`http://localhost${checkoutLocation}`, {
      headers: {
        cookie: guestCheckoutCookie ?? "",
      },
    });

    const checkoutSessionResultAfterFreshNotFoundRetry = await checkoutSessionLoader({
      request: checkoutRequest,
      params: { sessionId: "chk_guest" },
      context: undefined,
    } as never);

    expect(mockGetCheckoutSession).toHaveBeenCalledTimes(2);
    expect(checkoutSessionResultAfterFreshNotFoundRetry).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          session_id: "chk_guest",
          buyer_account_id: "acc_guest",
          source_type: "buy-now",
          order_ids: [],
          payment_id: null,
        }),
        paymentPreview: expect.objectContaining({
          amount: "26.00",
        }),
      }),
    );

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request(`http://localhost${checkoutLocation}`, {
          headers: {
            cookie: guestCheckoutCookie ?? "",
          },
        }),
        params: { sessionId: "chk_guest" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(503);
    expect(recoveryResponse?.statusText).toBe("Preparing checkout");
    const recoveryText = (await recoveryResponse?.text()) ?? "";
    expect(recoveryText).toContain("getting your checkout ready");
    expect(recoveryText).toContain("Refresh checkout");
    expect(recoveryText).toContain("Your payment has not started.");
    expect(recoveryText).not.toContain("We could not find this checkout session.");

    const checkoutSessionResultAfterRefresh = await checkoutSessionLoader({
      request: new Request(`http://localhost${checkoutLocation}`, {
        headers: {
          cookie: guestCheckoutCookie ?? "",
        },
      }),
      params: { sessionId: "chk_guest" },
      context: undefined,
    } as never);

    expect(mockGetCheckoutSession).toHaveBeenCalledTimes(4);
    expect(checkoutSessionResultAfterRefresh).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          session_id: "chk_guest",
          buyer_account_id: "acc_guest",
          source_type: "buy-now",
          order_ids: [],
          payment_id: null,
        }),
      }),
    );
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("does not start payment while starting signed-out guest cart checkout", async () => {
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
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });
    mockCreatePaymentsRequestApiClient.mockReturnValue({
      createCheckoutPayment: vi.fn(),
      previewCheckoutStatus: mockPreviewCheckoutStatus,
    });

    const form = new URLSearchParams();
    form.set("contactName", "Jane Smith");
    form.set("email", "jane@example.com");
    form.set("source", "cart");

    await checkoutStartAction({
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
    } as never);

    expect(mockCreatePaymentsRequestApiClient).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
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
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
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
      savedCheckoutInstrumentId: null,
      savePaymentMethodForFuture: false,
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

  it("starts payment from checkout review for accelerated saved-payment confirmation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
    form.set("savedCheckoutInstrumentId", "sci_card_1");
    form.set("acceleratedSavedPayment", "true");
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
        marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
        savedCheckoutInstrumentId: "sci_card_1",
        deferPayment: false,
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/payments/pay_1");
  });

  it("starts payment when a trusted-step saved instrument is selected", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "bank-account");
    form.set("previewPaymentMethodCategory", "bank-account");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_bank_1");
    form.set("savedCheckoutInstrumentId", "sci_bank_1");
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
        paymentMethodCategory: "bank-account",
        marketplaceCheckoutFeeQuoteFingerprint: "quote_bank_1",
        savedCheckoutInstrumentId: "sci_bank_1",
        deferPayment: false,
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/payments/pay_1");
  });

  it("refreshes checkout review when confirmation is missing the payment quote", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectShippingAddress.mockResolvedValue({});
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
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

    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
    expect(mockSelectShippingAddress).toHaveBeenCalledWith("chk_1", {
      shippingAddress: expect.objectContaining({ postalCode: "60601" }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/checkout/chk_1?paymentMethodCategory=card&review=updated&quote=required",
    );
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

  it("refreshes guest checkout totals with a fresh-write redirect token", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockSelectShippingOption.mockResolvedValue(checkoutCommit("41", "evt_shipping_option"));
    mockSelectShippingAddress.mockResolvedValue(checkoutCommit("42", "evt_shipping_address"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "refresh-checkout-preview");
    form.set("shippingOption", "standard");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");
    form.set("previewPaymentMethodCategory", "card");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;
    const location = response.headers.get("Location") ?? "";
    const receipt = readFreshWriteToken(location);

    expect(response.status).toBe(302);
    expect(location).toContain("/checkout/chk_1?paymentMethodCategory=card&afterWrite=");
    expect(receipt?.commitPosition).toBe("42");
    expect(receipt?.sources).toEqual([
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "42",
        eventIds: ["evt_shipping_option", "evt_shipping_address"],
      },
    ]);
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
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
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
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

  it("keeps checkout review refresh fallback freshness-aware", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    mockSelectShippingOption.mockResolvedValue(checkoutCommit("43", "evt_shipping_option"));
    mockSelectShippingAddress.mockResolvedValue(checkoutCommit("44", "evt_shipping_address"));
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "priority");
    form.set("reviewedShippingOption", "standard");
    form.set("reviewedShippingAddressSignature", "previous-preview");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
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
    const location = response.headers.get("Location") ?? "";
    const receipt = readFreshWriteToken(location);

    expect(response.status).toBe(302);
    expect(location).toContain("/checkout/chk_1?paymentMethodCategory=card&review=updated&afterWrite=");
    expect(receipt?.commitPosition).toBe("44");
    expect(receipt?.sources).toEqual([
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "44",
        eventIds: ["evt_shipping_option", "evt_shipping_address"],
      },
    ]);
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
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

  it("returns checkout-owned recovery when checkout access is missing", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(401, {
          error: { code: "authentication_required", message: "Authentication required." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(401);
    expect(recoveryResponse?.statusText).toBe("Checkout access required");
    await expect(recoveryResponse?.text()).resolves.toContain("checkout access is not active in this browser");
  });

  it("returns checkout-owned recovery when guest checkout access is expired", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(401, {
          error: { code: "authentication_required", message: "Authentication required." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(401);
    expect(recoveryResponse?.statusText).toBe("Guest checkout access expired");
    await expect(recoveryResponse?.text()).resolves.toContain("guest checkout link is no longer active");
  });

  it("returns checkout-owned recovery when the checkout belongs to another account", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_other", permissions: [] });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(403, {
          error: { code: "authorization_forbidden", message: "Forbidden." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(403);
    expect(recoveryResponse?.statusText).toBe("Checkout belongs to another account");
    await expect(recoveryResponse?.text()).resolves.toContain("Sign in with the account that started this checkout");
  });

  it("returns checkout-owned recovery when the checkout session is not found", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(404, {
          error: { code: "not_found", message: "Checkout session not found." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(404);
    expect(recoveryResponse?.statusText).toBe("Checkout session not found.");
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      description?: string;
      primaryAction?: { href?: string };
    };
    expect(recoveryBody.description).toContain("We could not find this checkout session.");
    expect(recoveryBody.primaryAction?.href).toBe("/search");
  });

  it("returns safe checkout recovery for expired fresh checkout handoffs", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(404, {
          error: { code: "not_found", message: "Checkout session not found." },
        });
      }),
    });
    const expiredPath = appendFreshWriteToken("/checkout/chk_1", checkoutCommit("42", "evt_checkout"), 1);

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request(`http://localhost${expiredPath}`),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(410);
    expect(recoveryResponse?.statusText).toBe("Checkout needs a fresh start");
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      description?: string;
      primaryAction?: { href?: string };
      secondaryAction?: { href?: string };
      trustCue?: string;
    };
    expect(recoveryBody.description).toContain("took longer than expected");
    expect(recoveryBody.trustCue).toBe("Your payment has not started.");
    expect(recoveryBody.primaryAction?.href).toBe("/account/cart");
    expect(recoveryBody.secondaryAction?.href).toBe("/search");
  });

  it("returns permanent checkout recovery for malformed fresh checkout handoffs", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(404, {
          error: { code: "not_found", message: "Checkout session not found." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/chk_1?afterWrite=%7Bnot-json"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(404);
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      description?: string;
      primaryAction?: { href?: string };
    };
    expect(recoveryBody.description).toContain("We could not find this checkout session.");
    expect(recoveryBody.primaryAction?.href).toBe("/search");
  });

  it("returns temporary recovery when a fresh checkout handoff has not projected yet", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(404, {
          error: { code: "not_found", message: "Checkout session not found." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: freshCheckoutRequest(),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(503);
    expect(recoveryResponse?.statusText).toBe("Preparing checkout");
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      description?: string;
      primaryAction?: { href?: string; label?: string };
      trustCue?: string;
    };
    expect(recoveryBody.description).toContain("getting your checkout ready");
    expect(recoveryBody.trustCue).toBe("Your payment has not started.");
    expect(recoveryBody.primaryAction?.href).toContain("/checkout/chk_1?afterWrite=");
    expect(recoveryBody.primaryAction?.label).toBe("Refresh checkout");
  });

  it("returns temporary recovery when a fresh checkout handoff hits projection freshness timeout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(503, {
          error: {
            code: "projection_freshness_timeout",
            message: "Projection read model did not catch up before the freshness timeout.",
          },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: freshCheckoutRequest(),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(503);
    expect(recoveryResponse?.statusText).toBe("Preparing checkout");
    await expect(recoveryResponse?.text()).resolves.toContain("Refresh checkout");
  });

  it("retries a fresh checkout handoff until the session read model appears", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    const getCheckoutSession = vi
      .fn()
      .mockRejectedValueOnce(
        new MockCheckoutApiError(404, {
          error: { code: "not_found", message: "Checkout session not found." },
        }),
      )
      .mockResolvedValue({
        session_id: "chk_1",
        buyer_account_id: "acc_guest",
        source_type: "offer-intent",
        payment_id: null,
        submitted_offer_id: null,
        shipping_option: "standard",
        shipping_address: null,
        optimization_goal: "lowest-total",
        fulfillment_preview_revision: null,
        order_ids: [],
        lines: [],
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession,
    });

    const result = await checkoutSessionLoader({
      request: freshCheckoutRequest(),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(getCheckoutSession).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          session_id: "chk_1",
          buyer_account_id: "acc_guest",
        }),
      }),
    );
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
