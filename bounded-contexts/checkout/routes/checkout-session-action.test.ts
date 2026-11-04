import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  appendFreshWriteToken,
  appendFreshWriteTokenFromSources,
  readCompactPostWriteToken,
  readFreshWriteToken,
} from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
  guestCheckoutActor,
  MockCheckoutApiError,
  mockConfirmCheckoutSession,
  mockCreateAuthRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockCreateIdentityRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateOrderingRequestApiClient,
  mockCreatePaymentsRequestApiClient,
  mockGetCheckoutSession,
  mockListSellListShipFromAddresses,
  MockMarketplaceApiError,
  mockPreviewCheckoutFulfillment,
  mockRecordFulfillmentPreview,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockSelectAuthenticityCheckOptIn,
  mockSelectShippingAddress,
  mockSelectShippingOption,
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

import { action as checkoutSessionAction } from "./checkout-session";
import { t } from "@chase-sets/localization";

async function readResolvedFreshWriteToken(location: string | null) {
  const request = new Request(new URL(location ?? "", "http://localhost"));
  const resolvedRequest = await resolvePlatformPostWriteRequest(request);
  return readFreshWriteToken(resolvedRequest);
}

function expectCompactPostWriteLocation(location: string | null, expectedPrefix: string) {
  expect(location).toContain(expectedPrefix);
  expect(readCompactPostWriteToken(location ?? "")).toMatch(/^pwt_/);
  expect(location).not.toContain("afterWrite=");
  expect(location).not.toContain("postWriteHandoff=");
}

function checkoutSessionForReviewedPreview(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "chk_1",
    source_type: "cart",
    payment_id: null,
    shipping_option: "standard",
    shipping_address: null,
    optimization_goal: "lowest-total",
    lines: [
      {
        listingId: "lst_1",
        cartLineId: "cart_line_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
      },
    ],
    ...overrides,
  };
}

function reviewedFulfillmentPreview(revision = "fulfillment_rev_2") {
  return {
    revision,
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
  };
}

function confirmCheckoutForm(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    intent: "confirm-checkout",
    shippingOption: "standard",
    paymentMethodCategory: "card",
    previewPaymentMethodCategory: "card",
    marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
    shippingName: "Jane Smith",
    shippingLine1: "100 Market Street",
    shippingCity: "Chicago",
    shippingState: "IL",
    shippingPostalCode: "60601",
    shippingCountry: "US",
    ...overrides,
  });
}

describe("checkout web routes: checkout session action", () => {
  it("AC6 refuses an expired covered handoff before confirm or checkout mutations", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockGetCheckoutSession.mockResolvedValue({
      source_type: "buy-now",
      order_ids: [],
      handoff_expires_at: "2000-01-01T00:00:00Z",
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCheckoutSession: mockGetCheckoutSession });
    const form = new URLSearchParams({
      intent: "confirm-checkout",
      shippingOption: "standard",
      shippingName: "Synthetic buyer",
      shippingLine1: "100 Market Street",
      shippingCity: "Chicago",
      shippingState: "IL",
      shippingPostalCode: "60601",
      shippingCountry: "US",
    });
    const result = await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", { method: "POST", body: form }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);
    expect(result).toMatchObject({
      code: "checkout_expired",
      error: t("checkout.routes.checkoutRecovery.checkout.handoff.expired.description"),
    });
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
    expect(mockSelectShippingOption).not.toHaveBeenCalled();
    expect(mockRecordFulfillmentPreview).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["shipping_address_required", "shipping_address_unsupported", "shipping_address_restricted"])(
    "does not save a new address when the Checkout pre-call returns %s",
    async (code) => {
      const createShippingAddress = vi.fn(async () => ({ id: "adr_new_checkout" }));
      mockResolveActorFromAuthApi.mockResolvedValue({
        accountId: "acc_buyer",
        roleKey: "owner",
        permissions: ["accounts.view", "accounts.manage"],
      });
      mockCreateIdentityRequestApiClient.mockReturnValue({ createShippingAddress });
      mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
      mockSelectShippingAddress.mockRejectedValue(
        new MockCheckoutApiError(400, { error: { code, message: "Address refused by Checkout." } }),
      );
      mockCreateCheckoutRequestApiClient.mockReturnValue({
        getCheckoutSession: mockGetCheckoutSession,
        listSellListShipFromAddresses: mockListSellListShipFromAddresses,
        selectShippingAddress: mockSelectShippingAddress,
        selectShippingOption: mockSelectShippingOption,
        selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
        confirmCheckoutSession: mockConfirmCheckoutSession,
      });
      mockListSellListShipFromAddresses.mockResolvedValue({ items: [] });

      const form = new URLSearchParams({
        intent: "confirm-checkout",
        shippingOption: "standard",
        addressBookAction: "save-new",
        paymentMethodCategory: "card",
        previewPaymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
        shippingName: "Jane Smith",
        shippingLine1: "100 Market Street",
        shippingCity: "Chicago",
        shippingState: "IL",
        shippingPostalCode: "60601",
        shippingCountry: "US",
      });

      const response = (await checkoutSessionAction({
        request: new Request("http://localhost/checkout/buy/session/chk_1", {
          method: "POST",
          body: form,
        }),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never)) as { error: string; editSection: string };

      expect(response.editSection).toBe("delivery");
      expect(mockSelectShippingAddress).toHaveBeenCalledTimes(1);
      expect(createShippingAddress).not.toHaveBeenCalled();
      expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
    },
  );

  it("does not update a selected address when the Checkout pre-call refuses it", async () => {
    const updateShippingAddress = vi.fn(async () => undefined);
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["accounts.view", "accounts.manage"],
    });
    mockCreateIdentityRequestApiClient.mockReturnValue({ updateShippingAddress });
    mockListSellListShipFromAddresses.mockResolvedValue({
      items: [
        {
          shipping_address_id: "adr_home",
          account_id: "acc_buyer",
          label: "Home",
          recipient_name: "Jane Smith",
          company: null,
          line1: "100 Market Street",
          line2: null,
          city: "Chicago",
          state: "IL",
          postal_code: "60601",
          country: "US",
          phone: null,
          email: null,
          is_default: true,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockSelectShippingAddress.mockRejectedValue(
      new MockCheckoutApiError(400, {
        error: { code: "shipping_address_restricted", message: "Address refused by Checkout." },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      selectShippingAddress: mockSelectShippingAddress,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams({
      intent: "confirm-checkout",
      shippingOption: "standard",
      shippingAddressId: "adr_home",
      addressBookAction: "update-selected",
      paymentMethodCategory: "card",
      previewPaymentMethodCategory: "card",
      marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
      shippingName: "Jane Smith",
      shippingLine1: "100 Market Street",
      shippingCity: "Chicago",
      shippingState: "IL",
      shippingPostalCode: "60601",
      shippingCountry: "US",
    });

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", { method: "POST", body: form }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as { error: string; editSection: string };

    expect(response.editSection).toBe("delivery");
    expect(mockSelectShippingAddress).toHaveBeenCalledTimes(1);
    expect(updateShippingAddress).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("pre-calls Checkout before saving a new accepted address and confirming", async () => {
    const createShippingAddress = vi.fn(async () => ({ id: "adr_new_checkout" }));
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["accounts.view", "accounts.manage"],
    });
    mockCreateIdentityRequestApiClient.mockReturnValue({ createShippingAddress });
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockSelectShippingAddress.mockResolvedValue({});
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      selectShippingAddress: mockSelectShippingAddress,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });
    mockListSellListShipFromAddresses.mockResolvedValue({ items: [] });

    const form = new URLSearchParams({
      intent: "confirm-checkout",
      shippingOption: "standard",
      addressBookAction: "save-new",
      paymentMethodCategory: "card",
      previewPaymentMethodCategory: "card",
      marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
      shippingName: "Jane Smith",
      shippingLine1: "100 Market Street",
      shippingCity: "Chicago",
      shippingState: "IL",
      shippingPostalCode: "60601",
      shippingCountry: "US",
    });

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", { method: "POST", body: form }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(mockSelectShippingAddress.mock.invocationCallOrder[0]).toBeLessThan(
      createShippingAddress.mock.invocationCallOrder[0],
    );
    expect(createShippingAddress.mock.invocationCallOrder[0]).toBeLessThan(
      mockConfirmCheckoutSession.mock.invocationCallOrder[0],
    );
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({ shippingAddress: expect.objectContaining({ shippingAddressId: "adr_new_checkout" }) }),
    );
  });

  it("pre-calls and reselects a saved new address around the review refresh", async () => {
    const createShippingAddress = vi.fn(async () => ({ id: "adr_new_checkout" }));
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["accounts.view", "accounts.manage"],
    });
    mockCreateIdentityRequestApiClient.mockReturnValue({ createShippingAddress });
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockSelectShippingAddress.mockResolvedValue({});
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectAuthenticityCheckOptIn.mockResolvedValue({});
    mockRecordFulfillmentPreview.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      selectShippingAddress: mockSelectShippingAddress,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      recordFulfillmentPreview: mockRecordFulfillmentPreview,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });
    mockListSellListShipFromAddresses.mockResolvedValue({ items: [] });

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        body: confirmCheckoutForm({
          addressBookAction: "save-new",
          previewPaymentMethodCategory: "bank-account",
        }),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(mockSelectShippingAddress).toHaveBeenCalledTimes(2);
    expect(mockSelectShippingAddress.mock.invocationCallOrder[0]).toBeLessThan(
      createShippingAddress.mock.invocationCallOrder[0],
    );
    expect(createShippingAddress.mock.invocationCallOrder[0]).toBeLessThan(
      mockSelectShippingAddress.mock.invocationCallOrder[1],
    );
    expect(mockSelectShippingAddress).toHaveBeenLastCalledWith("chk_1", {
      shippingAddress: expect.objectContaining({ shippingAddressId: "adr_new_checkout" }),
    });
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("pre-calls and reselects a saved new address when only a payment quote is needed", async () => {
    const createShippingAddress = vi.fn(async () => ({ id: "adr_new_checkout" }));
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["accounts.view", "accounts.manage"],
    });
    mockCreateIdentityRequestApiClient.mockReturnValue({ createShippingAddress });
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockSelectShippingAddress.mockResolvedValue({});
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectAuthenticityCheckOptIn.mockResolvedValue({});
    mockRecordFulfillmentPreview.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      selectShippingAddress: mockSelectShippingAddress,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      recordFulfillmentPreview: mockRecordFulfillmentPreview,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });
    mockListSellListShipFromAddresses.mockResolvedValue({ items: [] });

    const form = confirmCheckoutForm({ addressBookAction: "save-new" });
    form.delete("marketplaceCheckoutFeeQuoteFingerprint");
    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", { method: "POST", body: form }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(mockSelectShippingAddress).toHaveBeenCalledTimes(2);
    expect(mockSelectShippingAddress.mock.invocationCallOrder[0]).toBeLessThan(
      createShippingAddress.mock.invocationCallOrder[0],
    );
    expect(createShippingAddress.mock.invocationCallOrder[0]).toBeLessThan(
      mockSelectShippingAddress.mock.invocationCallOrder[1],
    );
    expect(mockSelectShippingAddress).toHaveBeenLastCalledWith("chk_1", {
      shippingAddress: expect.objectContaining({ shippingAddressId: "adr_new_checkout" }),
    });
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("pre-calls and reselects an updated address around the review refresh", async () => {
    const updateShippingAddress = vi.fn(async () => undefined);
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["accounts.view", "accounts.manage"],
    });
    mockCreateIdentityRequestApiClient.mockReturnValue({ updateShippingAddress });
    mockListSellListShipFromAddresses.mockResolvedValue({
      items: [
        {
          shipping_address_id: "adr_home",
          account_id: "acc_buyer",
          label: "Home",
          recipient_name: "Jane Smith",
          company: null,
          line1: "100 Market Street",
          line2: null,
          city: "Chicago",
          state: "IL",
          postal_code: "60601",
          country: "US",
          phone: null,
          email: null,
          is_default: true,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockSelectShippingAddress.mockResolvedValue({});
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectAuthenticityCheckOptIn.mockResolvedValue({});
    mockRecordFulfillmentPreview.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      selectShippingAddress: mockSelectShippingAddress,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      recordFulfillmentPreview: mockRecordFulfillmentPreview,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        body: confirmCheckoutForm({
          shippingAddressId: "adr_home",
          addressBookAction: "update-selected",
          previewPaymentMethodCategory: "bank-account",
        }),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(mockSelectShippingAddress).toHaveBeenCalledTimes(2);
    expect(mockSelectShippingAddress).toHaveBeenNthCalledWith(1, "chk_1", {
      shippingAddress: expect.objectContaining({ shippingAddressId: "adr_home" }),
    });
    expect(mockSelectShippingAddress).toHaveBeenLastCalledWith("chk_1", {
      shippingAddress: expect.objectContaining({ shippingAddressId: "adr_home" }),
    });
    expect(mockSelectShippingAddress.mock.invocationCallOrder[0]).toBeLessThan(
      updateShippingAddress.mock.invocationCallOrder[0],
    );
    expect(updateShippingAddress.mock.invocationCallOrder[0]).toBeLessThan(
      mockSelectShippingAddress.mock.invocationCallOrder[1],
    );
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns a generic error for a pre-call address-choice response without saving", async () => {
    const createShippingAddress = vi.fn(async () => ({ id: "adr_new_checkout" }));
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["accounts.view", "accounts.manage"],
    });
    mockCreateIdentityRequestApiClient.mockReturnValue({ createShippingAddress });
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockSelectShippingAddress.mockRejectedValue(
      new MockCheckoutApiError(409, { error: { code: "address_standardization_suggested" } }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      selectShippingAddress: mockSelectShippingAddress,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });
    mockListSellListShipFromAddresses.mockResolvedValue({ items: [] });

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        body: confirmCheckoutForm({ addressBookAction: "save-new" }),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as { error: string };

    expect(response.error).toBe("Checkout API error 409");
    expect(createShippingAddress).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns an expired handoff before a pending address-book write", async () => {
    const createShippingAddress = vi.fn(async () => ({ id: "adr_new_checkout" }));
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["accounts.view", "accounts.manage"],
    });
    mockCreateIdentityRequestApiClient.mockReturnValue({ createShippingAddress });
    mockGetCheckoutSession.mockResolvedValue({
      source_type: "cart",
      payment_id: null,
      order_ids: [],
      handoff_expires_at: "2000-01-01T00:00:00Z",
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });
    mockListSellListShipFromAddresses.mockResolvedValue({ items: [] });

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        body: confirmCheckoutForm({ addressBookAction: "save-new" }),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as { code: string };

    expect(response.code).toBe("checkout_expired");
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
    expect(createShippingAddress).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("does not confirm after an accepted pre-call when Identity persistence fails", async () => {
    const createShippingAddress = vi.fn(async () => {
      throw new Error("Identity unavailable");
    });
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["accounts.view", "accounts.manage"],
    });
    mockCreateIdentityRequestApiClient.mockReturnValue({ createShippingAddress });
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockSelectShippingAddress.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });
    mockListSellListShipFromAddresses.mockResolvedValue({ items: [] });

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        body: confirmCheckoutForm({ addressBookAction: "save-new" }),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as { error: string };

    expect(response.error).toBe("Identity unavailable");
    expect(mockSelectShippingAddress).toHaveBeenCalledTimes(1);
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("skips the pre-call but saves a pending address on a committed session", async () => {
    const createShippingAddress = vi.fn(async () => ({ id: "adr_new_checkout" }));
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["accounts.view", "accounts.manage"],
    });
    mockCreateIdentityRequestApiClient.mockReturnValue({ createShippingAddress });
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: "pay_1", order_ids: ["ord_1"] });
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });
    mockListSellListShipFromAddresses.mockResolvedValue({ items: [] });

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        body: confirmCheckoutForm({ addressBookAction: "save-new" }),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
    expect(createShippingAddress).toHaveBeenCalledTimes(1);
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({ shippingAddress: expect.objectContaining({ shippingAddressId: "adr_new_checkout" }) }),
    );
  });

  it("only Pay commits a fresh checkout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
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
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1");
  });

  it("forwards visible fulfillment preview acknowledgement to checkout confirmation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
    form.set("fulfillmentPreviewRevision", "fulfillment_rev_visible");
    form.set("acknowledgedMaterialChanges", "true");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1?review=updated", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        fulfillmentPreviewRevision: "fulfillment_rev_visible",
        acknowledgedMaterialChanges: true,
      }),
    );
  });

  it("preserves payment freshness metadata on the confirmation handoff", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({
      payment_id: "pay_1",
      order_ids: ["ord_1"],
      status: "confirmed",
      commitPosition: "84",
      commitEventIds: ["evt_payment_created"],
      commitPositions: [
        {
          sourceContextName: "payments",
          maxGlobalPosition: "84",
          eventIds: ["evt_payment_created"],
        },
      ],
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "priority");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_card_1");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location");
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(location, "/checkout/buy/session/chk_1?postWriteToken=");
    expect((await readResolvedFreshWriteToken(location))?.sources).toEqual([
      {
        sourceContextName: "payments",
        maxGlobalPosition: "84",
        eventIds: ["evt_payment_created"],
      },
    ]);
  });

  it("starts payment from checkout review for accelerated saved-payment confirmation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
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
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1/confirmation");
  });

  it("keeps reviewed totals actionable when Pay now saves a manual address to the address book", async () => {
    const createShippingAddress = vi.fn(async () => ({ id: "adr_new_checkout" }));
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["accounts.view", "accounts.manage"],
    });
    mockCreateIdentityRequestApiClient.mockReturnValue({
      createShippingAddress,
    });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("reviewedShippingOption", "standard");
    form.set("addressBookAction", "save-new");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set(
      "marketplaceCheckoutFeeQuoteFingerprint",
      "marketplace-checkout-fee-v1|card|9.99|0.00|10.99|0.64|11.63|11.63",
    );
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");
    form.set(
      "reviewedShippingAddressSignature",
      JSON.stringify({
        name: "Jane Smith",
        company: "",
        line1: "100 Market Street",
        line2: "",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        phone: "",
        email: "",
      }),
    );

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(createShippingAddress).toHaveBeenCalledWith(
      "acc_buyer",
      expect.objectContaining({
        name: "Jane Smith",
        postalCode: "60601",
      }),
    );
    expect(mockSelectShippingAddress).toHaveBeenCalledWith("chk_1", {
      shippingAddress: expect.objectContaining({
        shippingAddressId: null,
        line1: "100 Market Street",
      }),
    });
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|9.99|0.00|10.99|0.64|11.63|11.63",
        shippingAddress: expect.objectContaining({
          shippingAddressId: "adr_new_checkout",
          line1: "100 Market Street",
          postalCode: "60601",
        }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1");
  });

  it("starts payment when a trusted-step saved instrument is selected", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
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
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1");
  });

  it("rejects guest saved checkout instruments before checkout mutations", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectShippingAddress.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
    form.set("savedCheckoutInstrumentId", "sci_guest_card");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as { error: string };

    expect(response).toEqual({
      error: "Saved payment methods are available after sign-in. Continue with card payment.",
    });
    expect(mockSelectShippingOption).not.toHaveBeenCalled();
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects guest save-payment requests before checkout mutations", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectShippingAddress.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
    form.set("savePaymentMethodForFuture", "true");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as { error: string };

    expect(response).toEqual({
      error: "Saved payment methods are available after sign-in. Continue with card payment.",
    });
    expect(mockSelectShippingOption).not.toHaveBeenCalled();
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it.each([
    ["shipping_address_required", "Enter a shipping address before continuing to payment."],
    ["shipping_address_unsupported", "Use a supported US delivery address before continuing to payment."],
    [
      "shipping_address_restricted",
      "Use a street address before continuing to payment. PO boxes are not supported for this shipping service.",
    ],
  ] as const)("maps a Checkout API refusal for %s to a delivery correction", async (code, error) => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectShippingAddress.mockResolvedValue({});
    mockConfirmCheckoutSession.mockRejectedValue(
      new MockCheckoutApiError(400, { error: { code, message: "Address refused by Checkout." } }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as { error: string; editSection: string };

    expect(response).toEqual({
      error,
      editSection: "delivery",
    });
    expect(mockSelectShippingOption).toHaveBeenCalledWith("chk_1", { shippingOption: "standard" });
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["shipping_address_required", "Enter a shipping address before continuing to payment."],
    ["shipping_address_unsupported", "Use a supported US delivery address before continuing to payment."],
    [
      "shipping_address_restricted",
      "Use a street address before continuing to payment. PO boxes are not supported for this shipping service.",
    ],
  ] as const)("maps a Checkout API refusal during refresh for %s to a delivery correction", async (code, error) => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectShippingAddress.mockRejectedValue(
      new MockCheckoutApiError(400, { error: { code, message: "Address refused by Checkout." } }),
    );
    mockGetCheckoutSession.mockResolvedValue(checkoutSessionForReviewedPreview());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      selectShippingAddress: mockSelectShippingAddress,
    });

    const form = new URLSearchParams();
    form.set("intent", "refresh-checkout-preview");
    form.set("shippingOption", "standard");
    form.set("previewPaymentMethodCategory", "card");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as { error: string; editSection: string };

    expect(response).toEqual({ error, editSection: "delivery" });
    expect(mockSelectShippingOption).toHaveBeenCalledWith("chk_1", { shippingOption: "standard" });
    expect(mockSelectShippingAddress).toHaveBeenCalledTimes(1);
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("maps checkout API delivery failures to customer-safe correction copy", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockRejectedValue(
      new MockCheckoutApiError(400, {
        error: {
          code: "shipping_address_unsupported",
          message: "Provider rejected raw delivery destination 96910.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as { error: string; editSection: string };

    expect(response).toEqual({
      error: "Use a supported US delivery address before continuing to payment.",
      editSection: "delivery",
    });
    expect(JSON.stringify(response)).not.toContain("96910");
    expect(mockSelectShippingOption).toHaveBeenCalledWith("chk_1", {
      shippingOption: "standard",
    });
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        shippingAddress: expect.objectContaining({
          line1: "100 Market Street",
        }),
      }),
    );
  });

  it("returns shipping correction before checkout mutations when the shipping method is unavailable", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockRejectedValue(
      new MockCheckoutApiError(400, {
        error: {
          code: "shipping_option_unavailable",
          message: "Provider rejected raw shipping service drone.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "drone");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as { error: string; editSection: string };

    expect(response).toEqual({
      error: "Choose an available shipping method before continuing.",
      editSection: "shipping",
    });
    expect(JSON.stringify(response)).not.toContain("drone");
    expect(mockSelectShippingOption).toHaveBeenCalledWith("chk_1", {
      shippingOption: "drone",
    });
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns cart recovery when active checkout readiness is stale during review refresh", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockRejectedValue(
      new MockCheckoutApiError(400, {
        error: {
          code: "readiness_snapshot_stale",
          message: "Cart readiness changed. Review your cart before checkout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionAction({
        request: new Request("http://localhost/checkout/buy/session/chk_1", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(400);
    expect(recoveryResponse?.statusText).toBe("Checkout needs attention");
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      kind?: string;
      primaryAction?: { href?: string; label?: string };
      trustCue?: string;
    };
    expect(recoveryBody.kind).toBe("request-validation");
    expect(recoveryBody.primaryAction?.href).toBe("/account/cart");
    expect(recoveryBody.primaryAction?.label).toBe("View Buy Cart");
    expect(recoveryBody.trustCue).toBe("Your payment has not started.");
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns cart recovery when split-group handoff is stale during confirmation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockRejectedValue(
      new MockCheckoutApiError(400, {
        error: {
          code: "split_group_handoff_stale",
          message: "Checkout groups changed. Review your cart before checkout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionAction({
        request: new Request("http://localhost/checkout/buy/session/chk_1", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(400);
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      kind?: string;
      primaryAction?: { href?: string };
      trustCue?: string;
    };
    expect(recoveryBody.kind).toBe("request-validation");
    expect(recoveryBody.primaryAction?.href).toBe("/account/cart");
    expect(recoveryBody.trustCue).toBe("Your payment has not started.");
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
      }),
    );
  });

  it("refreshes checkout review when confirmation is missing the payment quote", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectShippingAddress.mockResolvedValue({});
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
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
      "/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated&quote=required",
    );
  });

  it.each(["payment_quote_required", "fee_quote_stale"])(
    "refreshes checkout review when confirmation reports %s",
    async (errorCode) => {
      mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
      mockSelectShippingOption.mockResolvedValue({});
      mockConfirmCheckoutSession.mockRejectedValue(
        new MockCheckoutApiError(409, {
          error: {
            code: errorCode,
            message: "Review the latest payable total before payment starts.",
          },
          commitPosition: "77",
          commitEventIds: ["evt_checkout_orders_created"],
          commitPositions: [
            {
              sourceContextName: "checkout",
              maxGlobalPosition: "77",
              eventIds: ["evt_checkout_orders_created"],
            },
          ],
        }),
      );
      mockCreateCheckoutRequestApiClient.mockReturnValue({
        selectShippingOption: mockSelectShippingOption,
        selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
        confirmCheckoutSession: mockConfirmCheckoutSession,
      });

      const form = new URLSearchParams();
      form.set("intent", "confirm-checkout");
      form.set("shippingOption", "standard");
      form.set("paymentMethodCategory", "card");
      form.set("previewPaymentMethodCategory", "card");
      form.set(
        "marketplaceCheckoutFeeQuoteFingerprint",
        "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
      );
      form.set("shippingName", "Jane Smith");
      form.set("shippingLine1", "100 Market Street");
      form.set("shippingCity", "Chicago");
      form.set("shippingState", "IL");
      form.set("shippingPostalCode", "60601");
      form.set("shippingCountry", "US");

      const response = (await checkoutSessionAction({
        request: new Request("http://localhost/checkout/buy/session/chk_1", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never)) as Response;

      expect(response.status).toBe(302);
      const location = response.headers.get("Location") ?? "";
      const receipt = await readResolvedFreshWriteToken(location);
      expectCompactPostWriteLocation(
        location,
        "/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated&quote=required&postWriteToken=",
      );
      expect(receipt?.commitPosition).toBe("77");
      expect(receipt?.sources).toEqual([
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "77",
          eventIds: ["evt_checkout_orders_created"],
        },
      ]);
      expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
        "chk_1",
        expect.objectContaining({
          marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
        }),
      );
    },
  );

  it("refreshes checkout review when payment start is waiting on newly created orders", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockRejectedValue(
      new MockCheckoutApiError(409, {
        error: {
          code: "payment_start_pending",
          message: "Payment setup is still catching up. Review checkout again before payment starts.",
        },
        commitPosition: "77",
        commitEventIds: ["evt_order_created", "evt_checkout_orders_created"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "77",
            eventIds: ["evt_checkout_orders_created"],
          },
          {
            sourceContextName: "ordering",
            maxGlobalPosition: "42",
            eventIds: ["evt_order_created"],
          },
        ],
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set(
      "marketplaceCheckoutFeeQuoteFingerprint",
      "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
    );
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    const receipt = await readResolvedFreshWriteToken(location);
    expectCompactPostWriteLocation(
      location,
      "/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated&resumePaymentStart=1&postWriteToken=",
    );
    expect(receipt?.commitPosition).toBeUndefined();
    expect(receipt?.sources).toEqual([
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "77",
        eventIds: ["evt_checkout_orders_created"],
      },
      {
        sourceContextName: "ordering",
        maxGlobalPosition: "42",
        eventIds: ["evt_order_created"],
      },
    ]);
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
      }),
    );
  });

  it("retries payment start without editing shipping once checkout orders are committed", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockGetCheckoutSession.mockResolvedValue(
      checkoutSessionForReviewedPreview({ order_ids: ["ord_1"], payment_id: null }),
    );
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set(
      "marketplaceCheckoutFeeQuoteFingerprint",
      "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
    );
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const orderingCommit = {
      commitEventIds: ["evt_order_created"],
      commitPositions: [
        {
          sourceContextName: "ordering",
          maxGlobalPosition: "42",
          eventIds: ["evt_order_created"],
        },
      ],
    };
    const requestPath = appendFreshWriteTokenFromSources(
      "/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated",
      [checkoutCommit("40", "evt_prior_review"), orderingCommit],
    );
    const response = (await checkoutSessionAction({
      request: new Request(`http://localhost${requestPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(mockSelectShippingOption).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith("chk_1", {
      requestedBalanceCreditAmount: null,
      paymentMethodCategory: "card",
      marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
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
        email: null,
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1");
  });

  it("retries payment start when the checkout review compact post-write token expired", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockGetCheckoutSession.mockResolvedValue(
      checkoutSessionForReviewedPreview({ order_ids: ["ord_1"], payment_id: null }),
    );
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set(
      "marketplaceCheckoutFeeQuoteFingerprint",
      "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
    );
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await checkoutSessionAction({
      request: new Request(
        "http://localhost/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated&postWriteToken=pwt_expiredMissing1",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        },
      ),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(mockSelectShippingOption).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1");
  });

  it("committed continuation keeps identity", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockGetCheckoutSession.mockResolvedValue(
      checkoutSessionForReviewedPreview({ order_ids: ["ord_1"], payment_id: null }),
    );
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      selectShippingAddress: mockSelectShippingAddress,
      recordFulfillmentPreview: mockRecordFulfillmentPreview,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("reviewedShippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const orderingCommit = {
      commitEventIds: ["evt_order_created"],
      commitPositions: [
        {
          sourceContextName: "ordering",
          maxGlobalPosition: "42",
          eventIds: ["evt_order_created"],
        },
      ],
    };
    const requestPath = appendFreshWriteTokenFromSources(
      "/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated",
      [checkoutCommit("40", "evt_prior_review"), orderingCommit],
    );
    const response = (await checkoutSessionAction({
      request: new Request(`http://localhost${requestPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(mockSelectShippingOption).not.toHaveBeenCalled();
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
    expect(mockRecordFulfillmentPreview).not.toHaveBeenCalled();
    const readApiRequest = mockCreateCheckoutRequestApiClient.mock.calls[0]?.[0] as Request;
    expect(readFreshWriteToken(readApiRequest)?.sources).toEqual([
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "40",
        eventIds: ["evt_prior_review"],
      },
      {
        sourceContextName: "ordering",
        maxGlobalPosition: "42",
        eventIds: ["evt_order_created"],
      },
    ]);
    const writeApiRequest = mockCreateCheckoutRequestApiClient.mock.calls[1]?.[0] as Request;
    expect(new URL(writeApiRequest.url).searchParams.has("afterWrite")).toBe(false);
    expect(writeApiRequest.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
    const confirmApiRequest = mockCreateCheckoutRequestApiClient.mock.calls[2]?.[0] as Request;
    const confirmReceipt = readFreshWriteToken(confirmApiRequest);
    expect(confirmReceipt?.sources).toEqual([
      {
        sourceContextName: "ordering",
        maxGlobalPosition: "42",
        eventIds: ["evt_order_created"],
      },
    ]);
    expect(confirmApiRequest.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        marketplaceCheckoutFeeQuoteFingerprint: null,
        paymentMethodCategory: "card",
        shippingAddress: expect.objectContaining({
          name: "Jane Smith",
          postalCode: "60601",
        }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1");
  });

  it("starts payment from a reviewed checkout even when the payment-start retry has no fresh-write token", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockGetCheckoutSession.mockResolvedValue(
      checkoutSessionForReviewedPreview({ order_ids: ["ord_1"], payment_id: null }),
    );
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      selectShippingAddress: mockSelectShippingAddress,
      recordFulfillmentPreview: mockRecordFulfillmentPreview,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "standard");
    form.set("reviewedShippingOption", "standard");
    form.set("paymentMethodCategory", "card");
    form.set("previewPaymentMethodCategory", "card");
    form.set(
      "marketplaceCheckoutFeeQuoteFingerprint",
      "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
    );
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");
    form.set(
      "reviewedShippingAddressSignature",
      JSON.stringify({
        name: "Jane Smith",
        company: "",
        line1: "100 Market Street",
        line2: "",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        phone: "",
        email: "",
      }),
    );

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(mockSelectShippingOption).not.toHaveBeenCalled();
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
    expect(mockRecordFulfillmentPreview).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
        paymentMethodCategory: "card",
        shippingAddress: expect.objectContaining({
          name: "Jane Smith",
          postalCode: "60601",
        }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1");
  });

  it("revalidates an unavailable wallet with incomplete edited fields without writing or starting payment", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    const form = new URLSearchParams({
      intent: "retry-wallet-balance",
      shippingEmail: "edited-buyer@example.com",
      shippingName: "Edited Buyer",
      shippingLine1: "100 Market Street",
      shippingPhone: "3125550100",
    });

    const response = await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(response).toBeNull();
    expect(mockCreateCheckoutRequestApiClient).not.toHaveBeenCalled();
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
    expect(mockSelectShippingOption).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("refreshes checkout totals by saving the current shipping address without confirming", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectShippingAddress.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      selectShippingAddress: mockSelectShippingAddress,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "refresh-checkout-preview");
    form.set("shippingOption", "expedited");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingLine2", "Suite 7");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");
    form.set("shippingEmail", "edited-buyer@example.com");
    form.set("shippingPhone", "3125550100");
    form.set("previewPaymentMethodCategory", "bank-account");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
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
        line1: "100 Market Street",
        line2: "Suite 7",
        postalCode: "60601",
        email: "edited-buyer@example.com",
        phone: "3125550100",
      }),
    });
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1?paymentMethodCategory=bank-account");
  });

  it("records the reviewed fulfillment preview revision when refreshing checkout totals", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    mockGetCheckoutSession.mockResolvedValue(checkoutSessionForReviewedPreview());
    mockSelectShippingOption.mockResolvedValue(checkoutCommit("41", "evt_shipping_option"));
    mockSelectShippingAddress.mockResolvedValue(checkoutCommit("42", "evt_shipping_address"));
    mockRecordFulfillmentPreview.mockResolvedValue(checkoutCommit("43", "evt_fulfillment_preview"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      selectShippingAddress: mockSelectShippingAddress,
      recordFulfillmentPreview: mockRecordFulfillmentPreview,
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
    form.set("previewPaymentMethodCategory", "card");

    const response = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;
    const location = response.headers.get("Location") ?? "";
    const receipt = await readResolvedFreshWriteToken(location);

    expect(mockGetCheckoutSession).toHaveBeenCalledWith("chk_1");
    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockRecordFulfillmentPreview).toHaveBeenCalledWith("chk_1", {
      shippingOption: "expedited",
      shippingAddress: expect.objectContaining({ postalCode: "60601" }),
    });
    const checkoutApiRequest = mockCreateCheckoutRequestApiClient.mock.calls[0]?.[0] as Request;
    expect(new URL(checkoutApiRequest.url).searchParams.has("afterWrite")).toBe(false);
    expect(mockCreateOrderingRequestApiClient).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(location, "/checkout/buy/session/chk_1?paymentMethodCategory=card&postWriteToken=");
    expect(receipt?.commitPosition).toBe("43");
    expect(receipt?.sources).toEqual([
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "43",
        eventIds: ["evt_shipping_option", "evt_shipping_address", "evt_fulfillment_preview"],
      },
    ]);
  });

  it("refreshes guest checkout totals with a fresh-write redirect token", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockSelectShippingOption.mockResolvedValue(checkoutCommit("41", "evt_shipping_option"));
    mockSelectShippingAddress.mockResolvedValue(checkoutCommit("42", "evt_shipping_address"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;
    const location = response.headers.get("Location") ?? "";
    const receipt = await readResolvedFreshWriteToken(location);

    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(location, "/checkout/buy/session/chk_1?paymentMethodCategory=card&postWriteToken=");
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
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
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
      "/checkout/buy/session/chk_1?paymentMethodCategory=bank-account&review=updated",
    );
  });

  it("refreshes checkout review instead of confirming when submitted shipping differs from the visible preview", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    mockSelectShippingOption.mockResolvedValue({});
    mockSelectShippingAddress.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
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
    expect(response.headers.get("Location")).toBe(
      "/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated",
    );
  });

  it("keeps checkout review refresh fallback freshness-aware", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    mockSelectShippingOption.mockResolvedValue(checkoutCommit("43", "evt_shipping_option"));
    mockSelectShippingAddress.mockResolvedValue(checkoutCommit("44", "evt_shipping_address"));
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;
    const location = response.headers.get("Location") ?? "";
    const receipt = await readResolvedFreshWriteToken(location);

    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(
      location,
      "/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated&postWriteToken=",
    );
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

  it("records the reviewed fulfillment preview revision when confirmation refreshes checkout review", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    mockSelectShippingOption.mockResolvedValue(checkoutCommit("51", "evt_shipping_option"));
    mockSelectShippingAddress.mockResolvedValue(checkoutCommit("52", "evt_shipping_address"));
    mockGetCheckoutSession.mockResolvedValue(checkoutSessionForReviewedPreview());
    mockRecordFulfillmentPreview.mockResolvedValue(checkoutCommit("53", "evt_fulfillment_preview"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      selectShippingAddress: mockSelectShippingAddress,
      recordFulfillmentPreview: mockRecordFulfillmentPreview,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "priority");
    form.set("reviewedShippingOption", "standard");
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;
    const location = response.headers.get("Location") ?? "";
    const receipt = await readResolvedFreshWriteToken(location);

    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockRecordFulfillmentPreview).toHaveBeenCalledWith("chk_1", {
      shippingOption: "priority",
      shippingAddress: expect.objectContaining({ postalCode: "60601" }),
    });
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(
      location,
      "/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated&postWriteToken=",
    );
    expect(receipt?.commitPosition).toBe("53");
    expect(receipt?.sources).toEqual([
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "53",
        eventIds: ["evt_shipping_option", "evt_shipping_address", "evt_fulfillment_preview"],
      },
    ]);
  });

  it("keeps guest payment entry inline on checkout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"] });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1");
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith("chk_1", expect.objectContaining({}));
  });

  it("redirects confirmed purchase intent to the submitted offer", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({
      offer_id: "off_chk_1",
      status: "purchase-intent-submitted",
      commitPosition: "44",
      commitEventIds: ["evt_checkout_offer_submitted", "evt_marketplace_offer_submitted"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "44",
          eventIds: ["evt_checkout_offer_submitted"],
        },
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "43",
          eventIds: ["evt_marketplace_offer_submitted"],
        },
      ],
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
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
    const location = response.headers.get("Location") ?? "";
    expectCompactPostWriteLocation(location, "/account/offers/submitted/off_chk_1?postWriteToken=");
    expect((await readResolvedFreshWriteToken(location))?.sources).toEqual([
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "44",
        eventIds: ["evt_checkout_offer_submitted"],
      },
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "43",
        eventIds: ["evt_marketplace_offer_submitted"],
      },
    ]);
  });

  it("submits purchase intent instead of bouncing to review updated when shipping changed", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue(checkoutCommit("43", "evt_shipping_option"));
    mockGetCheckoutSession.mockResolvedValue({ source_type: "offer-intent", payment_id: null });
    mockConfirmCheckoutSession.mockResolvedValue({
      offer_id: "off_chk_1",
      status: "purchase-intent-submitted",
      commitPositions: [
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "44",
          eventIds: ["evt_marketplace_offer_submitted"],
        },
      ],
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expectCompactPostWriteLocation(location, "/account/offers/submitted/off_chk_1?postWriteToken=");
    expect((await readResolvedFreshWriteToken(location))?.sources).toEqual([
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "44",
        eventIds: ["evt_marketplace_offer_submitted"],
      },
    ]);
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        shippingAddress: expect.objectContaining({
          name: "Jane Smith",
          postalCode: "60601",
        }),
      }),
    );
  });

  it("submits purchase intent instead of bouncing to review updated when shipping changed", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockSelectShippingOption.mockResolvedValue(checkoutCommit("43", "evt_shipping_option"));
    mockGetCheckoutSession.mockResolvedValue({ source_type: "offer-intent", payment_id: null });
    mockConfirmCheckoutSession.mockResolvedValue({ offer_id: "off_chk_1", status: "purchase-intent-submitted" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/offers/submitted/off_chk_1");
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith(
      "chk_1",
      expect.objectContaining({
        shippingAddress: expect.objectContaining({
          name: "Jane Smith",
          postalCode: "60601",
        }),
      }),
    );
  });
});

describe("checkout session day-after confirm replay matrix", () => {
  const dayBefore = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
      selectShippingAddress: mockSelectShippingAddress,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      recordFulfillmentPreview: mockRecordFulfillmentPreview,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    // A covered handoff with no orders is past its window the day after; nothing is sent.
    ["no orders", () => ({ source_type: "buy-now", order_ids: [], handoff_expires_at: dayBefore() }), null, null],
    [
      "orders only",
      () => ({ order_ids: ["ord_1"] }),
      { payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" },
      "/checkout/buy/session/chk_1",
    ],
    [
      "payment started",
      () => ({ order_ids: ["ord_1"], payment_id: "pay_1" }),
      { payment_id: "pay_1", order_ids: ["ord_1"], status: "confirmed" },
      "/checkout/buy/session/chk_1",
    ],
    [
      "Offer submitted",
      () => ({ source_type: "offer-intent", submitted_offer_id: "off_1" }),
      { offer_id: "off_1", status: "purchase-intent-submitted" },
      "/account/offers/submitted/off_1",
    ],
    ["cancelled", () => ({ cancelled_at: dayBefore() }), null, "/checkout/buy/session/chk_1"],
  ] as const)(
    "replays the identical confirm a day later from %s with zero Checkout Session edits",
    async (_state, overrides, firstResult, destination) => {
      mockGetCheckoutSession.mockResolvedValue(checkoutSessionForReviewedPreview(overrides()));
      if (firstResult) mockConfirmCheckoutSession.mockResolvedValue(firstResult);

      const result = await checkoutSessionAction({
        request: new Request("http://localhost/checkout/buy/session/chk_1", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: confirmCheckoutForm().toString(),
        }),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);

      expect(mockSelectShippingOption).not.toHaveBeenCalled();
      expect(mockSelectShippingAddress).not.toHaveBeenCalled();
      expect(mockSelectAuthenticityCheckOptIn).not.toHaveBeenCalled();
      expect(mockRecordFulfillmentPreview).not.toHaveBeenCalled();
      // The Checkout owner answers a replay from the Session it already holds (route.test.ts covers its zero owner writes).
      expect(mockConfirmCheckoutSession).toHaveBeenCalledTimes(firstResult ? 1 : 0);
      if (destination) {
        expect((result as Response).status).toBe(302);
        expect(new URL((result as Response).headers.get("Location") ?? "", "http://localhost").pathname).toBe(
          destination,
        );
      } else {
        expect(result).toEqual({ code: "checkout_expired", error: expect.any(String) });
      }
    },
  );
});
