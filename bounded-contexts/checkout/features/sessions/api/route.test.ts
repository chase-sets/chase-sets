import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { CheckoutApiEnv } from "../../../api";
import type { CheckoutSessionServices } from "./runtime";

const {
  mockCreateCheckoutInventoryReservations,
  mockCreateCheckoutOrdersThroughOrdering,
  mockCreateCheckoutPaymentThroughPayments,
  mockPreviewCheckoutFulfillmentThroughOrdering,
  mockPreviewBuyNowCheckoutSupplyThroughOrdering,
  mockSubmitPurchaseIntentThroughMarketplace,
} = vi.hoisted(() => ({
  mockCreateCheckoutInventoryReservations: vi.fn(),
  mockCreateCheckoutOrdersThroughOrdering: vi.fn(),
  mockCreateCheckoutPaymentThroughPayments: vi.fn(),
  mockPreviewCheckoutFulfillmentThroughOrdering: vi.fn(),
  mockPreviewBuyNowCheckoutSupplyThroughOrdering: vi.fn(),
  mockSubmitPurchaseIntentThroughMarketplace: vi.fn(),
}));

vi.mock("../../../support/request-support/checkout-confirmation", () => ({
  createCheckoutInventoryReservations: mockCreateCheckoutInventoryReservations,
  createCheckoutOrdersThroughOrdering: mockCreateCheckoutOrdersThroughOrdering,
  createCheckoutPaymentThroughPayments: mockCreateCheckoutPaymentThroughPayments,
  previewCheckoutFulfillmentThroughOrdering: mockPreviewCheckoutFulfillmentThroughOrdering,
  previewBuyNowCheckoutSupplyThroughOrdering: mockPreviewBuyNowCheckoutSupplyThroughOrdering,
  submitPurchaseIntentThroughMarketplace: mockSubmitPurchaseIntentThroughMarketplace,
  normalizeRequestedBalanceCreditAmount: (value: unknown) =>
    value === null || value === undefined ? null : String(value),
}));

import { createAccountCheckoutSessionRoutes } from "./route";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import type { CheckoutSessionRow } from "../read-model/queries";
import type { CheckoutObservabilityTelemetry } from "./checkout-observability-telemetry";

type TestActorOverrides = Partial<NonNullable<CheckoutApiEnv["Variables"]["actor"]>>;

function createAccountUserTestActor(
  overrides: TestActorOverrides = {},
): NonNullable<CheckoutApiEnv["Variables"]["actor"]> {
  return {
    sessionId: "ses_test",
    tenantId: "tnt_identity" as never,
    userId: "usr_test" as never,
    accountId: "acc_test" as never,
    membershipId: "mbr_test" as never,
    roleKey: "owner",
    permissions: ["accounts.view", "accounts.manage"],
    ...overrides,
  };
}

function useMockReset(...mocks: ReadonlyArray<{ mockReset: () => void }>) {
  afterEach(() => {
    for (const mock of mocks) {
      mock.mockReset();
    }
  });
}

function createTestApp<TEnv extends CheckoutApiEnv>(
  options: Readonly<{
    actor: TEnv["Variables"]["actor"];
    routes: (app: Hono<TEnv>) => void;
  }>,
) {
  const app = new Hono<TEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", options.actor as never);
    c.set(
      "context",
      options.actor
        ? ({
            tenantId: options.actor.tenantId,
            audit: {
              performedByUserId: options.actor.userId,
              forAccountId: options.actor.accountId,
            },
          } as never)
        : null,
    );
    await next();
  });
  options.routes(app);
  return app;
}

const shippingAddress = {
  name: "Jane Smith",
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
} as const;

const orderingWriteResult = {
  orderIds: ["ord_1"],
  commandReceipt: {
    mode: "eventual",
    commitPosition: "42",
    commitEventIds: ["evt_order_created"],
    commitPositions: [
      {
        sourceContextName: "ordering",
        maxGlobalPosition: "42",
        eventIds: ["evt_order_created"],
      },
    ],
  },
} as const;

const orderingApiWriteResult = {
  orderIds: ["ord_1"],
  commitPosition: "42",
  commitEventIds: ["evt_order_created"],
  commitPositions: [
    {
      sourceContextName: "ordering",
      maxGlobalPosition: "42",
      eventIds: ["evt_order_created"],
    },
  ],
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
    fulfillment_preview_snapshot: null,
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
    checkout_reservations: [],
    order_ids: [],
    order_write_commit_positions: [],
    payment_id: null,
    submitted_offer_id: null,
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    ...overrides,
  };
}

function createPaymentResult(paymentId: string, position = "84", eventId = `evt_${paymentId}`) {
  return {
    payment_id: paymentId,
    commandReceipt: {
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
    },
  };
}

function readyBuyNowSupplyPreview() {
  return {
    revision: "buy_now_supply_ready",
    readyLineKeys: ["lst_1:0"],
    unavailableLineKeys: [],
    sellerGroups: [],
    totals: {
      itemSubtotalAmount: "0.00",
      shippingAmount: "0.00",
      salesTaxAmount: "0.00",
      totalAmount: "0.00",
      packageCount: 0,
    },
    unavailableLines: [],
    materialChangeReasons: [],
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
    verifyShippingAddress: vi.fn(async (address) => ({ status: "accepted", shippingAddress: address }) as const),
    setShippingAddress: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    assertReadyForOrderCreation: vi.fn(async ({ sessionId }) => createSession({ session_id: sessionId })),
    recordCheckoutReservations: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordOrdersCreated: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordPaymentStarted: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordOfferSubmitted: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    getSession: vi.fn(async () => createSession()),
    getPaymentSummary: vi.fn(async () => null),
    listSavedPaymentInstruments: vi.fn(async () => []),
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
  mockCreateCheckoutInventoryReservations,
  mockCreateCheckoutOrdersThroughOrdering,
  mockCreateCheckoutPaymentThroughPayments,
  mockPreviewCheckoutFulfillmentThroughOrdering,
  mockPreviewBuyNowCheckoutSupplyThroughOrdering,
  mockSubmitPurchaseIntentThroughMarketplace,
);

describe("checkout session routes", () => {
  beforeEach(() => {
    mockCreateCheckoutInventoryReservations.mockResolvedValue({ reservations: [], unavailableLines: [] });
    mockPreviewBuyNowCheckoutSupplyThroughOrdering.mockResolvedValue(readyBuyNowSupplyPreview());
    mockPreviewCheckoutFulfillmentThroughOrdering.mockResolvedValue(readyBuyNowSupplyPreview());
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
        capabilityDecision: "blocked",
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

  it("emits split-group summary telemetry without raw group references", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices({
      getSession: vi.fn(async () =>
        createSession({
          cart_readiness_snapshot: { snapshotId: "cr_multi", sourceRevision: "cart_rev_1" } as never,
          split_group_handoff: {
            status: "ready",
            supportReference: "CS-CR_MULTI",
            groups: [
              {
                groupId: "cfg_card_vault",
                lineIds: ["cli_card_vault"],
                listingIds: ["lst_card_vault"],
                sellerAccountId: "acc_card_vault",
                sellerDisplayName: "Card Vault",
                itemCount: 1,
                packageCount: 1,
                deliveryPromise: null,
                shippingAmount: null,
                supportReference: "CSG-CARDVAULT",
                downstreamReferenceStatus: "not-started",
              },
              {
                groupId: "cfg_second_seller",
                lineIds: ["cli_second_seller"],
                listingIds: ["lst_second_seller"],
                sellerAccountId: "acc_second_seller",
                sellerDisplayName: "Second Seller",
                itemCount: 1,
                packageCount: 1,
                deliveryPromise: null,
                shippingAmount: null,
                supportReference: "CSG-SECONDSELLER",
                downstreamReferenceStatus: "not-started",
              },
            ],
          },
        }),
      ),
    });
    const app = buildApp(services, undefined, checkoutObservabilityTelemetry);

    const response = await app.fetch(new Request("http://checkout.test/account/checkout-sessions/chk_1"));

    expect(response.status).toBe(200);
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledTimes(2);
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.buy.split_group_summary_rendered",
        actorMode: "signed-in",
        entrySource: "buy-cart-readiness",
        scenarioState: "split-group",
        visibleState: "checkout-review-visible",
        sideEffectStatus: "forbidden-before-confirm",
        readinessContract: "checkout.cart-readiness.v1",
        readinessSnapshotState: "fresh",
        sourceRevisionState: "current",
        supportReferencePresent: true,
        downstreamStatus: "not-started",
        capabilityDecision: "enabled",
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls);
    expect(emitted).not.toContain("chk_1");
    expect(emitted).not.toContain("acc_card_vault");
    expect(emitted).not.toContain("cfg_card_vault");
    expect(emitted).not.toContain("CSG-CARDVAULT");
    expect(emitted).not.toContain("CS-CR_MULTI");
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

  it("passes cart readiness snapshot facts into cart checkout creation", async () => {
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

  it("sets verified shipping addresses silently", async () => {
    const verifiedAddress = {
      ...shippingAddress,
      verification: {
        status: "verified" as const,
        source: "easypost:test",
        checkedAt: "2026-07-07T00:00:00.000Z",
      },
    };
    const services = createServices({
      verifyShippingAddress: vi.fn(async () => ({ status: "accepted", shippingAddress: verifiedAddress }) as const),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/shipping-address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingAddress }),
      }),
    );

    expect(response.status).toBe(200);
    expect(services.setShippingAddress).toHaveBeenCalledWith(
      expect.objectContaining({ shippingAddress: verifiedAddress }),
      expect.any(Object),
    );
  });

  it("returns a standardized address choice before mutating checkout", async () => {
    const suggestedAddress = { ...shippingAddress, line1: "100 W Market St", postalCode: "60601-1000" };
    const services = createServices({
      verifyShippingAddress: vi.fn(
        async () =>
          ({
            status: "choice-required",
            suggestedAddress,
            verification: {
              status: "corrected",
              source: "easypost:test",
              checkedAt: "2026-07-07T00:00:00.000Z",
              suggestedAddress,
            },
            messages: ["USPS standardized this address."],
          }) as const,
      ),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/shipping-address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingAddress }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "address_standardization_suggested" },
      suggestedAddress,
    });
    expect(services.setShippingAddress).not.toHaveBeenCalled();
  });

  it("blocks undeliverable checkout shipping addresses", async () => {
    const services = createServices({
      verifyShippingAddress: vi.fn(async () => {
        throw new CheckoutDomainError(
          "We could not verify this as a deliverable address. Use a deliverable shipping address before continuing.",
          "shipping_address_undeliverable",
        );
      }),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/shipping-address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingAddress }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "shipping_address_undeliverable",
        message:
          "We could not verify this as a deliverable address. Use a deliverable shipping address before continuing.",
      },
    });
    expect(services.setShippingAddress).not.toHaveBeenCalled();
  });

  it("uses checkout entry attempt keys as idempotent cart session overrides", async () => {
    const createFromCart = vi.fn(async (params: Parameters<CheckoutSessionServices["createFromCart"]>[0]) => ({
      sessionId: params.sessionIdOverride ?? ("chk_missing_override" as never),
    }));
    const services = createServices({ createFromCart });
    const app = buildApp(services);
    const body = {
      entryAttemptKey: "entry_attempt_1",
      source: {
        type: "cart",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: {
          optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" },
        },
      },
    };

    const first = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const second = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.session_id).toMatch(/^chk_[a-f0-9]{32}$/);
    expect(secondBody.session_id).toBe(firstBody.session_id);
    expect(createFromCart.mock.calls[0]?.[0].sessionIdOverride).toBe(
      createFromCart.mock.calls[1]?.[0].sessionIdOverride,
    );
    expect(String(firstBody.session_id)).not.toContain("entry_attempt_1");
  });

  it("rejects old-shaped cart readiness payloads without adapting them into checkout facts", async () => {
    const services = createServices({
      createFromCart: vi.fn(async () => {
        throw new CheckoutDomainError(
          "Cart readiness changed. Review your cart before checkout.",
          "readiness_snapshot_stale",
        );
      }),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: {
            type: "cart",
            cart_readiness_snapshot: {
              snapshot_id: "cr_old",
              source_revision: "cart_rev_old",
              unresolved_line_ids: [],
            },
            readiness_snapshot_id: "cr_old",
            readiness_source_revision: "cart_rev_old",
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "readiness_snapshot_stale",
        message: "Cart readiness changed. Review your cart before checkout.",
      },
    });
    expect(services.createFromCart).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_buyer",
        readinessSnapshotId: "",
        readinessSourceRevision: "",
        readinessDecisions: {
          lineOutcomes: [],
          optimization: null,
        },
      }),
      expect.any(Object),
    );
    expect(services.createBuyNow).not.toHaveBeenCalled();
    expect(services.createOfferIntent).not.toHaveBeenCalled();
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
        fulfillmentPreviewRevision: "buy_now_supply_ready",
      }),
      expect.any(Object),
    );
  });

  it("starts guest buy-now sessions directly without using the cart workaround", async () => {
    const services = createServices({
      createBuyNow: vi.fn(async () => ({
        sessionId: "chk_guest_buy_now" as never,
        commitPosition: "51",
        commitEventIds: ["evt_guest_buy_now_started"],
      })),
    });
    const app = buildApp(services, createGuestBuyerActor());

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: {
            type: "buy-now",
            listingId: "lst_guest",
            lockedListingId: "lst_guest",
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
    await expect(response.json()).resolves.toEqual({
      session_id: "chk_guest_buy_now",
      status: "started",
      commitPosition: "51",
      commitEventIds: ["evt_guest_buy_now_started"],
    });
    expect(services.createBuyNow).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_guest",
        listingId: "lst_guest",
        lockedListingId: "lst_guest",
        fulfillmentMode: "locked-listing",
        productId: "cat_1::form:raw",
        fulfillmentPreviewRevision: "buy_now_supply_ready",
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_guest",
          performedByUserId: "usr_guest_checkout",
        }),
      }),
    );
    expect(services.createFromCart).not.toHaveBeenCalled();
    expect(services.createOfferIntent).not.toHaveBeenCalled();
  });

  it("deduplicates buy-now entry attempts without pinning future attempts to the old session", async () => {
    const createBuyNow = vi.fn(async (params: Parameters<CheckoutSessionServices["createBuyNow"]>[0]) => ({
      sessionId: params.sessionIdOverride ?? ("chk_missing_override" as never),
    }));
    const services = createServices({ createBuyNow });
    const app = buildApp(services);
    const source = {
      type: "buy-now",
      listingId: "lst_1",
      lockedListingId: "lst_1",
      catalogItemId: "cat_1",
      productId: "cat_1::form:raw",
      itemTitle: "Charizard",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      quantity: 1,
    };
    async function start(entryAttemptKey: string) {
      const response = await app.fetch(
        new Request("http://checkout.test/account/checkout-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entryAttemptKey, source }),
        }),
      );

      expect(response.status).toBe(201);
      return response.json() as Promise<{ session_id: string }>;
    }

    const first = await start("entry_attempt_1");
    const duplicate = await start("entry_attempt_1");
    const futureAttempt = await start("entry_attempt_2");

    expect(duplicate.session_id).toBe(first.session_id);
    expect(futureAttempt.session_id).not.toBe(first.session_id);
    expect(createBuyNow.mock.calls[0]?.[0].sessionIdOverride).toBe(createBuyNow.mock.calls[1]?.[0].sessionIdOverride);
    expect(createBuyNow.mock.calls[2]?.[0].sessionIdOverride).not.toBe(
      createBuyNow.mock.calls[0]?.[0].sessionIdOverride,
    );
  });

  it("rebinds replacement Buy Now sessions to an Ordering preview for the fresh session id", async () => {
    mockPreviewBuyNowCheckoutSupplyThroughOrdering
      .mockResolvedValueOnce({
        ...readyBuyNowSupplyPreview(),
        revision: "stale_deterministic_preview",
      })
      .mockResolvedValueOnce({
        ...readyBuyNowSupplyPreview(),
        revision: "fresh_replacement_preview",
      });
    const createBuyNow = vi.fn(async () => ({
      sessionId: "chk_replacement" as never,
      commitPosition: "41",
      commitEventIds: ["evt_replacement_started"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "41",
          eventIds: ["evt_replacement_started"],
        },
      ],
    }));
    const recordFulfillmentPreview = vi.fn(async ({ sessionId }) => ({
      sessionId,
      session: createSession({ session_id: sessionId }),
      commitPosition: "42",
      commitEventIds: ["evt_replacement_preview"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "42",
          eventIds: ["evt_replacement_preview"],
        },
      ],
    }));
    const services = createServices({ createBuyNow, recordFulfillmentPreview });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryAttemptKey: "entry_attempt_1",
          source: {
            type: "buy-now",
            listingId: "lst_1",
            lockedListingId: "lst_1",
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
    await expect(response.json()).resolves.toEqual({
      session_id: "chk_replacement",
      status: "started",
      commitPosition: "42",
      commitEventIds: ["evt_replacement_started", "evt_replacement_preview"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "42",
          eventIds: ["evt_replacement_started", "evt_replacement_preview"],
        },
      ],
    });
    const stalePreviewSessionId = mockPreviewBuyNowCheckoutSupplyThroughOrdering.mock.calls[0]?.[1].checkoutSessionId;
    expect(stalePreviewSessionId).toMatch(/^chk_[a-f0-9]{32}$/);
    expect(createBuyNow).toHaveBeenCalledWith(
      expect.objectContaining({
        fulfillmentPreviewRevision: "stale_deterministic_preview",
        sessionIdOverride: stalePreviewSessionId,
      }),
      expect.any(Object),
    );
    expect(mockPreviewBuyNowCheckoutSupplyThroughOrdering.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        checkoutSessionId: "chk_replacement",
      }),
    );
    expect(recordFulfillmentPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chk_replacement",
        accountId: "acc_buyer",
        fulfillmentPreviewRevision: "fresh_replacement_preview",
        fulfillmentPreviewSnapshot: expect.objectContaining({ revision: "fresh_replacement_preview" }),
      }),
      expect.any(Object),
    );
  });

  it("blocks buy-now session creation until Ordering can fulfill the locked listing", async () => {
    mockPreviewBuyNowCheckoutSupplyThroughOrdering.mockResolvedValue({
      ...readyBuyNowSupplyPreview(),
      readyLineKeys: [],
      unavailableLineKeys: ["lst_1:0"],
      unavailableLines: [
        {
          lineKey: "lst_1:0",
          catalogItemId: "cat_1",
          productId: "cat_1::form:raw",
          itemTitle: "Charizard",
          productSummary: "Raw",
          quantity: 1,
          reason: "Locked listing is unavailable.",
        },
      ],
      materialChangeReasons: ["unavailable-lines"],
    });
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
            lockedListingId: "lst_1",
            catalogItemId: "cat_1",
            productId: "cat_1::form:raw",
            itemTitle: "Charizard",
            selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
            productSummary: "Raw",
            quantity: 1,
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unresolved_fulfillment",
        message: "This listing is still becoming available for checkout. Try again shortly.",
      },
    });
    expect(mockPreviewBuyNowCheckoutSupplyThroughOrdering).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        shippingOption: "standard",
        optimizationGoal: "lowest-total",
        line: expect.objectContaining({
          listingId: "lst_1",
          lockedListingId: "lst_1",
          fulfillmentMode: "locked-listing",
          productId: "cat_1::form:raw",
        }),
      }),
    );
    expect(services.createBuyNow).not.toHaveBeenCalled();
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

  it("rejects old-shaped buy-now payloads instead of adapting old checkout links", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const services = createServices();
    const app = buildApp(services, createGuestBuyerActor(), checkoutObservabilityTelemetry);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: {
            type: "buy-now",
            checkoutId: "old_checkout_1",
            checkoutSessionId: "old_session_1",
            oldCheckoutUrl: "/checkout/start?session=old_session_1",
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
    expect(services.createFromCart).not.toHaveBeenCalled();
    expect(services.createOfferIntent).not.toHaveBeenCalled();
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entrySource: "buy-now",
        actorMode: "guest",
        sideEffectStatus: "not-attempted",
        downstreamStatus: "not-started",
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("old_checkout_1");
    expect(emitted).not.toContain("old_session_1");
    expect(emitted).not.toContain("/checkout/start");
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
        message: "Register or sign in before submitting an offer.",
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
        fulfillmentPreviewRevision: "buy_now_supply_ready",
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

  it("records a reviewed fulfillment preview revision on the checkout session", async () => {
    const services = createServices();
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/fulfillment-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fulfillmentPreviewRevision: "fulfillment_rev_2" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session_id: "chk_1",
      status: "fulfillment-preview-recorded",
    });
    expect(services.recordFulfillmentPreview).toHaveBeenCalledWith(
      {
        sessionId: "chk_1",
        accountId: "acc_buyer",
        fulfillmentPreviewRevision: "fulfillment_rev_2",
      },
      expect.any(Object),
    );
  });

  it("confirms a new checkout session by recording orders and payment", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
      writeResult: orderingApiWriteResult,
    });
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue(createPaymentResult("pay_1"));
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
      recordPaymentStarted: vi.fn(async ({ sessionId }) => ({
        sessionId,
        session: createSession({ session_id: sessionId, payment_id: "pay_1" }),
        commitPosition: "91",
        commitEventIds: ["evt_checkout_payment_started"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "91",
            eventIds: ["evt_checkout_payment_started"],
          },
        ],
      })),
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
    const body = await response.json();
    expect(body).toMatchObject({
      payment_id: "pay_1",
      order_ids: ["ord_1"],
    });
    expect(body).toMatchObject({
      commitPosition: "91",
      commitEventIds: ["evt_pay_1", "evt_checkout_payment_started"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "91",
          eventIds: ["evt_checkout_payment_started"],
        },
        {
          sourceContextName: "payments",
          maxGlobalPosition: "84",
          eventIds: ["evt_pay_1"],
        },
      ],
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).toHaveBeenCalledTimes(1);
    expect(services.recordOrdersCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chk_1",
        orderIds: ["ord_1"],
        orderWriteCommitPositions: orderingApiWriteResult.commitPositions,
      }),
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
      null,
      {
        commandReceipt: {
          commitEventIds: ["evt_order_created"],
          commitPositions: orderingApiWriteResult.commitPositions,
        },
      },
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
        capabilityDecision: "enabled",
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("chk_1");
    expect(emitted).not.toContain("acc_buyer");
    expect(emitted).not.toContain("ord_1");
    expect(emitted).not.toContain("pay_1");
  });

  it("records successful checkout holds before returning line-level reservation failures", async () => {
    const reservation = {
      holdId: "hld_checkout_1",
      lineKey: "cli_1",
      sellerAccountId: "acc_seller",
      inventoryItemId: "inv_1",
      quantity: 1,
      expiresAt: "2026-04-29T00:15:00.000Z",
      extensionCount: 0,
      status: "active",
    } as const;
    const unavailableLine = {
      lineKey: "cli_2",
      sellerAccountId: "acc_seller_2",
      inventoryItemId: "inv_2",
      catalogItemId: "cat_2",
      productId: "prod_2",
      itemTitle: "Blastoise",
      productSummary: "Raw",
      quantity: 1,
      reason: "reserved-by-another-buyer",
    } as const;
    mockCreateCheckoutInventoryReservations.mockResolvedValue({
      reservations: [reservation],
      unavailableLines: [unavailableLine],
    });
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
      recordCheckoutReservations: vi.fn(async ({ sessionId }) => ({
        sessionId,
        session: createSession({ session_id: sessionId, checkout_reservations: [reservation] }),
        commitPosition: "67",
        commitEventIds: ["evt_checkout_reservations_recorded"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "67",
            eventIds: ["evt_checkout_reservations_recorded"],
          },
        ],
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

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "checkout_reservation_unavailable",
        message: "One or more checkout items were just reserved by another buyer.",
      },
      unavailableLines: [unavailableLine],
      commitPosition: "67",
      commitEventIds: ["evt_checkout_reservations_recorded"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "67",
          eventIds: ["evt_checkout_reservations_recorded"],
        },
      ],
    });
    expect(services.recordCheckoutReservations).toHaveBeenCalledWith(
      {
        sessionId: "chk_1",
        accountId: "acc_buyer",
        reservations: [reservation],
      },
      expect.any(Object),
    );
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
    expect(services.recordOrdersCreated).not.toHaveBeenCalled();
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("confirms a multi-seller buy checkout with one payment action and support-safe group references", async () => {
    const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
    const multiSellerSession = createSession({
      session_id: "chk_multi_seller",
      lines: [
        {
          listingId: "lst_card_vault",
          cartLineId: "cli_card_vault",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form:raw",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: "Raw",
          quantity: 1,
          fulfillmentMode: "locked-listing",
          lockedListingId: "lst_card_vault",
          sellerPreferenceId: null,
          availabilityState: "available",
        },
        {
          listingId: "lst_second_seller",
          cartLineId: "cli_second_seller",
          catalogItemId: "cat_blastoise",
          productId: "cat_blastoise::form:raw",
          itemTitle: "Blastoise",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: "Raw",
          quantity: 1,
          fulfillmentMode: "locked-listing",
          lockedListingId: "lst_second_seller",
          sellerPreferenceId: null,
          availabilityState: "available",
        },
      ],
      split_group_handoff: {
        status: "ready",
        supportReference: "CS-CR_MULTI",
        groups: [
          {
            groupId: "cfg_card_vault",
            lineIds: ["cli_card_vault"],
            listingIds: ["lst_card_vault"],
            sellerAccountId: "acc_card_vault",
            sellerDisplayName: "Card Vault",
            itemCount: 1,
            packageCount: 1,
            deliveryPromise: null,
            shippingAmount: null,
            supportReference: "CSG-CARDVAULT",
            downstreamReferenceStatus: "not-started",
          },
          {
            groupId: "cfg_second_seller",
            lineIds: ["cli_second_seller"],
            listingIds: ["lst_second_seller"],
            sellerAccountId: "acc_second_seller",
            sellerDisplayName: "Second Seller",
            itemCount: 1,
            packageCount: 1,
            deliveryPromise: null,
            shippingAmount: null,
            supportReference: "CSG-SECONDSELLER",
            downstreamReferenceStatus: "not-started",
          },
        ],
      },
    });
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_card_vault", "ord_second_seller"],
      readyLineKeys: ["cli_card_vault", "cli_second_seller"],
    });
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue(createPaymentResult("pay_multi_seller"));
    const services = createServices({
      getSession: vi.fn(async () => multiSellerSession),
      setShippingAddress: vi.fn(async () => ({ sessionId: "chk_multi_seller", session: multiSellerSession })),
      assertReadyForOrderCreation: vi.fn(async () => multiSellerSession),
      recordOrdersCreated: vi.fn(async () => ({
        sessionId: "chk_multi_seller",
        session: createSession({
          ...multiSellerSession,
          order_ids: ["ord_card_vault", "ord_second_seller"],
        }),
      })),
      recordPaymentStarted: vi.fn(async () => ({
        sessionId: "chk_multi_seller",
        session: createSession({
          ...multiSellerSession,
          order_ids: ["ord_card_vault", "ord_second_seller"],
          payment_id: "pay_multi_seller",
        }),
      })),
    });
    const app = buildApp(services, undefined, checkoutObservabilityTelemetry);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_multi_seller/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingAddress, marketplaceCheckoutFeeQuoteFingerprint: "quote_multi" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      payment_id: "pay_multi_seller",
      order_ids: ["ord_card_vault", "ord_second_seller"],
      status: "confirmed",
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).toHaveBeenCalledTimes(1);
    expect(mockCreateCheckoutOrdersThroughOrdering).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        session_id: "chk_multi_seller",
        split_group_handoff: expect.objectContaining({
          supportReference: "CS-CR_MULTI",
          groups: expect.arrayContaining([
            expect.objectContaining({ supportReference: "CSG-CARDVAULT" }),
            expect.objectContaining({ supportReference: "CSG-SECONDSELLER" }),
          ]),
        }),
      }),
      expect.any(Object),
    );
    expect(services.recordOrdersCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chk_multi_seller",
        orderIds: ["ord_card_vault", "ord_second_seller"],
        fulfilledLineKeys: ["cli_card_vault", "cli_second_seller"],
      }),
      expect.any(Object),
    );
    expect(mockCreateCheckoutPaymentThroughPayments).toHaveBeenCalledTimes(1);
    expect(mockCreateCheckoutPaymentThroughPayments).toHaveBeenCalledWith(
      expect.any(Request),
      "chk_multi_seller",
      ["ord_card_vault", "ord_second_seller"],
      null,
      "card",
      "quote_multi",
      null,
      false,
      "/account/payments/:paymentId",
      null,
      undefined,
    );
    expect(checkoutObservabilityTelemetry.recordCheckoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "checkout.reconciliation.pending_visible",
        sideEffectStatus: "pending-downstream",
        downstreamStatus: "payment-started",
        supportReferencePresent: true,
      }),
    );
    const emitted = JSON.stringify(checkoutObservabilityTelemetry.recordCheckoutEvent.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("chk_multi_seller");
    expect(emitted).not.toContain("ord_card_vault");
    expect(emitted).not.toContain("pay_multi_seller");
    expect(emitted).not.toContain("CSG-CARDVAULT");
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

  it("rejects unsupported customer economics input before checkout side effects", async () => {
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
        message: "Promo codes, gift cards, and store credit are not available in checkout yet.",
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
        scenarioState: "unsupported-capability",
        visibleState: "checkout-review-visible",
        sideEffectStatus: "not-attempted",
        capabilityDecision: "blocked",
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
        capabilityDecision: "blocked",
      }),
    );
  });

  it("confirms with Ordering when a visibly refreshed fulfillment preview is acknowledged", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
      writeResult: orderingApiWriteResult,
    });
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue(createPaymentResult("pay_1"));
    const services = createServices({
      getSession: vi.fn(async () =>
        createSession({
          fulfillment_preview_revision: "fulfillment-rev-1",
        }),
      ),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
          fulfillmentPreviewRevision: "fulfillment-rev-2",
          acknowledgedMaterialChanges: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCreateCheckoutOrdersThroughOrdering).toHaveBeenCalledWith(expect.any(Request), expect.any(Object), {
      fulfillmentPreviewRevision: "fulfillment-rev-2",
      acknowledgedMaterialChanges: true,
      checkoutReservations: [],
    });
    expect(mockCreateCheckoutPaymentThroughPayments).toHaveBeenCalledTimes(1);
  });

  it("does not support payment deferral payloads before committing orders or payment", async () => {
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

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "payment_quote_required",
        message: "Review the latest payable total before payment starts.",
      },
    });
    expect(mockCreateCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(mockCreateCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
    expect(services.recordOrdersCreated).not.toHaveBeenCalled();
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("rejects payment confirmation before committing orders when fee quote is missing", async () => {
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

  it("rejects mismatched payment method and fee quote before committing orders", async () => {
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
          paymentMethodCategory: "bank-account",
          marketplaceCheckoutFeeQuoteFingerprint:
            "marketplace-checkout-fee-v1|card|489.00|0.00|489.00|14.67|503.67|503.67",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "payment_quote_required",
        message: "Review the latest payable total before payment starts.",
      },
    });
    expectNoCheckoutConfirmSideEffects(services);
  });

  it("retries payment recording without recreating orders", async () => {
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue(createPaymentResult("pay_existing"));
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
      null,
      undefined,
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
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue(createPaymentResult("pay_1"));
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
      null,
      undefined,
    );
  });

  it("asks checkout review to refresh when Payments rejects a stale fee quote", async () => {
    const refreshedMarketplaceQuote = {
      marketplace_checkout_fee_amount: "0.55",
      marketplace_checkout_fee_reduction_amount: "0.00",
      total_amount: "7.36",
      processor_amount: "7.36",
      quote_fingerprint: "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.55|7.36|7.36",
    };
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutPaymentThroughPayments.mockRejectedValue(
      Object.assign(new Error("Review the latest payable total before payment starts."), {
        status: 409,
        body: {
          error: {
            code: "fee_quote_stale",
            message: "Marketplace checkout fee quote changed. Review the latest payable total before paying.",
          },
          marketplace_checkout_fee: refreshedMarketplaceQuote,
        },
      }),
    );
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
      recordOrdersCreated: vi.fn(async ({ sessionId }) => ({
        sessionId,
        session: createSession({ order_ids: ["ord_1"] }),
        commitPosition: "77",
        commitEventIds: ["evt_checkout_orders_created"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "77",
            eventIds: ["evt_checkout_orders_created"],
          },
        ],
      })),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethodCategory: "card",
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "payment_quote_required",
        message: "Review the latest payable total before payment starts.",
      },
      marketplace_checkout_fee: refreshedMarketplaceQuote,
      commitPosition: "77",
      commitEventIds: ["evt_checkout_orders_created"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "77",
          eventIds: ["evt_checkout_orders_created"],
        },
      ],
    });
    expect(services.recordOrdersCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chk_1",
        orderIds: ["ord_1"],
        orderWriteCommitPositions: [],
      }),
      expect.any(Object),
    );
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("asks checkout review to retry when Payments has not observed newly created orders", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
      writeResult: orderingWriteResult,
    });
    mockCreateCheckoutPaymentThroughPayments.mockRejectedValue(
      Object.assign(new Error("Order ord_1 was not found."), {
        status: 400,
        body: {
          error: {
            code: "validation_failed",
            message: "Order ord_1 was not found.",
          },
        },
      }),
    );
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
      recordOrdersCreated: vi.fn(async ({ sessionId }) => ({
        sessionId,
        session: createSession({ order_ids: ["ord_1"] }),
        commitPosition: "77",
        commitEventIds: ["evt_checkout_orders_created"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "77",
            eventIds: ["evt_checkout_orders_created"],
          },
        ],
      })),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethodCategory: "card",
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "payment_start_pending",
        message: "Payment setup is still catching up. Review checkout again before payment starts.",
      },
      commitPosition: "77",
      commitEventIds: ["evt_order_created", "evt_checkout_orders_created"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "77",
          eventIds: ["evt_checkout_orders_created"],
        },
        {
          sourceContextName: "ordering",
          maxGlobalPosition: "42",
          eventIds: ["evt_order_created"],
        },
      ],
    });
    expect(services.recordOrdersCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chk_1",
        orderIds: ["ord_1"],
        orderWriteCommitPositions: orderingWriteResult.commandReceipt.commitPositions,
      }),
      expect.any(Object),
    );
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("uses stored order write positions when retrying payment after orders already exist", async () => {
    const orderedSession = createSession({
      order_ids: ["ord_1"],
      order_write_commit_positions: orderingWriteResult.commandReceipt.commitPositions,
      payment_id: null,
    });
    mockCreateCheckoutPaymentThroughPayments.mockRejectedValue(
      Object.assign(new Error("Order ord_1 was not found."), {
        status: 400,
        body: {
          error: {
            code: "validation_failed",
            message: "Order ord_1 was not found.",
          },
        },
      }),
    );
    const services = createServices({
      getSession: vi.fn(async () => orderedSession),
      assertReadyForOrderCreation: vi.fn(),
      recordOrdersCreated: vi.fn(),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethodCategory: "card",
          marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "payment_start_pending",
        message: "Payment setup is still catching up. Review checkout again before payment starts.",
      },
      commitEventIds: ["evt_order_created"],
      commitPositions: [
        {
          sourceContextName: "ordering",
          maxGlobalPosition: "42",
          eventIds: ["evt_order_created"],
        },
      ],
    });
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
      null,
      {
        commandReceipt: {
          commitEventIds: ["evt_order_created"],
          commitPositions: orderingWriteResult.commandReceipt.commitPositions,
        },
      },
    );
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("asks checkout review to retry when Payments sees newly created orders before pending-payment", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
      writeResult: orderingWriteResult,
    });
    mockCreateCheckoutPaymentThroughPayments.mockRejectedValue(
      Object.assign(new Error("Order ord_1 is not eligible for payment in status pending-reservation."), {
        status: 400,
        body: {
          error: {
            code: "order_not_payment_ready",
            message: "Order ord_1 is not eligible for payment in status pending-reservation.",
          },
        },
      }),
    );
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
      recordOrdersCreated: vi.fn(async ({ sessionId }) => ({
        sessionId,
        session: createSession({ order_ids: ["ord_1"] }),
        commitPosition: "77",
        commitEventIds: ["evt_checkout_orders_created"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "77",
            eventIds: ["evt_checkout_orders_created"],
          },
        ],
      })),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethodCategory: "card",
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "payment_start_pending",
        message: "Payment setup is still catching up. Review checkout again before payment starts.",
      },
      commitPosition: "77",
      commitEventIds: ["evt_order_created", "evt_checkout_orders_created"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "77",
          eventIds: ["evt_checkout_orders_created"],
        },
        {
          sourceContextName: "ordering",
          maxGlobalPosition: "42",
          eventIds: ["evt_order_created"],
        },
      ],
    });
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("asks checkout review to retry when Payments order-input fresh-read times out", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
      writeResult: orderingWriteResult,
    });
    mockCreateCheckoutPaymentThroughPayments.mockRejectedValue(
      Object.assign(new Error("Projection read model did not catch up before the freshness timeout."), {
        status: 503,
        body: {
          error: {
            code: "projection_freshness_timeout",
            message: "Projection read model did not catch up before the freshness timeout.",
          },
        },
      }),
    );
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
      recordOrdersCreated: vi.fn(async ({ sessionId }) => ({
        sessionId,
        session: createSession({ order_ids: ["ord_1"] }),
        commitPosition: "77",
        commitEventIds: ["evt_checkout_orders_created"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "77",
            eventIds: ["evt_checkout_orders_created"],
          },
        ],
      })),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethodCategory: "card",
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "payment_start_pending",
        message: "Payment setup is still catching up. Review checkout again before payment starts.",
      },
      commitPosition: "77",
      commitEventIds: ["evt_order_created", "evt_checkout_orders_created"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "77",
          eventIds: ["evt_checkout_orders_created"],
        },
        {
          sourceContextName: "ordering",
          maxGlobalPosition: "42",
          eventIds: ["evt_order_created"],
        },
      ],
    });
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("keeps unrelated payment validation failures as validation errors after orders are created", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutPaymentThroughPayments.mockRejectedValue(
      Object.assign(new Error("Payment method is unavailable."), {
        status: 400,
        body: {
          error: {
            code: "validation_failed",
            message: "Payment method is unavailable.",
          },
        },
      }),
    );
    const services = createServices({
      getSession: vi.fn(async () => createSession()),
      recordOrdersCreated: vi.fn(async ({ sessionId }) => ({
        sessionId,
        session: createSession({ order_ids: ["ord_1"] }),
        commitPosition: "77",
      })),
    });
    const app = buildApp(services);

    const response = await app.fetch(
      new Request("http://checkout.test/account/checkout-sessions/chk_1/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethodCategory: "card",
          shippingAddress,
          marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|6.81|0.00|6.81|0.52|7.33|7.33",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "validation_failed",
        message: "Payment method is unavailable.",
      },
    });
    expect(services.recordOrdersCreated).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chk_1", orderIds: ["ord_1"] }),
      expect.any(Object),
    );
    expect(services.recordPaymentStarted).not.toHaveBeenCalled();
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
        capabilityDecision: "blocked",
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
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue(createPaymentResult("pay_1"));
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
      null,
      undefined,
    );
  });

  it("treats blank saved checkout instruments as absent", async () => {
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue(createPaymentResult("pay_1"));
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
      null,
      undefined,
    );
  });

  it("submits purchase intent through Marketplace without creating orders or payment", async () => {
    mockSubmitPurchaseIntentThroughMarketplace.mockResolvedValue({
      offerId: "off_chk_1",
      writeResult: {
        id: "off_chk_1",
        commandReceipt: {
          mode: "eventual",
          commitPosition: "42",
          commitEventIds: ["evt_marketplace_offer_submitted"],
          commitPositions: [
            {
              sourceContextName: "marketplace",
              maxGlobalPosition: "42",
              eventIds: ["evt_marketplace_offer_submitted"],
            },
          ],
        },
      },
    });
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
        commitPosition: "43",
        commitEventIds: ["evt_checkout_offer_submitted"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "43",
            eventIds: ["evt_checkout_offer_submitted"],
          },
        ],
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
      commitPosition: "43",
      commitEventIds: ["evt_marketplace_offer_submitted", "evt_checkout_offer_submitted"],
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "43",
          eventIds: ["evt_checkout_offer_submitted"],
        },
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "42",
          eventIds: ["evt_marketplace_offer_submitted"],
        },
      ],
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
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue(createPaymentResult("pay_1"));
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
      null,
      undefined,
    );
  });

  it("lets guest checkout proceed with buyer-confirmed unverified address when verification is unavailable", async () => {
    const unverifiedAddress = {
      ...shippingAddress,
      verification: {
        status: "unverified" as const,
        source: "easypost:test",
        checkedAt: "2026-07-07T00:00:00.000Z",
        buyerDecision: "provider-unavailable" as const,
      },
    };
    mockCreateCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue(createPaymentResult("pay_1"));
    const services = createServices({
      getSession: vi.fn(async () => createSession({ buyer_account_id: "acc_guest" })),
      verifyShippingAddress: vi.fn(async () => ({ status: "accepted", shippingAddress: unverifiedAddress }) as const),
      setShippingAddress: vi.fn(async ({ sessionId, shippingAddress }) => ({
        sessionId,
        session: createSession({ buyer_account_id: "acc_guest", shipping_address: shippingAddress }),
      })),
      assertReadyForOrderCreation: vi.fn(async ({ sessionId }) =>
        createSession({ session_id: sessionId, buyer_account_id: "acc_guest", shipping_address: unverifiedAddress }),
      ),
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
    expect(services.setShippingAddress).toHaveBeenCalledWith(
      expect.objectContaining({ shippingAddress: unverifiedAddress }),
      expect.any(Object),
    );
    expect(mockCreateCheckoutOrdersThroughOrdering).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ shipping_address: unverifiedAddress }),
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
      "/checkout/payments/:paymentId",
      null,
      undefined,
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
      order_write_commit_positions: orderingWriteResult.commandReceipt.commitPositions,
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
    mockCreateCheckoutPaymentThroughPayments.mockResolvedValue(createPaymentResult("pay_existing"));
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
      null,
      {
        commandReceipt: {
          commitEventIds: ["evt_order_created"],
          commitPositions: orderingWriteResult.commandReceipt.commitPositions,
        },
      },
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
