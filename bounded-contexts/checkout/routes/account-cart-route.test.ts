import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
  guestCheckoutActor,
  MockCheckoutApiError,
  mockCreateAuthRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockCreateIdentityRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateOrderingRequestApiClient,
  mockCreatePaymentsRequestApiClient,
  mockCreateSettlementRequestApiClient,
  mockGetCart,
  mockGetGuestCart,
  MockMarketplaceApiError,
  mockRemoveCartLine,
  mockRemoveGuestCartLine,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockUpdateCartLineFulfillment,
  mockUpdateCartLineQuantity,
  mockUpdateGuestCartLineFulfillment,
  mockUpdateGuestCartLineQuantity,
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

import { action as accountCartAction, loader as accountCartLoader } from "./account-cart";

describe("checkout web routes: account cart", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
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

  it("recovers signed-in account cart self-refresh when a fresh receipt times out waiting for projection freshness", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
    });
    const request = new Request(
      `http://localhost${appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"))}`,
    );

    const result = await accountCartLoader({
      request,
      params: {},
      context: undefined,
    } as never);

    expect(mockCreateCheckoutRequestApiClient).toHaveBeenCalledWith(request);
    expect(result).toEqual({
      cart: { items: [], count: 0 },
      freshnessError: expect.any(String),
    });
  });

  it("engages the account cart projection wait when discovery's View cart link carries an add-to-cart receipt, but reads empty without one (#1930)", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });

    // Discovery's add-to-cart action builds viewCartHref the same way: it threads the
    // Checkout addCartLine command receipt through appendFreshWriteToken("/account/cart", result).
    const viewCartHref = appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_cart_line"));
    expect(readFreshWriteToken(new URL(viewCartHref, "http://localhost"))).toMatchObject({
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "42", eventIds: ["evt_cart_line"] }],
    });

    // With the token, a still-lagging cart projection is a transient freshness timeout the
    // loader recovers from after engaging the projection wait, rather than surfacing as a hard failure.
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    const withToken = await accountCartLoader({
      request: new Request(`http://localhost${viewCartHref}`),
      params: {},
      context: undefined,
    } as never);

    expect(withToken).toEqual({
      cart: { items: [], count: 0 },
      freshnessError: expect.any(String),
    });

    // Without the token (the pre-fix static href="/account/cart"), the same lagging projection
    // is treated as a permanent failure: the loader never waits and the cart cannot self-heal.
    vi.clearAllMocks();
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    await expect(
      accountCartLoader({
        request: new Request("http://localhost/account/cart"),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("recovers signed-in account cart self-refresh when a fresh receipt reads a transient not-found cart", async () => {
    vi.useFakeTimers();
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(404, {
        error: {
          code: "not_found",
          message: "Cart projection has not caught up yet.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
    });
    const request = new Request(
      `http://localhost${appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"))}`,
    );

    const resultPromise = accountCartLoader({
      request,
      params: {},
      context: undefined,
    } as never);

    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      cart: { items: [], count: 0 },
      freshnessError: expect.any(String),
    });
    expect(mockGetCart).toHaveBeenCalledTimes(6);
  });

  it.each([502, 503, 504])(
    "recovers signed-in account cart self-refresh when a fresh receipt reads an opaque %i gateway error",
    async (status) => {
      mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
      mockGetCart.mockRejectedValue(new MockCheckoutApiError(status, null));
      mockCreateCheckoutRequestApiClient.mockReturnValue({
        getCart: mockGetCart,
      });
      const request = new Request(
        `http://localhost${appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"))}`,
      );

      const result = await accountCartLoader({
        request,
        params: {},
        context: undefined,
      } as never);

      expect(result).toEqual({
        cart: { items: [], count: 0 },
        freshnessError: expect.any(String),
      });
    },
  );

  it("treats account cart projection timeouts without a fresh receipt as permanent loader failures", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
    });

    await expect(
      accountCartLoader({
        request: new Request("http://localhost/account/cart"),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });

  it.each([
    {
      name: "malformed",
      href: "/account/cart?afterWrite=%7Bnot-json",
    },
    {
      name: "far-future",
      href: appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"), Date.now() + 60_000),
    },
  ])(
    "treats account cart projection timeouts with $name fresh receipts as permanent loader failures",
    async ({ href }) => {
      mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
      mockGetCart.mockRejectedValue(
        new MockCheckoutApiError(503, {
          error: {
            code: "projection_freshness_timeout",
            message: "Projection read model did not catch up before the freshness timeout.",
          },
        }),
      );
      mockCreateCheckoutRequestApiClient.mockReturnValue({
        getCart: mockGetCart,
      });

      await expect(
        accountCartLoader({
          request: new Request(`http://localhost${href}`),
          params: {},
          context: undefined,
        } as never),
      ).rejects.toMatchObject({ status: 503 });
    },
  );

  it("treats account cart projection timeouts with expired fresh receipts as permanent loader failures", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
    });
    const request = new Request(
      `http://localhost${appendFreshWriteToken(
        "/account/cart",
        checkoutCommit("42", "evt_checkout"),
        Date.now() - 40_000,
      )}`,
    );

    await expect(
      accountCartLoader({
        request,
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });

  it.each([401, 403])(
    "treats account cart authorization status %i with fresh receipts as permanent loader failures",
    async (status) => {
      mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
      mockGetCart.mockRejectedValue(
        new MockCheckoutApiError(status, {
          error: {
            code: status === 401 ? "authentication_required" : "authorization_forbidden",
            message: "Authentication required.",
          },
        }),
      );
      mockCreateCheckoutRequestApiClient.mockReturnValue({
        getCart: mockGetCart,
      });
      const request = new Request(
        `http://localhost${appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"))}`,
      );

      await expect(
        accountCartLoader({
          request,
          params: {},
          context: undefined,
        } as never),
      ).rejects.toMatchObject({ status });
    },
  );

  it.each([
    {
      name: "missing",
      href: "/account/cart",
    },
    {
      name: "malformed",
      href: "/account/cart?afterWrite=%7Bnot-json",
    },
    {
      name: "expired",
      href: appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"), Date.now() - 40_000),
    },
    {
      name: "far-future",
      href: appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"), Date.now() + 60_000),
    },
  ])("treats account cart not-found reads with $name receipts as permanent loader failures", async ({ href }) => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(404, {
        error: {
          code: "not_found",
          message: "Cart not found.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
    });

    await expect(
      accountCartLoader({
        request: new Request(`http://localhost${href}`),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
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

  it("uses absolute optimistic quantity for signed-in grouped cart updates", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockUpdateCartLineQuantity.mockResolvedValue(checkoutCommit("48", "evt_quantity"));
    mockRemoveCartLine.mockResolvedValue(checkoutCommit("49", "evt_duplicate_removed"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      updateCartLineQuantity: mockUpdateCartLineQuantity,
      removeCartLine: mockRemoveCartLine,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("quantity", "5");
    form.set("quantityDelta", "-1");
    form.set("optimisticStrategy", "optimistic-with-correction");
    form.set("correctionSource", "fresh-read:loader-revalidation");
    form.set("optimisticSequence", "3");
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

    expect(mockUpdateCartLineQuantity).toHaveBeenCalledWith("cli_primary", { quantity: 5 });
    expect(mockRemoveCartLine).toHaveBeenCalledWith("cli_duplicate");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/account/cart?afterWrite=");
  });

  it("uses absolute optimistic quantity for guest cart updates", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockUpdateGuestCartLineQuantity.mockResolvedValue(checkoutCommit("50", "evt_guest_quantity"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      updateGuestCartLineQuantity: mockUpdateGuestCartLineQuantity,
      removeGuestCartLine: mockRemoveGuestCartLine,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_guest");
    form.set("quantity", "4");
    form.set("optimisticStrategy", "optimistic-with-correction");
    form.set("correctionSource", "fresh-read:loader-revalidation");
    form.set("optimisticSequence", "2");
    form.set("intent", "update-cart-line");

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

    expect(mockUpdateGuestCartLineQuantity).toHaveBeenCalledWith("anon_cart_1", "cli_guest", { quantity: 4 });
    expect(mockRemoveGuestCartLine).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/account/cart?afterWrite=");
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
});
