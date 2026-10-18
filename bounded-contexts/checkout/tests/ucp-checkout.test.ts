import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { UcpOperationHandlerInput } from "@chase-sets/platform-runtime/ucp";
import { createCheckoutUcpHandlers, checkoutUcpState, type CheckoutUcpListing } from "../support/ucp-support/checkout";
import type { CheckoutSessionRow } from "../features/sessions/read-model/queries";
import type { CheckoutSessionServices } from "../features/sessions/api/runtime";

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
    sellerGroups: [],
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
  const writes = {
    createBuyNow: vi.fn<CheckoutSessionServices["createBuyNow"]>(async (params) => {
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
    getSession: vi.fn(async (_id: string, account: string) => (account === current.buyer_account_id ? current : null)),
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
      headers: { "Content-Type": "application/json", ...(signed ? { Signature: "test-verified-by-dispatch" } : {}) },
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
  it("preserves unresolved_fulfillment on initial and replacement previews", async () => {
    const f = fixture();
    ports.previewBuyNowCheckoutSupplyThroughOrdering.mockResolvedValueOnce(preview(false));
    expect((await f.restHandlers.create_checkout(input(dto()))).messages).toEqual([
      expect.objectContaining({ code: "unresolved_fulfillment" }),
    ]);
    noWrites(f);
    f.writes.createBuyNow.mockResolvedValueOnce({ sessionId: id as never });
    ports.previewBuyNowCheckoutSupplyThroughOrdering
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(preview(false));
    const request = input(dto());
    request.request.headers.set("Idempotency-Key", "replacement");
    expect((await f.restHandlers.create_checkout(request)).messages).toEqual([
      expect.objectContaining({ code: "unresolved_fulfillment" }),
    ]);
    expect(f.writes.recordFulfillmentPreview).not.toHaveBeenCalled();
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
      messages: [{ code: "item_unavailable", recoverability: "unrecoverable", target: "$.line_items[0]" }],
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
        messages: [{ code: "payment_confirmation_required", recoverability: "requires_buyer_input" }],
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
    expect(completed).toMatchObject({ status: "completed", order: [{ id: "ord_1" }] });
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
        messages: [{ code: "payment_required", recoverability: "requires_buyer_input" }],
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
      messages: [{ recoverability: "requires_buyer_input" }],
    });
    f.setTime("2026-10-16T06:00:00Z");
    ports.previewBuyNowCheckoutSupplyThroughOrdering.mockClear();
    const expired = await f.restHandlers.get_checkout(input());
    expect(expired).toMatchObject({
      status: "canceled",
      messages: [{ code: "checkout_expired", recoverability: "unrecoverable" }],
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
      messages: [{ code: "payment_required", recoverability: "requires_buyer_input" }],
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
    expect(result).toMatchObject({ checkout: { status: "canceled" } });
    expect(f.writes.cancelSession).toHaveBeenCalledTimes(1);
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
