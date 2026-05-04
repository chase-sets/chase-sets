import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockCreateCheckoutRequestApiClient,
  mockCreateAuthRequestApiClient,
  mockCreateCheckoutSession,
  mockSelectShippingOption,
  mockConfirmCheckoutSession,
  mockStartGuestCheckout,
  mockMergeGuestCartToAccount,
} = vi.hoisted(() => ({
  mockRequireActorFromAuthApi: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
  mockCreateCheckoutRequestApiClient: vi.fn(),
  mockCreateAuthRequestApiClient: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
  mockSelectShippingOption: vi.fn(),
  mockConfirmCheckoutSession: vi.fn(),
  mockStartGuestCheckout: vi.fn(),
  mockMergeGuestCartToAccount: vi.fn(),
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

vi.mock("@chase-sets/auth/server", () => ({
  createAuthRequestApiClient: mockCreateAuthRequestApiClient,
}));

vi.mock("../support/request-support/api-client", () => ({
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
}));

import { action as checkoutStartAction } from "./checkout-start";
import {
  action as checkoutSessionAction,
  loader as checkoutSessionLoader,
} from "./checkout-session";

describe("checkout web routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function guestCheckoutActor() {
    return {
      sessionId: "guest:tok_1",
      tenantId: "tnt_identity",
      userId: "usr_guest_checkout",
      accountId: "acc_guest",
      membershipId: "guest:tok_1",
      roleKey: "guest-buyer",
      permissions: ["guest-checkout.manage"],
    };
  }

  it("starts cart checkout through the canonical checkout session API", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_cart" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/start", {
        method: "POST",
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: { type: "cart" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_cart");
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
    mockMergeGuestCartToAccount.mockResolvedValue({ status: "merged" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("contactName", "Jane Smith");
    form.set("email", "jane@example.com");
    form.set("source", "cart");

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/start", {
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

    expect(mockStartGuestCheckout).toHaveBeenCalledWith({
      displayName: "Jane Smith",
      email: "jane@example.com",
    });
    expect(mockMergeGuestCartToAccount).toHaveBeenCalledWith("anon_cart_1");
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: { type: "cart" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/chk_guest");
    expect(response.headers.getSetCookie().join("; ")).toContain(
      "chase_sets_guest_checkout=guest_token",
    );
  });

  it("confirms checkout and redirects to the payment detail", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
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
    form.set("shippingLine2", "");
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
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith("chk_1", {
      requestedBalanceCreditAmount: null,
      paymentMethodCategory: "bank-account",
      shippingAddress: {
        name: "Jane Smith",
        line1: "100 Market Street",
        line2: null,
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/payments/pay_1");
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
  });

  it("redirects completed checkout sessions to payment detail", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => ({
        session_id: "chk_1",
        buyer_account_id: "acc_buyer",
        source_type: "cart",
        shipping_option: "standard",
        lines: [],
        order_ids: ["ord_1"],
        payment_id: "pay_1",
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      })),
    });

    let redirectResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      redirectResponse = error as Response;
    }

    expect(redirectResponse?.status).toBe(302);
    expect(redirectResponse?.headers.get("Location")).toBe("/account/payments/pay_1");
  });

  it("keeps completed guest checkout sessions on the guest payment route", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => ({
        session_id: "chk_1",
        buyer_account_id: "acc_guest",
        source_type: "cart",
        shipping_option: "standard",
        lines: [],
        order_ids: ["ord_1"],
        payment_id: "pay_1",
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      })),
    });

    let redirectResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      redirectResponse = error as Response;
    }

    expect(redirectResponse?.status).toBe(302);
    expect(redirectResponse?.headers.get("Location")).toBe("/checkout/payments/pay_1");
  });
});
