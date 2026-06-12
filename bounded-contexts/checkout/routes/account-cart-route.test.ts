import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFreshWriteToken } from "@chase-sets/http/responses";
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
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockUpdateCartLineFulfillment,
  mockUpdateCartLineQuantity,
  mockUpdateGuestCartLineFulfillment,
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

    expect(result).toEqual({ cart: { items: [], count: 0 }, checkoutUnavailable: false });
    expect(mockGetGuestCart).toHaveBeenCalledWith("anon_cart_1");
    expect(mockGetCart).not.toHaveBeenCalled();
  });

  it("keeps cart reachable with an unavailable checkout state", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
    });

    const result = await accountCartLoader({
      request: new Request("http://localhost/account/cart?checkout=disabled"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({ cart: { items: [], count: 0 }, checkoutUnavailable: true });
    expect(mockGetCart).toHaveBeenCalled();
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
});
