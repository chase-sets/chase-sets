import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
  freshCheckoutRequest,
  guestCheckoutActor,
  MockCheckoutApiError,
  mockCreateAuthRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockCreateIdentityRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateOrderingRequestApiClient,
  mockCreatePaymentsRequestApiClient,
  mockCreateSettlementRequestApiClient,
  mockGetCheckoutSession,
  mockGetGuestCheckoutClaimContext,
  MockMarketplaceApiError,
  mockPreviewCheckoutFulfillment,
  mockPreviewCheckoutStatus,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
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

import { loader as checkoutSessionLoader } from "./checkout-session";

describe("checkout web routes: checkout session loader", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps checkout visible when checkout totals are temporarily unavailable", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetCheckoutSession.mockResolvedValue({
      session_id: "chk_1",
      source_type: "buy-now",
      payment_id: null,
      submitted_offer_id: null,
      shipping_option: "standard",
      optimization_goal: "lowest-total",
      fulfillment_preview_revision: null,
      order_ids: [],
      lines: [
        {
          listingId: null,
          cartLineId: null,
          catalogItemId: "cat_1",
          productId: "prd_1",
          itemTitle: "Test card",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
        },
      ],
    });
    mockPreviewCheckoutFulfillment.mockRejectedValue(new Error("preview unavailable"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });

    const result = await checkoutSessionLoader({
      request: new Request("http://localhost/checkout/buy/session/chk_1"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        fulfillmentPreview: null,
        previewError: "Checkout totals are temporarily unavailable. Refresh before confirming payment.",
      }),
    );
    expect(mockPreviewCheckoutFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "chk_1",
        sourceType: "buy-now",
      }),
    );
  });

  it("passes safe checkout edit section query state to the checkout page", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetCheckoutSession.mockResolvedValue({
      session_id: "chk_1",
      source_type: "buy-now",
      payment_id: null,
      submitted_offer_id: null,
      shipping_option: "standard",
      optimization_goal: "lowest-total",
      fulfillment_preview_revision: null,
      order_ids: [],
      lines: [
        {
          listingId: "lst_1",
          cartLineId: null,
          catalogItemId: "cat_1",
          productId: "prd_1",
          itemTitle: "Test card",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
        },
      ],
    });
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "rev_1",
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
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });

    const result = await checkoutSessionLoader({
      request: new Request("http://localhost/checkout/buy/session/chk_1?edit=delivery"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(result.initialEditSection).toBe("delivery");
  });

  it("ignores unsafe checkout edit section query state", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetCheckoutSession.mockResolvedValue({
      session_id: "chk_1",
      source_type: "buy-now",
      payment_id: null,
      submitted_offer_id: null,
      shipping_option: "standard",
      optimization_goal: "lowest-total",
      fulfillment_preview_revision: null,
      order_ids: [],
      lines: [
        {
          listingId: "lst_1",
          cartLineId: null,
          catalogItemId: "cat_1",
          productId: "prd_1",
          itemTitle: "Test card",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
        },
      ],
    });
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "rev_1",
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
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });

    const result = await checkoutSessionLoader({
      request: new Request("http://localhost/checkout/buy/session/chk_1?edit=provider-payload"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(result.initialEditSection).toBeNull();
  });

  it("loads a Payments-owned checkout fee preview before order creation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockGetCheckoutSession.mockResolvedValue({
      session_id: "chk_1",
      source_type: "buy-now",
      payment_id: null,
      submitted_offer_id: null,
      shipping_option: "standard",
      shipping_address: null,
      optimization_goal: "lowest-total",
      fulfillment_preview_revision: null,
      order_ids: [],
      lines: [
        {
          listingId: "lst_1",
          cartLineId: null,
          catalogItemId: "cat_1",
          productId: "prd_1",
          itemTitle: "Test card",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
        },
      ],
    });
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "rev_1",
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
    });
    mockPreviewCheckoutStatus.mockResolvedValue({
      amount: "26.00",
      marketplace_checkout_fee: { total_amount: "27.10" },
      wallet_credit: { applied_amount: "0.00" },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });
    mockCreatePaymentsRequestApiClient.mockReturnValue({
      previewCheckoutStatus: mockPreviewCheckoutStatus,
    });

    const result = await checkoutSessionLoader({
      request: new Request("http://localhost/checkout/buy/session/chk_1"),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(mockPreviewCheckoutStatus).toHaveBeenCalledWith({
      amount: "26.00",
      currencyCode: "usd",
      requestedBalanceCreditAmount: "0.00",
      paymentMethodCategory: "card",
    });
    expect(result.paymentPreview).toEqual({
      amount: "26.00",
      marketplace_checkout_fee: { total_amount: "27.10" },
      wallet_credit: { applied_amount: "0.00" },
    });
  });

  it("loads Auth-owned guest checkout contact as checkout defaults", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockGetCheckoutSession.mockResolvedValue({
      session_id: "chk_1",
      source_type: "buy-now",
      payment_id: null,
      submitted_offer_id: null,
      shipping_option: "standard",
      shipping_address: null,
      optimization_goal: "lowest-total",
      fulfillment_preview_revision: null,
      order_ids: [],
      lines: [
        {
          listingId: "lst_1",
          cartLineId: null,
          catalogItemId: "cat_1",
          productId: "prd_1",
          itemTitle: "Test card",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
        },
      ],
    });
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "rev_1",
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
    });
    mockPreviewCheckoutStatus.mockResolvedValue({
      amount: "26.00",
      marketplace_checkout_fee: { total_amount: "27.10" },
      wallet_credit: { applied_amount: "0.00" },
    });
    mockGetGuestCheckoutClaimContext.mockResolvedValue({
      contactName: "Jane Smith",
      contactEmail: " Jane@Example.com ",
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: mockGetCheckoutSession,
    });
    mockCreateOrderingRequestApiClient.mockReturnValue({
      previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    });
    mockCreatePaymentsRequestApiClient.mockReturnValue({
      previewCheckoutStatus: mockPreviewCheckoutStatus,
    });
    mockCreateAuthRequestApiClient.mockReturnValue({
      getGuestCheckoutClaimContext: mockGetGuestCheckoutClaimContext,
    });

    const result = await checkoutSessionLoader({
      request: new Request("http://localhost/checkout/buy/session/chk_1", {
        headers: { cookie: "chase_sets_guest_checkout=guest_token" },
      }),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(mockGetGuestCheckoutClaimContext).toHaveBeenCalledWith({});
    expect(result.guestCheckoutContact).toEqual({
      contactName: "Jane Smith",
      contactEmail: "jane@example.com",
    });
  });

  it("returns checkout-owned recovery when checkout access is missing", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(401, {
          error: { code: "authentication_required", message: "Authentication required." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/buy/session/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(401);
    expect(recoveryResponse?.statusText).toBe("Checkout access required");
    await expect(recoveryResponse?.text()).resolves.toContain("checkout access is not active in this browser");
  });

  it("returns checkout-owned recovery when guest checkout access is expired", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(401, {
          error: { code: "authentication_required", message: "Authentication required." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/buy/session/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(401);
    expect(recoveryResponse?.statusText).toBe("Guest checkout access expired");
    await expect(recoveryResponse?.text()).resolves.toContain("guest checkout link is no longer active");
  });

  it("redirects guest checkout session ownership mismatch to the guest checkout continuation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(403, {
          error: { code: "authorization_forbidden", message: "Forbidden." },
        });
      }),
    });

    let redirectResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/buy/session/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      redirectResponse = error as Response;
    }

    expect(redirectResponse?.status).toBe(302);
    expect(redirectResponse?.headers.get("Location")).toBe("/checkout/buy/readiness");
    const body = redirectResponse ? await redirectResponse.text() : "";
    expect(body).not.toContain("Checkout belongs to another account");
    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockPreviewCheckoutStatus).not.toHaveBeenCalled();
  });

  it("returns checkout-owned recovery when the signed-in checkout belongs to another account", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_other", permissions: [] });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(403, {
          error: { code: "authorization_forbidden", message: "Forbidden." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/buy/session/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(403);
    expect(recoveryResponse?.statusText).toBe("Checkout belongs to another account");
    await expect(recoveryResponse?.text()).resolves.toContain("Sign in with the account that started this checkout");
  });

  it("returns checkout-owned recovery when the checkout session is not found", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(404, {
          error: { code: "not_found", message: "Checkout session not found." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/buy/session/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(404);
    expect(recoveryResponse?.statusText).toBe("Checkout session not found.");
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      description?: string;
      primaryAction?: { href?: string };
    };
    expect(recoveryBody.description).toContain("We could not find this checkout session.");
    expect(recoveryBody.primaryAction?.href).toBe("/search");
  });

  it("returns cart recovery when active cart readiness is stale on checkout reload", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(400, {
          error: {
            code: "readiness_snapshot_stale",
            message: "Cart readiness changed. Review your cart before checkout.",
          },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/buy/session/chk_1"),
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
      description?: string;
      primaryAction?: { href?: string; label?: string };
      trustCue?: string;
    };
    expect(recoveryBody.kind).toBe("request-validation");
    expect(recoveryBody.description).toContain("Review your Buy Cart or browse for another item.");
    expect(recoveryBody.trustCue).toBe("Your payment has not started.");
    expect(recoveryBody.primaryAction?.href).toBe("/account/cart");
    expect(recoveryBody.primaryAction?.label).toBe("View Buy Cart");
    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockPreviewCheckoutStatus).not.toHaveBeenCalled();
  });

  it("returns safe checkout recovery for expired fresh checkout handoffs", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(404, {
          error: { code: "not_found", message: "Checkout session not found." },
        });
      }),
    });
    const expiredPath = appendFreshWriteToken("/checkout/buy/session/chk_1", checkoutCommit("42", "evt_checkout"), 1);

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request(`http://localhost${expiredPath}`),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(410);
    expect(recoveryResponse?.statusText).toBe("Checkout needs a fresh start");
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      description?: string;
      primaryAction?: { href?: string };
      secondaryAction?: { href?: string };
      trustCue?: string;
    };
    expect(recoveryBody.description).toContain("took longer than expected");
    expect(recoveryBody.trustCue).toBe("Your payment has not started.");
    expect(recoveryBody.primaryAction?.href).toBe("/account/cart");
    expect(recoveryBody.secondaryAction?.href).toBe("/search");
  });

  it("returns permanent checkout recovery for malformed fresh checkout handoffs", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(404, {
          error: { code: "not_found", message: "Checkout session not found." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/buy/session/chk_1?afterWrite=%7Bnot-json"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(404);
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      description?: string;
      primaryAction?: { href?: string };
    };
    expect(recoveryBody.description).toContain("We could not find this checkout session.");
    expect(recoveryBody.primaryAction?.href).toBe("/search");
  });

  it("returns temporary recovery when a fresh checkout handoff has not projected yet", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(404, {
          error: { code: "not_found", message: "Checkout session not found." },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: freshCheckoutRequest(),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(202);
    expect(recoveryResponse?.statusText).toBe("Preparing checkout");
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      description?: string;
      primaryAction?: { href?: string; label?: string };
      trustCue?: string;
    };
    expect(recoveryBody.description).toContain("getting your checkout ready");
    expect(recoveryBody.trustCue).toBe("Your payment has not started.");
    expect(recoveryBody.primaryAction?.href).toContain("/checkout/buy/session/chk_1?afterWrite=");
    expect(recoveryBody.primaryAction?.label).toBe("Refresh checkout");
  });

  it("returns temporary recovery when a fresh checkout handoff hits projection freshness timeout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(503, {
          error: {
            code: "projection_freshness_timeout",
            message: "Projection read model did not catch up before the freshness timeout.",
          },
        });
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: freshCheckoutRequest(),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(202);
    expect(recoveryResponse?.statusText).toBe("Preparing checkout");
    await expect(recoveryResponse?.text()).resolves.toContain("Refresh checkout");
  });

  it("returns temporary recovery when a fresh checkout handoff hits an opaque gateway timeout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(504, null);
      }),
    });

    let recoveryResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: freshCheckoutRequest(),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      recoveryResponse = error as Response;
    }

    expect(recoveryResponse?.status).toBe(202);
    expect(recoveryResponse?.statusText).toBe("Preparing checkout");
    const recoveryBody = JSON.parse((await recoveryResponse?.text()) ?? "{}") as {
      primaryAction?: { href?: string; label?: string };
      trustCue?: string;
    };
    expect(recoveryBody.primaryAction?.href).toContain("/checkout/buy/session/chk_1?afterWrite=");
    expect(recoveryBody.primaryAction?.label).toBe("Refresh checkout");
    expect(recoveryBody.trustCue).toBe("Your payment has not started.");
  });

  it("retries a fresh checkout handoff until the session read model appears", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    const getCheckoutSession = vi
      .fn()
      .mockRejectedValueOnce(
        new MockCheckoutApiError(404, {
          error: { code: "not_found", message: "Checkout session not found." },
        }),
      )
      .mockResolvedValue({
        session_id: "chk_1",
        buyer_account_id: "acc_guest",
        source_type: "offer-intent",
        payment_id: null,
        submitted_offer_id: null,
        shipping_option: "standard",
        shipping_address: null,
        optimization_goal: "lowest-total",
        fulfillment_preview_revision: null,
        order_ids: [],
        lines: [],
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession,
    });

    const result = await checkoutSessionLoader({
      request: freshCheckoutRequest(),
      params: { sessionId: "chk_1" },
      context: undefined,
    } as never);

    expect(getCheckoutSession).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          session_id: "chk_1",
          buyer_account_id: "acc_guest",
        }),
      }),
    );
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
        request: new Request("http://localhost/checkout/buy/session/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      redirectResponse = error as Response;
    }

    expect(redirectResponse?.status).toBe(302);
    expect(redirectResponse?.headers.get("Location")).toBe("/account/payments/pay_1");
  });

  it("redirects submitted purchase-intent sessions to the submitted offer", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCheckoutSession: vi.fn(async () => ({
        session_id: "chk_1",
        buyer_account_id: "acc_buyer",
        source_type: "offer-intent",
        shipping_option: "standard",
        lines: [],
        order_ids: [],
        payment_id: null,
        submitted_offer_id: "off_chk_1",
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      })),
    });

    let redirectResponse: Response | null = null;
    try {
      await checkoutSessionLoader({
        request: new Request("http://localhost/checkout/buy/session/chk_1"),
        params: { sessionId: "chk_1" },
        context: undefined,
      } as never);
    } catch (error) {
      redirectResponse = error as Response;
    }

    expect(redirectResponse?.status).toBe(302);
    expect(redirectResponse?.headers.get("Location")).toBe(
      "/account/offers/submitted/off_chk_1?feedbackWorkflow=offer-submit",
    );
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
        request: new Request("http://localhost/checkout/buy/session/chk_1"),
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
