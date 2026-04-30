import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireActorFromAuthApi,
  mockCreateCheckoutRequestApiClient,
  mockCreateCheckoutSession,
  mockSelectShippingOption,
  mockConfirmCheckoutSession,
} = vi.hoisted(() => ({
  mockRequireActorFromAuthApi: vi.fn(),
  mockCreateCheckoutRequestApiClient: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
  mockSelectShippingOption: vi.fn(),
  mockConfirmCheckoutSession: vi.fn(),
}));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
  };
});

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

  it("starts cart checkout through the canonical checkout session API", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({});
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

  it("confirms checkout and redirects to the payment detail", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({});
    mockSelectShippingOption.mockResolvedValue({});
    mockConfirmCheckoutSession.mockResolvedValue({ payment_id: "pay_1", order_ids: ["ord_1"] });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      selectShippingOption: mockSelectShippingOption,
      confirmCheckoutSession: mockConfirmCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "confirm-checkout");
    form.set("shippingOption", "priority");

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
    expect(mockConfirmCheckoutSession).toHaveBeenCalledWith("chk_1");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/payments/pay_1");
  });

  it("redirects completed checkout sessions to payment detail", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({});
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
});
