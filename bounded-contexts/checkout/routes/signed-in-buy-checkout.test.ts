import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCompactPostWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
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
  mockCreateSettlementRequestApiClient,
  mockGetCheckoutPaymentConfirmation,
  mockGetCheckoutPaymentSummary,
  mockGetCheckoutSession,
  mockGetCheckoutStatus,
  MockMarketplaceApiError,
  mockListSellListShipFromAddresses,
  mockMergeGuestCartToAccount,
  mockPreviewCheckoutFulfillment,
  mockPreviewCheckoutStatus,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockSelectAuthenticityCheckOptIn,
  mockSelectShippingOption,
  mockStartGuestCheckout,
} from "../tests/support/checkout-route-test-harness";

const mockListSavedCheckoutInstruments = vi.fn();
const mockListCheckoutSavedPaymentInstruments = vi.fn();

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

vi.mock("@chase-sets/settlement/server", () => ({
  createSettlementRequestApiClient: mockCreateSettlementRequestApiClient,
}));

import { action as checkoutStartAction } from "./checkout-start";
import { action as checkoutSessionAction, loader as checkoutSessionLoader } from "./checkout-session";

const signedInBuyer = {
  accountId: "acc_buyer",
  roleKey: "owner",
  permissions: ["accounts.view", "accounts.manage", "orders.manage"],
};

function signedInCartSession() {
  return {
    session_id: "chk_signed_in",
    buyer_account_id: "acc_buyer",
    source_type: "cart",
    payment_id: null,
    submitted_offer_id: null,
    shipping_option: "standard",
    shipping_address: null,
    optimization_goal: "lowest-total",
    fulfillment_preview_revision: "fulfillment_rev_1",
    fulfillment_preview_snapshot: {
      revision: "fulfillment_rev_1",
      optimizationGoal: "lowest-total",
      readyLineKeys: ["cart_line_1"],
      unavailableLineKeys: [],
      unavailableLines: [],
      materialChangeReasons: [],
      sellerGroups: [],
      totals: {
        itemSubtotalAmount: "25.99",
        shippingAmount: "0.20",
        salesTaxAmount: "0.00",
        totalAmount: "26.19",
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
        itemTitle: "Acerola's Mischief",
        itemSubtitle: "Raw / Damaged",
        selectedOptions: [],
        productSummary: "Raw - Damaged",
        quantity: 1,
      },
    ],
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
  };
}

function signedInBuyNowCommittedOrderSession(paymentId: string | null = null) {
  return {
    session_id: "chk_signed_in",
    buyer_account_id: "acc_buyer",
    source_type: "buy-now",
    payment_id: paymentId,
    submitted_offer_id: null,
    shipping_option: "standard",
    shipping_address: {
      shippingAddressId: "adr_manual",
      name: "Jane Smith",
      company: "",
      line1: "100 Market Street",
      line2: "",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: "312-555-0100",
      email: "jane@example.com",
    },
    optimization_goal: "lowest-total",
    fulfillment_preview_revision: "fulfillment_rev_1",
    fulfillment_preview_snapshot: {
      revision: "fulfillment_rev_1",
      optimizationGoal: "lowest-total",
      readyLineKeys: ["cart_line_1"],
      unavailableLineKeys: [],
      unavailableLines: [],
      materialChangeReasons: [],
      sellerGroups: [],
      totals: {
        itemSubtotalAmount: "25.99",
        shippingAmount: "0.20",
        salesTaxAmount: "0.00",
        totalAmount: "26.19",
        packageCount: 1,
      },
    },
    order_ids: ["ord_signed_in_1"],
    order_write_commit_positions: [
      {
        sourceContextName: "ordering",
        maxGlobalPosition: "42",
        eventIds: ["evt_order_created"],
      },
    ],
    lines: [
      {
        listingId: "lst_1",
        cartLineId: null,
        catalogItemId: "cat_1",
        productId: "prd_1",
        itemTitle: "Acerola's Mischief",
        itemSubtitle: "Raw / Damaged",
        selectedOptions: [],
        productSummary: "Raw - Damaged",
        quantity: 1,
      },
    ],
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
  };
}

function mockSignedInSavedRows() {
  mockListSellListShipFromAddresses.mockResolvedValue({
    items: [
      {
        shipping_address_id: "adr_buyer",
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
        phone: "312-555-0100",
        email: "jane@example.com",
        is_default: true,
        updated_at: "2026-04-01T00:00:00.000Z",
      },
    ],
  });
  mockListCheckoutSavedPaymentInstruments.mockResolvedValue({
    items: [
      {
        instrument_id: "sci_card_1",
        payment_method_category: "card",
        display_label: "Visa ending in 4242",
        confirmation_experience: "off-session-token",
        readiness: "ready",
        is_default: true,
        removed_at: null,
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      },
    ],
  });
  mockCreatePaymentsRequestApiClient.mockReturnValue({
    previewCheckoutStatus: mockPreviewCheckoutStatus,
  });
}

function mockCheckoutPreview() {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ available_balance_amount: "0.00", currency_code: "usd" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  mockPreviewCheckoutFulfillment.mockResolvedValue({
    revision: "fulfillment_rev_1",
    readyLineKeys: ["lst_1"],
    unavailableLineKeys: [],
    unavailableLines: [],
    materialChangeReasons: [],
    sellerGroups: [
      {
        groupId: "fg_1",
        supportReference: "CHK-FG-1",
      },
    ],
    totals: {
      itemSubtotalAmount: "25.99",
      shippingAmount: "0.20",
      salesTaxAmount: "0.00",
      totalAmount: "26.19",
      packageCount: 1,
    },
  });
  mockPreviewCheckoutStatus.mockResolvedValue({
    amount: "26.19",
    marketplace_checkout_fee: {
      total_amount: "27.29",
      quote_fingerprint: "quote_card_1",
    },
    wallet_credit: { applied_amount: "0.00" },
  });
  mockCreateOrderingRequestApiClient.mockReturnValue({
    previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
  });
}

describe("checkout web routes: signed-in buy checkout", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
    mockResolveActorFromAuthApi.mockResolvedValue(signedInBuyer);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("proves signed-in Buy Cart reaches account payment with saved rows and fresh readiness", async () => {
    mockCreateCheckoutSession.mockResolvedValue({
      session_id: "chk_signed_in",
      ...checkoutCommit("42", "evt_checkout_session_started"),
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const startForm = new URLSearchParams();
    startForm.set("source", "cart");

    const startResponse = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: startForm.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;
    const startLocation = startResponse.headers.get("Location") ?? "";
    const startFreshReceipt = await readResolvedFreshWriteToken(startLocation);

    expect(startResponse.status).toBe(302);
    expectCompactPostWriteLocation(startLocation, "/checkout/buy/session/chk_signed_in?postWriteToken=");
    expect(startFreshReceipt?.sources).toEqual([
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "42",
        eventIds: ["evt_checkout_session_started"],
      },
    ]);
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "cart",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: null,
      },
    });
    expect(mockStartGuestCheckout).not.toHaveBeenCalled();
    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();

    mockSignedInSavedRows();
    mockCheckoutPreview();
    mockGetCheckoutSession.mockResolvedValue(signedInCartSession());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listCheckoutSavedPaymentInstruments: mockListCheckoutSavedPaymentInstruments,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    });

    const checkoutReview = await checkoutSessionLoader({
      request: new Request(`http://localhost${startLocation}`),
      params: { sessionId: "chk_signed_in" },
      context: undefined,
    } as never);

    expect(mockGetCheckoutSession).toHaveBeenCalledWith("chk_signed_in");
    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockPreviewCheckoutStatus).not.toHaveBeenCalled();
    expect(mockListCheckoutSavedPaymentInstruments).toHaveBeenCalled();
    expect(mockListSavedCheckoutInstruments).not.toHaveBeenCalled();
    expect(checkoutReview).toEqual(
      expect.objectContaining({
        isSignedInBuyer: true,
        canManageShippingAddresses: true,
        canSavePaymentMethods: true,
        selectedPaymentMethodCategory: "card",
        savedShippingAddresses: [
          expect.objectContaining({
            shipping_address_id: "adr_buyer",
            line1: "100 Market Street",
          }),
        ],
        savedCheckoutInstruments: [
          expect.objectContaining({
            id: "sci_card_1",
            readiness: "ready",
            payment_method_category: "card",
          }),
        ],
        paymentPreview: expect.objectContaining({
          marketplace_checkout_fee: expect.objectContaining({
            quote_fingerprint: "marketplace-checkout-fee-v1|card|26.19|0.00|26.19|1.10|27.29|27.29",
          }),
        }),
      }),
    );
    expect(JSON.stringify(checkoutReview)).not.toContain("4242424242424242");
    expect(JSON.stringify(checkoutReview)).not.toContain("cs_live");

    mockSelectShippingOption.mockResolvedValue(checkoutCommit("43", "evt_shipping_option_selected"));
    mockGetCheckoutSession.mockResolvedValue({ source_type: "cart", payment_id: null });
    mockConfirmCheckoutSession.mockResolvedValue({
      payment_id: "pay_signed_in_1",
      order_ids: ["ord_signed_in_1"],
      status: "confirmed",
      ...checkoutCommit("44", "evt_checkout_confirmed"),
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const confirmForm = new URLSearchParams();
    confirmForm.set("intent", "confirm-checkout");
    confirmForm.set("sourceType", "cart");
    confirmForm.set("shippingOption", "standard");
    confirmForm.set("shippingAddressId", "adr_buyer");
    confirmForm.set("paymentMethodCategory", "card");
    confirmForm.set("previewPaymentMethodCategory", "card");
    confirmForm.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_card_1");
    confirmForm.set("savedCheckoutInstrumentId", "sci_card_1");
    confirmForm.set("acceleratedSavedPayment", "true");

    const confirmResponse = (await checkoutSessionAction({
      request: new Request("http://localhost/checkout/buy/session/chk_signed_in", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: confirmForm.toString(),
      }),
      params: { sessionId: "chk_signed_in" },
      context: undefined,
    } as never)) as Response;
    const confirmLocation = confirmResponse.headers.get("Location") ?? "";
    const confirmFreshReceipt = await readResolvedFreshWriteToken(confirmLocation);

    expect(confirmResponse.status).toBe(302);
    expectCompactPostWriteLocation(confirmLocation, "/checkout/buy/session/chk_signed_in/confirmation?postWriteToken=");
    expect(confirmLocation).not.toContain("/checkout/payments");
    expect(confirmFreshReceipt?.sources).toEqual([
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "44",
        eventIds: ["evt_checkout_confirmed"],
      },
    ]);
    expect(mockSelectShippingOption).toHaveBeenCalledWith("chk_signed_in", {
      shippingOption: "standard",
    });
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith("chk_signed_in", {
      requestedBalanceCreditAmount: null,
      paymentMethodCategory: "card",
      marketplaceCheckoutFeeQuoteFingerprint: "quote_card_1",
      savedCheckoutInstrumentId: "sci_card_1",
      savePaymentMethodForFuture: false,
      fulfillmentPreviewRevision: null,
      acknowledgedMaterialChanges: false,
      shippingAddress: {
        shippingAddressId: "adr_buyer",
        name: "Jane Smith",
        company: null,
        line1: "100 Market Street",
        line2: null,
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        phone: "312-555-0100",
        email: "jane@example.com",
      },
    });
    expect(JSON.stringify(mockConfirmCheckoutSession.mock.calls)).not.toContain("4242424242424242");
  });

  it("recovers tokenless signed-in payment-start resume into the account payment handoff", async () => {
    const committedSession = signedInBuyNowCommittedOrderSession();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ available_balance_amount: "0.00", currency_code: "usd" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    mockListSellListShipFromAddresses.mockResolvedValue({ items: [] });
    mockListSavedCheckoutInstruments.mockResolvedValue({ items: [] });
    mockPreviewCheckoutFulfillment.mockRejectedValue(
      new Error("fulfillment preview is unavailable after order commit"),
    );
    mockGetCheckoutStatus
      .mockRejectedValueOnce({
        status: 400,
        body: {
          error: {
            code: "order_input_not_ready",
            message: "Order ord_signed_in_1 was not found.",
          },
        },
      })
      .mockResolvedValue({
        order_ids: ["ord_signed_in_1"],
        currency_code: "usd",
        amount: "26.19",
        marketplace_checkout_fee: {
          policy_version: "marketplace-checkout-fee-v1",
          payment_method_category: "card",
          order_amount: "26.19",
          external_basis_amount: "26.19",
          balance_credit_amount: "0.00",
          percentage_bps: 290,
          fixed_amount: "0.30",
          variable_amount: "0.76",
          total_amount: "1.06",
          buyer_total_amount: "27.25",
          quote_fingerprint: "quote_card_1",
        },
        payment_method_quotes: [],
        wallet_credit: {
          requested_amount: "0.00",
          applied_amount: "0.00",
          external_amount: "26.19",
        },
        can_start_payment: true,
        unavailable_reasons: [],
        unavailable_reason_details: [],
      });
    mockGetCheckoutPaymentConfirmation.mockResolvedValue({
      payment_id: "pay_signed_in_1",
      amount: "27.25",
      status: "pending-confirmation",
      currency_code: "usd",
    });
    mockGetCheckoutPaymentSummary.mockResolvedValue({
      payment_id: "pay_signed_in_1",
      amount: "27.25",
      status: "pending-confirmation",
      currency_code: "usd",
    });
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });
    mockCreatePaymentsRequestApiClient.mockReturnValue({
      listSavedCheckoutInstruments: mockListSavedCheckoutInstruments,
      getCheckoutStatus: mockGetCheckoutStatus,
      previewCheckoutStatus: mockPreviewCheckoutStatus,
    });
    mockGetCheckoutSession.mockResolvedValue(committedSession);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      getCheckoutPaymentConfirmation: mockGetCheckoutPaymentConfirmation,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    });

    const resumeUrl =
      "http://localhost/checkout/buy/session/chk_signed_in?paymentMethodCategory=card&review=updated&resumePaymentStart=1";
    const recoveredReview = await checkoutSessionLoader({
      request: new Request(resumeUrl),
      params: { sessionId: "chk_signed_in" },
      context: undefined,
    } as never);
    expect(mockGetCheckoutStatus).not.toHaveBeenCalled();
    expect(mockPreviewCheckoutStatus).not.toHaveBeenCalled();
    expect(recoveredReview).toEqual(
      expect.objectContaining({
        autoResumePaymentStart: true,
        isSignedInBuyer: true,
        paymentPreview: expect.objectContaining({
          marketplace_checkout_fee: expect.objectContaining({
            quote_fingerprint: "marketplace-checkout-fee-v1|card|26.19|0.00|26.19|1.10|27.29|27.29",
          }),
        }),
      }),
    );

    mockConfirmCheckoutSession.mockResolvedValue({
      payment_id: "pay_signed_in_1",
      order_ids: ["ord_signed_in_1"],
      status: "confirmed",
      ...checkoutCommit("43", "evt_payment_started"),
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      selectShippingOption: mockSelectShippingOption,
      selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });
    const confirmForm = new URLSearchParams();
    confirmForm.set("intent", "confirm-checkout");
    confirmForm.set("sourceType", "buy-now");
    confirmForm.set("shippingOption", "standard");
    confirmForm.set("paymentMethodCategory", "card");
    confirmForm.set("previewPaymentMethodCategory", "card");
    confirmForm.set("marketplaceCheckoutFeeQuoteFingerprint", "quote_card_1");
    confirmForm.set("shippingName", "Jane Smith");
    confirmForm.set("shippingLine1", "100 Market Street");
    confirmForm.set("shippingCity", "Chicago");
    confirmForm.set("shippingState", "IL");
    confirmForm.set("shippingPostalCode", "60601");
    confirmForm.set("shippingCountry", "US");

    const confirmResponse = (await checkoutSessionAction({
      request: new Request(resumeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: confirmForm.toString(),
      }),
      params: { sessionId: "chk_signed_in" },
      context: undefined,
    } as never)) as Response;
    const confirmLocation = confirmResponse.headers.get("Location") ?? "";

    expect(confirmResponse.status).toBe(302);
    expectCompactPostWriteLocation(confirmLocation, "/checkout/buy/session/chk_signed_in?postWriteToken=");
    expect(mockSelectShippingOption).not.toHaveBeenCalled();

    mockGetCheckoutSession.mockResolvedValue(signedInBuyNowCommittedOrderSession("pay_signed_in_1"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
      getCheckoutPaymentConfirmation: mockGetCheckoutPaymentConfirmation,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    });

    const inlinePayment = await checkoutSessionLoader({
      request: new Request(`http://localhost${confirmLocation}`),
      params: { sessionId: "chk_signed_in" },
      context: undefined,
    } as never);

    expect(inlinePayment.preparedPayment).toEqual(
      expect.objectContaining({ payment_id: "pay_signed_in_1", status: "pending-confirmation" }),
    );
    expect(mockGetCheckoutPaymentConfirmation).toHaveBeenCalledWith("chk_signed_in");
  });
});
