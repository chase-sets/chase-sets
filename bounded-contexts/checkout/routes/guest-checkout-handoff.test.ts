import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCompactPostWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import {
  applyCheckoutRouteMockDefaults,
  guestCheckoutActor,
  MockCheckoutApiError,
  mockConfirmCheckoutSession,
  mockCreateAuthRequestApiClient,
  mockCreateCartReadiness,
  mockCreateCheckoutRequestApiClient,
  mockCreateCheckoutSession,
  mockCreateIdentityRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateOrderingRequestApiClient,
  mockCreatePaymentsRequestApiClient,
  mockGetCheckoutSession,
  mockGetGuestCheckoutClaimContext,
  mockGetGuestCart,
  MockMarketplaceApiError,
  mockMergeGuestCartToAccount,
  mockPreviewCheckoutFulfillment,
  mockPreviewCheckoutStatus,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockSelectAuthenticityCheckOptIn,
  mockSelectShippingOption,
  mockStartGuestCheckout,
} from "../tests/support/checkout-route-test-harness";

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

async function readResolvedFreshWriteToken(location: string) {
  const resolvedRequest = await resolvePlatformPostWriteRequest(new Request(new URL(location, "http://localhost")));
  return readFreshWriteToken(resolvedRequest);
}

function expectCompactPostWriteLocation(location: string, expectedPrefix: string) {
  expect(location).toContain(expectedPrefix);
  expect(readCompactPostWriteToken(location)).toMatch(/^pwt_/);
  expect(location).not.toContain("afterWrite=");
  expect(location).not.toContain("postWriteHandoff=");
}

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

vi.mock("@chase-sets/payments/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/payments/server")>("@chase-sets/payments/server");

  return {
    ...actual,
    createPaymentsRequestApiClient: mockCreatePaymentsRequestApiClient,
    normalizeRequestedBalanceCreditAmount: (value: unknown) => {
      const text = String(value ?? "").trim();
      return text ? text : null;
    },
  };
});

vi.mock("@chase-sets/marketplace/server", () => ({
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
  MarketplaceApiError: MockMarketplaceApiError,
}));

import { action as checkoutStartAction } from "./checkout-start";
import { action as checkoutSessionAction, loader as checkoutSessionLoader } from "./checkout-session";

/** Auth resolves the guest-buyer only when the request presents the guest cookie. */
function resolveGuestFromCookie() {
  mockResolveActorFromAuthApi.mockImplementation(async ({ request }: { request: Request }) =>
    (request.headers.get("cookie") ?? "").includes("chase_sets_guest_checkout=guest_token")
      ? guestCheckoutActor()
      : null,
  );
}

/** One start POST as the browser sends it, presenting the cookies it holds. */
async function postStart(url: string, body: URLSearchParams, cookie = "") {
  return (await checkoutStartAction({
    request: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
      body: body.toString(),
    }),
    params: {},
    context: undefined,
  } as never)) as Response;
}

/**
 * A signed-out start as the browser runs it: the first POST answers the guest
 * entry `307` carrying only the guest cookie and writes no Session; the
 * browser re-sends the same body to its Location, presenting that cookie.
 */
async function startGuestEntry(url: string, body: URLSearchParams, heldCookie = "") {
  const hop = await postStart(url, body, heldCookie);
  expect(hop.status).toBe(307);
  expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  const hopCookies = hop.headers.getSetCookie().map((cookie) => cookie.split(";")[0] ?? "");
  expect(hopCookies).toEqual(["chase_sets_guest_checkout=guest_token"]);
  const location = new URL(hop.headers.get("Location") ?? "", url);
  expect(location.searchParams.get("guestEntry")).toBe("1");
  const response = await postStart(location.toString(), body, [heldCookie, ...hopCookies].filter(Boolean).join("; "));
  return { hop, response };
}

describe("checkout web routes: guest checkout handoff", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("proves guest cart checkout reaches payment without requiring a signed-in account", async () => {
    resolveGuestFromCookie();
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
    form.set("source", "cart");

    const { hop, response: checkoutStartResponse } = await startGuestEntry(
      "http://localhost/checkout/buy/readiness",
      form,
      "chase_sets_anonymous_cart=anon_cart_1",
    );
    const guestCheckoutCookie = hop.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("chase_sets_guest_checkout="));

    expect(checkoutStartResponse.headers.get("Location")).toBe("/checkout/buy/session/chk_guest");
    expect(checkoutStartResponse.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(guestCheckoutCookie).toContain("chase_sets_guest_checkout=guest_token");
    expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
    expect(mockStartGuestCheckout).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "cart",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: null,
      },
    });

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
      fulfillment_preview_revision: "rev_1",
      fulfillment_preview_snapshot: {
        revision: "rev_1",
        optimizationGoal: "lowest-total",
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
      },
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
      marketplace_checkout_fee: { total_amount: "27.10", quote_fingerprint: "quote_card_1" },
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
    mockGetGuestCheckoutClaimContext.mockResolvedValue({
      contactName: "Jane Smith",
      contactEmail: "jane@example.com",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({
      getGuestCheckoutClaimContext: mockGetGuestCheckoutClaimContext,
    });

    const checkoutSessionResult = await checkoutSessionLoader({
      request: new Request("http://localhost/checkout/buy/session/chk_guest", {
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
        guestCheckoutContact: {
          contactName: "Jane Smith",
          contactEmail: "jane@example.com",
        },
      }),
    );
    expect(mockGetGuestCheckoutClaimContext).toHaveBeenCalledWith({});

    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({
      payment_id: "pay_guest_1",
      order_ids: ["ord_guest_1"],
      status: "confirmed",
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const confirmationForm = new URLSearchParams();
    confirmationForm.set("intent", "confirm-checkout");
    confirmationForm.set("sourceType", "cart");
    confirmationForm.set("shippingOption", "standard");
    confirmationForm.set("paymentMethodCategory", "card");
    confirmationForm.set("previewPaymentMethodCategory", "card");
    confirmationForm.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_card_1");
    confirmationForm.set("shippingName", "Jane Smith");
    confirmationForm.set("shippingLine1", "100 Market Street");
    confirmationForm.set("shippingCity", "Chicago");
    confirmationForm.set("shippingState", "IL");
    confirmationForm.set("shippingPostalCode", "60601");
    confirmationForm.set("shippingCountry", "US");
    confirmationForm.set("shippingEmail", checkoutSessionResult.guestCheckoutContact?.contactEmail ?? "");

    const confirmationResponse = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_guest", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: guestCheckoutCookie ?? "",
        },
        body: confirmationForm.toString(),
      }),
      params: { sessionId: "chk_guest" },
      context: undefined,
    } as never)) as Response;

    expect(confirmationResponse.status).toBe(302);
    expect(confirmationResponse.headers.get("Location")).toBe("/checkout/buy/session/chk_guest");
    expect(confirmationResponse.headers.get("Location")).not.toContain("/account/payments");
    expect(mockSelectShippingOption).toHaveBeenCalledWith("chk_guest", {
      shippingOption: "standard",
    });
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith("chk_guest", {
      requestedBalanceCreditAmount: null,
      paymentMethodCategory: "card",
      marketplaceCheckoutFeeQuoteFingerprint: "quote_card_1",
      savedCheckoutInstrumentId: null,
      savePaymentMethodForFuture: false,
      fulfillmentPreviewRevision: null,
      acknowledgedMaterialChanges: false,
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
        email: "jane@example.com",
      },
    });
    expect(mockCreateIdentityRequestApiClient).not.toHaveBeenCalled();
    expect(JSON.stringify(mockConfirmCheckoutSession.mock.calls)).not.toContain("4242");
  });

  it("reuses a valid returning guest cookie without starting another guest identity", async () => {
    resolveGuestFromCookie();
    mockStartGuestCheckout.mockResolvedValue({
      accountId: "acc_guest",
      guestToken: "guest_token",
      expiresAt: "2026-04-02T00:00:00.000Z",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({ startGuestCheckout: mockStartGuestCheckout });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutSession
      .mockResolvedValueOnce({ session_id: "chk_guest_cart" })
      .mockResolvedValueOnce({ session_id: "chk_guest_buy_now" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const { response: first } = await startGuestEntry(
      "http://localhost/checkout/buy/readiness",
      new URLSearchParams({ source: "cart" }),
      "chase_sets_anonymous_cart=anon_cart_1",
    );

    const second = (await checkoutStartAction({
      request: new Request(
        "http://localhost/checkout/buy/readiness?source=buy-now&listingId=lst_1&fulfillmentMode=locked-listing&lockedListingId=lst_1&catalogItemId=cat_1&productId=prod_1&itemTitle=Test+card&quantity=1",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            cookie: "chase_sets_guest_checkout=guest_token",
          },
          body: new URLSearchParams({ entryAttemptKey: "guest-handoff-returning-buy-now-20261031" }),
        },
      ),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(first.headers.get("Location")).toBe("/checkout/buy/session/chk_guest_cart");
    expect(second.headers.get("Location")).toBe("/checkout/buy/session/chk_guest_buy_now");
    expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
  });

  it("hands a cart guest whose access no longer matches to a fresh guest through the entry hop", async () => {
    mockResolveActorFromAuthApi.mockImplementation(async ({ request }: { request: Request }) => {
      const cookie = request.headers.get("cookie") ?? "";
      if (cookie.includes("chase_sets_guest_checkout=guest_token")) return guestCheckoutActor();
      return cookie.includes("chase_sets_guest_checkout=stale_guest_token")
        ? { ...guestCheckoutActor(), accountId: "acc_stale_guest" }
        : null;
    });
    mockStartGuestCheckout.mockResolvedValue({
      accountId: "acc_guest",
      guestToken: "guest_token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({ startGuestCheckout: mockStartGuestCheckout });
    mockMergeGuestCartToAccount.mockResolvedValue({ status: "merged" });
    // Each Session write records the cookie its own request presented; the stale guest is refused.
    const sessionWriters: string[] = [];
    mockCreateCheckoutRequestApiClient.mockImplementation((request: Request) => ({
      createCartReadiness: mockCreateCartReadiness,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
      createCheckoutSession: async (body: unknown) => {
        const writer = request.headers.get("cookie") ?? "";
        sessionWriters.push(writer);
        await mockCreateCheckoutSession(body);
        if (writer.includes("stale_guest_token")) {
          throw new MockCheckoutApiError(403, { error: { code: "authorization_forbidden", message: "Forbidden." } });
        }
        return { session_id: "chk_guest_recovered_cart" };
      },
    }));
    const form = new URLSearchParams({ source: "cart" });
    const anonymousCart = "chase_sets_anonymous_cart=anon_cart_1";

    const hop = await postStart(
      "http://localhost/checkout/buy/readiness",
      form,
      `${anonymousCart}; chase_sets_guest_checkout=stale_guest_token`,
    );

    expect(hop.status).toBe(307);
    expect(hop.headers.getSetCookie().map((cookie) => cookie.split(";")[0])).toEqual([
      "chase_sets_guest_checkout=guest_token",
    ]);
    expect(mockCreateCheckoutSession).toHaveBeenCalledOnce();
    expect(mockStartGuestCheckout).toHaveBeenCalledOnce();

    // The browser replaces the stale guest cookie and keeps the anonymous cart for the followed POST.
    const response = await postStart(
      new URL(hop.headers.get("Location") ?? "", "http://localhost").toString(),
      form,
      `${anonymousCart}; chase_sets_guest_checkout=guest_token`,
    );

    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_guest_recovered_cart");
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(response.headers.getSetCookie().map((cookie) => cookie.split(";")[0])).toEqual([
      "chase_sets_anonymous_cart=",
    ]);
    expect(sessionWriters).toEqual([
      `${anonymousCart}; chase_sets_guest_checkout=stale_guest_token`,
      `${anonymousCart}; chase_sets_guest_checkout=guest_token`,
    ]);
    expect(mockMergeGuestCartToAccount).toHaveBeenCalledTimes(2);
    expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
  });

  it("fails closed to cart recovery when guest cart readiness is stale before checkout", async () => {
    resolveGuestFromCookie();
    mockStartGuestCheckout.mockResolvedValue({
      accountId: "acc_guest",
      guestToken: "guest_token",
      expiresAt: "2026-04-02T00:00:00.000Z",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockCreateCheckoutSession.mockRejectedValue(
      new MockCheckoutApiError(400, {
        error: {
          code: "readiness_snapshot_stale",
          message: "Cart readiness changed. Review your cart before checkout.",
        },
      }),
    );
    mockMergeGuestCartToAccount.mockResolvedValue({ status: "merged" });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");

    const { response: result } = await startGuestEntry(
      "http://localhost/checkout/buy/readiness",
      form,
      "chase_sets_anonymous_cart=anon_cart_1",
    );

    expect(result).toEqual({
      recovery: expect.objectContaining({
        kind: "request-validation",
        primaryAction: expect.objectContaining({ href: "/account/cart" }),
        trustCue: "Your payment has not started.",
      }),
    });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "cart",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: null,
      },
    });
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
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
      fulfillment_preview_revision: "rev_1",
      fulfillment_preview_snapshot: {
        revision: "rev_1",
        optimizationGoal: "lowest-total",
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
      },
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
    resolveGuestFromCookie();
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
    form.set("entryAttemptKey", "guest-handoff-projection-lag-20261031");

    const { hop, response: checkoutStartResponse } = await startGuestEntry(
      "http://localhost/checkout/buy/readiness",
      form,
    );
    const guestCheckoutCookie = hop.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("chase_sets_guest_checkout="));
    const checkoutLocation = checkoutStartResponse.headers.get("Location") ?? "";
    const freshReceipt = await readResolvedFreshWriteToken(checkoutLocation);

    expect(checkoutStartResponse.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(guestCheckoutCookie).toContain("chase_sets_guest_checkout=guest_token");
    expectCompactPostWriteLocation(checkoutLocation, "/checkout/buy/session/chk_guest?postWriteToken=");
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
      entryAttemptKey: "guest-handoff-projection-lag-20261031",
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
    // The Session is written by a client whose request presents the guest cookie itself.
    const [sessionWriteRequest, sessionWriteOptions] = mockCreateCheckoutRequestApiClient.mock.lastCall as [
      Request,
      unknown,
    ];
    expect(sessionWriteRequest.headers.get("cookie")).toBe("chase_sets_guest_checkout=guest_token");
    expect(sessionWriteOptions).toEqual({ headers: undefined });
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
});
