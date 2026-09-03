import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION, type GlobalPosition } from "@chase-sets/event-core/storage";
import { createCheckoutCartRuntime, type CheckoutCartServices } from "../features/cart/api/runtime";
import type { CheckoutCartLineRow } from "../features/cart/read-model/queries";
import { evolveCheckoutCart, initialCheckoutCartState, type CheckoutCartEvent } from "../features/cart/domain/domain";
import { createCartReadinessSnapshot } from "../features/cart/domain/readiness";
import {
  evolveCheckoutSession,
  initialCheckoutSessionState,
  type CheckoutSessionEvent,
} from "../features/sessions/domain/domain";
import { createCheckoutSessionRuntime } from "../features/sessions/api/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { createUcpEnvelope, type UcpOperationHandlerInput } from "@chase-sets/platform-runtime/ucp";
import { createCheckoutUcpHandlers } from "../support/ucp-support/checkout";
import type { CheckoutSessionServices } from "../features/sessions/api/runtime";
import type { CheckoutSessionRow } from "../features/sessions/read-model/queries";
import { CheckoutDomainError } from "../support/runtime-support/common";

const checkoutConfirmationMocks = vi.hoisted(() => ({
  createCheckoutOrdersThroughOrdering: vi.fn(),
  createCheckoutPaymentThroughPayments: vi.fn(),
  getCheckoutPaymentStatusThroughPayments: vi.fn(),
  releaseCheckoutInventoryReservations: vi.fn(),
}));

vi.mock("../support/request-support/checkout-confirmation", () => checkoutConfirmationMocks);

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_buyer",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["orders.view", "orders.manage"],
};

const context: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_1" as never,
    forAccountId: "acc_buyer" as never,
  },
};

function session(overrides: Partial<CheckoutSessionRow> = {}): CheckoutSessionRow {
  return {
    session_id: "chk_1",
    buyer_account_id: "acc_buyer",
    source_type: "buy-now",
    optimization_goal: "lowest-total",
    fulfillment_preview_revision: null,
    fulfillment_preview_snapshot: null,
    shipping_option: "standard",
    shipping_address_id: null,
    shipping_address: null,
    lines: [
      {
        listingId: "lst_1",
        cartLineId: null,
        catalogItemId: "cat_1",
        productId: "cat_1::form:raw",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Raw",
        quantity: 1,
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_1",
        sellerPreferenceId: null,
        availabilityState: "available",
      },
    ],
    checkout_reservations: [],
    order_ids: [],
    order_write_commit_positions: [],
    payment_id: null,
    submitted_offer_id: null,
    cancelled_at: null,
    created_at: "2026-05-16T00:00:00.000Z",
    updated_at: "2026-05-16T00:00:00.000Z",
    ...overrides,
  };
}

function createSessions(overrides: Partial<CheckoutSessionServices> = {}): CheckoutSessionServices {
  const mutationResult = (sessionId: string) => ({ sessionId, session: session({ session_id: sessionId }) });

  return {
    commandHandler: vi.fn() as never,
    createFromCart: vi.fn(async () => ({ sessionId: "chk_cart" as never })),
    createBuyNow: vi.fn(async () => ({ sessionId: "chk_1" as never })),
    createOfferIntent: vi.fn(async () => ({ sessionId: "chk_offer" as never })),
    selectShippingOption: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    selectOptimizationGoal: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordFulfillmentPreview: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    verifyShippingAddress: vi.fn(async (address) => ({ status: "accepted", shippingAddress: address }) as const),
    setShippingAddress: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    selectAuthenticityCheckOptIn: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    assertReadyForOrderCreation: vi.fn(async ({ sessionId }) => session({ session_id: sessionId })),
    recordCheckoutReservations: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordOrdersCreated: vi.fn<CheckoutSessionServices["recordOrdersCreated"]>(async ({ sessionId, orderIds }) => ({
      sessionId,
      session: session({ session_id: sessionId, order_ids: [...orderIds] }),
    })),
    resumeOrderCartCleanup: vi.fn<CheckoutSessionServices["resumeOrderCartCleanup"]>(
      async ({ sessionId, accountId }) => ({
        sessionId,
        session: (await (overrides.getSession ?? (async () => session()))(sessionId, accountId)) ?? session(),
      }),
    ),
    recordPaymentStarted: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordOfferSubmitted: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    cancelSession: vi.fn(async ({ sessionId }) => ({
      sessionId,
      session: session({ session_id: sessionId, cancelled_at: "2026-07-08T00:00:00.000Z" }),
      commitPosition: "44",
      commitEventIds: ["evt_checkout_cancelled"],
      commitPositions: [
        { sourceContextName: "checkout", maxGlobalPosition: "44", eventIds: ["evt_checkout_cancelled"] },
      ],
    })),
    getSession: vi.fn(async () => session()),
    getPaymentSummary: vi.fn(async () => null),
    getPaymentConfirmation: vi.fn(async () => null),
    listSavedPaymentInstruments: vi.fn(async () => []),
    projectors: [],
    ...overrides,
  };
}

function input(
  args: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, string>> = {},
  resolvedActor: ResolvedActor | null = actor,
): UcpOperationHandlerInput {
  return {
    actor: resolvedActor,
    context: resolvedActor ? context : null,
    arguments: args,
    params,
    request: new Request("https://marketplace.example/ucp/v1/checkout-sessions", {
      method: "POST",
      body: JSON.stringify(args),
      headers: { "Content-Type": "application/json" },
    }),
  };
}

describe("checkout UCP handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkoutConfirmationMocks.createCheckoutOrdersThroughOrdering.mockResolvedValue({
      orderIds: ["ord_1"],
      readyLineKeys: ["line_1"],
      writeResult: { commitPosition: "33" },
    });
    checkoutConfirmationMocks.createCheckoutPaymentThroughPayments.mockResolvedValue({ payment_id: "pay_1" });
    checkoutConfirmationMocks.getCheckoutPaymentStatusThroughPayments.mockResolvedValue({
      order_ids: ["ord_1"],
      currency_code: "usd",
      amount: "25.00",
      marketplace_checkout_fee: {
        payment_method_category: "card",
        external_basis_amount: "25.00",
        marketplace_checkout_fee_amount: "1.05",
        marketplace_checkout_fee_reduction_amount: "0.00",
        total_amount: "26.05",
        processor_amount: "26.05",
        policy_version: "marketplace-checkout-fee-v1",
        quote_fingerprint: "quote_1",
        quoted_at: "2026-07-09T00:00:00.000Z",
      },
      payment_method_quotes: [],
      wallet_credit: {
        requested_amount: "0.00",
        applied_amount: "0.00",
        external_amount: "25.00",
      },
      can_start_payment: true,
      unavailable_reasons: [],
      unavailable_reason_details: [],
    });
    checkoutConfirmationMocks.releaseCheckoutInventoryReservations.mockResolvedValue([]);
  });

  it("creates buy-now checkout through Checkout-owned session services", async () => {
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers({ sessions });

    const response = await handlers.restHandlers.create_checkout(
      input({
        source: {
          type: "buy-now",
          listing_id: "lst_1",
          catalog_item_id: "cat_1",
          product_id: "cat_1::form:raw",
          title: "Charizard",
          selected_options: [{ dimension_id: "form", option_id: "raw" }],
          quantity: 2,
          fulfillment_preview_revision: "buy_now_supply_ready",
        },
        shipping_option: "priority",
      }),
    );

    expect(response.ucp.status).toBe("ok");
    expect(sessions.createBuyNow).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_buyer",
        listingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "cat_1::form:raw",
        quantity: 2,
        shippingOption: "priority",
        fulfillmentPreviewRevision: "buy_now_supply_ready",
      }),
      context,
    );
  });

  it("creates cart checkout only with cart readiness facts", async () => {
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers({ sessions });

    const response = await handlers.restHandlers.create_checkout(
      input({
        source: {
          type: "cart",
          readiness: {
            snapshot_id: "cr_ready",
            source_revision: "cr_source",
            decisions: {
              line_outcomes: [{ line_id: "cli_waiting", outcome: "save-for-later" }],
              optimization: { decision: "accepted", line_id: "cli_1", listing_id: "lst_lower" },
            },
          },
        },
        shipping_option: "priority",
      }),
    );

    expect(response.ucp.status).toBe("ok");
    expect(sessions.createFromCart).toHaveBeenCalledWith(
      {
        accountId: "acc_buyer",
        shippingOption: "priority",
        optimizationGoal: undefined,
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: {
          lineOutcomes: [{ lineId: "cli_waiting", outcome: "save-for-later" }],
          optimization: { decision: "accepted", lineId: "cli_1", listingId: "lst_lower" },
        },
      },
      context,
    );
  });

  it("keeps UCP cart checkout Account-only when anonymous-looking input and headers are presented", async () => {
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers({ sessions });
    const operation = input({
      source: {
        type: "cart",
        readiness: { snapshot_id: "cr_ready", source_revision: "cr_source" },
        anonymous_cart_id: "anon_raw_marker",
      },
      presented_anonymous_cart_id: "anon_raw_marker",
    });

    const response = await handlers.restHandlers.create_checkout({
      ...operation,
      request: new Request(operation.request, {
        headers: {
          ...Object.fromEntries(operation.request.headers.entries()),
          "x-checkout-anonymous-cart-id": "anon_raw_marker",
        },
      }),
    });

    expect(response.ucp.status).toBe("ok");
    expect(sessions.createFromCart).toHaveBeenCalledWith(
      {
        accountId: "acc_buyer",
        shippingOption: undefined,
        optimizationGoal: undefined,
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: undefined,
      },
      context,
    );
    expect(JSON.stringify(vi.mocked(sessions.createFromCart).mock.calls)).not.toContain("anon_raw_marker");
  });

  it("updates shipping details on an existing checkout session", async () => {
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers({ sessions });

    const response = await handlers.restHandlers.update_checkout(
      input(
        {
          shipping_option: "expedited",
          shipping_address: {
            name: "Jane Smith",
            line1: "100 Market Street",
            city: "Chicago",
            state: "IL",
            postal_code: "60601",
            country: "US",
          },
        },
        { id: "chk_1" },
      ),
    );

    expect(response.ucp.status).toBe("ok");
    expect(sessions.selectShippingOption).toHaveBeenCalledWith(
      {
        sessionId: "chk_1",
        accountId: "acc_buyer",
        shippingOption: "expedited",
      },
      context,
    );
    expect(sessions.setShippingAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chk_1",
        accountId: "acc_buyer",
      }),
      context,
    );
  });

  it("requires trusted UI instead of completing payment from an agent call", async () => {
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers({ sessions });

    const response = await handlers.restHandlers.complete_checkout(input({}, { id: "chk_1" }));

    expect(response.ucp.status).toBe("requires_action");
    expect(response.messages).toEqual([expect.objectContaining({ code: "trusted_ui_required" })]);
  });

  it("adds a resumable checkout URL to a mandate rejection without money-moving effects", async () => {
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers(
      { sessions },
      {
        paymentHandoff: {
          payment: {},
          evaluateCompleteRequest: () => ({
            kind: "respond",
            response: createUcpEnvelope("requires_action", { action: { type: "trusted_checkout_handoff" } }, [
              { severity: "error", code: "mandate_expired", message: "Mandate expired." },
            ]),
          }),
        },
      },
    );

    const response = await handlers.restHandlers.complete_checkout(input({}, { id: "chk_1" }));

    expect(response).toMatchObject({
      ucp: { status: "requires_action" },
      action: { type: "trusted_checkout_handoff", url: "/checkout/buy/session/chk_1" },
      messages: [{ severity: "error", code: "mandate_expired" }],
    });
    expect(sessions.recordOrdersCreated).not.toHaveBeenCalled();
    expect(sessions.recordPaymentStarted).not.toHaveBeenCalled();
    expect(checkoutConfirmationMocks.createCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
  });

  it("cancels checkout sessions without trusted UI handoff", async () => {
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers({ sessions });

    const response = await handlers.restHandlers.cancel_checkout(input({}, { id: "chk_1" }));

    expect(response.ucp.status).toBe("ok");
    expect(response.checkout).toEqual(expect.objectContaining({ id: "chk_1", status: "cancelled" }));
    expect(response).toEqual(
      expect.objectContaining({
        released_reservation_ids: [],
        commit_position: "44",
        commit_event_ids: ["evt_checkout_cancelled"],
      }),
    );
    expect(sessions.cancelSession).toHaveBeenCalledWith({ sessionId: "chk_1", accountId: "acc_buyer" }, context);
  });

  it("does not complete headless checkout when delivery address serviceability fails", async () => {
    const sessions = createSessions({
      assertReadyForOrderCreation: vi.fn(async () => {
        throw new CheckoutDomainError(
          "This delivery address is not supported for the selected shipping service. Use a street address before paying.",
          "shipping_address_restricted",
        );
      }),
    });
    const handlers = createCheckoutUcpHandlers(
      {
        sessions,
      },
      {
        paymentHandoff: {
          payment: { provider: "test" },
          evaluateCompleteRequest: () => ({
            kind: "headless-agentic-payment",
            agenticPayment: {} as never,
            humanPresent: true,
            evidence: { mandate: "verified" },
          }),
        },
      },
    );

    const response = await handlers.restHandlers.complete_checkout(
      input(
        {
          marketplace_checkout_fee_quote_fingerprint: "quote_1",
          shipping_address: {
            name: "Jane Smith",
            line1: "PO Box 100",
            city: "Chicago",
            state: "IL",
            postal_code: "60601",
            country: "US",
          },
        },
        { id: "chk_1" },
      ),
    );

    expect(response.ucp.status).toBe("error");
    expect(response.messages).toEqual([
      expect.objectContaining({
        code: "shipping_address_restricted",
        message:
          "This delivery address is not supported for the selected shipping service. Use a street address before paying.",
      }),
    ]);
    expect(sessions.recordOrdersCreated).not.toHaveBeenCalled();
    expect(sessions.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("does not complete headless checkout with unsupported customer economics input", async () => {
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers(
      {
        sessions,
      },
      {
        paymentHandoff: {
          payment: { provider: "test" },
          evaluateCompleteRequest: () => ({
            kind: "headless-agentic-payment",
            agenticPayment: {} as never,
            humanPresent: true,
            evidence: { mandate: "verified" },
          }),
        },
      },
    );

    const response = await handlers.restHandlers.complete_checkout(
      input(
        {
          marketplace_checkout_fee_quote_fingerprint: "quote_1",
          gift_card_code: "GC123",
          shipping_address: {
            name: "Jane Smith",
            line1: "100 Market Street",
            city: "Chicago",
            state: "IL",
            postal_code: "60601",
            country: "US",
          },
        },
        { id: "chk_1" },
      ),
    );

    expect(response.ucp.status).toBe("error");
    expect(response.messages).toEqual([
      expect.objectContaining({
        code: "checkout_economics_unsupported",
        message: "Promo codes, gift cards, and store credit are not available in checkout yet.",
      }),
    ]);
    expect(sessions.setShippingAddress).not.toHaveBeenCalled();
    expect(sessions.recordOrdersCreated).not.toHaveBeenCalled();
    expect(sessions.recordPaymentStarted).not.toHaveBeenCalled();
  });

  it("blocks headless checkout spend from the Payments-computed order total instead of the request amount", async () => {
    const sessions = createSessions();
    const spendPolicy = {
      authorize: vi.fn(async () => ({
        allowed: false as const,
        limitKind: "daily-cap" as const,
        reason: "This agent grant exceeded its platform spend cap.",
        remainingCents: 1_000,
        capCents: 2_000,
      })),
    };
    const handlers = createCheckoutUcpHandlers(
      {
        sessions,
      },
      {
        agentGrantSpendPolicy: spendPolicy,
        paymentHandoff: {
          payment: { provider: "test" },
          evaluateCompleteRequest: () => ({
            kind: "headless-agentic-payment",
            agenticPayment: {} as never,
            humanPresent: true,
            evidence: { mandate: "verified" },
          }),
        },
      },
    );

    const response = await handlers.restHandlers.complete_checkout(
      input(
        {
          marketplace_checkout_fee_quote_fingerprint: "quote_1",
          total_amount: "10.00",
        },
        { id: "chk_1" },
        { ...actor, sessionId: "ucp:auth_1" },
      ),
    );

    expect(response.ucp.status).toBe("requires_action");
    expect(response.messages).toEqual([
      expect.objectContaining({
        code: "agent_grant_spending_mandate_blocked",
        message: "This agent grant exceeded its platform spend cap.",
      }),
    ]);
    expect(response.guardrail).toEqual({
      type: "agent_grant_spending_mandate",
      limit_kind: "daily-cap",
      cap_cents: 2_000,
      remaining_cents: 1_000,
    });
    expect(spendPolicy.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: "auth_1",
        accountId: "acc_buyer",
        operation: "complete_checkout",
        amountCents: 2_605,
        rail: "ap2",
        humanPresent: true,
        humanNotPresentAuthorized: false,
      }),
    );
    expect(checkoutConfirmationMocks.createCheckoutOrdersThroughOrdering).toHaveBeenCalledTimes(1);
    expect(checkoutConfirmationMocks.getCheckoutPaymentStatusThroughPayments).toHaveBeenCalledWith(
      expect.any(Request),
      ["ord_1"],
      null,
      "card",
      { commitPosition: "33" },
    );
    expect(sessions.setShippingAddress).not.toHaveBeenCalled();
    expect(sessions.recordOrdersCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chk_1",
        orderIds: ["ord_1"],
      }),
      context,
    );
    expect(sessions.recordPaymentStarted).not.toHaveBeenCalled();
    expect(checkoutConfirmationMocks.createCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
  });

  it("returns a trusted handoff for headless offer-intent completion without ordering or payment side effects", async () => {
    const offerIntentSession = session({
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
          fulfillmentMode: "optimize",
          lockedListingId: null,
          sellerPreferenceId: null,
          availabilityState: "waiting-for-supply",
        },
      ],
    });
    const sessions = createSessions({
      getSession: vi.fn(async () => offerIntentSession),
    });
    const handlers = createCheckoutUcpHandlers(
      {
        sessions,
      },
      {
        paymentHandoff: {
          payment: { provider: "test" },
          evaluateCompleteRequest: () => ({
            kind: "headless-agentic-payment",
            agenticPayment: {} as never,
            humanPresent: true,
            evidence: { mandate: "verified" },
          }),
        },
      },
    );

    const response = await handlers.restHandlers.complete_checkout(
      input(
        {
          marketplace_checkout_fee_quote_fingerprint: "quote_1",
        },
        { id: "chk_1" },
      ),
    );

    expect(response.ucp.status).toBe("requires_action");
    expect(response.action).toEqual({
      type: "trusted_checkout_handoff",
      reason: "Purchase-intent offer submission still requires trusted UI review.",
    });
    expect(response.messages).toEqual([
      expect.objectContaining({
        code: "trusted_ui_required",
        message: "UCP headless payment completion is only enabled for buy-now and cart checkout sessions.",
      }),
    ]);
    expect(sessions.assertReadyForOrderCreation).not.toHaveBeenCalled();
    expect(sessions.recordOrdersCreated).not.toHaveBeenCalled();
    expect(sessions.recordPaymentStarted).not.toHaveBeenCalled();
    expect(sessions.recordOfferSubmitted).not.toHaveBeenCalled();
  });

  it("completes headless checkout off-session with a stored payment method when no challenge is required", async () => {
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers(
      { sessions },
      {
        paymentHandoff: {
          payment: { provider: "test" },
          evaluateCompleteRequest: () => ({
            kind: "headless-stored-payment-method",
            savedCheckoutInstrumentId: "sci_card_1",
          }),
        },
      },
    );

    const response = await handlers.restHandlers.complete_checkout(
      input(
        {
          marketplace_checkout_fee_quote_fingerprint: "quote_1",
          payment: { instruments: [{ type: "stored_payment_method", id: "sci_card_1" }] },
        },
        { id: "chk_1" },
      ),
    );

    expect(response.ucp.status).toBe("ok");
    expect(response.payment_id).toBe("pay_1");
    expect(response.order_ids).toEqual(["ord_1"]);
    expect(response.payment_rail).toBe("stored-payment-method");
    // The saved instrument id is passed as savedCheckoutInstrumentId and no agentic payment is used.
    expect(checkoutConfirmationMocks.createCheckoutPaymentThroughPayments).toHaveBeenCalledWith(
      expect.any(Request),
      "chk_1",
      ["ord_1"],
      null,
      "card",
      "quote_1",
      "sci_card_1",
      false,
      "/account/payments/:paymentId",
      null,
      { commitPosition: "33" },
      undefined,
      undefined,
    );
    expect(sessions.recordPaymentStarted).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chk_1", paymentId: "pay_1" }),
      context,
    );
  });

  it("hands off a hosted 3DS challenge URL when the off-session stored-PM charge requires action", async () => {
    checkoutConfirmationMocks.createCheckoutPaymentThroughPayments.mockResolvedValueOnce({
      payment_id: "pay_1",
      status: "pending-confirmation",
      processor_status: "requires_action",
      processor_redirect_url: "https://hooks.stripe.test/3ds/pay_1",
    });
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers(
      { sessions },
      {
        paymentHandoff: {
          payment: { provider: "test" },
          evaluateCompleteRequest: () => ({
            kind: "headless-stored-payment-method",
            savedCheckoutInstrumentId: "sci_card_1",
          }),
        },
      },
    );

    const response = await handlers.restHandlers.complete_checkout(
      input({ marketplace_checkout_fee_quote_fingerprint: "quote_1" }, { id: "chk_1" }),
    );

    expect(response.ucp.status).toBe("requires_action");
    expect(response.payment_id).toBe("pay_1");
    expect(response.order_ids).toEqual(["ord_1"]);
    expect(response.action).toEqual(
      expect.objectContaining({
        type: "payment_challenge",
        url: "https://hooks.stripe.test/3ds/pay_1",
        payment_id: "pay_1",
        resume: { operation: "complete_checkout", checkout_id: "chk_1" },
      }),
    );
    expect(response.messages).toEqual([expect.objectContaining({ code: "payment_challenge_required" })]);
    // The payment is recorded so a resume after the buyer authenticates finds the same payment.
    expect(sessions.recordPaymentStarted).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chk_1", paymentId: "pay_1" }),
      context,
    );
  });

  it("resumes a challenged stored-PM checkout idempotently without recreating orders", async () => {
    // The session already has orders and a payment from the first (challenged) attempt.
    const sessions = createSessions({
      getSession: vi.fn(async () => session({ order_ids: ["ord_1"], payment_id: "pay_1" })),
      assertReadyForOrderCreation: vi.fn(async () => {
        throw new Error("Orders must not be recreated on resume.");
      }),
    });
    // The processor now reports the challenge is cleared and the payment is settling.
    checkoutConfirmationMocks.createCheckoutPaymentThroughPayments.mockResolvedValueOnce({
      payment_id: "pay_1",
      status: "captured",
      processor_status: "succeeded",
      processor_redirect_url: null,
    });
    const handlers = createCheckoutUcpHandlers(
      { sessions },
      {
        paymentHandoff: {
          payment: { provider: "test" },
          evaluateCompleteRequest: () => ({
            kind: "headless-stored-payment-method",
            savedCheckoutInstrumentId: "sci_card_1",
          }),
        },
      },
    );

    const response = await handlers.restHandlers.complete_checkout(
      input({ marketplace_checkout_fee_quote_fingerprint: "quote_1" }, { id: "chk_1" }),
    );

    expect(response.ucp.status).toBe("ok");
    expect(response.payment_id).toBe("pay_1");
    expect(checkoutConfirmationMocks.createCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
    expect(checkoutConfirmationMocks.createCheckoutPaymentThroughPayments).toHaveBeenCalledWith(
      expect.any(Request),
      "chk_1",
      ["ord_1"],
      null,
      "card",
      "quote_1",
      "sci_card_1",
      false,
      "/account/payments/:paymentId",
      null,
      undefined,
      undefined,
      undefined,
    );
  });

  it("requires a linked buyer account", async () => {
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers({ sessions });

    const response = await handlers.restHandlers.create_checkout(input({}, {}, null));

    expect(response.ucp.status).toBe("error");
    expect(response.messages).toEqual([expect.objectContaining({ code: "authentication_required" })]);
  });
});

const productMeasureSnapshot = {
  catalogItemId: "cat_1",
  productId: "cat_1::",
  selectedOptions: [],
  measureVersion: "pm_test_raw_v1",
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.02,
  unitWeightOunces: 0.08,
  physicalFlags: ["raw-card"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "measured",
};

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

const readyCartLine: CheckoutCartLineRow = {
  buyer_account_id: "acc_buyer",
  line_id: "cli_1",
  catalog_catalog_item_id: "cat_1",
  product_id: "cat_1::",
  item_language_code: "en",
  item_title: "Charizard",
  item_subtitle: null,
  item_image_url: null,
  item_image_srcset: null,
  item_image_loading_url: null,
  item_image_loading_alt: null,
  item_image_loading_srcset: null,
  selected_options: [],
  product_summary: null,
  quantity: 1,
  fulfillment_mode: "locked-listing",
  locked_listing_id: "lst_1",
  selected_listing_id: null,
  selected_listing_seller_account_id: null,
  selected_listing_seller_display_name: null,
  selected_listing_seller_slug: null,
  selected_listing_price_amount: null,
  selected_listing_snapshot_source: null,
  selected_listing_snapshot_captured_at: null,
  seller_preference_id: null,
  availability_state: "available",
  seller_options: [
    {
      listing_id: "lst_1",
      seller_account_id: "acc_seller",
      seller_slug: "seller",
      seller_display_name: "Card Vault",
      seller_average_rating: null,
      seller_review_count: 0,
      price_amount: "25.00",
      available_quantity: 1,
      product_summary: null,
      product_measure_snapshot: productMeasureSnapshot,
    },
  ],
  created_at: "2026-06-09T00:00:00.000Z",
  updated_at: "2026-06-09T00:00:00.000Z",
};

async function unionCleanupHarness() {
  const { eventStore } = createInMemoryEventStore();
  let projected: CheckoutSessionRow | null = null;
  const db = {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes("checkout_catalog_items")
        ? [{ catalog_item_id: "cat_1", status: "active", product_schema: null, language_code: "en" }]
        : sql.includes("checkout_session_pages") && projected
          ? [projected]
          : [],
    })),
  };
  const checkpointStore = createCheckpointStore();
  const anonymous = "anon_raw_cleanup_marker";
  const buyer = context.audit.forAccountId;
  const events = (streamId: string) => eventStore.readStream({ streamId });
  const cartState = async (owner: string) =>
    (await events(`checkout.cart-${owner}`)).reduce(
      (state, event) => evolveCheckoutCart(state, { type: event.eventType, data: event.payload } as CheckoutCartEvent),
      initialCheckoutCartState,
    );
  const cart = createCheckoutCartRuntime({ eventStore, checkpointStore, db });
  let listingSequence = 0;
  const add = async (owner: string) =>
    cart.addLine(
      {
        accountId: owner as never,
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
        fulfillmentMode: "locked-listing",
        lockedListingId: `lst_${++listingSequence}`,
      },
      context,
    );
  const first = await add(anonymous);
  const second = await add(anonymous);
  const copy = async (lineId: string, owner = String(buyer), quantity = 1) => {
    const line = (await cartState(anonymous)).lines.find((entry) => entry.lineId === lineId)!;
    await cart.commandHandler({
      streamId: `checkout.cart-${owner}`,
      context,
      command: { ...line, type: "AddCartLine", buyerAccountId: owner as never, quantity },
    });
  };
  const listCartLines: CheckoutCartServices["listCartLines"] = async (accountId, presented) => {
    const lines = [...(await cartState(accountId)).lines, ...(presented ? (await cartState(presented)).lines : [])];
    return [
      ...new Map(
        lines.reverse().map((line) => [
          line.lineId,
          {
            ...readyCartLine,
            buyer_account_id: String(accountId),
            line_id: line.lineId,
            quantity: line.quantity,
            locked_listing_id: line.lockedListingId,
            seller_options: [
              { ...readyCartLine.seller_options[0]!, listing_id: line.lockedListingId!, available_quantity: 20 },
            ],
          },
        ]),
      ).values(),
    ];
  };
  const realCart = { ...cart, listCartLines };
  const runtime = () => createCheckoutSessionRuntime({ eventStore, checkpointStore, db, cart: realCart });
  const sessions = runtime();
  const readiness = createCartReadinessSnapshot(await listCartLines(buyer, anonymous), undefined, {
    accountId: buyer,
    presentedAnonymousCartId: anonymous,
  });
  const created = await sessions.createFromCart(
    {
      accountId: buyer,
      presentedAnonymousCartId: anonymous,
      readinessSnapshotId: readiness.snapshotId,
      readinessSourceRevision: readiness.sourceRevision,
    },
    context,
  );
  const params = { sessionId: created.sessionId, accountId: buyer };
  await sessions.commandHandler({
    streamId: `checkout.session-${params.sessionId}`,
    context,
    command: {
      type: "SetShippingAddress",
      shippingAddress: {
        name: "Buyer",
        line1: "100 Market Street",
        line2: null,
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
      selectedAt: new Date().toISOString(),
    },
  });
  const sessionEvents = () => events(`checkout.session-${params.sessionId}`);
  const state = async () =>
    (await sessionEvents()).reduce(
      (current, event) =>
        evolveCheckoutSession(current, { type: event.eventType, data: event.payload } as CheckoutSessionEvent),
      initialCheckoutSessionState,
    );
  return {
    eventStore,
    cart,
    realCart,
    runtime,
    params,
    setProjected: (row: CheckoutSessionRow | null) => {
      projected = row;
    },
    anonymous,
    buyer,
    add,
    copy,
    cartState,
    sessionEvents,
    state,
    ids: [first.lineId, second.lineId],
    record: {
      ...params,
      orderIds: ["ord_union"],
      orderWriteCommitPositions: [
        { sourceContextName: "ordering", maxGlobalPosition: "800", eventIds: ["evt_ordering"] },
      ],
    },
  };
}

describe("UCP union cleanup caller closure", () => {
  const body = {
    shipping_address: {
      name: "Buyer",
      line1: "100 Market Street",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    marketplace_checkout_fee_quote_fingerprint: "quote_1",
    accountId: "acc_foreign",
    presentedAnonymousCartId: "anon_foreign",
  };
  const handlersFor = (sessions: CheckoutSessionServices, rail: "agentic" | "stored") =>
    createCheckoutUcpHandlers(
      { sessions },
      {
        paymentHandoff: {
          payment: { provider: "test" },
          evaluateCompleteRequest: () =>
            rail === "agentic"
              ? { kind: "headless-agentic-payment", agenticPayment: {} as never, humanPresent: true }
              : { kind: "headless-stored-payment-method", savedCheckoutInstrumentId: "instrument_test" },
        },
      },
    );
  beforeEach(() => {
    checkoutConfirmationMocks.createCheckoutOrdersThroughOrdering.mockReset();
    checkoutConfirmationMocks.createCheckoutPaymentThroughPayments
      .mockReset()
      .mockResolvedValue({ payment_id: "pay_union" });
  });

  it.each(["agentic", "stored"] as const)(
    "union cleanup caller closure %s zero/partial-copy and identical shipping retry",
    async (rail) => {
      for (const copies of [0, 1]) {
        const h = await unionCleanupHarness();
        if (copies) await h.copy(h.ids[0]!);
        checkoutConfirmationMocks.createCheckoutOrdersThroughOrdering.mockClear().mockResolvedValue({
          orderIds: h.record.orderIds,
          readyLineKeys: h.ids,
          writeResult: { commitPositions: h.record.orderWriteCommitPositions },
        });
        const result = await handlersFor(h.runtime(), rail).restHandlers.complete_checkout!(
          input(body, { id: h.params.sessionId }),
        );
        expect(result.ucp.status).toBe("ok");
        expect((await h.cartState(h.anonymous)).lines).toEqual([]);
        expect((await h.cartState(h.buyer)).lines).toEqual([]);
        expect(JSON.stringify(result)).not.toContain(h.anonymous);
        const before = await h.sessionEvents();
        await handlersFor(h.runtime(), rail).restHandlers.complete_checkout!(input(body, { id: h.params.sessionId }));
        expect(checkoutConfirmationMocks.createCheckoutOrdersThroughOrdering).toHaveBeenCalledTimes(1);
        expect(await h.sessionEvents()).toEqual(before);
      }
    },
  );

  it.each(["agentic", "stored"] as const)(
    "union cleanup crash resume %s both projection variants at each commit",
    async (rail) => {
      for (const projection of ["absent", "stale", "orders"])
        for (const boundary of ["orders", "remove-1", "remove-2", "remove-3", "complete", "complete-ack"]) {
          const h = await unionCleanupHarness();
          await h.copy(h.ids[0]!);
          const initialPage = await h.runtime().getSession(h.params.sessionId, h.buyer);
          checkoutConfirmationMocks.createCheckoutOrdersThroughOrdering.mockClear().mockResolvedValue({
            orderIds: h.record.orderIds,
            readyLineKeys: h.ids,
            writeResult: { commitPositions: h.record.orderWriteCommitPositions },
          });
          const original = h.eventStore.appendToStream.bind(h.eventStore);
          let removals = 0;
          const fault = vi.spyOn(h.eventStore, "appendToStream").mockImplementation(async (input) => {
            const type = input.events[0]?.eventType;
            const at =
              type === "checkout.session.orders-created"
                ? "orders"
                : type === "checkout.cart.line-removed"
                  ? `remove-${++removals}`
                  : type === "checkout.session.cart-cleanup-completed"
                    ? "complete"
                    : "other";
            if (at === boundary || (boundary === "complete-ack" && at === "complete")) {
              if (boundary !== "complete") await original(input);
              throw new Error(`store ${h.anonymous}`);
            }
            return original(input);
          });
          const result = await handlersFor(h.runtime(), rail).restHandlers.complete_checkout!(
            input(body, { id: h.params.sessionId }),
          );
          expect(result.ucp.status, `${projection} ${boundary}`).toBe("error");
          expect(result.messages?.[0]?.message).toBe("Cart cleanup could not finish. Retry checkout.");
          expect(JSON.stringify(result)).not.toContain(h.anonymous);
          expect(result.commit_positions).toContainEqual(h.record.orderWriteCommitPositions[0]);
          fault.mockRestore();
          h.setProjected(
            projection === "absent"
              ? null
              : projection === "stale"
                ? initialPage
                : await h.runtime().getSession(h.params.sessionId, h.buyer),
          );
          const retry = await handlersFor(h.runtime(), rail).mcpToolHandlers.complete_checkout!(
            input(body, { id: h.params.sessionId }),
          );
          expect(retry.ucp.status, `${projection} ${boundary}`).toBe("ok");
          expect(checkoutConfirmationMocks.createCheckoutOrdersThroughOrdering).toHaveBeenCalledTimes(1);
          expect((await h.cartState(h.anonymous)).lines).toEqual([]);
          expect((await h.cartState(h.buyer)).lines).toEqual([]);
          expect(
            (await h.sessionEvents()).filter((event) => event.eventType === "checkout.session.orders-created"),
          ).toHaveLength(1);
          expect(
            (await h.sessionEvents()).filter((event) => event.eventType === "checkout.session.cart-cleanup-completed"),
          ).toHaveLength(1);
        }
    },
  );

  it("union cleanup authority and redaction precedes guarded and terminal returns", async () => {
    for (const mode of ["guarded", "terminal", "default"]) {
      const terminal = mode === "terminal";
      const h = await unionCleanupHarness();
      await h.runtime().commandHandler({
        streamId: `checkout.session-${h.params.sessionId}`,
        context,
        command: {
          type: "RecordOrdersCreated",
          orderIds: ["ord_union" as never],
          orderWriteCommitPositions: h.record.orderWriteCommitPositions,
          recordedAt: "2026-09-01T00:00:00Z",
        },
      });
      if (terminal) await h.runtime().recordPaymentStarted({ ...h.params, paymentId: "pay_union" }, context);
      const guarded = () =>
        createCheckoutUcpHandlers(
          { sessions: h.runtime() },
          terminal
            ? {}
            : {
                paymentHandoff: {
                  payment: {},
                  evaluateCompleteRequest: () => ({
                    kind: "respond",
                    response: createUcpEnvelope("requires_action", {}),
                  }),
                },
              },
        );
      const fault = vi
        .spyOn(h.realCart, "removeLine")
        .mockRejectedValue(new CheckoutDomainError(`cart ${h.anonymous}`));
      const wrong = await guarded().restHandlers.complete_checkout!(
        input(body, { id: h.params.sessionId }, { ...actor, accountId: "acc_foreign" }),
      );
      expect(wrong.ucp.status).toBe("error");
      const missing = await guarded().restHandlers.complete_checkout!(input(body, { id: h.params.sessionId }, null));
      expect(missing.ucp.status).toBe("error");
      expect(fault).not.toHaveBeenCalled();
      const result = await guarded().restHandlers.complete_checkout!(input(body, { id: h.params.sessionId }));
      expect(result.ucp.status).toBe("error");
      expect(JSON.stringify(result)).not.toContain(h.anonymous);
      expect((await h.state()).orderCartCleanup?.status).toBe("pending");
      fault.mockRestore();
      const resumed = await guarded().restHandlers.complete_checkout!(input(body, { id: h.params.sessionId }));
      expect(resumed.ucp.status).toBe(terminal ? "ok" : "requires_action");
      expect(resumed.commit_positions).toContainEqual(h.record.orderWriteCommitPositions[0]);
      expect((await h.cartState(h.anonymous)).lines).toEqual([]);
    }
  });
});
