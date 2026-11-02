import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateSellerAttentionQueue,
  isSellerAttentionItem,
  type SellerAttentionContext,
} from "@chase-sets/seller-attention-queue";
import {
  createBlockedPayoutAttentionSource,
  createBlockedPayoutAttentionSourceFromReadModel,
  selectBlockedPayoutAttentionRows,
  toBlockedPayoutAttentionItems,
  type BlockedPayoutAttentionRow,
} from "./seller-attention-source";
import type { SettlementPayoutRow } from "./queries";

const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: "2026-07-14T12:00:00.000Z" };
const CLOSED_MESSAGE = "The bank account has been closed.";

// Answers the summary count and items queries the way the Settlement read model does.
function summaryReadModel(rows: readonly SettlementPayoutRow[], count = rows.length) {
  return {
    query: vi.fn(async (sql: string) => (sql.includes("COUNT(*)") ? { rows: [{ count: String(count) }] } : { rows })),
  };
}

function row(overrides: Partial<BlockedPayoutAttentionRow> = {}): BlockedPayoutAttentionRow {
  return {
    payoutId: "pay-1",
    reference: "PO-1",
    blockReason: "reconciliation-hold",
    observedAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("toBlockedPayoutAttentionItems", () => {
  it("maps a blocked payout to a critical, undated item that deep-links to the payout", () => {
    const [item] = toBlockedPayoutAttentionItems([row()]);
    expect(item.severity).toBe("critical");
    expect(item.dueAt).toBeNull();
    expect(item.summary).toEqual({
      code: "payout-blocked",
      params: { reference: "PO-1", reason: "reconciliation-hold" },
    });
    expect(item.deepLink).toEqual({ surface: "payout", href: "/account/desk/payouts/pay-1" });
    expect(isSellerAttentionItem(item, "settlement-blocked-payout")).toBe(true);
  });
});

describe("createBlockedPayoutAttentionSourceFromReadModel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads all blocked kinds from the complete Settlement summary", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const query = vi.fn(async (sql: string) =>
      sql.includes("COUNT(*)")
        ? { rows: [{ count: "1" }] }
        : {
            rows: [
              {
                payout_id: "pay-1",
                account_id: "acct-1",
                amount: "25.00",
                requested_amount: "25.00",
                fee_amount: "0.32",
                net_amount: "24.68",
                currency_code: "usd",
                destination_reference: null,
                note: null,
                display_reference: "PO-1",
                status: "failed",
                provider_transfer_reference: null,
                provider_payout_reference: null,
                provider_status: "failed",
                provider_failure_code: null,
                provider_failure_message: null,
                requested_at: "2026-07-12T00:00:00.000Z",
                updated_at: "2026-07-12T00:00:00.000Z",
                sent_at: null,
                completed_at: null,
                failed_at: "2026-07-12T00:00:00.000Z",
                failure_reason: "identity-verification-required",
                last_provider_event_at: null,
                last_reconciled_at: null,
                retry_count: 0,
                next_retry_at: null,
                retry_reason: null,
              },
            ],
          },
    );

    const items = await createBlockedPayoutAttentionSourceFromReadModel({ query } as never).load(CONTEXT);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("account_id = $1"), ["acct-1"]);
    expect(items[0]?.summary.params).toEqual({
      reference: "PO-1",
      reason: "identity verification required",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and returns no attention items when payout summary is incomplete", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const readModel = summaryReadModel(
      Array.from({ length: 251 }, (_, index) => payout({ payout_id: `failed-${index}`, status: "failed" })),
    );

    const items = await createBlockedPayoutAttentionSourceFromReadModel(readModel as never).load(CONTEXT);

    expect(items).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Settlement payout summary is incomplete; Seller Desk attention is bounded.", {
      accountId: "acct-1",
      total: 251,
      cap: 250,
      reason: "payout-summary-cap-exceeded",
    });
  });

  it("loads seller-facing reasons for failed payouts without a failure_reason", async () => {
    const readModel = summaryReadModel([
      payout({
        payout_id: "code-and-message",
        display_reference: "PYO-CM",
        status: "failed",
        provider_failure_code: "account_closed",
        provider_failure_message: CLOSED_MESSAGE,
      }),
      payout({
        payout_id: "code-only",
        display_reference: "PYO-C",
        status: "failed",
        provider_failure_code: "account_closed",
      }),
      payout({ payout_id: "no-detail", display_reference: "PYO-N", status: "failed" }),
    ]);

    const items = await createBlockedPayoutAttentionSourceFromReadModel(readModel as never).load(CONTEXT);

    expect(items.map((item) => [item.id, item.summary.params])).toEqual([
      ["settlement-blocked-payout:code-and-message", { reference: "PYO-CM", reason: CLOSED_MESSAGE }],
      ["settlement-blocked-payout:code-only", { reference: "PYO-C", reason: "Payout failed" }],
      ["settlement-blocked-payout:no-detail", { reference: "PYO-N", reason: "Payout failed" }],
    ]);
  });

  // Fixtures arrive newest first, as the summary query orders them
  // (updated_at DESC, payout_id DESC).
  it("orders equal-time blocked payouts by payout ID on the Seller Desk queue", async () => {
    const failedAt = "2026-07-12T00:00:00.000Z";
    const readModel = summaryReadModel([
      payout({ payout_id: "pay-b", status: "failed", updated_at: failedAt, failed_at: failedAt }),
      payout({ payout_id: "pay-a", status: "failed", updated_at: failedAt, failed_at: failedAt }),
    ]);

    const queue = await aggregateSellerAttentionQueue(
      [createBlockedPayoutAttentionSourceFromReadModel(readModel as never)],
      CONTEXT,
    );

    expect(queue.items.map((item) => item.id)).toEqual([
      "settlement-blocked-payout:pay-a",
      "settlement-blocked-payout:pay-b",
    ]);
  });

  it("keeps the older blocked payout first on the Seller Desk queue", async () => {
    const readModel = summaryReadModel([
      payout({
        payout_id: "pay-a",
        status: "failed",
        updated_at: "2026-07-12T00:00:00.000Z",
        failed_at: "2026-07-12T00:00:00.000Z",
      }),
      payout({
        payout_id: "pay-b",
        status: "failed",
        updated_at: "2026-07-11T00:00:00.000Z",
        failed_at: "2026-07-11T00:00:00.000Z",
      }),
    ]);

    const queue = await aggregateSellerAttentionQueue(
      [createBlockedPayoutAttentionSourceFromReadModel(readModel as never)],
      CONTEXT,
    );

    expect(queue.items.map((item) => item.id)).toEqual([
      "settlement-blocked-payout:pay-b",
      "settlement-blocked-payout:pay-a",
    ]);
  });
});

describe("createBlockedPayoutAttentionSource", () => {
  it("loads rows through the injected query", async () => {
    const source = createBlockedPayoutAttentionSource({
      loadBlockedPayoutRows: async () => [row(), row({ payoutId: "pay-2" })],
    });
    const items = await source.load(CONTEXT);
    expect(source.id).toBe("settlement-blocked-payout");
    expect(items).toHaveLength(2);
  });
});

function payout(overrides: Partial<SettlementPayoutRow> = {}): SettlementPayoutRow {
  return {
    payout_id: "pay-1",
    account_id: "acct-1",
    amount: "25.00",
    requested_amount: "25.00",
    fee_amount: "0.32",
    net_amount: "24.68",
    currency_code: "usd",
    destination_reference: null,
    note: null,
    display_reference: "PYO-PAY1",
    status: "requested",
    provider_transfer_reference: null,
    provider_payout_reference: null,
    provider_status: null,
    provider_failure_code: null,
    provider_failure_message: null,
    requested_at: "2026-07-14T11:00:00.000Z",
    updated_at: "2026-07-14T11:00:00.000Z",
    sent_at: null,
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    last_provider_event_at: null,
    last_reconciled_at: null,
    retry_count: 0,
    next_retry_at: null,
    retry_reason: null,
    ...overrides,
  };
}

describe("selectBlockedPayoutAttentionRows", () => {
  it("selects the failed, missing-reference, and stale-requested states used by the dashboard and queue", () => {
    const rows = selectBlockedPayoutAttentionRows(
      [
        payout({
          payout_id: "failed",
          display_reference: "PYO-FAILED",
          status: "failed",
          failure_reason: "recent-payout-failure",
          failed_at: "2026-07-14T10:00:00.000Z",
        }),
        payout({
          payout_id: "missing",
          display_reference: "PYO-MISSING",
          status: "in-transit",
          updated_at: "2026-07-14T11:50:00.000Z",
        }),
        payout({ payout_id: "stale", display_reference: "PYO-STALE" }),
        payout({
          payout_id: "fresh",
          display_reference: "PYO-FRESH",
          updated_at: "2026-07-14T11:55:00.000Z",
        }),
        payout({
          payout_id: "paid",
          display_reference: "PYO-PAID",
          status: "completed",
          provider_payout_reference: "provider-paid",
        }),
      ],
      CONTEXT,
    );

    expect(rows.map((candidate) => [candidate.payoutId, candidate.kind, candidate.nextAction])).toEqual([
      ["failed", "failed", "retry"],
      ["missing", "missing-provider-reference", "run-reconciliation"],
      ["stale", "stale-requested", "run-reconciliation"],
    ]);
  });

  it("feeds the shared queue mapper from the same selected rows", () => {
    const rows = selectBlockedPayoutAttentionRows(
      [
        payout({
          payout_id: "failed",
          display_reference: "PYO-FAILED",
          status: "failed",
          failure_reason: "recent-payout-failure",
          failed_at: "2026-07-14T10:00:00.000Z",
        }),
      ],
      CONTEXT,
    );

    expect(toBlockedPayoutAttentionItems(rows)[0]).toMatchObject({
      id: "settlement-blocked-payout:failed",
      summary: {
        code: "payout-blocked",
        params: { reference: "PYO-FAILED", reason: "Review the recent payout failure before requesting more funds." },
      },
    });
  });

  it.each([
    [
      "a coded failure_reason",
      {
        status: "failed",
        failure_reason: "identity-verification-required",
        provider_failure_code: "account_closed",
        provider_failure_message: CLOSED_MESSAGE,
      },
      "identity verification required",
    ],
    [
      "a provider code and message",
      {
        status: "failed",
        failure_reason: null,
        provider_failure_code: "account_closed",
        provider_failure_message: CLOSED_MESSAGE,
      },
      CLOSED_MESSAGE,
    ],
    [
      "a provider code only",
      {
        status: "failed",
        failure_reason: null,
        provider_failure_code: "account_closed",
        provider_failure_message: null,
      },
      "Payout failed",
    ],
    [
      "a provider message only",
      { status: "failed", failure_reason: null, provider_failure_code: null, provider_failure_message: CLOSED_MESSAGE },
      CLOSED_MESSAGE,
    ],
    [
      "no failure detail",
      { status: "failed", failure_reason: null, provider_failure_code: null, provider_failure_message: null },
      "Payout failed",
    ],
    ["a stale request", { status: "requested" }, "A previous payout request needs reconciliation."],
    [
      "a missing provider reference",
      { status: "in-transit", updated_at: "2026-07-14T11:50:00.000Z" },
      "A previous payout request needs reconciliation.",
    ],
  ] as const)("shows the seller-facing reason for %s", (_name, overrides, reason) => {
    const rows = selectBlockedPayoutAttentionRows(
      [
        payout({
          payout_id: "blocked",
          display_reference: "PYO-BLOCKED",
          failed_at: "2026-07-14T10:00:00.000Z",
          ...overrides,
        }),
      ],
      CONTEXT,
    );

    expect(toBlockedPayoutAttentionItems(rows).map((item) => item.summary.params)).toEqual([
      { reference: "PYO-BLOCKED", reason },
    ]);
  });
});
