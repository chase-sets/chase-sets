import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { expectUcpCapture } from "@chase-sets/platform-runtime/ucp-schema-test-support";
import { createCheckoutUcpHandlers, type CheckoutUcpOrderFact } from "../support/ucp-support/checkout";
import type { CheckoutSessionServices } from "../features/sessions/api/runtime";
import type { CheckoutSessionRow } from "../features/sessions/read-model/queries";
import fixtures from "../features/sessions/ui/agent-checkout-fixtures.json";

const ports = vi.hoisted(() => ({ previewBuyNowCheckoutSupplyThroughOrdering: vi.fn() }));
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
// Shipping and tax make the line sum differ from the checkout total, which the views must show as sent.
const quote = (ready: boolean) => ({
  revision: "server_readiness_revision",
  readyLineKeys: ready ? ["lst_1:0"] : [],
  unavailableLineKeys: [],
  unavailableLines: [],
  materialChangeReasons: [],
  sellerGroups: [{ lines: [{ listingId: "lst_1", estimatedUnitPriceAmount: "20.00" }] }],
  totals: {
    itemSubtotalAmount: "20.00",
    shippingAmount: "4.99",
    salesTaxAmount: "1.50",
    totalAmount: "26.49",
    packageCount: 1,
  },
});
const placed = { id: "ord_1", status: "pending-payment" };
const fulfillmentReady: CheckoutUcpOrderFact = {
  id: "ord_1",
  readyForFulfillmentAt: "2026-10-16T00:30:00.000Z",
  label: "Purchase CS-0001",
  permalinkUrl: "/account/purchases/ord_1",
  totals: { itemSubtotal: "20.00", shipping: "4.99", tax: "1.50", total: "26.49" },
  lines: [{ listingId: "lst_1", unitPrice: "20.00" }],
};

type Row = Readonly<{
  operation: "get_checkout" | "complete_checkout";
  session?: Partial<CheckoutSessionRow> | null;
  ready?: boolean;
  payment?: string;
  facts?: readonly CheckoutUcpOrderFact[];
  now?: string;
}>;

// One row per state in Checkout's UCP mapping, captured from the real handlers with only storage reads replaced.
const rows = {
  unpaid: { operation: "complete_checkout" },
  pendingConfirmation: {
    operation: "complete_checkout",
    session: { order_ids: ["ord_1"], payment_id: "pay_1" },
    payment: "pending-confirmation",
    facts: [placed],
  },
  failedPayment: {
    operation: "complete_checkout",
    session: { order_ids: ["ord_1"], payment_id: "pay_1" },
    payment: "failed",
    facts: [placed],
  },
  cancelledPayment: {
    operation: "complete_checkout",
    session: { order_ids: ["ord_1"], payment_id: "pay_1" },
    payment: "cancelled",
    facts: [placed],
  },
  captured: {
    operation: "get_checkout",
    session: { order_ids: ["ord_1"], payment_id: "pay_1" },
    payment: "captured",
    facts: [placed],
  },
  unavailable: { operation: "get_checkout", ready: false },
  completed: {
    operation: "get_checkout",
    session: { order_ids: ["ord_1"], payment_id: "pay_1" },
    payment: "captured",
    facts: [fulfillmentReady],
  },
  canceled: { operation: "get_checkout", session: { cancelled_at: "2026-10-16T01:00:00.000Z" } },
  expired: { operation: "get_checkout", now: "2026-10-16T06:00:00.000Z" },
  empty: { operation: "get_checkout", session: { lines: [] } },
  notFound: { operation: "get_checkout", session: null },
} as const satisfies Record<string, Row>;

async function capture(row: Row) {
  const session: CheckoutSessionRow | null =
    row.session === null
      ? null
      : {
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
          ...row.session,
        };
  ports.previewBuyNowCheckoutSupplyThroughOrdering.mockResolvedValue(quote(row.ready ?? true));
  const sessions = {
    getSession: async () => session,
    getPaymentSummary: async () => (row.payment ? { status: row.payment, currency_code: "usd" } : null),
    getLastRecordedQuote: async () => quote(true),
  } as unknown as CheckoutSessionServices;
  const handlers = createCheckoutUcpHandlers(
    { sessions },
    {
      getPublicListingById: async () => null,
      getOrderFacts: async () => row.facts ?? [],
      now: () => new Date(row.now ?? "2026-10-16T00:00:00.000Z"),
    },
  );
  return handlers.mcpToolHandlers[row.operation]({
    actor,
    context,
    arguments: { id },
    params: {},
    request: new Request("https://marketplace.example/ucp/mcp", {
      method: "POST",
      headers: { "Idempotency-Key": "fixture" },
    }),
  });
}

describe("agent checkout fixtures", () => {
  it.each(Object.entries(rows))(
    "%s is the committed handler output and passes the pinned schemas",
    async (name, row) => {
      const result = await capture(row);
      expect(result).toEqual(fixtures[name as keyof typeof fixtures]);
      expectUcpCapture(result, {
        operation: row.operation,
        kind: result.ucp.status === "error" ? "error" : "resource",
      });
    },
  );

  it("commits exactly one fixture per captured row", () => {
    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(rows).sort());
  });
});
