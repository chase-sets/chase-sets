import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFreshWriteToken } from "@chase-sets/http/responses";
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
  mockGetCart,
  mockGetGuestCart,
  MockMarketplaceApiError,
  mockMergeGuestCartToAccount,
  mockPreviewCheckoutStatus,
  readyCartReadinessResponse,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
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

import {
  action as checkoutStartAction,
  checkoutStartBuyerProtectionItems,
  checkoutStartHeaderCopy,
  loader as checkoutStartLoader,
} from "./checkout-start";

async function readRedirectFreshWriteToken(location: string | null) {
  const request = new Request(new URL(location ?? "", "http://localhost"));
  const resolvedRequest = await resolvePlatformPostWriteRequest(request);
  return readFreshWriteToken(resolvedRequest);
}

function checkoutSessionResult(sessionId: string, position = "42") {
  return {
    session_id: sessionId,
    commitPositions: [
      {
        sourceContextName: "checkout",
        maxGlobalPosition: position,
        eventIds: [`evt_${sessionId}`],
      },
    ],
  };
}

describe("checkout web routes: checkout start", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

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
      request: new Request("http://localhost/checkout/buy/readiness", {
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
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_cart");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_cart=");
  });

  it("refreshes signed-in cart readiness instead of trusting cart-page display snapshot fields", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_cart" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");
    form.set("readinessSnapshotId", "cr_display_only");
    form.set("readinessSourceRevision", "cr_display_revision");
    form.set(
      "readinessDecisions",
      JSON.stringify({ optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" } }),
    );

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
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
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_cart");
  });

  it("keeps signed-out buyers on the checkout start choice page with a checkout return target", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestCart.mockResolvedValue({ items: [], count: 2 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
    });

    const result = await checkoutStartLoader({
      request: new Request("http://localhost/checkout/buy/readiness"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      isSignedIn: false,
      isGuestBuyer: false,
      source: null,
      cartReadiness: null,
      cartCount: 2,
      entryAttemptKey: expect.stringMatching(/^chkentry_/),
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness",
    });
    expect(mockGetGuestCart).toHaveBeenCalledWith(null);
    expect(mockStartGuestCheckout).not.toHaveBeenCalled();
    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
    expect(mockCreateCartReadiness).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("marks guest checkout actors separately from registered signed-in accounts on checkout start", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await checkoutStartLoader({
      request: new Request("http://localhost/checkout/buy/readiness"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      isSignedIn: false,
      isGuestBuyer: true,
      source: null,
      cartReadiness: null,
      cartCount: 0,
      entryAttemptKey: expect.stringMatching(/^chkentry_/),
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness",
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
    form.set("source", "cart");

    const result = await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
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

  it("starts signed-out cart checkout in one POST without guest contact fields", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockStartGuestCheckout.mockResolvedValue({
      accountId: "acc_guest",
      guestToken: "guest_token",
      expiresAt: "2026-04-02T00:00:00.000Z",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_guest_one_post" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");
    form.set("readinessSnapshotId", "cr_ready");
    form.set("readinessSourceRevision", "cr_source");

    const result = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
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

    expect(result.headers.get("Location")).toBe("/checkout/buy/session/chk_guest_one_post");
    expect(mockGetGuestCart).toHaveBeenCalledWith("anon_cart_1");
    expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
    expect(mockStartGuestCheckout).toHaveBeenCalledWith({});
    expect(mockMergeGuestCartToAccount).toHaveBeenCalledWith("anon_cart_1");
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).toHaveBeenCalledOnce();
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
      request: new Request("http://localhost/checkout/buy/readiness", {
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
        request: new Request("http://localhost/checkout/buy/readiness", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toThrow("database unavailable");
  });

  it("preserves buy-now checkout intent in the sign-in return target", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await checkoutStartLoader({
      request: new Request(
        "http://localhost/checkout/buy/readiness?source=buy-now&listingId=lst_1&catalogItemId=cat_1&productId=prod_1&itemTitle=Charizard&quantity=1",
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
      "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness%3Fsource%3Dbuy-now%26listingId%3Dlst_1%26catalogItemId%3Dcat_1%26productId%3Dprod_1%26itemTitle%3DCharizard%26quantity%3D1",
    );
  });

  it("loads current signed-in cart readiness after sign-in returns to checkout start", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
    });

    const result = await checkoutStartLoader({
      request: new Request("http://localhost/checkout/buy/readiness"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      isSignedIn: true,
      isGuestBuyer: false,
      source: null,
      cartReadiness: {
        status: "ready",
        lineCount: 1,
        customerSafeFacts: ["Ready for checkout."],
      },
      cartCount: 1,
      entryAttemptKey: expect.stringMatching(/^chkentry_/),
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness",
    });
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({});
    expect(mockGetGuestCart).not.toHaveBeenCalled();
  });

  it("represents blocked signed-in cart readiness on the checkout start loader", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    mockCreateCartReadiness.mockResolvedValueOnce({
      readiness: {
        ...readyCartReadinessResponse().readiness,
        snapshotId: "cr_blocked",
        status: "blocked",
        lineCount: 1,
        includedLineIds: [],
        unresolvedLineIds: ["cli_air_balloon"],
        lineOutcomes: [{ lineId: "cli_air_balloon", outcome: "checkout", reason: "shipping-measure-missing" }],
        customerSafeFacts: ["No cart items are ready for checkout."],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
    });

    const result = await checkoutStartLoader({
      request: new Request("http://localhost/checkout/buy/readiness"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        isSignedIn: true,
        source: null,
        cartCount: 1,
        cartReadiness: {
          status: "blocked",
          lineCount: 1,
          customerSafeFacts: ["No cart items are ready for checkout."],
        },
      }),
    );
    expect(mockGetGuestCart).not.toHaveBeenCalled();
  });

  it("starts signed-in buy-now checkout from the preserved checkout start payload", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    mockCreateCheckoutSession.mockResolvedValue(checkoutSessionResult("chk_buy_now"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("entryAttemptKey", "entry_attempt_1");
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
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: "entry_attempt_1",
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
    const redirectUrl = new URL(response.headers.get("Location") ?? "", "http://localhost");
    expect(redirectUrl.pathname).toBe("/checkout/buy/session/chk_buy_now");
    expect(await readRedirectFreshWriteToken(redirectUrl.toString())).toMatchObject({
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "42",
          eventIds: ["evt_chk_buy_now"],
        },
      ],
    });
  });

  it("starts signed-out buy-now checkout with a guest cookie and fresh checkout receipt", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockStartGuestCheckout.mockResolvedValue({
      accountId: "acc_guest",
      guestToken: "guest_token",
      expiresAt: "2026-04-02T00:00:00.000Z",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockCreateCheckoutSession.mockResolvedValue(checkoutSessionResult("chk_guest_buy_now"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("entryAttemptKey", "entry_attempt_1");
    form.set("source", "cart");
    form.set("listingId", "lst_tampered");
    form.set("fulfillmentMode", "locked-listing");
    form.set("lockedListingId", "lst_tampered");
    form.set("catalogItemId", "cat_tampered");
    form.set("productId", "prod_tampered");
    form.set("itemTitle", "Tampered");
    form.set("selectedOptions", "[]");
    form.set("quantity", "99");

    const response = (await checkoutStartAction({
      request: new Request(
        "http://localhost/checkout/buy/readiness?source=buy-now&listingId=lst_1&fulfillmentMode=locked-listing&lockedListingId=lst_1&catalogItemId=cat_1&productId=prod_1&itemTitle=Charizard&selectedOptions=%5B%7B%22dimensionId%22%3A%22condition%22%2C%22optionId%22%3A%22raw%22%7D%5D&quantity=1",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        },
      ),
      params: {},
      context: undefined,
    } as never)) as Response;
    const redirectUrl = new URL(response.headers.get("Location") ?? "", "http://localhost");

    expect(mockStartGuestCheckout).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: "entry_attempt_1",
      source: expect.objectContaining({
        type: "buy-now",
        listingId: "lst_1",
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        itemTitle: "Charizard",
        selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
        quantity: 1,
      }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_guest_checkout=guest_token");
    expect(redirectUrl.pathname).toBe("/checkout/buy/session/chk_guest_buy_now");
    expect(await readRedirectFreshWriteToken(redirectUrl.toString())).toMatchObject({
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "42",
          eventIds: ["evt_chk_guest_buy_now"],
        },
      ],
    });
  });

  it("silently recovers active guest buy-now checkout when the current guest account cannot start the preserved session", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    const blockedCreateCheckoutSession = vi.fn(async () => {
      throw new MockCheckoutApiError(403, {
        error: { code: "authorization_forbidden", message: "Forbidden." },
      });
    });
    const recoveredCreateCheckoutSession = vi.fn(async () => ({ session_id: "chk_guest_recovered" }));
    mockStartGuestCheckout.mockResolvedValue({
      accountId: "acc_guest_recovered",
      guestToken: "guest_token_recovered",
      expiresAt: "2026-04-02T00:00:00.000Z",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockCreateCheckoutRequestApiClient
      .mockReturnValueOnce({
        createCheckoutSession: blockedCreateCheckoutSession,
        mergeGuestCartToAccount: mockMergeGuestCartToAccount,
      })
      .mockReturnValueOnce({
        createCheckoutSession: recoveredCreateCheckoutSession,
        mergeGuestCartToAccount: mockMergeGuestCartToAccount,
      });

    const form = new URLSearchParams();
    form.set("entryAttemptKey", "entry_attempt_1");
    form.set("source", "buy-now");
    form.set("listingId", "lst_1");
    form.set("catalogItemId", "cat_1");
    form.set("productId", "prod_1");
    form.set("itemTitle", "Charizard");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "condition", optionId: "raw" }]));
    form.set("quantity", "1");

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_guest_checkout=stale_guest_token",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(blockedCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: "entry_attempt_1",
      source: expect.objectContaining({
        type: "buy-now",
        listingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        itemTitle: "Charizard",
      }),
    });
    expect(mockStartGuestCheckout).toHaveBeenCalledWith({});
    expect(recoveredCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: "entry_attempt_1",
      source: expect.objectContaining({
        type: "buy-now",
        listingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        itemTitle: "Charizard",
      }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_guest_recovered");
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_guest_checkout=guest_token_recovered");
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("keeps signed-in wrong-account checkout start protected", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_other", permissions: [] });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(403, {
          error: { code: "authorization_forbidden", message: "Forbidden." },
        });
      }),
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "buy-now");
    form.set("listingId", "lst_1");
    form.set("catalogItemId", "cat_1");
    form.set("productId", "prod_1");
    form.set("itemTitle", "Charizard");
    form.set("selectedOptions", "[]");
    form.set("quantity", "1");

    const result = await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      recovery: expect.objectContaining({
        kind: "wrong-account",
        title: "Checkout belongs to another account",
      }),
    });
    expect(mockStartGuestCheckout).not.toHaveBeenCalled();
  });

  it("uses the authoritative offer-intent URL over conflicting form data", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_offer" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("entryAttemptKey", "entry_attempt_offer_1");
    form.set("source", "buy-now");
    form.set("listingId", "lst_tampered");
    form.set("catalogItemId", "cat_tampered");
    form.set("productId", "prod_tampered");
    form.set("itemTitle", "Tampered");
    form.set("selectedOptions", "[]");
    form.set("quantity", "99");

    const response = (await checkoutStartAction({
      request: new Request(
        "http://localhost/checkout/buy/readiness?source=offer-intent&catalogItemId=cat_1&productId=prod_1&itemTitle=Charizard&itemSubtitle=Base+Set&selectedOptions=%5B%7B%22dimensionId%22%3A%22condition%22%2C%22optionId%22%3A%22raw%22%7D%5D&productSummary=Raw&offerPriceAmount=350.00&quantity=2",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        },
      ),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: "entry_attempt_offer_1",
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
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_offer");
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
    mockMergeGuestCartToAccount.mockResolvedValue({ mergedLineCount: 0, failedLineCount: 0 });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
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

    expect(mockStartGuestCheckout).toHaveBeenCalledWith({});
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
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_guest");
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_guest_checkout=guest_token");
  });

  it("uses one anonymous-source client for guest merge, readiness, and session without polling", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockStartGuestCheckout.mockResolvedValue({
      accountId: "acc_guest",
      guestToken: "guest_token",
      expiresAt: "2026-04-02T00:00:00.000Z",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockMergeGuestCartToAccount.mockResolvedValue({
      mergedLineCount: 1,
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "42",
          eventIds: ["evt_guest_cart_merged"],
        },
      ],
    });
    mockCreateCheckoutSession.mockResolvedValue({
      session_id: "chk_guest",
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "43",
          eventIds: ["evt_checkout_session_started"],
        },
      ],
    });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    const mutableApiClientCalls: { request: Request; options: unknown }[] = [];
    mockCreateCheckoutRequestApiClient.mockImplementation((request: Request, options?: unknown) => {
      mutableApiClientCalls.push({ request, options });
      return {
        getGuestCart: mockGetGuestCart,
        createCartReadiness: mockCreateCartReadiness,
        createCheckoutSession: mockCreateCheckoutSession,
        mergeGuestCartToAccount: mockMergeGuestCartToAccount,
      };
    });

    const form = new URLSearchParams();
    form.set("source", "cart");

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
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
    const redirectReceipt = await readRedirectFreshWriteToken(response.headers.get("Location"));

    expect(mockMergeGuestCartToAccount).toHaveBeenCalledWith("anon_cart_1");
    expect(mockGetCart).not.toHaveBeenCalled();
    expect(mutableApiClientCalls).toHaveLength(2);
    expect(mutableApiClientCalls[0]?.options).toEqual({
      headers: { "x-checkout-anonymous-cart-id": "anon_cart_1" },
    });
    expect(mutableApiClientCalls[1]?.options).toEqual({
      headers: {
        cookie: "chase_sets_guest_checkout=guest_token",
        "x-checkout-anonymous-cart-id": "anon_cart_1",
      },
    });
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "cart",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: null,
      },
    });
    expect(redirectReceipt).toMatchObject({
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "43",
          eventIds: ["evt_guest_cart_merged", "evt_checkout_session_started"],
        },
      ],
    });
  });

  it("continues guest cart entry from the union when the best-effort merge throws", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockStartGuestCheckout.mockResolvedValue({
      accountId: "acc_guest",
      guestToken: "guest_token",
      expiresAt: "2026-04-02T00:00:00.000Z",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({ startGuestCheckout: mockStartGuestCheckout });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockMergeGuestCartToAccount.mockRejectedValue(new Error("anon_raw_merge_marker secret"));
    mockCreateCheckoutSession.mockResolvedValue(checkoutSessionResult("chk_guest_union", "43"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_cart=anon_cart_1",
        },
        body: new URLSearchParams({ source: "cart" }).toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockGetCart).not.toHaveBeenCalled();
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).toHaveBeenCalledOnce();
    expect(response.headers.get("Location")).toContain("/checkout/buy/session/chk_guest_union");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_cart=");
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
    form.set("source", "cart");

    const response = (await checkoutStartAction({
      request: new Request("https://staging.chasesets.com/checkout/buy/readiness", {
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
    form.set("source", "cart");

    await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
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

  it("requires registration or sign-in before starting purchase-intent checkout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("source", "offer-intent");

    const result = await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness?source=offer-intent", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      error: "Register or sign in to submit an offer.",
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness%3Fsource%3Doffer-intent",
    });
    expect(mockStartGuestCheckout).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("uses purchase-intent account copy instead of guest checkout copy", () => {
    expect(checkoutStartHeaderCopy({ isSignedIn: false, isOfferIntent: true })).toEqual({
      title: "Register to submit an offer",
      description: "Register or sign in to submit your offer. Sellers review it before any payment is collected.",
    });
    expect(checkoutStartHeaderCopy({ isSignedIn: true, isOfferIntent: true })).toEqual({
      title: "Submit offer",
      description: "Confirm shipping so sellers can review your offer. No payment today.",
    });
    expect(
      checkoutStartBuyerProtectionItems(true)
        .map((item) => item.description)
        .join(" "),
    ).not.toContain("Guest");
  });
});
