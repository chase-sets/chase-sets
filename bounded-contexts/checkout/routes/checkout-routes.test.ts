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
  mockCreateIdentityRequestApiClient,
  MockMarketplaceApiError,
  mockCreateCheckoutSession,
  mockCreateCartReadiness,
  mockCreateSellListReadiness,
  mockCreateGuestSellListReadiness,
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
  mockUpdateCartLineFulfillment,
  mockUpdateGuestCartLineFulfillment,
  mockRemoveCartLine,
  mockGetGuestSellList,
  mockGetOfferMatch,
  mockListOfferMatches,
  mockPreviewPublicStandardListingTerms,
  mockPreviewOfferAcceptanceTerms,
  mockAcceptOfferMatch,
  mockCreateListing,
  mockPublishListing,
  mockGetPayoutReadiness,
  mockAddSellListLine,
  mockAddGuestSellListLine,
  mockGetSellListConfirmation,
  mockConfirmSellListCheckout,
  mockRemoveGuestSellListLine,
  mockMergeGuestSellListToAccount,
  mockListShippingAddresses,
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
  mockCreateIdentityRequestApiClient: vi.fn(),
  MockMarketplaceApiError: class MarketplaceApiError extends Error {
    public constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`Marketplace API error ${status}`);
    }
  },
  mockCreateCheckoutSession: vi.fn(),
  mockCreateCartReadiness: vi.fn(),
  mockCreateSellListReadiness: vi.fn(),
  mockCreateGuestSellListReadiness: vi.fn(),
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
  mockUpdateCartLineFulfillment: vi.fn(),
  mockUpdateGuestCartLineFulfillment: vi.fn(),
  mockRemoveCartLine: vi.fn(),
  mockGetGuestSellList: vi.fn(),
  mockGetOfferMatch: vi.fn(),
  mockListOfferMatches: vi.fn(),
  mockPreviewPublicStandardListingTerms: vi.fn(),
  mockPreviewOfferAcceptanceTerms: vi.fn(),
  mockAcceptOfferMatch: vi.fn(),
  mockCreateListing: vi.fn(),
  mockPublishListing: vi.fn(),
  mockGetPayoutReadiness: vi.fn(),
  mockAddSellListLine: vi.fn(),
  mockAddGuestSellListLine: vi.fn(),
  mockGetSellListConfirmation: vi.fn(),
  mockConfirmSellListCheckout: vi.fn(),
  mockRemoveGuestSellListLine: vi.fn(),
  mockMergeGuestSellListToAccount: vi.fn(),
  mockListShippingAddresses: vi.fn(),
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

vi.mock("@chase-sets/identity/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/identity/server")>("@chase-sets/identity/server");

  return {
    ...actual,
    createIdentityRequestApiClient: mockCreateIdentityRequestApiClient,
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
  MarketplaceApiError: MockMarketplaceApiError,
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
import { action as sellCheckoutSessionAction, loader as sellCheckoutSessionLoader } from "./sell-checkout-session";

describe("checkout web routes", () => {
  beforeEach(() => {
    mockGetSellListConfirmation.mockRejectedValue(new Error("not found"));
    mockConfirmSellListCheckout.mockImplementation(
      async (body: { confirmationId: string; handoffSummary: unknown }) => ({
        confirmation: {
          seller_account_id: "acc_seller",
          confirmation_id: body.confirmationId,
          confirmed_at: "2026-06-10T00:00:00.000Z",
          readiness_evidence: {},
          seller_evidence: {},
          handoff_summary: body.handoffSummary,
        },
      }),
    );
    mockAcceptOfferMatch.mockResolvedValue({ status: "accepted" });
    mockCreateListing.mockResolvedValue({
      id: "lst_slc_chk_sell_1_sll_1",
      status: "draft",
      feeQuoteFingerprint: "listing_quote_1",
    });
    mockPublishListing.mockResolvedValue({ status: "published" });
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
    mockCreateIdentityRequestApiClient.mockReturnValue({
      listShippingAddresses: mockListShippingAddresses.mockResolvedValue({
        items: [
          {
            shipping_address_id: "adr_seller",
            label: "Warehouse",
            recipient_name: "Jane Seller",
            company: null,
            line1: "100 Market Street",
            line2: null,
            city: "Wichita",
            state: "KS",
            postal_code: "67202",
            country: "US",
            phone: "316-555-0110",
            email: "seller@example.com",
            is_default: true,
          },
        ],
      }),
    });
    mockCreateCartReadiness.mockResolvedValue(readyCartReadinessResponse());
    mockCreateSellListReadiness.mockResolvedValue(readySellListReadinessResponse());
    mockCreateGuestSellListReadiness.mockResolvedValue(readySellListReadinessResponse());
    mockPreviewOfferAcceptanceTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "38.00",
      marketplace_sales_fee_unit_amount: "3.80",
      seller_net_unit_amount: "34.20",
      shipping_allowance_percentage_bps: 0,
      schedule_id: "terms_standard",
      agreement_id: null,
      resolved_at: "2026-06-10T00:00:00.000Z",
      fee_quote_fingerprint: "quote_1",
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

  function guestSellListLine(overrides: Record<string, unknown> = {}) {
    return {
      seller_account_id: "anon_sell_1",
      line_id: "sll_1",
      line_type: "selected-offer",
      offer_id: "off_1",
      buyer_account_id: "acc_buyer",
      buyer_display_name: "Buyer",
      offer_price_amount: "38.00",
      catalog_catalog_item_id: "cat_1",
      product_id: "prod_1",
      item_title: "Acerola's Mischief",
      item_subtitle: "Raw / Damaged",
      selected_options: [{ dimensionId: "Condition", optionId: "Damaged" }],
      product_summary: "Raw card",
      quantity: 1,
      fallback_mode: "none",
      minimum_listing_price_amount: null,
      created_at: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-10T00:00:00.000Z",
      ...overrides,
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

  it("locks preferred listing fulfillment for signed-in grouped cart lines", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockUpdateCartLineFulfillment
      .mockResolvedValueOnce(checkoutCommit("45", "evt_primary_locked"))
      .mockResolvedValueOnce(checkoutCommit("46", "evt_duplicate_locked"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      updateCartLineFulfillment: mockUpdateCartLineFulfillment,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("sellerPreferenceId", "lst_card_vault");
    form.set("intent", "lock-preferred-listing");

    const response = (await accountCartAction({
      request: new Request("http://localhost/account/cart", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockUpdateCartLineFulfillment).toHaveBeenCalledWith("cli_primary", {
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_card_vault",
      sellerPreferenceId: "lst_card_vault",
      availabilityState: "available",
    });
    expect(mockUpdateCartLineFulfillment).toHaveBeenCalledWith("cli_duplicate", {
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_card_vault",
      sellerPreferenceId: "lst_card_vault",
      availabilityState: "available",
    });
    expect(response.status).toBe(302);
    expect(readFreshWriteToken(response.headers.get("Location") ?? "")).toMatchObject({
      commitPosition: "46",
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "46", eventIds: ["evt_duplicate_locked"] }],
    });
  });

  it("locks preferred listing fulfillment for guest cart lines", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockUpdateGuestCartLineFulfillment.mockResolvedValue(checkoutCommit("47", "evt_guest_locked"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      updateGuestCartLineFulfillment: mockUpdateGuestCartLineFulfillment,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_guest");
    form.set("sellerPreferenceId", "lst_card_vault");
    form.set("intent", "lock-preferred-listing");

    const response = (await accountCartAction({
      request: new Request("http://localhost/account/cart", {
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

    expect(mockUpdateGuestCartLineFulfillment).toHaveBeenCalledWith("anon_cart_1", "cli_guest", {
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_card_vault",
      sellerPreferenceId: "lst_card_vault",
      availabilityState: "available",
    });
    expect(response.status).toBe(302);
    expect(readFreshWriteToken(response.headers.get("Location") ?? "")).toMatchObject({
      commitPosition: "47",
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "47", eventIds: ["evt_guest_locked"] }],
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

  it("adds a posted selected offer snapshot to the anonymous Sell List when signed out", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockAddGuestSellListLine.mockResolvedValue({ status: "added" });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getOfferMatch: mockGetOfferMatch,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addGuestSellListLine: mockAddGuestSellListLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-selected-offer");
    form.set("offerId", "off_1");
    form.set("buyerDisplayName", "Collector123");
    form.set("buyerAccountId", "acc_buyer_private");
    form.set("offerPriceAmount", "40.00");
    form.set("catalogItemId", "cat_mewtwo");
    form.set("productId", "cat_mewtwo::raw:nm");
    form.set("itemTitle", "Mewtwo");
    form.set("itemSubtitle", "Black Star Promo 3");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw / Near Mint");
    form.set("quantity", "2");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockGetOfferMatch).not.toHaveBeenCalled();
    expect(mockAddGuestSellListLine).toHaveBeenCalledWith(expect.stringMatching(/^anon_/), {
      lineType: "selected-offer",
      offerId: "off_1",
      buyerAccountId: null,
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
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_sell_list=anon_");
  });

  function expectNoSellerCommitSideEffects() {
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
    expect(mockPublishListing).not.toHaveBeenCalled();
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
  }

  function expectSignedInSellCheckoutRedirect(response: Response) {
    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    expect(location).toBeTruthy();
    const url = new URL(location ?? "", "http://localhost");
    expect(url.pathname).toMatch(/^\/checkout\/sell\/session\/chk_/);
    expect(url.searchParams.get("readinessSnapshotId")).toBe("slr_ready");
    expect(url.searchParams.get("readinessSourceRevision")).toBe("slr_source");
    return {
      url,
      readinessDecisions: JSON.parse(url.searchParams.get("readinessDecisions") ?? "{}") as Record<string, unknown>,
      sellListReviewPlan: JSON.parse(url.searchParams.get("sellListReviewPlan") ?? "{}") as Record<string, unknown>,
    };
  }

  it("starts signed-in seller checkout from Sell List readiness without sale side effects", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const sellListLine = {
      line_id: "sll_1",
      line_type: "selected-offer",
      offer_id: "off_1",
      item_title: "Mewtwo",
      quantity: 1,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
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

    const redirect = expectSignedInSellCheckoutRedirect(response);
    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
      lineOutcomes: [],
    });
    expect(redirect.readinessDecisions).toEqual({
      lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
      lineOutcomes: [],
    });
    expect((redirect.sellListReviewPlan.lines as unknown[])[0]).toEqual(
      expect.objectContaining({
        lineId: "sll_1",
        selectedOffer: { offerId: "off_1", feeQuoteFingerprint: "quote_1" },
      }),
    );
    expectNoSellerCommitSideEffects();
  });

  it("rejects stale or guest-sourced selected-offer fee fingerprints before seller checkout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockPreviewOfferAcceptanceTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "38.00",
      marketplace_sales_fee_unit_amount: "3.80",
      seller_net_unit_amount: "34.20",
      shipping_allowance_percentage_bps: 0,
      schedule_id: "terms_registered",
      agreement_id: null,
      resolved_at: "2026-06-10T00:00:00.000Z",
      fee_quote_fingerprint: "registered_quote",
    });
    mockCreateSellListReadiness.mockResolvedValueOnce({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        status: "blocked",
        includedLineIds: [],
        lineOutcomes: [{ lineId: "sll_1", outcome: "keep-in-list", reason: "stale-terms" }],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      startSellListExecution: mockStartSellListExecution,
      recordSellListExecutionProgress: mockRecordSellListExecutionProgress,
      createSellListReadiness: mockCreateSellListReadiness,
      checkoutSellList: mockCheckoutSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      acceptOfferMatch: mockAcceptOfferMatch,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("offerFeeQuoteFingerprint:sll_1", "guest_preview_quote");

    const result = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as { error: string };

    expect(mockPreviewOfferAcceptanceTerms).toHaveBeenCalledWith("off_1");
    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [],
      lineOutcomes: [{ lineId: "sll_1", outcome: "keep-in-list" }],
    });
    expect(result.error).toBe("Sell List readiness must be resolved before seller checkout starts.");
    expectNoSellerCommitSideEffects();
  });

  it("preserves product-level Sell List Smart Match choices without accepting offers", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
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
      createSellListReadiness: mockCreateSellListReadiness,
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

    const redirect = expectSignedInSellCheckoutRedirect(response);
    expect(mockGetOfferMatch).toHaveBeenCalledWith("off_product_1");
    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [{ lineId: "sll_product", action: "smart-match" }],
      lineOutcomes: [],
    });
    expect(redirect.readinessDecisions).toEqual({
      lineActions: [{ lineId: "sll_product", action: "smart-match" }],
      lineOutcomes: [],
    });
    expect((redirect.sellListReviewPlan.lines as unknown[])[0]).toEqual(
      expect.objectContaining({
        lineId: "sll_product",
        productOfferTargets: [{ offerId: "off_product_1", feeQuoteFingerprint: "quote_product_1", quantity: 2 }],
        fallbackListing: null,
      }),
    );
    expectNoSellerCommitSideEffects();
  });

  it("keeps partially resolved product lines out of seller checkout until the remainder is assigned", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetOfferMatch.mockResolvedValue({
      offer_id: "off_product_1",
      product_id: "cat_mewtwo::raw:nm",
      quantity_requested: 2,
    });
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        status: "blocked",
        includedLineIds: [],
        lineOutcomes: [{ lineId: "sll_product", outcome: "keep-in-list", reason: "ready", action: "smart-match" }],
      },
    });
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
      createSellListReadiness: mockCreateSellListReadiness,
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

    const result = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as { error: string };

    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [],
      lineOutcomes: [{ lineId: "sll_product", outcome: "keep-in-list" }],
    });
    expect(result.error).toBe("Sell List readiness must be resolved before seller checkout starts.");
    expectNoSellerCommitSideEffects();
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
      createSellListReadiness: mockCreateSellListReadiness,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
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

    expect(result.error).toBe("Sell List readiness must be resolved before seller checkout starts.");
    expectNoSellerCommitSideEffects();
  });

  it("preserves fallback listing choices for seller checkout without creating listings", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetOfferMatch.mockResolvedValue({
      offer_id: "off_product_1",
      product_id: "cat_mewtwo::raw:nm",
      quantity_requested: 1,
    });
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
      createSellListReadiness: mockCreateSellListReadiness,
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

    const redirect = expectSignedInSellCheckoutRedirect(response);
    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [{ lineId: "sll_product", action: "smart-match" }],
      lineOutcomes: [],
    });
    expect((redirect.sellListReviewPlan.lines as unknown[])[0]).toEqual(
      expect.objectContaining({
        lineId: "sll_product",
        productOfferTargets: [{ offerId: "off_product_1", feeQuoteFingerprint: "quote_product_1", quantity: 1 }],
        fallbackListing: { inventoryItemId: "inv_1", priceAmount: "12.00", quantityCap: 1 },
      }),
    );
    expectNoSellerCommitSideEffects();
  });

  it("keeps payout setup out of Sell List confirmation and lets seller checkout own recovery", async () => {
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
    const sellListLine = {
      line_id: "sll_1",
      line_type: "selected-offer",
      offer_id: "off_1",
      item_title: "Mewtwo",
      quantity: 1,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
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

    expectSignedInSellCheckoutRedirect(response);
    expect(mockGetPayoutReadiness).not.toHaveBeenCalled();
    expectNoSellerCommitSideEffects();
  });

  it("shows anonymous Sell List lines before account creation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestSellList.mockResolvedValue({ items: [{ line_id: "sll_1", quantity: 1 }], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

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
      registrationReturn: null,
      mergedLineCount: 0,
      mergeError: null,
      sellList: { items: [{ line_id: "sll_1", quantity: 1 }], count: 1 },
      offerReviews: [],
    });
    expect(mockGetGuestSellList).toHaveBeenCalledWith("anon_sell_1");
  });

  it("loads public standard terms for anonymous selected-offer Sell List lines", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockPreviewPublicStandardListingTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "34.35",
      seller_net_unit_amount: "345.65",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      source_updated_at: "2026-04-01T00:00:00.000Z",
      resolved_at: "2026-04-28T00:00:00.000Z",
    });
    mockGetGuestSellList.mockResolvedValue({
      items: [
        {
          line_id: "sll_1",
          line_type: "selected-offer",
          offer_price_amount: "380.00",
          quantity: 1,
        },
      ],
      count: 1,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewPublicStandardListingTerms: mockPreviewPublicStandardListingTerms,
    });

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(mockPreviewPublicStandardListingTerms).toHaveBeenCalledWith({ priceAmount: "380.00" });
    expect(result).toEqual({
      isSignedIn: false,
      registrationReturn: null,
      mergedLineCount: 0,
      mergeError: null,
      sellList: {
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_price_amount: "380.00",
            quantity: 1,
          },
        ],
        count: 1,
      },
      offerReviews: [
        {
          lineId: "sll_1",
          status: "ready",
          comparison: null,
          message: null,
          terms: expect.not.objectContaining({
            fee_quote_fingerprint: expect.anything(),
            schedule_id: expect.anything(),
            agreement_id: expect.anything(),
          }),
        },
      ],
    });
    expect(result.offerReviews[0]?.terms).toEqual(
      expect.objectContaining({
        seller_net_unit_amount: "345.65",
        source_kind: "public-standard-seller-terms",
        source_label: "Standard seller terms",
      }),
    );
  });

  it("merges anonymous Sell List lines after registration returns to Sell List review", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockMergeGuestSellListToAccount.mockResolvedValue({ mergedLineCount: 1 });
    mockPreviewOfferAcceptanceTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "38.00",
      seller_net_unit_amount: "342.00",
      shipping_allowance_percentage_bps: 0,
      schedule_id: "terms_registered",
      agreement_id: null,
      resolved_at: "2026-04-28T00:00:00.000Z",
      fee_quote_fingerprint: "registered_quote",
    });
    mockPreviewPublicStandardListingTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "34.35",
      seller_net_unit_amount: "345.65",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      source_updated_at: "2026-04-01T00:00:00.000Z",
      resolved_at: "2026-04-28T00:00:00.000Z",
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
            offer_price_amount: "380.00",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      mergeGuestSellListToAccount: mockMergeGuestSellListToAccount,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      previewPublicStandardListingTerms: mockPreviewPublicStandardListingTerms,
    });

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list?registrationReturn=seller-checkout", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result.isSignedIn).toBe(true);
    expect(result.registrationReturn).toBe("seller-checkout");
    expect(result.mergedLineCount).toBe(1);
    expect(result.mergeError).toBeNull();
    expect(mockMergeGuestSellListToAccount).toHaveBeenCalledWith("anon_sell_1");
    expect(mockPreviewOfferAcceptanceTerms).toHaveBeenCalledWith("off_1");
    expect(mockPreviewPublicStandardListingTerms).toHaveBeenCalledWith({ priceAmount: "380.00" });
    expect(result.offerReviews[0]).toEqual(
      expect.objectContaining({
        lineId: "sll_1",
        status: "ready",
        terms: expect.objectContaining({ fee_quote_fingerprint: "registered_quote" }),
        comparison: expect.objectContaining({
          status: "changed",
          changedFields: ["seller-net", "marketplace-fee", "shipping-allowance"],
          standardPreview: expect.objectContaining({
            seller_net_unit_amount: "345.65",
            source_kind: "public-standard-seller-terms",
          }),
        }),
      }),
    );
  });

  it("keeps final registered terms when the standard estimate comparison is unavailable", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockMergeGuestSellListToAccount.mockResolvedValue({ mergedLineCount: 1 });
    mockPreviewOfferAcceptanceTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "38.00",
      seller_net_unit_amount: "342.00",
      shipping_allowance_percentage_bps: 0,
      schedule_id: "terms_registered",
      agreement_id: null,
      resolved_at: "2026-04-28T00:00:00.000Z",
      fee_quote_fingerprint: "registered_quote",
    });
    mockPreviewPublicStandardListingTerms.mockRejectedValue(new Error("standard terms unavailable"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
            offer_price_amount: "380.00",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      mergeGuestSellListToAccount: mockMergeGuestSellListToAccount,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      previewPublicStandardListingTerms: mockPreviewPublicStandardListingTerms,
    });

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list?registrationReturn=seller-checkout", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result.offerReviews[0]).toEqual(
      expect.objectContaining({
        status: "ready",
        terms: expect.objectContaining({ fee_quote_fingerprint: "registered_quote" }),
        comparison: {
          status: "standard-preview-unavailable",
          standardPreview: null,
          changedFields: [],
        },
      }),
    );
  });

  it("keeps selected-offer intent recoverable when final registered terms are unavailable", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockMergeGuestSellListToAccount.mockResolvedValue({ mergedLineCount: 1 });
    mockPreviewOfferAcceptanceTerms.mockRejectedValue(new Error("Offer terms are stale."));
    mockPreviewPublicStandardListingTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "34.35",
      seller_net_unit_amount: "345.65",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      source_updated_at: "2026-04-01T00:00:00.000Z",
      resolved_at: "2026-04-28T00:00:00.000Z",
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
            offer_price_amount: "380.00",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      mergeGuestSellListToAccount: mockMergeGuestSellListToAccount,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      previewPublicStandardListingTerms: mockPreviewPublicStandardListingTerms,
    });

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list?registrationReturn=seller-checkout", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result.offerReviews[0]).toEqual({
      lineId: "sll_1",
      status: "unavailable",
      terms: null,
      message: "Offer terms are stale.",
      comparison: {
        status: "final-unavailable",
        standardPreview: expect.objectContaining({ seller_net_unit_amount: "345.65" }),
        changedFields: [],
      },
    });
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

  it("routes guest seller checkout through registration after Sell List readiness passes", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");

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

    expect(mockCreateGuestSellListReadiness).toHaveBeenCalledWith("anon_sell_1");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/register?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout",
    );
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("keeps guest seller checkout in Sell List recovery when readiness is blocked", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateGuestSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        status: "needs-resolution",
        unresolvedLineIds: ["sll_1"],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");

    const result = await accountSellListAction({
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
    } as never);

    expect(result).toEqual({ error: "Resolve Sell List readiness before seller checkout starts." });
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("loads guest seller checkout only when Sell List readiness still matches", async () => {
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const result = await sellCheckoutSessionLoader({
      request: new Request(
        "http://localhost/checkout/sell/session/chk_sell_1?readinessSnapshotId=slr_ready&readinessSourceRevision=slr_source",
        {
          headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
        },
      ),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(mockGetGuestSellList).toHaveBeenCalledWith("anon_sell_1");
    expect(mockCreateGuestSellListReadiness).toHaveBeenCalledWith("anon_sell_1");
    expect(result.recovery).toBeNull();
    expect(result.readiness?.snapshotId).toBe("slr_ready");
    expect(result.lines).toEqual([expect.objectContaining({ line_id: "sll_1" })]);
  });

  it("fails guest seller checkout closed when readiness is stale", async () => {
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const result = await sellCheckoutSessionLoader({
      request: new Request(
        "http://localhost/checkout/sell/session/chk_sell_1?readinessSnapshotId=slr_old&readinessSourceRevision=slr_old_source",
        {
          headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
        },
      ),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.recovery).toEqual({ kind: "readiness-stale" });
    expect(result.lines).toEqual([expect.objectContaining({ line_id: "sll_1" })]);
  });

  it("fails guest seller checkout closed when readiness is unresolved", async () => {
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateGuestSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        status: "needs-resolution",
        unresolvedLineIds: ["sll_1"],
        includedLineIds: [],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const result = await sellCheckoutSessionLoader({
      request: new Request(
        "http://localhost/checkout/sell/session/chk_sell_1?readinessSnapshotId=slr_ready&readinessSourceRevision=slr_source",
        {
          headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
        },
      ),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.recovery).toEqual({ kind: "readiness-blocked" });
    expect(result.lines).toEqual([expect.objectContaining({ line_id: "sll_1" })]);
  });

  function signedInSellerActor() {
    return {
      accountId: "acc_seller",
      roleKey: "seller",
      permissions: ["accounts.view"],
    };
  }

  function signedInSellCheckoutUrl(overrides: Record<string, string> = {}) {
    const params = new URLSearchParams({
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
      readinessDecisions: JSON.stringify({
        lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
        lineOutcomes: [],
      }),
      sellListReviewPlan: JSON.stringify({ version: 1, lines: [{ lineId: "sll_1", lineType: "selected-offer" }] }),
      ...overrides,
    });
    return `http://localhost/checkout/sell/session/chk_sell_1?${params.toString()}`;
  }

  it("loads signed-in seller checkout from current Sell List readiness and saved rows", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [guestSellListLine({ seller_account_id: "acc_seller" })], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
    });

    const result = await sellCheckoutSessionLoader({
      request: new Request(signedInSellCheckoutUrl()),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.mode).toBe("signed-in");
    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
      lineOutcomes: [],
    });
    expect(result.recovery).toBeNull();
    expect(result.readiness?.snapshotId).toBe("slr_ready");
    expect(result.lines).toEqual([expect.objectContaining({ line_id: "sll_1" })]);
    expect(result.mode === "signed-in" ? result.defaultValues.email : "").toBe("seller@example.com");
    expect(result.mode === "signed-in" ? result.defaultValues.shipFromLine1 : "").toBe("100 Market Street");
    expect(result.mode === "signed-in" ? result.payoutSummary?.status : "").toBe("ready");
    expect(result.mode === "signed-in" ? result.sellListReviewPlan : "").toContain('"version":1');
  });

  it("fails signed-in seller checkout closed when Sell List readiness is stale", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        snapshotId: "slr_new",
        sourceRevision: "slr_source",
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [guestSellListLine({ seller_account_id: "acc_seller" })], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
    });

    const result = await sellCheckoutSessionLoader({
      request: new Request(signedInSellCheckoutUrl()),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.mode).toBe("signed-in");
    expect(result.recovery).toEqual({ kind: "readiness-stale" });
    expect(result.lines).toEqual([expect.objectContaining({ line_id: "sll_1" })]);
  });

  function guestSellCheckoutForm(overrides: Record<string, string> = {}) {
    const form = new URLSearchParams({
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
      sellerName: "Jane Seller",
      email: "jane@example.com",
      phone: "555-0100",
      shipFromName: "Jane Seller",
      company: "",
      shipFromLine1: "100 Market St",
      shipFromLine2: "",
      shipFromCity: "Wichita",
      shipFromState: "KS",
      shipFromPostalCode: "67202",
      shipFromCountry: "US",
      payoutHandoff: "create-account",
      labelPreference: "prepaid-label",
      termsAccepted: "accepted",
      payoutState: "ready",
      payoutEstimateState: "current",
      riskState: "clear",
      labelState: "ready",
      ...overrides,
    });
    return form;
  }

  function signedInSellCheckoutForm(overrides: Record<string, string> = {}) {
    const form = new URLSearchParams({
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
      readinessDecisions: JSON.stringify({
        lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
        lineOutcomes: [],
      }),
      sellListReviewPlan: JSON.stringify({
        version: 1,
        lines: [
          {
            lineId: "sll_1",
            lineType: "selected-offer",
            itemTitle: "Mewtwo",
            productId: "prod_1",
            quantity: 1,
            selectedOffer: { offerId: "off_1", feeQuoteFingerprint: "quote_1" },
            productOfferTargets: [],
            fallbackListing: null,
            skippedReasons: [],
          },
        ],
      }),
      sellerName: "Jane Seller",
      email: "jane@example.com",
      phone: "555-0100",
      shipFromAddressId: "adr_seller",
      shipFromName: "Jane Seller",
      company: "",
      shipFromLine1: "100 Market St",
      shipFromLine2: "",
      shipFromCity: "Wichita",
      shipFromState: "KS",
      shipFromPostalCode: "67202",
      shipFromCountry: "US",
      payoutMethod: "saved-payout",
      labelPreference: "prepaid-label",
      termsAccepted: "accepted",
      payoutState: "ready",
      payoutEstimateState: "current",
      riskState: "clear",
      labelState: "ready",
      sellerReadinessState: "ready",
      ...overrides,
    });
    return form;
  }

  function mockSignedInSellCheckoutState() {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [guestSellListLine({ seller_account_id: "acc_seller" })], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListConfirmation: mockGetSellListConfirmation,
      confirmSellListCheckout: mockConfirmSellListCheckout,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });
  }

  it("validates signed-in seller checkout saved fields without side effects", async () => {
    mockSignedInSellCheckoutState();

    const form = signedInSellCheckoutForm({
      email: "",
      shipFromAddressId: "__manual",
      shipFromLine1: "",
      termsAccepted: "",
    });
    form.delete("termsAccepted");

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors : {}).toEqual(
      expect.objectContaining({
        email: "Enter a valid email address.",
        shipFromLine1: "Enter address line 1.",
        termsAccepted: "Confirm that you reviewed the final seller terms and sale details.",
      }),
    );
    expectNoSellerCommitSideEffects();
  });

  it("uses the selected saved ship-from address before signed-in validation", async () => {
    mockSignedInSellCheckoutState();

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm({
          shipFromAddressId: "adr_seller",
          shipFromLine1: "",
          shipFromCity: "",
          shipFromPostalCode: "",
        }).toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("confirmed");
    expect(result.status === "confirmed" ? result.values.shipFromLine1 : "").toBe("100 Market Street");
    expect(result.status === "confirmed" ? result.values.shipFromCity : "").toBe("Wichita");
    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_1", {
      feeQuoteFingerprint: "quote_1",
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_1:selected:off_1",
    });
    expect(mockConfirmSellListCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationId: "slc_chk_sell_1",
        sellerEvidence: expect.objectContaining({
          shipFrom: expect.objectContaining({
            addressId: "adr_seller",
            country: "US",
            region: "KS",
            postalCode: "67202",
          }),
        }),
      }),
    );
  });

  it.each([
    [
      "unsupported ship-from",
      { shipFromAddressId: "__manual", shipFromState: "PR" },
      "shipFromState",
      "This ship-from region is not supported",
    ],
    ["payout setup required", { payoutState: "setup-required" }, "payoutMethod", "Payout setup is required"],
    ["payout setup failure", { payoutState: "failed" }, "payoutMethod", "Payout setup is temporarily unavailable"],
    ["changed payout", { payoutEstimateState: "changed" }, "form", "The payout estimate changed"],
    ["risk hold", { riskState: "hold" }, "form", "This sale review is on hold"],
    ["risk block", { riskState: "block" }, "form", "This sale review cannot continue"],
    ["label failure", { labelState: "failed" }, "labelPreference", "Label readiness is unavailable"],
    ["seller readiness failure", { sellerReadinessState: "blocked" }, "form", "Seller readiness needs review"],
  ])("blocks signed-in seller checkout on %s without side effects", async (_label, overrides, fieldName, message) => {
    mockSignedInSellCheckoutState();

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm(overrides).toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors[fieldName as keyof typeof result.fieldErrors] : "").toContain(
      message,
    );
    expectNoSellerCommitSideEffects();
  });

  it("returns a signed-in seller confirmation after recording Marketplace handoff evidence", async () => {
    mockSignedInSellCheckoutState();

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        status: "confirmed",
        confirmation: expect.objectContaining({
          referenceId: "slc_chk_sell_1",
          sideEffects: {
            sale: "handoff-recorded",
            label: "pending-downstream",
            payout: "pending-downstream",
            settlement: "pending-downstream",
            notification: "pending-downstream",
            accountHistory: "pending-downstream",
          },
        }),
      }),
    );
    expect(mockGetSellListConfirmation).toHaveBeenCalledWith("slc_chk_sell_1");
    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_1", {
      feeQuoteFingerprint: "quote_1",
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_1:selected:off_1",
    });
    expect(mockConfirmSellListCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationId: "slc_chk_sell_1",
        readinessSnapshotId: "slr_ready",
        readinessSourceRevision: "slr_source",
        completedLineIds: ["sll_1"],
        remainingLineQuantities: [],
        handoffSummary: expect.objectContaining({
          acceptedOfferCount: 1,
          publishedListingCount: 0,
          skippedLineCount: 0,
          sideEffects: {
            sale: "handoff-recorded",
            label: "pending-downstream",
            payout: "pending-downstream",
            settlement: "pending-downstream",
            notification: "pending-downstream",
            accountHistory: "pending-downstream",
          },
        }),
      }),
    );
  });

  it("rejects hidden fallback listing facts on selected-offer confirmation before side effects", async () => {
    mockSignedInSellCheckoutState();

    const form = signedInSellCheckoutForm({
      sellListReviewPlan: JSON.stringify({
        version: 1,
        lines: [
          {
            lineId: "sll_1",
            lineType: "selected-offer",
            itemTitle: "Mewtwo",
            productId: "prod_1",
            quantity: 1,
            selectedOffer: { offerId: "off_1", feeQuoteFingerprint: "quote_1" },
            productOfferTargets: [],
            fallbackListing: { inventoryItemId: "inv_extra", priceAmount: "40.00", quantityCap: 1 },
            skippedReasons: [],
          },
        ],
      }),
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors.form : "").toContain(
      "Return to the Sell List and refresh the reviewed sale plan",
    );
    expectNoSellerCommitSideEffects();
  });

  it("records fallback-only listing handoff without claiming sale or payout side effects", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        lineCount: 1,
        includedLineIds: ["sll_product"],
        lineOutcomes: [{ lineId: "sll_product", outcome: "checkout", reason: "ready", action: "fallback-listing" }],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          guestSellListLine({
            seller_account_id: "acc_seller",
            line_id: "sll_product",
            line_type: "product",
            offer_id: null,
            offer_price_amount: null,
            quantity: 1,
            minimum_listing_price_amount: "12.00",
          }),
        ],
        count: 1,
      })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListConfirmation: mockGetSellListConfirmation,
      confirmSellListCheckout: mockConfirmSellListCheckout,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm({
          readinessDecisions: JSON.stringify({
            lineActions: [{ lineId: "sll_product", action: "fallback-listing" }],
            lineOutcomes: [],
          }),
          sellListReviewPlan: JSON.stringify({
            version: 1,
            lines: [
              {
                lineId: "sll_product",
                lineType: "product",
                itemTitle: "Mewtwo",
                productId: "prod_1",
                quantity: 1,
                selectedOffer: null,
                productOfferTargets: [],
                fallbackListing: { inventoryItemId: "inv_1", priceAmount: "12.00", quantityCap: 1 },
                skippedReasons: [],
              },
            ],
          }),
        }).toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("confirmed");
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).toHaveBeenCalledWith({
      inventoryItemId: "inv_1",
      priceAmount: "12.00",
      quantityCap: 1,
      listingIdOverride: "lst_slc_chk_sell_1_sll_product",
    });
    expect(mockConfirmSellListCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        completedLineIds: ["sll_product"],
        remainingLineQuantities: [],
        handoffSummary: expect.objectContaining({
          acceptedOfferCount: 0,
          publishedListingCount: 1,
          sideEffects: {
            sale: "not-applicable",
            label: "not-applicable",
            payout: "not-applicable",
            settlement: "not-applicable",
            notification: "pending-downstream",
            accountHistory: "pending-downstream",
          },
        }),
      }),
    );
  });

  it("records Smart Match and fallback listing handoffs with remaining Sell List quantity on publish replay", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        lineCount: 4,
        includedLineIds: ["sll_product"],
        lineOutcomes: [{ lineId: "sll_product", outcome: "checkout", reason: "ready", action: "smart-match" }],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          guestSellListLine({
            seller_account_id: "acc_seller",
            line_id: "sll_product",
            line_type: "product",
            offer_id: null,
            offer_price_amount: null,
            quantity: 4,
            minimum_listing_price_amount: "12.00",
          }),
        ],
        count: 4,
      })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListConfirmation: mockGetSellListConfirmation,
      confirmSellListCheckout: mockConfirmSellListCheckout,
    });
    mockCreateListing.mockResolvedValue({
      id: "lst_slc_chk_sell_1_sll_product",
      status: "draft",
      feeQuoteFingerprint: "listing_quote_1",
    });
    mockPublishListing.mockRejectedValueOnce(
      new MockMarketplaceApiError(400, { error: { message: "Listing is already active." } }),
    );
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });

    const form = signedInSellCheckoutForm({
      readinessDecisions: JSON.stringify({
        lineActions: [{ lineId: "sll_product", action: "smart-match" }],
        lineOutcomes: [],
      }),
      sellListReviewPlan: JSON.stringify({
        version: 1,
        lines: [
          {
            lineId: "sll_product",
            lineType: "product",
            itemTitle: "Mewtwo",
            productId: "prod_1",
            quantity: 4,
            selectedOffer: null,
            productOfferTargets: [{ offerId: "off_product_1", feeQuoteFingerprint: "quote_product_1", quantity: 1 }],
            fallbackListing: { inventoryItemId: "inv_1", priceAmount: "12.00", quantityCap: 1 },
            skippedReasons: [],
          },
        ],
      }),
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("confirmed");
    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_product_1", {
      feeQuoteFingerprint: "quote_product_1",
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_product:match:off_product_1",
    });
    expect(mockCreateListing).toHaveBeenCalledWith({
      inventoryItemId: "inv_1",
      priceAmount: "12.00",
      quantityCap: 1,
      listingIdOverride: "lst_slc_chk_sell_1_sll_product",
    });
    expect(mockPublishListing).toHaveBeenCalledWith("lst_slc_chk_sell_1_sll_product", {
      feeQuoteFingerprint: "listing_quote_1",
    });
    expect(mockConfirmSellListCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        completedLineIds: [],
        remainingLineQuantities: [{ lineId: "sll_product", quantity: 2 }],
        handoffSummary: expect.objectContaining({
          acceptedOfferCount: 1,
          publishedListingCount: 1,
          lineOutcomes: [
            expect.objectContaining({
              lineId: "sll_product",
              status: "partial",
              action: "mixed",
              remainingQuantity: 2,
              references: {
                offerIds: ["off_product_1"],
                listingId: "lst_slc_chk_sell_1_sll_product",
              },
            }),
          ],
        }),
      }),
    );
  });

  it("rejects signed-in seller confirmation when the reviewed plan exceeds current line quantity", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        includedLineIds: ["sll_product"],
        lineOutcomes: [{ lineId: "sll_product", outcome: "checkout", reason: "ready", action: "smart-match" }],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          guestSellListLine({
            seller_account_id: "acc_seller",
            line_id: "sll_product",
            line_type: "product",
            offer_id: null,
            offer_price_amount: null,
            quantity: 1,
            minimum_listing_price_amount: "12.00",
          }),
        ],
        count: 1,
      })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListConfirmation: mockGetSellListConfirmation,
      confirmSellListCheckout: mockConfirmSellListCheckout,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });

    const form = signedInSellCheckoutForm({
      readinessDecisions: JSON.stringify({
        lineActions: [{ lineId: "sll_product", action: "smart-match" }],
        lineOutcomes: [],
      }),
      sellListReviewPlan: JSON.stringify({
        version: 1,
        lines: [
          {
            lineId: "sll_product",
            lineType: "product",
            itemTitle: "Mewtwo",
            productId: "prod_1",
            quantity: 1,
            selectedOffer: null,
            productOfferTargets: [{ offerId: "off_product_1", feeQuoteFingerprint: "quote_product_1", quantity: 2 }],
            fallbackListing: null,
            skippedReasons: [],
          },
        ],
      }),
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors.form : "").toContain(
      "Return to the Sell List and refresh the reviewed sale plan",
    );
    expectNoSellerCommitSideEffects();
  });

  it("validates guest seller checkout contact and ship-from fields without side effects", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const form = guestSellCheckoutForm({ email: "", shipFromLine1: "", termsAccepted: "" });
    form.delete("termsAccepted");

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_sell_list=anon_sell_1",
        },
        body: form.toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors : {}).toEqual(
      expect.objectContaining({
        email: "Enter a valid email address.",
        shipFromLine1: "Enter address line 1.",
        termsAccepted: "Confirm that you reviewed the final seller terms and sale details.",
      }),
    );
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported ship-from", { shipFromState: "PR" }, "shipFromState", "This ship-from region is not supported"],
    ["payout setup required", { payoutState: "setup-required" }, "payoutHandoff", "Payout setup is required"],
    ["payout setup failure", { payoutState: "failed" }, "payoutHandoff", "Payout setup is temporarily unavailable"],
    ["changed payout", { payoutEstimateState: "changed" }, "form", "The payout estimate changed"],
    ["risk hold", { riskState: "hold" }, "form", "This sale review is on hold"],
    ["risk block", { riskState: "block" }, "form", "This sale review cannot continue"],
    ["label failure", { labelState: "failed" }, "labelPreference", "Label readiness is unavailable"],
  ])("blocks guest seller checkout on %s without side effects", async (_label, overrides, fieldName, message) => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_sell_list=anon_sell_1",
        },
        body: guestSellCheckoutForm(overrides).toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors[fieldName as keyof typeof result.fieldErrors] : "").toContain(
      message,
    );
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("returns a guest seller confirmation handoff with no seller-committing side effects", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_sell_list=anon_sell_1",
        },
        body: guestSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        status: "confirmed",
        confirmation: expect.objectContaining({
          referenceId: "guest-sell-chk_sell_1",
          sideEffects: {
            label: "not-attempted",
            payout: "not-attempted",
            sale: "not-attempted",
            settlement: "not-attempted",
            notification: "not-attempted",
            accountHistory: "not-attempted",
          },
        }),
      }),
    );
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
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

  it("keeps checkout visible when checkout totals are temporarily unavailable", async () => {
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
        previewError: "Checkout totals are temporarily unavailable. Refresh before confirming payment.",
      }),
    );
    expect(mockPreviewCheckoutFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "chk_1",
        sourceType: "buy-now",
      }),
    );
  });

  it("passes safe checkout edit section query state to the checkout page", async () => {
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
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });

    const result = await checkoutSessionLoader({
      request: new Request("http://localhost/checkout/chk_1?edit=delivery"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(result.initialEditSection).toBe("delivery");
  });

  it("ignores unsafe checkout edit section query state", async () => {
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
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });

    const result = await checkoutSessionLoader({
      request: new Request("http://localhost/checkout/chk_1?edit=provider-payload"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(result.initialEditSection).toBeNull();
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

    expect(recoveryResponse?.status).toBe(202);
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

  it("confirms signed-in checkout and redirects to payment detail", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
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
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_bank_1");

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
      marketplaceCheckoutFeeQuoteFingerprint: "quote_bank_1",
      savedCheckoutInstrumentId: null,
      savePaymentMethodForFuture: false,
      fulfillmentPreviewRevision: null,
      acknowledgedMaterialChanges: false,
      deferPayment: false,
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
    expect(response.headers.get("Location")).toBe("/account/payments/pay_1");
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

    expect(recoveryResponse?.status).toBe(202);
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

    expect(recoveryResponse?.status).toBe(202);
    expect(recoveryResponse?.statusText).toBe("Preparing checkout");
    await expect(recoveryResponse?.text()).resolves.toContain("Refresh checkout");
  });

  it("returns temporary recovery when a fresh checkout handoff hits an opaque gateway timeout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(504, null);
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

    expect(recoveryResponse?.status).toBe(202);
    expect(recoveryResponse?.statusText).toBe("Preparing checkout");
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      primaryAction?: { href?: string; label?: string };
      trustCue?: string;
    };
    expect(recoveryBody.primaryAction?.href).toContain("/checkout/chk_1?afterWrite=");
    expect(recoveryBody.primaryAction?.label).toBe("Refresh checkout");
    expect(recoveryBody.trustCue).toBe("Your payment has not started.");
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
