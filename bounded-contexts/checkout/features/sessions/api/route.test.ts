import {
  createAccountUserTestActor,
  createTestApp,
  type TestActorOverrides,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it, vi } from "vitest";
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
import type { CheckoutObservabilityTelemetry } from "./checkout-observability-telemetry";

const shippingAddress = {
  name: "Jane Smith",
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
} as const;

function createGuestBuyerActor(): CheckoutApiEnv["Variables"]["actor"] {
  return createAccountUserTestActor({
    sessionId: "guest:tok_1",
    userId: "usr_guest_checkout",
    accountId: "acc_guest",
    membershipId: "guest:tok_1",
    roleKey: "guest-buyer",
    permissions: ["guest-checkout.manage"],
  }) as NonNullable<CheckoutApiEnv["Variables"]["actor"]>;
}

function createBuyerActor(overrides: TestActorOverrides = {}): NonNullable<CheckoutApiEnv["Variables"]["actor"]> {
  return createAccountUserTestActor({
    sessionId: "ses_1",
    userId: "usr_1",
    accountId: "acc_buyer",
    membershipId: "mbr_1",
    permissions: ["orders.view", "orders.manage"],
    ...overrides,
  }) as NonNullable<CheckoutApiEnv["Variables"]["actor"]>;
}

function buildApp(
  services: CheckoutSessionServices,
  actor: CheckoutApiEnv["Variables"]["actor"] = createBuyerActor(),
  checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry,
) {
  return createTestApp<CheckoutApiEnv>({
    actor,
    routes: (app) => {
      app.route("/account", createAccountCheckoutSessionRoutes(services, checkoutObservabilityTelemetry));
    },
  });
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
    assertReadyForOrderCreation: vi.fn(async ({ sessionId }) => createSession({ session_id: sessionId })),
    recordOrdersCreated: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordPaymentStarted: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordOfferSubmitted: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    getSession: vi.fn(async () => createSession()),
    projectors: [],
    ...overrides,
  };
}

function expectNoCheckoutConfirmSideEffects(services: CheckoutSessionServices) {
  expect(services.getSession).not.toHaveBeenCalled();
  expect(services.setShippingAddress).not.toHaveBeenCalled();
  expect(services.assertReadyForOrderCreation).not.toHaveBeenCalled();
  expect(services.recordOrdersCreated).not.toHaveBeenCalled();
  expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
  expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
}

useMockReset(
  mockCreateCheckoutOrdersThroughOrdering,
  mockCreateCheckoutPaymentThroughPayments,
  mockSubmitPurchaseIntentThroughMarketplace,
);

describe("checkout session routes", () => {
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

  it("returns active-session readiness validation errors from checkout reload", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices({
      getSession: vi.fn(async () => {
        throw new CheckoutDomainError(
          "Cart readiness changed. Review your cart before checkout.",
          "readiness_snapshot_stale",
        );
      }),
    });
    const app = buildApp(services, undefined, checkoutObservabilityTelemetry);

    const response = await app.fetch(new Request("http://checkout.test/account/checkout-sessions/chk_1"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "readiness_snapshot_stale",
        message: "Cart readiness changed. Review your cart before checkout.",
      },
    });
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.session.active_stale_recovery",
        actorMode: "signed-in",
        entrySource: "active-session",
        scenarioState: "active-session-stale",
        visibleState: "checkout-permanent-recovery-visible",
        sideEffectStatus: "not-attempted",
        readinessContract: "checkout.session-read-model",
        readinessSnapshotState: "stale",
        sourceRevisionState: "stale",
        supportReferencePresent: false,
        launchDecision: "blocked",
      }),
    );
  });

  it("does not convert unexpected active-session reload failures into validation errors", async () => {
    const services = createServices({
      getSession: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    const app = buildApp(services);

    const response = await app.fetch(new Request("http://checkout.test/account/checkout-sessions/chk_1"));

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("validation_failed");
  });

  it("emits signed-in buy checkout review telemetry without raw identifiers", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices({
      getSession: vi.fn(async () =>
        createSession({
          cart_readiness_snapshot: { snapshotId: "cr_ready", sourceRevision: "cart_rev_1" } as never,
        }),
      ),
    });
    const app = buildApp(services, undefined, checkoutObservabilityTelemetry);

    const response = await app.fetch(new Request("http://checkout.test/account/checkout-sessions/chk_1"));

    expect(response.status).toBe(200);
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.buy.signed_in_review_rendered",
        actorMode: "signed-in",
        entrySource: "buy-cart-readiness",
        scenarioState: "normal",
        visibleState: "checkout-review-visible",
        sideEffectStatus: "forbidden-before-confirm",
        readinessContract: "checkout.cart-readiness.v1",
        readinessSnapshotState: "fresh",
        sourceRevisionState: "current",
        supportReferencePresent: false,
        downstreamStatus: "not-started",
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("chk_1");
    expect(emitted).not.toContain("acc_buyer");
    expect(emitted).not.toContain("cr_ready");
  });

  it("emits guest buy-now checkout review telemetry", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices({
      getSession: vi.fn(async () => createSession({ source_type: "buy-now" })),
    });
    const app = buildApp(services, createGuestBuyerActor(), checkoutObservabilityTelemetry);

    const response = await app.fetch(new Request("http://checkout.test/account/checkout-sessions/chk_1"));

    expect(response.status).toBe(200);
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.buy.guest_review_rendered",
        actorMode: "guest",
        entrySource: "buy-now",
        readinessContract: "checkout.session-read-model",
        readinessSnapshotState: "not-applicable",
        supportReferencePresent: false,
      }),
    );
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

  it("rejects buy-now session creation without assigned fulfillment", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices();
    const app = buildApp(services, undefined, checkoutObservabilityTelemetry);

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

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unresolved_fulfillment",
        message: "Resolve item availability before checkout starts.",
      },
    });
    expect(services.createBuyNow).not.toHaveBeenCalled();
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.readiness.unassigned_fulfillment",
        scenarioState: "unassigned-fulfillment",
        visibleState: "readiness-decision-visible",
        sideEffectStatus: "not-attempted",
        downstreamStatus: "not-started",
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("chk_");
    expect(emitted).not.toContain("acc_buyer");
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
    const app = buildApp(services, createGuestBuyerActor());

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
    const app = buildApp(services, createBuyerActor({ roleKey: "viewer", permissions: [] }));

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
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue("pay_1");
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
    });
    const app = buildApp(services, undefined, checkoutObservabilityTelemetry);

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
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.reconciliation.pending_visible",
        actorMode: "signed-in",
        entrySource: "buy-cart-readiness",
        scenarioState: "pending-downstream",
        visibleState: "support-safe-status-visible",
        sideEffectStatus: "pending-downstream",
        readinessContract: "downstream-owned-fact",
        downstreamStatus: "payment-started",
        supportReferencePresent: true,
        launchDecision: "enabled",
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("chk_1");
    expect(emitted).not.toContain("acc_buyer");
    expect(emitted).not.toContain("ord_1");
    expect(emitted).not.toContain("pay_1");
  });

  it("rejects stale active-session readiness before committing orders or payment", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices({
      getSession: vi.fn(async () => {
        throw new CheckoutDomainError(
          "Cart readiness changed. Review your cart before checkout.",
          "readiness_snapshot_stale",
        );
      }),
    });
    const app = buildApp(services, undefined, checkoutObservabilityTelemetry);

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
        code: "readiness_snapshot_stale",
        message: "Cart readiness changed. Review your cart before checkout.",
      },
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
    expect(services.setShippingAddress).not.toHaveBeenCalled();
    expect(services.recordOrdersCreated).not.toHaveBeenCalled();
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.session.active_stale_recovery",
        sideEffectStatus: "not-attempted",
        downstreamStatus: "not-started",
      }),
    );
  });

  it("rejects stale split-group handoff before creating checkout orders", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
      assertReadyForOrderCreation: vi.fn(async () => {
        throw new CheckoutDomainError(
          "Cart readiness changed. Review your cart before checkout.",
          "split_group_handoff_stale",
        );
      }),
    });
    const app = buildApp(services, undefined, checkoutObservabilityTelemetry);

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
        code: "split_group_handoff_stale",
        message: "Cart readiness changed. Review your cart before checkout.",
      },
    });
    expect(services.setShippingAddress).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chk_1", accountId: "acc_buyer" }),
      expect.any(Object),
    );
    expect(services.assertReadyForOrderCreation).toHaveBeenCalledWith({
      sessionId: "chk_1",
      accountId: "acc_buyer",
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
    expect(services.recordOrdersCreated).not.toHaveBeenCalled();
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.session.active_stale_recovery",
        sideEffectStatus: "not-attempted",
        downstreamStatus: "not-started",
      }),
    );
  });

  it("rejects restricted delivery addresses before creating checkout orders", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
      assertReadyForOrderCreation: vi.fn(async () => {
        throw new CheckoutDomainError(
          "This delivery address is not supported for the selected shipping service. Use a street address before paying.",
          "shipping_address_restricted",
        );
      }),
    });
    const app = buildApp(services, undefined, checkoutObservabilityTelemetry);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress: { ...shippingAddress, line1: "PO Box 100" },
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "shipping_address_restricted",
        message:
          "This delivery address is not supported for the selected shipping service. Use a street address before paying.",
      },
    });
    expect(services.setShippingAddress).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chk_1", accountId: "acc_buyer" }),
      expect.any(Object),
    );
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
    expect(services.recordOrdersCreated).not.toHaveBeenCalled();
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.address.serviceability_failed",
        scenarioState: "blocked",
        visibleState: "checkout-permanent-recovery-visible",
        sideEffectStatus: "not-attempted",
        providerCategory: "fulfillment",
        downstreamStatus: "not-started",
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("PO Box");
    expect(emitted).not.toContain("100");
    expect(emitted).not.toContain("chk_1");
    expect(emitted).not.toContain("acc_buyer");
  });

  it("rejects deferred customer economics input before checkout side effects", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices();
    const app = buildApp(services, undefined, checkoutObservabilityTelemetry);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
          promoCode: "SAVE10",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "checkout_economics_unsupported",
        message: "Promo codes, gift cards, and store credit are not available in launch checkout.",
      },
    });
    expect(services.getSession).not.toHaveBeenCalled();
    expect(services.setShippingAddress).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
    expect(services.recordOrdersCreated).not.toHaveBeenCalled();
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.capability.promo_credit_gift_card_state",
        scenarioState: "deferred-capability",
        visibleState: "checkout-review-visible",
        sideEffectStatus: "not-attempted",
        launchDecision: "deferred",
        downstreamStatus: "not-started",
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("SAVE10");
    expect(emitted).not.toContain("chk_1");
    expect(emitted).not.toContain("acc_buyer");
  });

  it("emits changed economics telemetry before stale fulfillment confirmation can commit", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices({
      getSession: vi.fn(async () =>
        createSession({
          fulfillment_preview_revision: "fulfillment-rev-2",
          cart_readiness_snapshot: { snapshotId: "cr_ready", sourceRevision: "cart_rev_1" } as never,
        }),
      ),
    });
    const app = buildApp(services, undefined, checkoutObservabilityTelemetry);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
          fulfillmentPreviewRevision: "fulfillment-rev-1",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "fulfillment_preview_stale",
        message: "Fulfillment changed. Review the latest checkout preview before continuing.",
      },
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.economics.changed_review_required",
        scenarioState: "blocked",
        visibleState: "checkout-review-visible",
        sideEffectStatus: "not-attempted",
        readinessContract: "checkout.cart-readiness.v1",
        readinessSnapshotState: "fresh",
        sourceRevisionState: "fulfillment-preview-stale",
        supportReferencePresent: false,
        launchDecision: "blocked",
      }),
    );
  });

  it("rejects customer deferred payment before committing orders or payment", async () => {
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

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "deferred_checkout_order_proof_required",
        message: "This checkout action is restricted.",
      },
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
    expect(services.recordOrdersCreated).not.toHaveBeenCalled();
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("rejects operator deferred payment when the proof reference is a placeholder", async () => {
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
    });
    const app = buildApp(
      services,
      createBuyerActor({
        userId: "usr_ops",
        membershipId: "mbr_ops",
        permissions: ["security.manage"],
      }),
    );

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress,
          deferPayment: true,
          deferredCheckoutOrderProofReference: "TODO",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "deferred_checkout_order_proof_required",
        message: "This checkout action is restricted.",
      },
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
    expect(services.recordOrdersCreated).not.toHaveBeenCalled();
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("allows operator production proof order creation to defer payment before fee quote review", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
    });
    const app = buildApp(
      services,
      createBuyerActor({
        userId: "usr_ops",
        membershipId: "mbr_ops",
        permissions: ["security.manage"],
      }),
      checkoutObservabilityTelemetry,
    );

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress,
          deferPayment: true,
          deferredCheckoutOrderProofReference: "PRODUCTION-PROOF-2026-06-10",
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
    expect(services.recordOrdersCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chk_1",
        accountId: "acc_buyer",
        orderIds: ["ord_1"],
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          performedByUserId: "usr_ops",
          forAccountId: "acc_buyer",
        }),
      }),
    );
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.reconciliation.pending_visible",
        actorMode: "signed-in",
        scenarioState: "pending-downstream",
        visibleState: "support-safe-status-visible",
        sideEffectStatus: "pending-downstream",
        supportReferencePresent: true,
        providerCategory: "payments",
        downstreamStatus: "orders-created-payment-deferred",
        launchDecision: "enabled",
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("PRODUCTION-PROOF-2026-06-10");
    expect(emitted).not.toContain("usr_ops");
    expect(emitted).not.toContain("mbr_ops");
    expect(emitted).not.toContain("chk_1");
    expect(emitted).not.toContain("acc_buyer");
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
        message: "Review the latest payable total before payment starts.",
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

  it("rejects guest saved checkout instruments before checkout side effects", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices({
      getSession: vi.fn(async () => {
        throw new Error("guest saved instrument should fail before session lookup");
      }),
    });
    const app = buildApp(services, createGuestBuyerActor(), checkoutObservabilityTelemetry);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
          savedCheckoutInstrumentId: "pci_guest",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "saved_checkout_instrument_unavailable",
        message: "Saved payment methods are available after sign-in. Continue with card payment.",
      },
    });
    expectNoCheckoutConfirmSideEffects(services);
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.capability.accelerated_or_saved_disabled",
        actorMode: "guest",
        scenarioState: "disabled-capability",
        visibleState: "checkout-review-visible",
        sideEffectStatus: "not-attempted",
        providerCategory: "payments",
        launchDecision: "blocked",
        downstreamStatus: "not-started",
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("pci_guest");
    expect(emitted).not.toContain("chk_1");
    expect(emitted).not.toContain("acc_guest");
  });

  it("rejects guest save-payment requests before checkout side effects", async () => {
    const services = createServices({
      getSession: vi.fn(async () => {
        throw new Error("guest saved payment request should fail before session lookup");
      }),
    });
    const app = buildApp(services, createGuestBuyerActor());

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
          savePaymentMethodForFuture: true,
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "saved_checkout_instrument_unavailable",
        message: "Saved payment methods are available after sign-in. Continue with card payment.",
      },
    });
    expectNoCheckoutConfirmSideEffects(services);
  });

  it("passes saved checkout instruments through signed-in confirmation", async () => {
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
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
          savedCheckoutInstrumentId: " pci_saved ",
          savePaymentMethodForFuture: true,
        }),
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
      "pci_saved",
      false,
      "/account/payments/:paymentId",
    );
  });

  it("treats blank saved checkout instruments as absent", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue("pay_1");
    const services = createServices({
      getSession: vi.fn(async () => createSession({ buyer_account_id: "acc_guest" })),
    });
    const app = buildApp(services, createGuestBuyerActor());

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
          savedCheckoutInstrumentId: "   ",
        }),
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
    const app = buildApp(services, createGuestBuyerActor());

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
    const app = buildApp(services, createGuestBuyerActor());

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

  it("retries payment without mutating shipping or creating duplicate orders after orders exist", async () => {
    const orderedSession = createSession({
      order_ids: ["ord_1"],
      payment_id: null,
      fulfillment_preview_revision: "fulfillment_preview_1",
    });
    const confirmedSession = createSession({
      order_ids: ["ord_1"],
      payment_id: "pay_existing",
      fulfillment_preview_revision: "fulfillment_preview_1",
    });
    const services = createServices({
      getSession: vi.fn(async () => orderedSession),
      setShippingAddress: vi.fn(),
      assertReadyForOrderCreation: vi.fn(),
      recordOrdersCreated: vi.fn(),
      recordPaymentStarted: vi.fn(async () => ({
        sessionId: "chk_1" as never,
        session: confirmedSession,
      })),
    });
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue("pay_existing");
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
          paymentMethodCategory: "card",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      payment_id: "pay_existing",
      order_ids: ["ord_1"],
      status: "confirmed",
      session: expect.objectContaining({
        payment_id: "pay_existing",
        order_ids: ["ord_1"],
      }),
    });
    expect(services.setShippingAddress).not.toHaveBeenCalled();
    expect(services.assertReadyForOrderCreation).not.toHaveBeenCalled();
    expect(services.recordOrdersCreated).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
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
      {
        sessionId: "chk_1",
        accountId: "acc_buyer",
        paymentId: "pay_existing",
      },
      expect.objectContaining({
        tenantId: "tnt_identity",
      }),
    );
  });
});
