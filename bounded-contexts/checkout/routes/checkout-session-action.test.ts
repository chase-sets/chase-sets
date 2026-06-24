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
  mockPreviewCheckoutFulfillment,
  mockRecordFulfillmentPreview,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
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

describe("checkout web routes: checkout session action", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("confirms signed-in checkout and redirects to confirmation handoff", async () => {
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
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1/confirmation");
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
    expect(location).toContain("/checkout/buy/session/chk_1/confirmation?afterWrite=");
    expect(readFreshWriteToken(location ?? "")?.sources).toEqual([
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
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1/confirmation");
  });

  it("rejects guest saved checkout instruments before checkout mutations", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
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

  it("returns delivery correction before checkout mutations when the address is restricted", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
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
    form.set("previewPaymentMethodCategory", "card");
    form.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_1");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "PO Box 100");
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
      error: "Use a street address before continuing to payment. PO boxes are not supported for this shipping service.",
      editSection: "delivery",
    });
    expect(mockSelectShippingOption).not.toHaveBeenCalled();
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns delivery correction before checkout mutations when required address fields are missing", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
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

    expect(response).toEqual({
      error: "Enter a shipping address before continuing to payment.",
      editSection: "delivery",
    });
    expect(mockSelectShippingOption).not.toHaveBeenCalled();
    expect(mockSelectShippingAddress).not.toHaveBeenCalled();
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
        postalCode: "60601",
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
    mockPreviewCheckoutFulfillment.mockResolvedValue(reviewedFulfillmentPreview("fulfillment_rev_reviewed"));
    mockRecordFulfillmentPreview.mockResolvedValue(checkoutCommit("43", "evt_fulfillment_preview"));
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
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
    const receipt = readFreshWriteToken(location);

    expect(mockGetCheckoutSession).toHaveBeenCalledWith("chk_1");
    expect(mockPreviewCheckoutFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "chk_1",
        sourceType: "cart-checkout",
        shippingOption: "expedited",
        shippingAddress: expect.objectContaining({ postalCode: "60601" }),
      }),
    );
    expect(mockRecordFulfillmentPreview).toHaveBeenCalledWith("chk_1", {
      fulfillmentPreviewRevision: "fulfillment_rev_reviewed",
    });
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(location).toContain("/checkout/buy/session/chk_1?paymentMethodCategory=card&afterWrite=");
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
    const receipt = readFreshWriteToken(location);

    expect(response.status).toBe(302);
    expect(location).toContain("/checkout/buy/session/chk_1?paymentMethodCategory=card&afterWrite=");
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
    const receipt = readFreshWriteToken(location);

    expect(response.status).toBe(302);
    expect(location).toContain("/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated&afterWrite=");
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
    mockPreviewCheckoutFulfillment.mockResolvedValue(reviewedFulfillmentPreview("fulfillment_rev_visible_change"));
    mockRecordFulfillmentPreview.mockResolvedValue(checkoutCommit("53", "evt_fulfillment_preview"));
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      selectShippingOption: mockSelectShippingOption,
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
    const receipt = readFreshWriteToken(location);

    expect(mockPreviewCheckoutFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "chk_1",
        shippingOption: "priority",
        shippingAddress: expect.objectContaining({ postalCode: "60601" }),
      }),
    );
    expect(mockRecordFulfillmentPreview).toHaveBeenCalledWith("chk_1", {
      fulfillmentPreviewRevision: "fulfillment_rev_visible_change",
    });
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(location).toContain("/checkout/buy/session/chk_1?paymentMethodCategory=card&review=updated&afterWrite=");
    expect(receipt?.commitPosition).toBe("53");
    expect(receipt?.sources).toEqual([
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "53",
        eventIds: ["evt_shipping_option", "evt_shipping_address", "evt_fulfillment_preview"],
      },
    ]);
  });

  it("keeps guest checkout confirmation on the checkout confirmation handoff route", async () => {
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
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_1/confirmation");
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
    expect(location).toMatch(/^\/account\/offers\/submitted\/off_chk_1\?feedbackWorkflow=offer-submit&afterWrite=/);
    expect(readFreshWriteToken(location)?.sources).toEqual([
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
    expect(location).toMatch(/^\/account\/offers\/submitted\/off_chk_1\?feedbackWorkflow=offer-submit&afterWrite=/);
    expect(readFreshWriteToken(location)?.sources).toEqual([
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
    expect(response.headers.get("Location")).toBe("/account/offers/submitted/off_chk_1?feedbackWorkflow=offer-submit");
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
