import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken, readCompactPostWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";

const {
  mockCreatePaymentsRequestApiClient,
  mockGetAccountPayment,
  mockGetCheckoutStatus,
  mockListAccountOrderInputs,
  mockRecoverCheckoutPayment,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
} = vi.hoisted(() => ({
  mockCreatePaymentsRequestApiClient: vi.fn(),
  mockGetAccountPayment: vi.fn(),
  mockGetCheckoutStatus: vi.fn(),
  mockListAccountOrderInputs: vi.fn(),
  mockRecoverCheckoutPayment: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
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

vi.mock("../../../../support/request-support/api-client", () => ({
  createPaymentsRequestApiClient: mockCreatePaymentsRequestApiClient,
  PaymentsApiError: class PaymentsApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super("Payments API error");
    }
  },
}));

import { action, loader } from "./account-payment";

const originalEnv = { ...process.env };

async function readResolvedFreshWriteToken(url: URL) {
  const resolvedRequest = await resolvePlatformPostWriteRequest(new Request(url));
  return readFreshWriteToken(resolvedRequest.url);
}

function paymentCommit(position: string, eventId: string) {
  return {
    mode: "eventual",
    commitPosition: position,
    commitEventIds: [eventId],
    commitPositions: [
      {
        sourceContextName: "payments",
        maxGlobalPosition: position,
        eventIds: [eventId],
      },
    ],
  };
}

function withPaymentCommandReceipt<T extends object>(body: T, position = "43", eventId = "evt_payment_retry"): T {
  Object.defineProperty(body, "commandReceipt", {
    value: paymentCommit(position, eventId),
    enumerable: false,
  });

  return body;
}

function freshPaymentRequest(path = "/checkout/payments/pay_1") {
  return new Request(`http://localhost${appendFreshWriteToken(path, paymentCommit("42", "evt_payment"))}`);
}

describe("guest payment claim action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccountPayment.mockResolvedValue({
      payment_id: "pay_1",
      status: "captured",
    });
    mockListAccountOrderInputs.mockResolvedValue({
      orders: [
        {
          order_id: "ord_1",
          buyer_email: "buyer@example.com",
          status: "paid",
          total_amount: "10.00",
          seller_payout_amount: "8.00",
        },
      ],
    });
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["orders.view"],
    });
    mockCreatePaymentsRequestApiClient.mockReturnValue({
      getAccountPayment: mockGetAccountPayment,
      getCheckoutStatus: mockGetCheckoutStatus,
      listAccountOrderInputs: mockListAccountOrderInputs,
      recoverCheckoutPayment: mockRecoverCheckoutPayment,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("loads a captured guest checkout payment without requiring a signed-in account", async () => {
    mockGetAccountPayment.mockResolvedValue({
      payment_id: "pay_guest_1",
      order_ids: ["ord_guest_1"],
      status: "captured",
      currency_code: "usd",
      processor_amount: "27.10",
      balance_credit_amount: "0.00",
      payment_method_category: "card",
    });
    mockListAccountOrderInputs.mockResolvedValue({
      orders: [
        {
          order_id: "ord_guest_1",
          buyer_email: "jane@example.com",
          status: "paid",
          total_amount: "27.10",
          seller_payout_amount: "25.00",
        },
      ],
    });
    mockResolveActorFromAuthApi.mockResolvedValue(null);

    const result = await loader({
      request: new Request("http://localhost/checkout/payments/pay_guest_1", {
        headers: { cookie: "chase_sets_guest_checkout=guest_token" },
      }),
      params: { paymentId: "pay_guest_1" },
      context: undefined,
    } as never);

    expect(mockResolveActorFromAuthApi).toHaveBeenCalled();
    expect(mockGetAccountPayment).toHaveBeenCalledWith("pay_guest_1", { readProcessorStatus: true });
    expect(mockListAccountOrderInputs).toHaveBeenCalledWith({ orderIds: ["ord_guest_1"] });
    expect(result).toEqual(
      expect.objectContaining({
        isGuestCheckoutPayment: true,
        showSupportDetails: false,
        paymentElementDefaultValues: null,
        payment: expect.objectContaining({
          payment_id: "pay_guest_1",
          status: "captured",
        }),
        orders: [
          expect.objectContaining({
            order_id: "ord_guest_1",
            status: "paid",
            total_amount: "27.10",
            seller_payout_amount: "25.00",
          }),
        ],
      }),
    );
    expect(JSON.stringify(result.orders)).not.toContain("100 Market Street");
    expect(JSON.stringify(result.orders)).not.toContain("jane@example.com");
  });

  it("loads a signed-in account payment without customer-visible support diagnostics", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["orders.view", "orders.manage"],
    });
    mockGetAccountPayment.mockResolvedValue({
      payment_id: "pay_signed_in_1",
      buyer_account_id: "acc_buyer",
      order_ids: ["ord_signed_in_1"],
      status: "captured",
      currency_code: "usd",
      processor_amount: "27.29",
      balance_credit_amount: "0.00",
      payment_method_category: "card",
    });
    mockListAccountOrderInputs.mockResolvedValue({
      orders: [
        {
          order_id: "ord_signed_in_1",
          buyer_account_id: "acc_buyer",
          buyer_email: "jane@example.com",
          shipping_destination_snapshot: {
            name: "Jane Smith",
            line1: "100 Market Street",
            line2: "Suite 2",
            city: "Chicago",
            state: "IL",
            postalCode: "60601",
            country: "US",
            email: "jane@example.com",
          },
          status: "paid",
          total_amount: "27.29",
          seller_payout_amount: "25.00",
        },
      ],
    });

    const result = await loader({
      request: new Request("http://localhost/account/payments/pay_signed_in_1"),
      params: { paymentId: "pay_signed_in_1" },
      context: undefined,
    } as never);

    expect(mockRequireActorFromAuthApi).toHaveBeenCalledWith({
      request: expect.any(Request),
      permission: "orders.view",
    });
    expect(mockResolveActorFromAuthApi).not.toHaveBeenCalled();
    expect(mockGetAccountPayment).toHaveBeenCalledWith("pay_signed_in_1", { readProcessorStatus: true });
    expect(mockListAccountOrderInputs).toHaveBeenCalledWith({ orderIds: ["ord_signed_in_1"] });
    expect(result).toEqual(
      expect.objectContaining({
        isGuestCheckoutPayment: false,
        showSupportDetails: false,
        paymentElementDefaultValues: null,
        payment: expect.objectContaining({
          payment_id: "pay_signed_in_1",
          status: "captured",
        }),
        orders: [
          expect.objectContaining({
            order_id: "ord_signed_in_1",
            status: "paid",
            total_amount: "27.29",
            seller_payout_amount: "25.00",
          }),
        ],
      }),
    );
    expect(JSON.stringify(result.orders)).not.toContain("100 Market Street");
    expect(JSON.stringify(result.orders)).not.toContain("chk_signed_in");
  });

  it("allows platform support operators to see the internal support panel flag", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_support",
      roleKey: "platform-admin",
      permissions: ["orders.view", "support.manage"],
    });
    mockGetAccountPayment.mockResolvedValue({
      payment_id: "pay_signed_in_1",
      buyer_account_id: "acc_support",
      order_ids: ["ord_signed_in_1"],
      status: "captured",
      currency_code: "usd",
      processor_amount: "27.29",
      balance_credit_amount: "0.00",
      payment_method_category: "card",
    });
    mockListAccountOrderInputs.mockResolvedValue({
      orders: [
        {
          order_id: "ord_signed_in_1",
          buyer_account_id: "acc_support",
          buyer_email: "operator-view@example.com",
          status: "paid",
          total_amount: "27.29",
          seller_payout_amount: "25.00",
        },
      ],
    });

    const result = await loader({
      request: new Request("http://localhost/account/payments/pay_signed_in_1"),
      params: { paymentId: "pay_signed_in_1" },
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        isGuestCheckoutPayment: false,
        showSupportDetails: true,
        paymentElementDefaultValues: null,
      }),
    );
  });

  it("returns buyer email only for pending processor checkout sessions", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["orders.view", "orders.manage"],
    });
    mockGetAccountPayment.mockResolvedValue({
      payment_id: "pay_checkout_session",
      buyer_account_id: "acc_buyer",
      order_ids: ["ord_checkout_session"],
      status: "pending-confirmation",
      currency_code: "usd",
      processor_amount: "27.29",
      balance_credit_amount: "0.00",
      payment_method_category: "card",
      processor_payment_kind: "checkout-session",
    });
    mockListAccountOrderInputs.mockResolvedValue({
      orders: [
        {
          order_id: "ord_checkout_session",
          buyer_account_id: "acc_buyer",
          buyer_email: "jane@example.com",
          shipping_destination_snapshot: {
            name: "Jane Smith",
            line1: "100 Market Street",
            line2: "Suite 2",
            city: "Chicago",
            state: "IL",
            postalCode: "60601",
            country: "US",
            email: "jane@example.com",
          },
          status: "pending-payment",
          total_amount: "27.29",
          seller_payout_amount: "25.00",
        },
      ],
    });

    const result = await loader({
      request: new Request("http://localhost/account/payments/pay_checkout_session"),
      params: { paymentId: "pay_checkout_session" },
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        paymentElementDefaultValues: {
          billingDetails: {
            email: "jane@example.com",
            name: "Jane Smith",
            address: {
              line1: "100 Market Street",
              line2: "Suite 2",
              city: "Chicago",
              state: "IL",
              postal_code: "60601",
              country: "US",
            },
          },
        },
        showSupportDetails: false,
        orders: [
          {
            order_id: "ord_checkout_session",
            status: "pending-payment",
            total_amount: "27.29",
            seller_payout_amount: "25.00",
          },
        ],
      }),
    );
    expect(JSON.stringify(result.orders)).not.toContain("100 Market Street");
  });

  it("recovers failed guest payments without leaving guest checkout", async () => {
    mockGetAccountPayment.mockResolvedValue({
      payment_id: "pay_1",
      order_ids: ["ord_1"],
      balance_credit_amount: "3.25",
      currency_code: "usd",
      payment_method_category: "bank-account",
      status: "failed",
    });
    mockRecoverCheckoutPayment.mockResolvedValue(withPaymentCommandReceipt({ payment_id: "pay_retry" }));
    mockGetCheckoutStatus.mockResolvedValue({
      marketplace_checkout_fee: {
        quote_fingerprint: "quote_bank_retry",
      },
    });

    const form = new URLSearchParams();
    form.set("intent", "retry-payment");

    const result = await action({
      request: new Request("http://localhost/checkout/payments/pay_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    } as never);

    expect(mockGetCheckoutStatus).toHaveBeenCalledWith({
      orderIds: ["ord_1"],
      currencyCode: "usd",
      requestedBalanceCreditAmount: "3.25",
      paymentMethodCategory: "bank-account",
    });
    expect(mockRecoverCheckoutPayment).toHaveBeenCalledWith({
      orderIds: ["ord_1"],
      currencyCode: "usd",
      requestedBalanceCreditAmount: "3.25",
      paymentMethodCategory: "bank-account",
      marketplaceCheckoutFeeQuoteFingerprint: "quote_bank_retry",
      returnUrlPath: "/checkout/payments/:paymentId",
    });
    const location = (result as Response).headers.get("Location");
    const redirectUrl = new URL(location ?? "", "http://localhost");
    expect(redirectUrl.pathname).toBe("/checkout/payments/pay_retry");
    expect(readCompactPostWriteToken(redirectUrl)).toMatch(/^pwt_/);
    expect(redirectUrl.searchParams.has("afterWrite")).toBe(false);
    expect(redirectUrl.searchParams.has("postWriteHandoff")).toBe(false);
    expect((await readResolvedFreshWriteToken(redirectUrl))?.sources).toEqual([
      {
        sourceContextName: "payments",
        maxGlobalPosition: "43",
        eventIds: ["evt_payment_retry"],
      },
    ]);
  });

  it("returns retry-scoped errors when guest payment recovery fails", async () => {
    mockGetAccountPayment.mockResolvedValue({
      payment_id: "pay_1",
      order_ids: ["ord_1"],
      balance_credit_amount: "3.25",
      currency_code: "usd",
      payment_method_category: "bank-account",
      status: "failed",
    });
    mockGetCheckoutStatus.mockResolvedValue({
      marketplace_checkout_fee: {
        quote_fingerprint: "quote_bank_retry",
      },
    });
    mockRecoverCheckoutPayment.mockRejectedValue(new Error("Fee quote changed."));

    const form = new URLSearchParams();
    form.set("intent", "retry-payment");

    const result = await action({
      request: new Request("http://localhost/checkout/payments/pay_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      scope: "retry",
      error: "Fee quote changed.",
    });
  });

  it("uses the expired-link recovery response when guest retry loses payment access", async () => {
    const { PaymentsApiError } = await import("../../../../support/request-support/api-client");
    mockGetAccountPayment.mockRejectedValue(
      new PaymentsApiError(401, {
        error: "guest token expired",
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "retry-payment");

    let response: Response | null = null;
    try {
      await action({
        request: new Request("http://localhost/checkout/payments/pay_1", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: { paymentId: "pay_1" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(401);
    expect(response?.statusText).toBe("Guest checkout link expired");
  });

  it("throws a controlled expired-link response for invalid guest payment access", async () => {
    const { PaymentsApiError } = await import("../../../../support/request-support/api-client");
    mockGetAccountPayment.mockRejectedValue(
      new PaymentsApiError(401, {
        error: "guest token expired",
      }),
    );

    let response: Response | null = null;
    try {
      await loader({
        request: new Request("http://localhost/checkout/payments/pay_1"),
        params: { paymentId: "pay_1" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(401);
    expect(response?.statusText).toBe("Guest checkout link expired");
  });

  it("returns temporary recovery when a fresh payment handoff has not projected yet", async () => {
    const { PaymentsApiError } = await import("../../../../support/request-support/api-client");
    mockGetAccountPayment.mockRejectedValue(
      new PaymentsApiError(404, {
        error: { code: "not_found", message: "Payment not found." },
      }),
    );

    let response: Response | null = null;
    try {
      await loader({
        request: freshPaymentRequest(),
        params: { paymentId: "pay_1" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(503);
    expect(response?.statusText).toBe("Preparing payment");
    await expect(response?.text()).resolves.toContain("getting your secure payment ready");
  });

  it("returns temporary recovery when a fresh payment handoff hits projection freshness timeout", async () => {
    const { PaymentsApiError } = await import("../../../../support/request-support/api-client");
    mockGetAccountPayment.mockRejectedValue(
      new PaymentsApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );

    let response: Response | null = null;
    try {
      await loader({
        request: freshPaymentRequest(),
        params: { paymentId: "pay_1" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(503);
    expect(response?.statusText).toBe("Preparing payment");
  });

  it("does not treat provider failures as payment projection lag", async () => {
    const { PaymentsApiError } = await import("../../../../support/request-support/api-client");
    const failure = new PaymentsApiError(503, {
      error: {
        code: "provider_failed",
        message: "The payment provider could not confirm this payment.",
      },
    });
    mockGetAccountPayment.mockRejectedValue(failure);

    await expect(
      loader({
        request: freshPaymentRequest(),
        params: { paymentId: "pay_1" },
        context: undefined,
      } as never),
    ).rejects.toBe(failure);
  });

  it("returns permanent not-found recovery for stale or manual payment links", async () => {
    const { PaymentsApiError } = await import("../../../../support/request-support/api-client");
    mockGetAccountPayment.mockRejectedValue(
      new PaymentsApiError(404, {
        error: { code: "not_found", message: "Payment not found." },
      }),
    );

    let response: Response | null = null;
    try {
      await loader({
        request: new Request("http://localhost/checkout/payments/pay_1"),
        params: { paymentId: "pay_1" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(404);
    expect(response?.statusText).toBe("");
    await expect(response?.text()).resolves.toBe("Payment not found.");
  });

  it("returns permanent not-found recovery for stale signed-in payment links", async () => {
    const { PaymentsApiError } = await import("../../../../support/request-support/api-client");
    mockGetAccountPayment.mockRejectedValue(
      new PaymentsApiError(404, {
        error: { code: "not_found", message: "Payment not found." },
      }),
    );

    let response: Response | null = null;
    try {
      await loader({
        request: new Request("http://localhost/account/payments/pay_e2e_missing"),
        params: { paymentId: "pay_e2e_missing" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(mockRequireActorFromAuthApi).toHaveBeenCalledWith({
      request: expect.any(Request),
      permission: "orders.view",
    });
    expect(response?.status).toBe(404);
    expect(response?.statusText).toBe("");
    await expect(response?.text()).resolves.toBe("Payment not found.");
  });

  it("returns permanent not-found recovery when a payment handoff is expired", async () => {
    const { PaymentsApiError } = await import("../../../../support/request-support/api-client");
    mockGetAccountPayment.mockRejectedValue(
      new PaymentsApiError(404, {
        error: { code: "not_found", message: "Payment not found." },
      }),
    );

    let response: Response | null = null;
    try {
      await loader({
        request: new Request(
          `http://localhost${appendFreshWriteToken(
            "/checkout/payments/pay_1",
            paymentCommit("42", "evt_payment"),
            Date.now() - 40_000,
          )}`,
        ),
        params: { paymentId: "pay_1" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe("Payment not found.");
  });
});
