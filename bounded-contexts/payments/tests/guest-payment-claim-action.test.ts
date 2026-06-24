import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken, readCompactPostWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";

const {
  mockClaimGuestCheckoutWithPasskey,
  mockClaimGuestCheckoutWithMagicLink,
  mockClearGuestCheckoutCookie,
  mockCompleteBrowserAuthentication,
  mockCreateInternalAuthRequestApiClient,
  mockCreatePaymentsRequestApiClient,
  mockGetAccountPayment,
  mockGetCheckoutStatus,
  mockGetPurchase,
  mockRecoverCheckoutPayment,
  mockRequireActorFromAuthApi,
  mockRequestGuestCheckoutClaimLink,
  mockResolveActorFromAuthApi,
} = vi.hoisted(() => ({
  mockClaimGuestCheckoutWithPasskey: vi.fn(),
  mockClaimGuestCheckoutWithMagicLink: vi.fn(),
  mockClearGuestCheckoutCookie: vi.fn(),
  mockCompleteBrowserAuthentication: vi.fn(
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: "/account/payments/pay_1" },
      }),
  ),
  mockCreateInternalAuthRequestApiClient: vi.fn(),
  mockCreatePaymentsRequestApiClient: vi.fn(),
  mockGetAccountPayment: vi.fn(),
  mockGetCheckoutStatus: vi.fn(),
  mockGetPurchase: vi.fn(),
  mockRecoverCheckoutPayment: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
  mockRequestGuestCheckoutClaimLink: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
}));

vi.mock("@chase-sets/auth/server", () => ({
  AuthApiError: class AuthApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super("Auth API error");
    }
  },
  clearGuestCheckoutCookie: mockClearGuestCheckoutCookie,
  completeBrowserAuthentication: mockCompleteBrowserAuthentication,
  createInternalAuthRequestApiClient: mockCreateInternalAuthRequestApiClient,
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

vi.mock("@chase-sets/ordering/server", () => ({
  createOrderingRequestApiClient: vi.fn(() => ({
    getPurchase: mockGetPurchase,
  })),
}));

vi.mock("../support/request-support/api-client", () => ({
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

import { action, loader } from "../routes/marketplace/account-payment";

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
    mockGetPurchase.mockResolvedValue({
      order_id: "ord_1",
      status: "paid",
      total_amount: "10.00",
      seller_payout_amount: "8.00",
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
      recoverCheckoutPayment: mockRecoverCheckoutPayment,
    });
  });

  it("loads a captured guest checkout payment without requiring a signed-in account", async () => {
    const getGuestCheckoutClaimContext = vi.fn(async () => ({
      contactName: "Jane Smith",
      contactEmail: "jane@example.com",
    }));
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      getGuestCheckoutClaimContext,
    });
    mockGetAccountPayment.mockResolvedValue({
      payment_id: "pay_guest_1",
      order_ids: ["ord_guest_1"],
      status: "captured",
      currency_code: "usd",
      processor_amount: "27.10",
      balance_credit_amount: "0.00",
      payment_method_category: "card",
    });
    mockGetPurchase.mockResolvedValue({
      order_id: "ord_guest_1",
      status: "paid",
      total_amount: "27.10",
      seller_payout_amount: "25.00",
      shipping_destination_snapshot: {
        name: "Jane Smith",
        line1: "100 Market Street",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        email: "jane@example.com",
      },
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
    expect(mockGetAccountPayment).toHaveBeenCalledWith("pay_guest_1");
    expect(mockGetPurchase).toHaveBeenCalledWith("ord_guest_1");
    expect(getGuestCheckoutClaimContext).toHaveBeenCalledWith({ paymentId: "pay_guest_1" });
    expect(result).toEqual(
      expect.objectContaining({
        isGuestCheckoutPayment: true,
        showSupportDetails: false,
        buyerEmail: null,
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
        guestClaimContext: {
          contactName: "Jane Smith",
          contactEmail: "jane@example.com",
        },
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
    mockGetPurchase.mockResolvedValue({
      order_id: "ord_signed_in_1",
      buyer_account_id: "acc_buyer",
      status: "paid",
      total_amount: "27.29",
      seller_payout_amount: "25.00",
      source_reference_id: "chk_signed_in",
      shipping_destination_snapshot: {
        name: "Jane Smith",
        line1: "100 Market Street",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        email: "jane@example.com",
      },
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
    expect(mockGetAccountPayment).toHaveBeenCalledWith("pay_signed_in_1");
    expect(mockGetPurchase).toHaveBeenCalledWith("ord_signed_in_1");
    expect(mockCreateInternalAuthRequestApiClient).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        isGuestCheckoutPayment: false,
        guestClaimContext: null,
        showSupportDetails: false,
        buyerEmail: null,
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
    mockGetPurchase.mockResolvedValue({
      order_id: "ord_signed_in_1",
      buyer_account_id: "acc_support",
      status: "paid",
      total_amount: "27.29",
      seller_payout_amount: "25.00",
      shipping_destination_snapshot: {
        email: "operator-view@example.com",
      },
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
        buyerEmail: null,
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
    mockGetPurchase.mockResolvedValue({
      order_id: "ord_checkout_session",
      buyer_account_id: "acc_buyer",
      status: "pending-payment",
      total_amount: "27.29",
      seller_payout_amount: "25.00",
      shipping_destination_snapshot: {
        name: "Jane Smith",
        line1: "100 Market Street",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        email: "jane@example.com",
      },
    });

    const result = await loader({
      request: new Request("http://localhost/account/payments/pay_checkout_session"),
      params: { paymentId: "pay_checkout_session" },
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        buyerEmail: "jane@example.com",
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

  it("requests a local email claim token for guest payment recovery", async () => {
    mockRequestGuestCheckoutClaimLink.mockResolvedValue({
      token: "magic_token",
      expiresAt: "2026-05-04T16:00:00.000Z",
    });
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      requestGuestCheckoutClaimLink: mockRequestGuestCheckoutClaimLink,
    });

    const form = new URLSearchParams();
    form.set("intent", "claim-link-request");
    form.set("displayName", "Jane Smith");
    form.set("email", "jane@example.com");

    const result = await action({
      request: new Request("http://localhost/checkout/payments/pay_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    } as never);

    expect(mockGetAccountPayment).toHaveBeenCalledWith("pay_1");
    expect(mockRequestGuestCheckoutClaimLink).toHaveBeenCalledWith({
      paymentId: "pay_1",
    });
    expect(result).toEqual({
      status: "claim-link-sent",
      token: "magic_token",
      expiresAt: "2026-05-04T16:00:00.000Z",
      displayName: "Jane Smith",
    });
  });

  it("claims the guest account with passkey proof and starts a browser session", async () => {
    const authResult = {
      type: "session-started",
      userId: "usr_1",
      sessionId: "ses_1",
      sessionToken: "session_token",
      session: { session_id: "ses_1" },
      memberships: [],
    };
    mockClaimGuestCheckoutWithPasskey.mockResolvedValue(authResult);
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      claimGuestCheckoutWithPasskey: mockClaimGuestCheckoutWithPasskey,
    });

    const form = new URLSearchParams();
    form.set("intent", "claim-passkey");
    form.set("displayName", "Jane Smith");
    form.set("email", "jane@example.com");
    form.set("challengeId", "cmd_challenge");
    form.set("challenge", "challenge");
    form.set("externalCredentialId", "cred_external");
    form.set("label", "Passkey");
    form.set("publicKey", "{}");

    const result = await action({
      request: new Request("http://localhost/checkout/payments/pay_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    } as never);

    expect(mockGetAccountPayment).toHaveBeenCalledWith("pay_1");
    expect(mockClaimGuestCheckoutWithPasskey).toHaveBeenCalledWith({
      displayName: "Jane Smith",
      email: "jane@example.com",
      paymentId: "pay_1",
      challengeId: "cmd_challenge",
      challenge: "challenge",
      externalCredentialId: "cred_external",
      label: "Passkey",
      publicKey: "{}",
    });
    expect(mockCompleteBrowserAuthentication).toHaveBeenCalledWith(expect.any(Request), authResult, {
      defaultSuccessPath: "/account/payments/pay_1",
      accountSelectionPath: "/account/select",
    });
    expect(mockClearGuestCheckoutCookie).toHaveBeenCalledWith((result as Response).headers, expect.any(Request));
    expect((result as Response).status).toBe(302);
  });

  it("consumes an email claim token before claiming a guest payment", async () => {
    const authResult = {
      type: "session-started",
      userId: "usr_1",
      sessionId: "ses_1",
      sessionToken: "session_token",
      session: { session_id: "ses_1" },
      memberships: [],
    };
    mockClaimGuestCheckoutWithMagicLink.mockResolvedValue(authResult);
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      claimGuestCheckoutWithMagicLink: mockClaimGuestCheckoutWithMagicLink,
    });

    const form = new URLSearchParams();
    form.set("intent", "claim-link-consume");
    form.set("displayName", "Jane Smith");
    form.set("token", "magic_token");

    const result = await action({
      request: new Request("http://localhost/checkout/payments/pay_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    } as never);

    expect(mockGetAccountPayment).toHaveBeenCalledWith("pay_1");
    expect(mockClaimGuestCheckoutWithMagicLink).toHaveBeenCalledWith({
      token: "magic_token",
      paymentId: "pay_1",
      displayName: "Jane Smith",
    });
    expect(mockClearGuestCheckoutCookie).toHaveBeenCalledWith((result as Response).headers, expect.any(Request));
    expect((result as Response).status).toBe(302);
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
    const { PaymentsApiError } = await import("../support/request-support/api-client");
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
    const { PaymentsApiError } = await import("../support/request-support/api-client");
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
    const { PaymentsApiError } = await import("../support/request-support/api-client");
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
    const { PaymentsApiError } = await import("../support/request-support/api-client");
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
    const { PaymentsApiError } = await import("../support/request-support/api-client");
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
    const { PaymentsApiError } = await import("../support/request-support/api-client");
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

  it("returns permanent not-found recovery when a payment handoff is expired", async () => {
    const { PaymentsApiError } = await import("../support/request-support/api-client");
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
