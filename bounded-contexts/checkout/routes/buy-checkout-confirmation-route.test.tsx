import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
  guestCheckoutActor,
  mockCreateCheckoutRequestApiClient,
  mockGetCheckoutSession,
  mockResolveActorFromAuthApi,
} from "../tests/support/checkout-route-test-harness";

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    resolveActorFromAuthApi: mockResolveActorFromAuthApi,
  };
});

vi.mock("../support/request-support/api-client", async () => {
  const actual = await vi.importActual<typeof import("../support/request-support/api-client")>(
    "../support/request-support/api-client",
  );

  return {
    ...actual,
    createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
  };
});

import { loader as buyCheckoutConfirmationLoader } from "./buy-checkout-confirmation";

function confirmedSession(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "chk_1",
    buyer_account_id: "acc_buyer",
    source_type: "cart",
    payment_id: "pay_1",
    submitted_offer_id: null,
    shipping_option: "standard",
    shipping_address: null,
    optimization_goal: "lowest-total",
    fulfillment_preview_revision: null,
    order_ids: ["ord_1"],
    lines: [],
    created_at: "2026-06-10T00:00:00.000Z",
    updated_at: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("checkout web routes: buy checkout confirmation loader", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("blocks buy confirmation while the Shopify-simple kill switch is active", async () => {
    vi.stubEnv("CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE", "true");
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });

    const redirectResponse = (await buyCheckoutConfirmationLoader({
      request: new Request("http://localhost/checkout/buy/session/chk_1/confirmation"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never).catch((error) => error)) as Response;

    expect(redirectResponse.status).toBe(302);
    expect(redirectResponse.headers.get("Location")).toBe("/account/cart?checkout=disabled");
    expect(mockGetCheckoutSession).not.toHaveBeenCalled();
  });

  it("shows signed-in buyers the confirmation handoff instead of redirecting to payment", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockGetCheckoutSession.mockResolvedValue(confirmedSession());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });

    const result = await buyCheckoutConfirmationLoader({
      request: new Request("http://localhost/checkout/buy/session/chk_1/confirmation"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          session_id: "chk_1",
          payment_id: "pay_1",
          order_ids: ["ord_1"],
        }),
        paymentPath: "/account/payments/pay_1",
      }),
    );
  });

  it("preserves the confirmation fresh-write token for the payment continuation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockGetCheckoutSession.mockResolvedValue(confirmedSession());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });

    const path = appendFreshWriteToken(
      "/checkout/buy/session/chk_1/confirmation",
      checkoutCommit("44", "evt_checkout_confirmed"),
    );
    const result = await buyCheckoutConfirmationLoader({
      request: new Request(`http://localhost${path}`),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        paymentPath: expect.stringContaining("/account/payments/pay_1?afterWrite="),
      }),
    );
  });

  it("keeps guest buyer payment continuation on the guest payment route", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockGetCheckoutSession.mockResolvedValue(confirmedSession({ buyer_account_id: "acc_guest" }));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });

    const result = await buyCheckoutConfirmationLoader({
      request: new Request("http://localhost/checkout/buy/session/chk_1/confirmation"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(result).toEqual(expect.objectContaining({ paymentPath: "/checkout/payments/pay_1" }));
  });

  it("returns active sessions without payment to checkout review", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", roleKey: "owner", permissions: [] });
    mockGetCheckoutSession.mockResolvedValue(confirmedSession({ payment_id: null, order_ids: [] }));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });

    const redirectResponse = (await buyCheckoutConfirmationLoader({
      request: new Request("http://localhost/checkout/buy/session/chk_1/confirmation"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never).catch((error) => error)) as Response;

    expect(redirectResponse.status).toBe(302);
    expect(redirectResponse.headers.get("Location")).toBe("/checkout/buy/session/chk_1");
  });
});
