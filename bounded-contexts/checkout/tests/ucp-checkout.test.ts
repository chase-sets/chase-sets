import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { UcpOperationHandlerInput } from "@chase-sets/platform-runtime/ucp";
import { createCheckoutUcpHandlers } from "../support/ucp-support/checkout";
import type { CheckoutSessionServices } from "../features/sessions/api/runtime";
import type { CheckoutSessionRow } from "../features/sessions/read-model/queries";
import { CheckoutDomainError } from "../support/runtime-support/common";

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
    assertReadyForOrderCreation: vi.fn(async ({ sessionId }) => session({ session_id: sessionId })),
    recordCheckoutReservations: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordOrdersCreated: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordPaymentStarted: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    recordOfferSubmitted: vi.fn(async ({ sessionId }) => mutationResult(sessionId)),
    getSession: vi.fn(async () => session()),
    getPaymentSummary: vi.fn(async () => null),
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

  it("requires a linked buyer account", async () => {
    const sessions = createSessions();
    const handlers = createCheckoutUcpHandlers({ sessions });

    const response = await handlers.restHandlers.create_checkout(input({}, {}, null));

    expect(response.ucp.status).toBe("error");
    expect(response.messages).toEqual([expect.objectContaining({ code: "authentication_required" })]);
  });
});
