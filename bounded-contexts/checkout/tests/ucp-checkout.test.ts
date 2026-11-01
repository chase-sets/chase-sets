import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { UcpOperationHandlerInput } from "@chase-sets/platform-runtime/ucp";
import {
  createCheckoutUcpHandlers,
  checkoutUcpState,
  checkoutUcpResource,
  resolveCheckoutUcpQuote,
  type CheckoutUcpListing,
  type CheckoutUcpOrderFact,
  type CheckoutUcpQuote,
} from "../support/ucp-support/checkout";
import { expectUcpCapture, ucpSchemaValidator } from "@chase-sets/platform-runtime/ucp-schema-test-support";
import type { CheckoutFulfillmentPreview } from "../features/sessions/domain/fulfillment-preview";
import type { CheckoutSessionRow } from "../features/sessions/read-model/queries";
import type { CheckoutSessionServices } from "../features/sessions/api/runtime";
import { CheckoutEntryAttemptConflict } from "../features/command-attempts/api/entry-attempt";
import { CheckoutDomainError } from "../support/runtime-support/common";

const ports = vi.hoisted(() => ({
  previewBuyNowCheckoutSupplyThroughOrdering: vi.fn(),
  releaseCheckoutInventoryReservations: vi.fn(async () => []),
  createCheckoutOrdersThroughOrdering: vi.fn(),
  createCheckoutPaymentThroughPayments: vi.fn(),
}));
vi.mock("../support/request-support/checkout-confirmation", () => ports);
const id = "chk_0123456789abcdefghijklmnop";
const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_buyer",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["orders.view", "orders.manage"],
};
const context: EventStoreContext = {
  tenantId: "tnt_1" as never,
  audit: { performedByUserId: "usr_1" as never, forAccountId: "acc_buyer" as never },
};
const listing: CheckoutUcpListing = {
  listing_id: "lst_1",
  catalog_catalog_item_id: "cat_1",
  product_id: "cat_1::form:raw",
  item_title: "Charizard",
  item_subtitle: null,
  product_summary: "Raw",
  selected_options: [],
  inventory_item_id: "inv_1",
  account_id: "acc_seller",
  price_amount: "20.00",
  price_currency_code: "usd",
  visible_quantity: 10,
};
const line = {
  listingId: "lst_1",
  cartLineId: null,
  catalogItemId: "cat_1",
  productId: "cat_1::form:raw",
  itemTitle: "Charizard",
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: "Raw",
  quantity: 1,
  fulfillmentMode: "locked-listing" as const,
  lockedListingId: "lst_1",
  sellerPreferenceId: null,
};
function session(overrides: Partial<CheckoutSessionRow> = {}): CheckoutSessionRow {
  return {
    session_id: id,
    buyer_account_id: "acc_buyer",
    source_type: "buy-now",
    optimization_goal: "lowest-total",
    fulfillment_preview_revision: "ready",
    fulfillment_preview_snapshot: null,
    shipping_option: "standard",
    shipping_address_id: null,
    shipping_address: null,
    lines: [line],
    checkout_reservations: [],
    order_ids: [],
    order_write_commit_positions: [],
    payment_id: null,
    submitted_offer_id: null,
    cancelled_at: null,
    handoff_expires_at: "2026-10-16T06:00:00.000Z",
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}
function preview(ready = true) {
  return {
    revision: "server_readiness_revision",
    readyLineKeys: ready ? ["lst_1:0"] : [],
    unavailableLineKeys: [],
    unavailableLines: [],
    materialChangeReasons: [],
    sellerGroups: [{ lines: [{ listingId: "lst_1", estimatedUnitPriceAmount: "20.00" }] }],
    totals: {
      itemSubtotalAmount: "20.00",
      shippingAmount: "0.00",
      salesTaxAmount: "0.00",
      totalAmount: "20.00",
      packageCount: 1,
    },
  };
}
function fixture(overrides: Partial<CheckoutSessionRow> = {}) {
  let current = session(overrides);
  let clock = new Date("2026-10-16T00:00:00.000Z");
  // The owner's entry attempts, as Checkout records them beside the started Session.
  const entryAttempts = new Map<string, { requestHash: string; sessionId: string }>();
  const resolveEntryAttempt = vi.fn<CheckoutSessionServices["resolveEntryAttempt"]>(async ({ entryAttempt }) => {
    const recorded = entryAttempts.get(entryAttempt.attemptId);
    if (!recorded) return null;
    if (recorded.requestHash !== entryAttempt.requestHash) throw new CheckoutEntryAttemptConflict();
    return { sessionId: recorded.sessionId as never };
  });
  const writes = {
    createBuyNow: vi.fn<CheckoutSessionServices["createBuyNow"]>(async (params) => {
      if (params.entryAttempt) {
        entryAttempts.set(params.entryAttempt.attemptId, {
          requestHash: params.entryAttempt.requestHash,
          sessionId: params.sessionIdOverride ?? id,
        });
      }
      current = session({
        session_id: params.sessionIdOverride ?? id,
        fulfillment_preview_revision: params.fulfillmentPreviewRevision,
        fulfillment_preview_snapshot: params.fulfillmentPreviewSnapshot ?? null,
        handoff_expires_at: params.handoffExpiresAt ?? null,
        created_at: params.createdAt ?? clock.toISOString(),
      });
      return { sessionId: current.session_id as never };
    }),
    cancelSession: vi.fn<CheckoutSessionServices["cancelSession"]>(async () => {
      current = { ...current, cancelled_at: clock.toISOString() };
      return { sessionId: id, session: current };
    }),
    recordFulfillmentPreview: vi.fn(),
    createFromCart: vi.fn(),
    createOfferIntent: vi.fn(),
    setShippingAddress: vi.fn(),
    selectShippingOption: vi.fn(),
    selectOptimizationGoal: vi.fn(),
    recordOrdersCreated: vi.fn(),
    recordPaymentStarted: vi.fn(),
    resumeOrderCartCleanup: vi.fn(),
    assertReadyForOrderCreation: vi.fn(),
    recordOfferSubmitted: vi.fn(),
  };
  const sessions = {
    ...writes,
    resolveEntryAttempt,
    getLastRecordedQuote: vi.fn(async () => ({
      revision: "retained_quote_revision",
      readyLineKeys: ["lst_1:0"],
      unavailableLineKeys: [],
      unavailableLines: [],
      materialChangeReasons: [],
      sellerGroups: [{ lines: [{ listingId: "lst_1", estimatedUnitPriceAmount: "20.00" }] }],
      totals: {
        itemSubtotalAmount: "20.00",
        shippingAmount: "0.00",
        salesTaxAmount: "0.00",
        totalAmount: "20.00",
        packageCount: 1,
      },
    })),
    getSession: vi.fn(async (_id: string, account: string) => (account === current.buyer_account_id ? current : null)),
    readSessionForCancellation: vi.fn<CheckoutSessionServices["readSessionForCancellation"]>(async () => {
      if (current.cancelled_at) return { status: "already-cancelled", session: current };
      if (current.payment_id || current.order_ids.length > 0)
        throw new CheckoutDomainError("Checkout already created orders.", "checkout_session_not_cancellable");
      return { status: "cancellable", session: current };
    }),
    getPaymentSummary: vi.fn(async () => null),
  } as unknown as CheckoutSessionServices;
  const getPublicListingById = vi.fn(async () => listing as CheckoutUcpListing | null);
  const getOrderFacts = vi.fn<Parameters<typeof createCheckoutUcpHandlers>[1]["getOrderFacts"]>(async () => []);
  const handlers = createCheckoutUcpHandlers({ sessions }, { getPublicListingById, getOrderFacts, now: () => clock });
  return {
    ...handlers,
    sessions,
    writes,
    getPublicListingById,
    getOrderFacts,
    setSession: (value: CheckoutSessionRow) => {
      current = value;
    },
    setTime: (value: string) => {
      clock = new Date(value);
    },
  };
}
function input(
  body: Record<string, unknown> = {},
  mcp = false,
  signed = false,
  checkoutId = id,
): UcpOperationHandlerInput {
  return {
    actor,
    context,
    arguments: mcp ? body : {},
    params: mcp ? {} : { id: checkoutId },
    request: new Request("https://marketplace.example/ucp/v1/checkout-sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The platform dispatch refuses a keyless create; every create here carries a retry key.
        "Idempotency-Key": "retry_ucp_default",
        ...(signed ? { Signature: "test-verified-by-dispatch" } : {}),
      },
      body: JSON.stringify(body),
    }),
  };
}
function noWrites(f: ReturnType<typeof fixture>) {
  for (const write of Object.values(f.writes)) expect(write).not.toHaveBeenCalled();
  expect(ports.createCheckoutOrdersThroughOrdering).not.toHaveBeenCalled();
  expect(ports.createCheckoutPaymentThroughPayments).not.toHaveBeenCalled();
}
const dto = (quantity = 1) => ({ line_items: [{ id: "li_1", item: { id: "lst_1" }, quantity }] });
beforeEach(() => {
  vi.clearAllMocks();
  ports.previewBuyNowCheckoutSupplyThroughOrdering.mockResolvedValue(preview());
});

describe("UCP buy-now readiness AC1", () => {
  it("uses canonical error severity for missing and malformed checkout sessions", async () => {
    const f = fixture();
    vi.spyOn(f.sessions, "getSession").mockResolvedValue(null);
    const missing = await f.restHandlers.get_checkout(input({ id }, false, false));
    expect(missing).toMatchObject({
      ucp: { status: "error" },
      messages: [{ code: "not_found", severity: "unrecoverable" }],
    });
    const malformed = await f.restHandlers.get_checkout(input({}, false, false, "bad"));
    expectUcpCapture(malformed, { operation: "get_checkout", kind: "error" });
    expect(malformed).toMatchObject({
      ucp: { status: "error" },
      messages: [{ code: "invalid_request", severity: "recoverable" }],
    });
  });

  // Brief create DTO replaces the retired source buy-now input; line id is not the listing id.
  it.each([false, true])("creates from item.id with the server revision on MCP=%s", async (mcp) => {
    const f = fixture();
    const request = input(mcp ? { checkout: dto() } : dto(), mcp);
    request.request.headers.set("Idempotency-Key", "retry_synthetic");
    const result = await f.restHandlers.create_checkout(request);
    expect(result.ucp.status).toBe("success");
    expect(f.getPublicListingById).toHaveBeenCalledExactlyOnceWith("lst_1");
    expect(f.writes.createBuyNow).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        listingId: "lst_1",
        fulfillmentPreviewRevision: "server_readiness_revision",
        createdAt: "2026-10-16T00:00:00.000Z",
        handoffExpiresAt: "2026-10-16T06:00:00.000Z",
        sessionIdOverride: expect.stringMatching(/^chk_[0-9A-Za-z]{26,32}$/),
      }),
      context,
    );
    expect(ports.previewBuyNowCheckoutSupplyThroughOrdering).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["unknown", dto(), "item_unavailable"],
    ["stale", dto(), "item_unavailable"],
    ["two lines", { line_items: [dto().line_items[0], dto().line_items[0]] }, "multiple_line_items_unsupported"],
    ["zero", dto(0), "invalid_quantity"],
    ["fraction", dto(1.5), "invalid_quantity"],
    [
      "kg",
      { line_items: [{ item: { id: "lst_1" }, quantity: 1, quantity_unit: { unit: "kg", scale: 0 } }] },
      "quantity_unit_mismatch",
    ],
    ["checkout id", { checkout: { id, ...dto() } }, "invalid_request"],
    // Brief single-line create replaces both cart/readiness tests with zero-write refusals.
    ["cart", { source: { type: "cart", anonymous_cart_id: "anon_raw_marker" } }, "invalid_request"],
    ["offer", { source: { type: "offer-intent" } }, "invalid_request"],
  ])("refuses %s without effects", async (kind, body, code) => {
    const f = fixture();
    if (kind === "unknown") f.getPublicListingById.mockResolvedValue(null);
    if (kind === "stale") f.getPublicListingById.mockResolvedValue({ ...listing, visible_quantity: 0 });
    const result = await f.restHandlers.create_checkout(input(body));
    expect(result.messages).toEqual([expect.objectContaining({ code })]);
    noWrites(f);
    expect(JSON.stringify(result)).not.toContain("anon_raw_marker");
  });
  it("accepts C62 but refuses a top-level MCP resource", async () => {
    const f = fixture();
    const body = { line_items: [{ item: { id: "lst_1" }, quantity: 1, quantity_unit: { unit: "C62", scale: 0 } }] };
    expect((await f.mcpToolHandlers.create_checkout(input({ checkout: body }, true))).ucp.status).toBe("success");
    f.writes.createBuyNow.mockClear();
    expect((await f.mcpToolHandlers.create_checkout(input(body, true))).messages).toEqual([
      expect.objectContaining({ code: "invalid_request" }),
    ]);
    noWrites(f);
  });
  // Brief update row replaces shipping writes with identical no-op and changed-line refusal.
  it.each([false, true])("identical update is a no-op, changed quantity is unsupported MCP=%s", async (mcp) => {
    const f = fixture();
    const args = (quantity: number) => (mcp ? { id, checkout: dto(quantity) } : dto(quantity));
    expect((await f.restHandlers.update_checkout(input(args(1), mcp))).ucp.status).toBe("success");
    expect((await f.restHandlers.update_checkout(input(args(2), mcp))).messages).toEqual([
      expect.objectContaining({ code: "line_items_update_unsupported" }),
    ]);
    noWrites(f);
  });
  it("preserves unresolved_fulfillment on the initial preview", async () => {
    const f = fixture();
    ports.previewBuyNowCheckoutSupplyThroughOrdering.mockResolvedValueOnce(preview(false));
    expect((await f.restHandlers.create_checkout(input(dto()))).messages).toEqual([
      expect.objectContaining({ code: "unresolved_fulfillment" }),
    ]);
    noWrites(f);
    expect(f.writes.recordFulfillmentPreview).not.toHaveBeenCalled();
  });

  // REST and MCP both reach this gate: MCP create_checkout keeps the platform
  // descriptor's idempotencyKeyRequired: false, so the handler is its key gate.
  it.each([false, true])("refuses a keyless create_checkout before any read or write on MCP=%s", async (mcp) => {
    const f = fixture();
    const request = input(mcp ? { checkout: dto() } : dto(), mcp);
    request.request.headers.delete("Idempotency-Key");
    const handlers = mcp ? f.mcpToolHandlers : f.restHandlers;
    expect((await handlers.create_checkout(request)).messages).toEqual([
      expect.objectContaining({ code: "checkout_attempt_required" }),
    ]);
    expect(f.getPublicListingById).not.toHaveBeenCalled();
    expect(f.sessions.resolveEntryAttempt).not.toHaveBeenCalled();
    noWrites(f);
  });

  it("returns the first Session for a repeated retry key once the platform record has expired", async () => {
    const f = fixture();
    const first = await f.restHandlers.create_checkout(input(dto(2)));
    const replay = await f.restHandlers.create_checkout(input(dto(2)));

    expect(first.ucp.status).toBe("success");
    expect(replay).toEqual(first);
    expect(f.writes.createBuyNow).toHaveBeenCalledTimes(1);
    expect(f.getPublicListingById).toHaveBeenCalledTimes(1);
  });

  it("refuses the same retry key with a changed quantity or listing and opens nothing", async () => {
    const f = fixture();
    expect((await f.restHandlers.create_checkout(input(dto(1)))).ucp.status).toBe("success");

    const changedQuantity = await f.restHandlers.create_checkout(input(dto(2)));
    const changedListing = await f.restHandlers.create_checkout(
      input({ line_items: [{ id: "li_1", item: { id: "lst_2" }, quantity: 1 }] }),
    );

    expect(changedQuantity.messages).toEqual([expect.objectContaining({ code: "checkout_attempt_conflict" })]);
    expect(changedListing.messages).toEqual([expect.objectContaining({ code: "checkout_attempt_conflict" })]);
    expect(f.writes.createBuyNow).toHaveBeenCalledTimes(1);
    expect(f.getPublicListingById).toHaveBeenCalledTimes(1);
  });
});

describe("UCP 2026-08-25 Checkout resource", () => {
  it("validates the resource shape and applies expiry, links, messages and order confirmation", () => {
    const request = new Request("https://marketplace.example/ucp/v1/checkout-sessions");
    const resource = checkoutUcpResource({
      session: session({ order_ids: ["ord_1", "ord_2"], handoff_expires_at: "2026-10-16T06:00:00.000Z" }),
      state: checkoutUcpState(session({ order_ids: ["ord_1", "ord_2"] }), [
        { id: "ord_1", readyForFulfillmentAt: "2026-10-16T07:00:00Z" },
        { id: "ord_2", readyForFulfillmentAt: "2026-10-16T07:01:00Z" },
      ]),
      quote: {
        subtotal: "20.00",
        fulfillment: "5.00",
        tax: "2.00",
        total: "27.00",
        linePrice: () => "20.00",
      },
      payment: { currency_code: "USD" },
      request,
      now: new Date("2026-10-16T07:00:00Z"),
    });
    const validate = ucpSchemaValidator("https://ucp.dev/2026-08-25/schemas/shopping/checkout.json");
    expect(validate({ ...resource, ucp: { version: "2026-08-25", status: "success", payment_handlers: {} } })).toBe(
      true,
    );
    expect(resource).toMatchObject({
      status: "completed",
      currency: "USD",
      totals: [
        { type: "subtotal", amount: 2000 },
        { type: "fulfillment", amount: 500 },
        { type: "tax", amount: 200 },
        { type: "total", amount: 2700 },
      ],
      order: { id: "ord_1", permalink_url: "https://marketplace.example/account/purchases" },
    });
    expect(resource).not.toHaveProperty("expires_at");
    expect(resource.links).toEqual([
      { type: "terms_of_service", url: "https://marketplace.example/terms" },
      { type: "privacy_policy", url: "https://marketplace.example/privacy" },
    ]);
  });
});

describe("UCP state lifecycle AC2 and expiry AC6", () => {
  it("uses fresh availability after create, but never previews committed orders", async () => {
    const f = fixture();
    await f.restHandlers.create_checkout(input(dto()));
    ports.previewBuyNowCheckoutSupplyThroughOrdering.mockResolvedValueOnce(preview(false));
    const result = await f.restHandlers.get_checkout(input());
    expect(result).toMatchObject({
      status: "incomplete",
      messages: [{ code: "item_unavailable", path: "$.line_items[0]" }],
    });
    expect(result).not.toHaveProperty("continue_url");
    ports.previewBuyNowCheckoutSupplyThroughOrdering.mockClear();
    f.setSession(session({ order_ids: ["ord_1"], payment_id: "pay_1" }));
    await f.restHandlers.get_checkout(input());
    expect(ports.previewBuyNowCheckoutSupplyThroughOrdering).not.toHaveBeenCalled();
  });
  it("derives confirmation, capture, fulfillment and cancellation from real fact sequences, next day and +72h", async () => {
    const f = fixture({ order_ids: ["ord_1"], payment_id: "pay_1" });
    f.getOrderFacts.mockResolvedValue([{ id: "ord_1", status: "pending-payment" }]);
    vi.mocked(f.sessions.getPaymentSummary).mockResolvedValue({ status: "pending-confirmation" } as never);
    for (const date of ["2026-10-16T00:01:00Z", "2026-10-17T00:01:00Z"]) {
      f.setTime(date);
      const result = await f.restHandlers.get_checkout(input());
      expect(result).toMatchObject({
        status: "requires_escalation",
        continue_url: `https://marketplace.example/checkout/buy/session/${id}`,
        messages: [{ code: "payment_confirmation_required" }],
      });
    }
    vi.mocked(f.sessions.getPaymentSummary).mockResolvedValue({ status: "captured" } as never);
    const captured = await f.restHandlers.get_checkout(input());
    expect(captured).toMatchObject({ status: "complete_in_progress" });
    expect(captured).not.toHaveProperty("messages");
    expect(captured).not.toHaveProperty("continue_url");
    f.getOrderFacts.mockResolvedValue([{ id: "ord_1", readyForFulfillmentAt: "2026-10-16T00:02:00Z" }]);
    f.setTime("2026-10-19T00:00:00Z");
    const completed = await f.restHandlers.complete_checkout(input());
    expect(completed).toMatchObject({ status: "completed", order: { id: "ord_1" } });
    expect(completed.messages).toBeUndefined();
    expect(completed).not.toHaveProperty("continue_url");
    f.setSession(session({ cancelled_at: "2026-10-16T01:00:00Z" }));
    const canceled = await f.restHandlers.complete_checkout(input());
    expect(canceled).toMatchObject({ status: "canceled" });
    expect(canceled.messages).toBeUndefined();
    expect(canceled).not.toHaveProperty("continue_url");
    noWrites(f);
  });
  it.each(["failed", "cancelled", null])(
    "requires buyer input for payment %s, not a recoverable agent retry",
    async (status) => {
      const result = checkoutUcpState(session({ order_ids: ["ord_1"] }), [], status ? { status } : null);
      expect(result).toMatchObject({
        status: "requires_escalation",
        continue: true,
        messages: [{ code: "payment_required", severity: "warning" }],
      });
    },
  );
  it("does not treat partial order facts as completed or canceled", () => {
    for (const fact of [
      { id: "ord_1", status: "cancelled" },
      { id: "ord_1", readyForFulfillmentAt: "today" },
    ])
      expect(checkoutUcpState(session({ order_ids: ["ord_1", "ord_2"] }), [fact]).status).toBe("requires_escalation");
  });
  it("expires at +6h before effects, with orders and web sessions ignoring the timer", async () => {
    const f = fixture();
    f.setTime("2026-10-16T05:59:00Z");
    expect(await f.restHandlers.get_checkout(input())).toMatchObject({
      status: "requires_escalation",
      expires_at: "2026-10-16T06:00:00.000Z",
      messages: [
        {
          type: "warning",
          code: "payment_required",
          content: "Payment is required to continue checkout.",
        },
      ],
    });
    f.setTime("2026-10-16T06:00:00Z");
    ports.previewBuyNowCheckoutSupplyThroughOrdering.mockClear();
    const expired = await f.restHandlers.get_checkout(input());
    expect(expired).toMatchObject({
      status: "canceled",
      messages: [{ code: "checkout_expired" }],
    });
    expect(expired).not.toHaveProperty("continue_url");
    for (const op of ["update_checkout", "complete_checkout"])
      for (const signed of [false, true]) {
        expect((await f.restHandlers[op](input(dto(), false, signed))).messages).toEqual([
          expect.objectContaining({ code: "checkout_expired" }),
        ]);
        expect(await f.preflight[op](input(dto(), false, signed))).toMatchObject({
          messages: [{ code: "checkout_expired" }],
        });
      }
    expect(ports.previewBuyNowCheckoutSupplyThroughOrdering).not.toHaveBeenCalled();
    noWrites(f);
    f.setTime("2026-10-16T07:00:00Z");
    f.setSession(session({ order_ids: ["ord_1"] }));
    expect(await f.restHandlers.complete_checkout(input())).toMatchObject({ status: "requires_escalation" });
    f.setSession(session({ handoff_expires_at: null }));
    expect(await f.restHandlers.complete_checkout(input())).toMatchObject({ status: "requires_escalation" });
  });
  // Brief complete row replaces stored-PM/3DS/spend/cleanup behavior: complete is always read-only.
  it.each<[string, Record<string, unknown>, Partial<CheckoutSessionRow>]>([
    ["stored payment", { payment: { instruments: [{ type: "stored_payment_method", id: "sci_1" }] } }, {}],
    [
      "3DS challenge",
      { payment: { instruments: [{ type: "card", credential: "synthetic_challenge" }] } },
      { payment_id: "pay_challenge" },
    ],
    ["shipping", { shipping_address: { postal_code: "60601" } }, {}],
    ["economics", { gift_card_code: "ignored", credit_amount: "10.00" }, {}],
    ["offer intent", {}, { source_type: "offer-intent", submitted_offer_id: "off_1" }],
    ["cleanup zero", {}, { order_ids: ["ord_1"] }],
    ["cleanup crash", {}, { order_ids: ["ord_1"] }],
    ["cleanup authority", {}, { order_ids: ["ord_1"] }],
  ])("%s cannot restore superseded complete writes", async (scenario, body, overrides) => {
    const f = fixture(overrides);
    if (scenario === "cleanup crash" || scenario === "cleanup authority")
      f.writes.resumeOrderCartCleanup.mockRejectedValueOnce(new Error(scenario));
    else f.writes.resumeOrderCartCleanup.mockResolvedValueOnce({ sessionId: id });
    const result = await f.restHandlers.complete_checkout(
      input({ ...body, presented_anonymous_cart_id: "anon_raw_marker" }),
    );
    expect(result).toMatchObject({
      status: "requires_escalation",
      continue_url: `https://marketplace.example/checkout/buy/session/${id}`,
      messages: [{ code: "payment_required" }],
    });
    expect(JSON.stringify(result)).not.toContain("anon_raw_marker");
    noWrites(f);
  });
  // Brief dispatch row replaces the old unsigned-cancel write test, with a signed counterpart.
  it("unsigned cancel is read-only; signed cancel writes once per invocation", async () => {
    const f = fixture();
    await f.restHandlers.cancel_checkout(input());
    noWrites(f);
    const result = await f.restHandlers.cancel_checkout(input({}, false, true));
    expect(result).toMatchObject({ status: "canceled" });
    expect(f.writes.cancelSession).toHaveBeenCalledTimes(1);
  });
  it("cancel of a cancelled checkout is idempotent and does not release or write again", async () => {
    const f = fixture({ cancelled_at: "2026-10-16T01:00:00.000Z" });
    const result = await f.restHandlers.cancel_checkout(input({}, false, true));
    expect(result).toMatchObject({ status: "canceled" });
    noWrites(f);
    expect(f.writes.cancelSession).not.toHaveBeenCalled();
    expect(ports.releaseCheckoutInventoryReservations).not.toHaveBeenCalled();
  });
  it("a repeated signed cancel returns the first cancelled Session with no release beyond the first", async () => {
    const f = fixture({
      checkout_reservations: [
        {
          holdId: "hold_1",
          lineKey: "lst_1:0",
          sellerAccountId: "acc_seller",
          inventoryItemId: "inv_1",
          quantity: 1,
          expiresAt: "2026-10-16T00:15:00.000Z",
          extensionCount: 0,
          status: "active",
        },
      ],
    });

    const first = await f.restHandlers.cancel_checkout(input({}, false, true));
    const replay = await f.restHandlers.cancel_checkout(input({}, false, true));

    expect(first).toMatchObject({ status: "canceled" });
    expect(replay).toEqual(first);
    expect(ports.releaseCheckoutInventoryReservations).toHaveBeenCalledTimes(1);
    expect(f.writes.cancelSession).toHaveBeenCalledTimes(1);
  });
  it("signed cancel shares Cancel checkout: one release, and none once orders exist", async () => {
    const f = fixture();
    await f.restHandlers.cancel_checkout(input({}, false, true));
    expect(ports.releaseCheckoutInventoryReservations).toHaveBeenCalledTimes(1);
    expect(f.writes.cancelSession).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const converted = fixture({ order_ids: ["ord_1"] });
    const refused = await converted.restHandlers.cancel_checkout(input({}, false, true));
    expect(refused).toMatchObject({ messages: [{ code: "checkout_session_not_cancellable" }] });
    expect(ports.releaseCheckoutInventoryReservations).not.toHaveBeenCalled();
    noWrites(converted);
  });
  it("preserves authentication, authorization and closed-rail refusals", async () => {
    const f = fixture();
    expect((await f.restHandlers.get_checkout({ ...input(), actor: null })).messages).toEqual([
      expect.objectContaining({ code: "authentication_required" }),
    ]);
    expect((await f.restHandlers.get_checkout({ ...input(), actor: { ...actor, permissions: [] } })).messages).toEqual([
      expect.objectContaining({ code: "authorization_forbidden" }),
    ]);
    noWrites(f);
    const closed = createCheckoutUcpHandlers(
      { sessions: f.sessions },
      { checkoutClosed: true, getPublicListingById: f.getPublicListingById, getOrderFacts: f.getOrderFacts },
    );
    for (const op of ["create_checkout", "update_checkout", "complete_checkout"])
      expect((await closed.restHandlers[op](input())).messages).toEqual([
        expect.objectContaining({ code: "checkout_closed" }),
      ]);
    noWrites(f);
  });
  it("AC5 has one checkout URL builder and no legacy fallback", () => {
    const source = readFileSync(new URL("../support/ucp-support/checkout.ts", import.meta.url), "utf8");
    expect(source.match(/\/checkout\//g)).toHaveLength(1);
    expect(source).not.toMatch(/completeHeadlessCheckout|legacy = false|\{1,32\}|async function createOfferIntent/);
  });
  it("route buy-now preparation is moved, not copied, retaining unresolved fulfillment", () => {
    const route = readFileSync(new URL("../features/sessions/api/route.ts", import.meta.url), "utf8");
    expect(route).toContain("await prepareBuyNowCheckout(");
    expect(route).not.toContain("await previewBuyNowCheckoutSupplyThroughOrdering(");
    expect(readFileSync(new URL("../features/sessions/api/buy-now-preparation.ts", import.meta.url), "utf8")).toContain(
      '"unresolved_fulfillment"',
    );
  });
});

// Quote sources from decision D1 of #10088 ("an honest quote source for every Checkout state") for a
// two-line session: lst_1 x2 and lst_2 x1. Each source prices the lines differently and no subtotal
// divided by the three units equals a line price, so a wrong source, a line from another source or
// an averaged price fails the table.
const quoteLines = [
  { ...line, quantity: 2 },
  { ...line, listingId: "lst_2", lockedListingId: "lst_2", catalogItemId: "cat_2", productId: "cat_2::form:raw" },
];
function recordedQuote(
  [itemSubtotalAmount, shippingAmount, salesTaxAmount, totalAmount]: readonly string[],
  prices: Readonly<Record<string, string>>,
) {
  // The quote reads only totals and line prices, so the rest of the preview shape is omitted.
  return {
    sellerGroups: [
      {
        lines: Object.entries(prices).map(([listingId, estimatedUnitPriceAmount]) => ({
          listingId,
          estimatedUnitPriceAmount,
        })),
      },
    ],
    totals: { itemSubtotalAmount, shippingAmount, salesTaxAmount, totalAmount, packageCount: 1 },
  } as unknown as CheckoutFulfillmentPreview;
}
const snapshotTotals = ["52.00", "5.00", "4.16", "61.16"];
const snapshotQuote = recordedQuote(snapshotTotals, { lst_1: "20.00", lst_2: "12.00" });
const freshTotals = ["54.50", "5.50", "4.36", "64.36"];
const freshQuote = recordedQuote(freshTotals, { lst_1: "21.00", lst_2: "12.50" });
const lst2UnavailableTotals = ["42.00", "4.50", "3.36", "49.86"];
const lst2UnavailableQuote = recordedQuote(lst2UnavailableTotals, { lst_1: "21.00" });
const retainedTotals = ["49.50", "4.75", "3.96", "58.21"];
const retainedQuote = recordedQuote(retainedTotals, { lst_1: "19.00", lst_2: "11.50" });
const purchase1: CheckoutUcpOrderFact = {
  id: "ord_1",
  status: "pending-payment",
  totals: { itemSubtotal: "37.00", shipping: "4.00", tax: "0.10", total: "41.10" },
  lines: [{ listingId: "lst_1", unitPrice: "18.50" }],
};
const purchase2: CheckoutUcpOrderFact = {
  id: "ord_2",
  status: "pending-payment",
  totals: { itemSubtotal: "11.25", shipping: "3.10", tax: "0.20", total: "14.55" },
  lines: [{ listingId: "lst_2", unitPrice: "11.25" }],
};
const priced = (totals: readonly string[], ...prices: readonly (string | null)[]) => ({ totals, prices });
const view = (quote: CheckoutUcpQuote | null) =>
  quote &&
  priced(
    [quote.subtotal, quote.fulfillment, quote.tax, quote.total],
    quote.linePrice("lst_1"),
    quote.linePrice("lst_2"),
  );
type QuoteCell = Readonly<{
  session: Partial<CheckoutSessionRow>;
  facts?: readonly CheckoutUcpOrderFact[];
  preview: CheckoutFulfillmentPreview | null;
  retained?: CheckoutFulfillmentPreview | null;
  expected: ReturnType<typeof view>;
  retainedReads: number;
}>;
const cancelled = { cancelled_at: "2026-10-16T01:00:00.000Z" };
const ordered = { order_ids: ["ord_1", "ord_2"], payment_id: "pay_1" };
const snapshotView = priced(snapshotTotals, "20.00", "12.00");
const retainedView = priced(retainedTotals, "19.00", "11.50");
// The adapter passes no preview for terminal or ordered sessions (F5); C6 and C7 are reads after the
// session's 06:00 handoff expiry, which the clock-free resolver sees only as that missing preview.
const quoteCells: [string, QuoteCell][] = [
  [
    "C1 live: snapshot totals and lines, not the preview",
    {
      session: { fulfillment_preview_snapshot: snapshotQuote },
      preview: freshQuote,
      expected: snapshotView,
      retainedReads: 0,
    },
  ],
  [
    "C2 live after invalidation: the same-request preview",
    { session: {}, preview: freshQuote, expected: priced(freshTotals, "21.00", "12.50"), retainedReads: 0 },
  ],
  [
    "C3 unavailable line: snapshot totals and line",
    {
      session: { fulfillment_preview_snapshot: snapshotQuote },
      preview: lst2UnavailableQuote,
      expected: snapshotView,
      retainedReads: 0,
    },
  ],
  [
    "C3 unavailable line without a snapshot: preview totals, retained line",
    {
      session: {},
      preview: lst2UnavailableQuote,
      expected: priced(lst2UnavailableTotals, "21.00", "11.50"),
      retainedReads: 1,
    },
  ],
  [
    "C4 signed-cancelled: snapshot",
    {
      session: { ...cancelled, fulfillment_preview_snapshot: snapshotQuote },
      preview: null,
      expected: snapshotView,
      retainedReads: 0,
    },
  ],
  [
    "C5 signed-cancelled after invalidation: retained",
    { session: cancelled, preview: null, expected: retainedView, retainedReads: 1 },
  ],
  [
    "C6 expired: snapshot",
    {
      session: { fulfillment_preview_snapshot: snapshotQuote },
      preview: null,
      expected: snapshotView,
      retainedReads: 0,
    },
  ],
  ["C7 expired after invalidation: retained", { session: {}, preview: null, expected: retainedView, retainedReads: 1 }],
  [
    "C8 two orders with complete facts: exact sums and order lines",
    {
      session: ordered,
      facts: [purchase2, purchase1],
      preview: null,
      expected: priced(["48.25", "7.10", "0.30", "55.65"], "18.50", "11.25"),
      retainedReads: 0,
    },
  ],
  [
    "C9 one order fact missing: retained",
    { session: ordered, facts: [purchase1], preview: null, expected: retainedView, retainedReads: 1 },
  ],
  [
    "C9 one order fact without totals: retained",
    {
      session: ordered,
      facts: [purchase1, { id: "ord_2", status: "pending-payment" }],
      preview: null,
      expected: retainedView,
      retainedReads: 1,
    },
  ],
  [
    "C10 never quoted: the C5 retained read finds none",
    { session: { ...cancelled, source_type: "cart" }, preview: null, retained: null, expected: null, retainedReads: 1 },
  ],
];
function quoteInput(cell: QuoteCell) {
  return {
    session: session({ lines: quoteLines, ...cell.session }),
    orderFacts: cell.facts ?? [],
    preview: cell.preview,
    loadRetainedQuote: vi.fn(async () => (cell.retained === undefined ? retainedQuote : cell.retained)),
  };
}

describe("UCP quote source follows decision D1 cells C1-C10", () => {
  it.each(quoteCells)("%s", async (_name, cell) => {
    const input = quoteInput(cell);
    expect(view(await resolveCheckoutUcpQuote(input))).toEqual(cell.expected);
    // The retained quote is read only in C3, C5, C7 and C9; C10 is the C5 read finding none.
    expect(input.loadRetainedQuote).toHaveBeenCalledTimes(cell.retainedReads);
  });
  it("keeps a session line's offer price and prices no unquoted listing", async () => {
    const offerLine = { ...quoteLines[0], offerPriceAmount: "15.00", offerPriceCurrencyCode: "USD" };
    const input = quoteInput({
      session: {
        source_type: "offer-intent",
        fulfillment_preview_snapshot: snapshotQuote,
        lines: [offerLine, quoteLines[1]],
      },
      preview: null,
      expected: null,
      retainedReads: 0,
    });
    const quote = await resolveCheckoutUcpQuote(input);
    expect(view(quote)).toEqual(priced(snapshotTotals, "15.00", "12.00"));
    expect(quote?.linePrice("lst_unquoted")).toBeNull();
    expect(input.loadRetainedQuote).not.toHaveBeenCalled();
  });
});

describe("UCP 2026-08-25 Checkout state resources", () => {
  it("UCP 2026-08-25 Checkout resource validates for every state row", async () => {
    const request = new Request("https://marketplace.example/ucp/v1/checkout-sessions");
    const validate = ucpSchemaValidator("https://ucp.dev/2026-08-25/schemas/shopping/checkout.json");
    const completed1 = {
      ...purchase1,
      label: "Purchase CS-0001",
      permalinkUrl: "/account/purchases/confirmed-1",
      readyForFulfillmentAt: "2026-10-16T07:00:00Z",
    };
    const completed2 = { ...purchase2, label: "Purchase CS-0002", readyForFulfillmentAt: "2026-10-16T07:01:00Z" };
    const rows: readonly Readonly<{
      name: string;
      cell: QuoteCell;
      time: string;
      status: string;
      payment?: { status: string };
      available?: boolean;
      expires?: string;
      code?: "payment_required" | "payment_confirmation_required" | "item_unavailable" | "checkout_expired";
      order?: { id: string; label: string; permalink_url: string };
    }>[] = [
      {
        name: "payment orderless C1",
        cell: quoteCells[0]![1],
        time: "01:00",
        status: "requires_escalation",
        expires: "06:00",
        code: "payment_required",
      },
      {
        name: "confirmation with orders C9",
        cell: quoteCells[9]![1],
        time: "07:00",
        status: "requires_escalation",
        payment: { status: "pending-confirmation" },
        expires: "13:00",
        code: "payment_confirmation_required",
      },
      {
        name: "incomplete C3",
        cell: quoteCells[2]![1],
        time: "01:00",
        status: "incomplete",
        available: false,
        expires: "06:00",
        code: "item_unavailable",
      },
      { name: "cancelled C4", cell: quoteCells[4]![1], time: "01:00", status: "canceled" },
      { name: "expired C6", cell: quoteCells[6]![1], time: "06:00", status: "canceled", code: "checkout_expired" },
      {
        name: "capture in progress C8",
        cell: quoteCells[8]![1],
        time: "07:00",
        status: "complete_in_progress",
        payment: { status: "captured" },
        expires: "13:00",
      },
      {
        name: "completed one order C8",
        cell: { ...quoteCells[8]![1], session: { order_ids: ["ord_1"], lines: [quoteLines[0]!] }, facts: [completed1] },
        time: "07:00",
        status: "completed",
        order: {
          id: "ord_1",
          label: "Purchase CS-0001",
          permalink_url: "https://marketplace.example/account/purchases/confirmed-1",
        },
      },
      {
        name: "completed two orders reversed C8",
        cell: { ...quoteCells[8]![1], facts: [completed2, completed1] },
        time: "07:00",
        status: "completed",
        order: {
          id: "ord_1",
          label: "Purchase CS-0001",
          permalink_url: "https://marketplace.example/account/purchases",
        },
      },
      {
        name: "boundary +5:59 C1",
        cell: quoteCells[0]![1],
        time: "05:59",
        status: "requires_escalation",
        expires: "06:00",
        code: "payment_required",
      },
      {
        name: "boundary +6:00 C6",
        cell: quoteCells[6]![1],
        time: "06:00",
        status: "canceled",
        code: "checkout_expired",
      },
    ];
    for (const row of rows) {
      const input = quoteInput(row.cell);
      const quote = await resolveCheckoutUcpQuote(input);
      expect(quote, `${row.name}: D1 quote must be non-null`).not.toBeNull();
      if (!quote) throw new Error(`Brief defect: ${row.name} has no D1 quote`);
      const now = new Date(`2026-10-16T${row.time}:00.000Z`);
      const state = checkoutUcpState(
        input.session,
        input.orderFacts,
        row.payment ?? null,
        preview(row.available !== false),
        now,
      );
      const resource = checkoutUcpResource({ session: input.session, state, quote, payment: null, request, now });
      expect(resource.status, row.name).toBe(row.status);
      expect(
        validate({ ...resource, ucp: { version: "2026-08-25", status: "success", payment_handlers: {} } }),
        `${row.name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
      expect(resource.currency, row.name).toBe("USD");
      if (row.status === "requires_escalation") {
        expect(resource.continue_url, row.name).toBe(`https://marketplace.example/checkout/buy/session/${id}`);
        expect(new URL(resource.continue_url!).origin, row.name).toBe("https://marketplace.example");
      } else expect(resource, row.name).not.toHaveProperty("continue_url");
      if (row.expires) expect(resource.expires_at, row.name).toBe(`2026-10-16T${row.expires}:00.000Z`);
      else expect(resource, row.name).not.toHaveProperty("expires_at");
      const content = {
        payment_required: "Payment is required to continue checkout.",
        payment_confirmation_required: "Buyer confirmation is required to continue payment.",
        item_unavailable: "This item is no longer available.",
        checkout_expired: "This checkout has expired. Start a new checkout.",
      };
      if (row.code)
        expect(resource.messages, row.name).toEqual([
          {
            type: "warning",
            code: row.code,
            content: content[row.code],
            ...(row.code === "item_unavailable" ? { path: "$.line_items[0]" } : {}),
          },
        ]);
      else expect(resource, row.name).not.toHaveProperty("messages");
      const expectedPrices = row.name.includes("completed one")
        ? [1850]
        : row.cell.expected!.prices.map((amount) => Number(amount!.replace(".", "")));
      expect(
        resource.line_items.map((item) => item.item.price),
        row.name,
      ).toEqual(expectedPrices);
      for (const item of resource.line_items) {
        expect(item.item.price, row.name).toBeGreaterThan(0);
        expect(item.totals, row.name).toEqual([
          { type: "subtotal", amount: item.item.price * item.quantity },
          { type: "total", amount: item.item.price * item.quantity },
        ]);
      }
      const expectedTotals = row.name.includes("completed one")
        ? [3700, 400, 10, 4110]
        : row.cell.expected!.totals.map((amount) => Number(amount.replace(".", "")));
      expect(resource.totals, row.name).toEqual(
        ["subtotal", "fulfillment", "tax", "total"].map((type, index) => ({ type, amount: expectedTotals[index] })),
      );
      if (row.order) expect(resource.order, row.name).toEqual(row.order);
      else expect(resource, row.name).not.toHaveProperty("order");
      console.info(
        "AC1_ROW",
        JSON.stringify({
          row: row.name,
          status: resource.status,
          valid: true,
          continue_url: resource.continue_url ?? null,
          expires_at: resource.expires_at ?? null,
          messages: resource.messages ?? [],
          order: resource.order ?? null,
        }),
      );
    }
  });

  it("rejects every quote amount above MONEY_AMOUNT_MAX and malformed amounts", async () => {
    const input = quoteInput(quoteCells[0]![1]);
    const quote = await resolveCheckoutUcpQuote(input);
    expect(quote).not.toBeNull();
    const build = (value: CheckoutUcpQuote) =>
      checkoutUcpResource({
        session: input.session,
        state: checkoutUcpState(input.session),
        quote: value,
        payment: null,
        request: new Request("https://marketplace.example/ucp"),
        now: new Date("2026-10-16T01:00:00Z"),
      });
    for (const amount of ["10000000000.00", "invalid", "1.001"]) {
      for (const field of ["subtotal", "fulfillment", "tax", "total"] as const)
        expect(() => build({ ...quote!, [field]: amount })).toThrow(`UCP Checkout ${field} has no exact USD amount.`);
      expect(() => build({ ...quote!, linePrice: () => amount })).toThrow(
        "UCP Checkout line lst_1 has no exact USD amount.",
      );
    }
    expect(() => build({ ...quote!, linePrice: () => null })).toThrow(
      "UCP Checkout line lst_1 has no exact USD amount.",
    );
  });
});

describe("UCP quote source is stable on a day-later re-read", () => {
  // Records every wall-clock read made while `run` resolves.
  async function clockReads<T>(run: () => Promise<T>) {
    const reads: string[] = [];
    vi.stubGlobal(
      "Date",
      new Proxy(Date, {
        construct: (target, args, newTarget) => {
          if (args.length === 0) reads.push("new Date()");
          return Reflect.construct(target, args, newTarget);
        },
        get: (target, key, receiver) => {
          if (key === "now") reads.push("Date.now");
          return Reflect.get(target, key, receiver);
        },
      }),
    );
    try {
      return { value: await run(), reads };
    } finally {
      vi.unstubAllGlobals();
    }
  }
  it("re-resolves C4-C9 identically a day later without reading a clock", async () => {
    const stableCells = quoteCells.filter(([name]) => /^C[4-9] /.test(name));
    expect(stableCells.map(([name]) => name.slice(0, 2))).toEqual(["C4", "C5", "C6", "C7", "C8", "C9", "C9"]);
    vi.useFakeTimers({ now: new Date("2026-10-16T07:00:00.000Z") });
    try {
      for (const [name, cell] of stableCells) {
        const input = quoteInput(cell);
        vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
        const first = await clockReads(() => resolveCheckoutUcpQuote(input));
        vi.setSystemTime(new Date("2026-10-17T07:00:00.000Z"));
        const dayLater = await clockReads(() => resolveCheckoutUcpQuote(input));
        expect(view(dayLater.value), name).toEqual(view(first.value));
        expect(view(dayLater.value), name).toEqual(cell.expected);
        expect([...first.reads, ...dayLater.reads], name).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
