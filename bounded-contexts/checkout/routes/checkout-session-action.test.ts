import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFreshWriteToken } from "@chase-sets/http/responses";
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
  mockCreateSettlementRequestApiClient,
  mockGetCheckoutSession,
  MockMarketplaceApiError,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockSelectShippingAddress,
  mockSelectShippingOption,
} from "./checkout-route-test-harness";

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

import { action as checkoutSessionAction } from "./checkout-session";

describe("checkout web routes: checkout session action", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    vi.clearAllMocks();
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
});
