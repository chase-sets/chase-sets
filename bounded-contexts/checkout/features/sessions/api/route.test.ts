import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckoutApiEnv } from "../../../api";
import type { CheckoutSessionServices } from "./runtime";

const {
  mockCreateCheckoutOrdersThroughOrdering,
  mockCreateCheckoutPaymentThroughPayments,
  mockSubmitPurchaseIntentThroughMarketplace,
} = vi.hoisted(() => ({
  mockCreateCheckoutOrdersThroughOrdering: vi.fn(),
  mockCreateCheckoutPaymentThroughPayments: vi.fn(),
  mockSubmitPurchaseIntentThroughMarketplace: vi.fn(),
}));

vi.mock("../../../support/request-support/checkout-confirmation", () => ({
  createCheckoutOrdersThroughOrdering: mockCreateCheckoutOrdersThroughOrdering,
  createCheckoutPaymentThroughPayments: mockCreateCheckoutPaymentThroughPayments,
  submitPurchaseIntentThroughMarketplace: mockSubmitPurchaseIntentThroughMarketplace,
  normalizeRequestedBalanceCreditAmount: (value: unknown) =>
    value === null || value === undefined ? null : String(value),
}));

import { createAccountCheckoutSessionRoutes } from "./route";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
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

function createSession(overrides: Partial<CheckoutSessionRow> = {}): CheckoutSessionRow {
  return {
    session_id: "chk_1",
    buyer_account_id: "acc_buyer",
    source_type: "cart",
    optimization_goal: "lowest-total",
    fulfillment_preview_revision: null,
    shipping_option: "standard",
    shipping_address_id: null,
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
    submitted_offer_id: null,
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    ...overrides,
  };
}

function createServices(overrides: Partial<CheckoutSessionServices> = {}): CheckoutSessionServices {
  const mutationResult = (sessionId: string) => ({ sessionId, session: createSession({ session_id: sessionId }) });

  return {
    commandHandler: vi.fn() as never,
    createFromCart: vi.fn(async () => ({ sessionId: "chk_cart" as never })),
    createBuyNow: vi.fn(async () => ({ sessionId: "chk_buy_now" as never })),
    createOfferIntent: vi.fn(async () => ({ sessionId: "chk_offer" as never })),
    selectOptimizationGoal: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordFulfillmentPreview: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    selectShippingOption: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    setShippingAddress: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordOrdersCreated: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordPaymentStarted: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordOfferSubmitted: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
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
    mockSubmitPurchaseIntentThroughMarketplace.mockReset();
  });

  it("returns cart session validation errors from checkout", async () => {
    const services = createServices({
      createFromCart: vi.fn(async () => {
        throw new CheckoutDomainError("Cart must contain at least one line.", "cart_empty");
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
        code: "cart_empty",
        message: "Cart must contain at least one line.",
      },
    });
  });

  it("passes cart readiness snapshot evidence into cart checkout creation", async () => {
    const services = createServices();
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: {
            type: "cart",
            readinessSnapshotId: "cr_ready",
            readinessSourceRevision: "cr_source",
            readinessDecisions: {
              optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" },
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.createFromCart).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_buyer",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: {
          lineOutcomes: [],
          optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" },
        },
      }),
      expect.any(Object),
    );
  });

  it("normalizes buy-now session payloads into checkout-owned session creation", async () => {
    const services = createServices({
      createBuyNow: vi.fn(async () => ({
        sessionId: "chk_buy_now" as never,
        commitPosition: "42",
        commitEventIds: ["evt_checkout_session_started"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "42",
            eventIds: ["evt_checkout_session_started"],
          },
        ],
      })),
    });
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
      commitPosition: "42",
      commitEventIds: ["evt_checkout_session_started"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "42",
          eventIds: ["evt_checkout_session_started"],
        },
      ],
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

  it("normalizes offer-intent payloads into checkout-owned session creation", async () => {
    const services = createServices();
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: {
            type: "offer-intent",
            catalogItemId: "cat_1",
            productId: "cat_1::form:raw",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
            productSummary: "Raw",
            offerPriceAmount: "350.00",
            quantity: 2,
          },
          shippingOption: "priority",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      session_id: "chk_offer",
      status: "started",
    });
    expect(services.createOfferIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_buyer",
        productId: "cat_1::form:raw",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        offerPriceAmount: "350.00",
        quantity: 2,
        shippingOption: "priority",
      }),
      expect.any(Object),
    );
  });

  it("blocks guest actors from starting offer-intent sessions", async () => {
    const services = createServices();
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
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: {
            type: "offer-intent",
            catalogItemId: "cat_1",
            productId: "cat_1::form:raw",
            itemTitle: "Charizard",
            selectedOptions: [],
            offerPriceAmount: "350.00",
            quantity: 1,
          },
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "account_registration_required",
        message: "Register or sign in before placing purchase intent.",
      },
    });
    expect(services.createOfferIntent).not.toHaveBeenCalled();
  });

  it("allows signed-in buyers without order-management permissions to start buy-now sessions", async () => {
    const services = createServices();
    const app = buildApp(services, {
      sessionId: "ses_1",
      tenantId: "tnt_identity",
      userId: "usr_1",
      accountId: "acc_buyer",
      membershipId: "mbr_1",
      roleKey: "viewer",
      permissions: [],
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: {
            type: "buy-now",
            listingId: "",
            catalogItemId: "cat_1",
            productId: "cat_1::form:raw",
            itemTitle: "Charizard",
            selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
            quantity: 1,
          },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.createBuyNow).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_buyer",
        productId: "cat_1::form:raw",
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_buyer",
          performedByUserId: "usr_1",
        }),
      }),
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
        body: JSON.stringify({ shippingAddress, marketplaceCheckoutFeeQuoteFingerprint: "quote_1" }),
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
      "quote_1",
      null,
      false,
      "/account/payments/:paymentId",
    );
    expect(services.recordPaymentStarted).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chk_1", paymentId: "pay_1" }),
      expect.any(Object),
    );
  });

  it("can defer payment so signed-in checkout reviews exact fees before payment creation", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress,
          deferPayment: true,
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      order_ids: ["ord_1"],
      status: "orders-created",
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).toHaveBeenCalledTimes(1);
    expect(services.recordOrdersCreated).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chk_1", orderIds: ["ord_1"] }),
      expect.any(Object),
    );
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("allows production proof order creation to defer payment before fee quote review", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress,
          deferPayment: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      order_ids: ["ord_1"],
      status: "orders-created",
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).toHaveBeenCalledTimes(1);
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("rejects non-deferred payment confirmation before committing orders when fee quote is missing", async () => {
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

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "payment_quote_required",
        message: "Review the latest payment quote before creating purchases.",
      },
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
  });

  it("retries payment recording without recreating orders", async () => {
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue("pay_existing");
    const sessionWithOrders = createSession({ order_ids: ["ord_existing"], payment_id: null });
    const services = createServices({
      getSession: vi.fn(async () => sessionWithOrders),
      setShippingAddress: vi.fn(async ({ sessionId }) => ({ sessionId, session: sessionWithOrders })),
      recordPaymentStarted: vi.fn(async ({ sessionId }) => ({
        sessionId,
        session: createSession({ order_ids: ["ord_existing"], payment_id: "pay_existing" }),
      })),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingAddress, marketplaceCheckoutFeeQuoteFingerprint: "quote_1" }),
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
      "quote_1",
      null,
      false,
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
      null,
      false,
      "/account/payments/:paymentId",
    );
  });

  it("submits purchase intent through Marketplace without creating orders or payment", async () => {
    mockSubmitPurchaseIntentThroughMarketplace.mockResolvedValue("off_chk_1");
    const offerIntentSession = createSession({
      source_type: "offer-intent",
      lines: [
        {
          listingId: null,
          cartLineId: null,
          catalogItemId: "cat_1",
          productId: "cat_1::form:raw",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Raw",
          offerPriceAmount: "350.00",
          quantity: 1,
          availabilityState: "waiting-for-supply",
        },
      ],
    });
    const services = createServices({
      getSession: vi.fn(async () => offerIntentSession),
      setShippingAddress: vi.fn(async ({ sessionId }) => ({ sessionId, session: offerIntentSession })),
      recordOfferSubmitted: vi.fn(async ({ sessionId }) => ({
        sessionId,
        session: { ...offerIntentSession, submitted_offer_id: "off_chk_1" },
      })),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingAddress, marketplaceCheckoutFeeQuoteFingerprint: "quote_1" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      offer_id: "off_chk_1",
      status: "purchase-intent-submitted",
    });
    expect(mockSubmitPurchaseIntentThroughMarketplace).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ source_type: "offer-intent" }),
    );
    expect(services.recordOfferSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chk_1", offerId: "off_chk_1" }),
      expect.any(Object),
    );
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
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
        body: JSON.stringify({ shippingAddress, marketplaceCheckoutFeeQuoteFingerprint: "quote_1" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCreateCheckoutPaymentThroughPayments).toHaveBeenCalledWith(
      expect.any(Request),
      "chk_1",
      ["ord_1"],
      null,
      "card",
      "quote_1",
      null,
      false,
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
        body: JSON.stringify({ shippingAddress, marketplaceCheckoutFeeQuoteFingerprint: "quote_1" }),
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
      getSession: vi.fn(async () => createSession({ order_ids: ["ord_1"], payment_id: "pay_1" })),
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
