import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockClaimGuestCheckoutWithPasskey,
  mockClaimGuestCheckoutWithMagicLink,
  mockCompleteBrowserAuthentication,
  mockCreateInternalAuthRequestApiClient,
  mockCreatePaymentsRequestApiClient,
  mockGetAccountPayment,
  mockGetCheckoutStatus,
  mockGetPurchase,
  mockRecoverCheckoutPayment,
  mockRequestGuestCheckoutClaimLink,
  mockResolveActorFromAuthApi,
} = vi.hoisted(() => ({
  mockClaimGuestCheckoutWithPasskey: vi.fn(),
  mockClaimGuestCheckoutWithMagicLink: vi.fn(),
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
  completeBrowserAuthentication: mockCompleteBrowserAuthentication,
  createInternalAuthRequestApiClient: mockCreateInternalAuthRequestApiClient,
}));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
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
    mockCreatePaymentsRequestApiClient.mockReturnValue({
      getAccountPayment: mockGetAccountPayment,
      getCheckoutStatus: mockGetCheckoutStatus,
      recoverCheckoutPayment: mockRecoverCheckoutPayment,
    });
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
    mockRecoverCheckoutPayment.mockResolvedValue({
      payment_id: "pay_retry",
    });
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
    expect((result as Response).headers.get("Location")).toBe("/checkout/payments/pay_retry");
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
});
