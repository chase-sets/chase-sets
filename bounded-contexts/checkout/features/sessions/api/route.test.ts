import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckoutApiEnv } from "../../../api";
import type { CheckoutSessionServices } from "./runtime";

const {
  mockCreateCheckoutOrdersThroughOrdering,
  mockCreateCheckoutPaymentThroughPayments,
} = vi.hoisted(() => ({
  mockCreateCheckoutOrdersThroughOrdering: vi.fn(),
  mockCreateCheckoutPaymentThroughPayments: vi.fn(),
}));

vi.mock("../../../support/request-support/checkout-confirmation", () => ({
  createCheckoutOrdersThroughOrdering: mockCreateCheckoutOrdersThroughOrdering,
  createCheckoutPaymentThroughPayments: mockCreateCheckoutPaymentThroughPayments,
  normalizeRequestedBalanceCreditAmount: (value: unknown) =>
    value === null || value === undefined ? null : String(value),
}));

import { createAccountCheckoutSessionRoutes } from "./route";
import type { CheckoutSessionRow } from "../read-model/queries";

const shippingAddress = {
  name: "Jane Smith",
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
} as const;

function buildApp(
  services: CheckoutSessionServices,
  actor: CheckoutApiEnv["Variables"]["actor"] = {
    sessionId: "ses_1",
    tenantId: "tnt_identity",
    userId: "usr_1",
    accountId: "acc_buyer",
    membershipId: "mbr_1",
    roleKey: "owner",
    permissions: ["orders.view", "orders.manage"],
  },
) {
  const app = new Hono<CheckoutApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", {
      tenantId: "tnt_identity" as never,
      audit: {
        performedByUserId: actor?.userId as never,
        forAccountId: actor?.accountId as never,
      },
    });
    await next();
  });

  app.route("/account", createAccountCheckoutSessionRoutes(services));
  return app;
}

function createSession(
  overrides: Partial<CheckoutSessionRow> = {},
): CheckoutSessionRow {
  return {
    session_id: "chk_1",
    buyer_account_id: "acc_buyer",
    source_type: "cart",
    shipping_option: "standard",
    lines: [
      {
        listingId: null,
        cartLineId: "cli_1",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
      },
    ],
    shipping_address: shippingAddress,
    order_ids: [],
    payment_id: null,
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    ...overrides,
  };
}

function createServices(
  overrides: Partial<CheckoutSessionServices> = {},
): CheckoutSessionServices {
  return {
    commandHandler: vi.fn() as never,
    createFromCart: vi.fn(async () => ({ sessionId: "chk_cart" as never })),
    createBuyNow: vi.fn(async () => ({ sessionId: "chk_buy_now" as never })),
    selectShippingOption: vi.fn(async ({ sessionId }) => ({ sessionId })),
    setShippingAddress: vi.fn(async ({ sessionId }) => ({ sessionId })),
    recordOrdersCreated: vi.fn(async ({ sessionId }) => ({ sessionId })),
    recordPaymentStarted: vi.fn(async ({ sessionId }) => ({ sessionId })),
    getSession: vi.fn(async () => createSession()),
    projectors: [],
    ...overrides,
  };
}

describe("checkout session routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockCreateCheckoutOrdersThroughOrdering.mockReset();
    mockCreateCheckoutPaymentThroughPayments.mockReset();
  });

  it("returns cart session validation errors from checkout", async () => {
    const services = createServices({
      createFromCart: vi.fn(async () => {
        throw new Error("Cart must contain at least one line.");
      }),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: { type: "cart" } }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "validation_failed",
        message: "Cart must contain at least one line.",
      },
    });
  });

  it("normalizes buy-now session payloads into checkout-owned session creation", async () => {
    const services = createServices();
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: {
            type: "buy-now",
            listingId: "lst_1",
            catalogItemId: "cat_1",
            productId: "cat_1::form:raw",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
            productSummary: "Raw",
            quantity: 2,
          },
          shippingOption: "priority",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      session_id: "chk_buy_now",
      status: "started",
    });
    expect(services.createBuyNow).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_buyer",
        listingId: "lst_1",
        productId: "cat_1::form:raw",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        quantity: 2,
        shippingOption: "priority",
      }),
      expect.any(Object),
    );
  });

  it("records shipping selection on the checkout session", async () => {
    const services = createServices();
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/shipping-option", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingOption: "expedited" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session_id: "chk_1",
      status: "shipping-option-selected",
    });
    expect(services.selectShippingOption).toHaveBeenCalledWith(
      {
        sessionId: "chk_1",
        accountId: "acc_buyer",
        shippingOption: "expedited",
      },
      expect.any(Object),
    );
  });

  it("confirms a new checkout session by recording orders and payment", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue("pay_1");
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingAddress }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      payment_id: "pay_1",
      order_ids: ["ord_1"],
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).toHaveBeenCalledTimes(1);
    expect(services.recordOrdersCreated).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chk_1", orderIds: ["ord_1"] }),
      expect.any(Object),
    );
    expect(mockCreateCheckoutPaymentThroughPayments).toHaveBeenCalledWith(
      expect.any(Request),
      "chk_1",
      ["ord_1"],
      null,
      "card",
      null,
      "/account/payments/:paymentId",
    );
    expect(services.recordPaymentStarted).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chk_1", paymentId: "pay_1" }),
      expect.any(Object),
    );
  });

  it("retries payment recording without recreating orders", async () => {
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue("pay_existing");
    const services = createServices({
      getSession: vi.fn(async () =>
        createSession({ order_ids: ["ord_existing"], payment_id: null }),
      ),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingAddress }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(services.recordOrdersCreated).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).toHaveBeenCalledWith(
      expect.any(Request),
      "chk_1",
      ["ord_existing"],
      null,
      "card",
      null,
      "/account/payments/:paymentId",
    );
    expect(services.recordPaymentStarted).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay_existing" }),
      expect.any(Object),
    );
  });

  it("passes requested balance credit when confirming checkout", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue("pay_1");
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestedBalanceCreditAmount: "8.50",
          paymentMethodCategory: "bank-account",
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
          shippingAddress,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCreateCheckoutPaymentThroughPayments).toHaveBeenCalledWith(
      expect.any(Request),
      "chk_1",
      ["ord_1"],
      "8.50",
      "bank-account",
      "quote_1",
      "/account/payments/:paymentId",
    );
  });

  it("uses the guest payment return path when confirming guest checkout", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue("pay_1");
    const services = createServices({
      getSession: vi.fn(async () => createSession({ buyer_account_id: "acc_guest" })),
    });
    const app = buildApp(services, {
      sessionId: "guest:tok_1",
      tenantId: "tnt_identity",
      userId: "usr_guest_checkout",
      accountId: "acc_guest",
      membershipId: "guest:tok_1",
      roleKey: "guest-buyer",
      permissions: ["guest-checkout.manage"],
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingAddress }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCreateCheckoutPaymentThroughPayments).toHaveBeenCalledWith(
      expect.any(Request),
      "chk_1",
      ["ord_1"],
      null,
      "card",
      null,
      "/checkout/payments/:paymentId",
    );
  });

  it("returns a sign-in-required code when limited listings cannot be confirmed as guest", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockRejectedValue(
      Object.assign(
        new Error("Sign in is required to confirm checkout for listings with daily or customer purchase limits."),
        {
          body: {
            error: {
              code: "account_sign_in_required",
              message: "Sign in is required to confirm checkout for listings with daily or customer purchase limits.",
            },
          },
        },
      ),
    );
    const services = createServices({
      getSession: vi.fn(async () => createSession({ buyer_account_id: "acc_guest" })),
    });
    const app = buildApp(services, {
      sessionId: "guest:tok_1",
      tenantId: "tnt_identity",
      userId: "usr_guest_checkout",
      accountId: "acc_guest",
      membershipId: "guest:tok_1",
      roleKey: "guest-buyer",
      permissions: ["guest-checkout.manage"],
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingAddress }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "account_sign_in_required",
        message: "Sign in is required to confirm checkout for listings with daily or customer purchase limits.",
      },
    });
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
  });

  it("returns an existing checkout payment without re-running confirmation", async () => {
    const services = createServices({
      getSession: vi.fn(async () =>
        createSession({ order_ids: ["ord_1"], payment_id: "pay_1" }),
      ),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      payment_id: "pay_1",
      order_ids: ["ord_1"],
      status: "confirmed",
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
  });
});
