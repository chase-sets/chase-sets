import { describe, expect, it, vi } from "vitest";
import { isSellerAttentionItem, type SellerAttentionContext } from "@chase-sets/seller-attention-queue";
import {
  createBlockedPayoutAttentionSource,
  createBlockedPayoutAttentionSourceFromReadModel,
  selectBlockedPayoutAttentionRows,
  toBlockedPayoutAttentionItems,
  type BlockedPayoutAttentionRow,
} from "./seller-attention-source";
import type { SettlementPayoutRow } from "./queries";

const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: "2026-07-14T12:00:00.000Z" };

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
  it("loads only failed payouts and carries the projected failure reason", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          payout_id: "pay-1",
          display_reference: "PO-1",
          failure_reason: "identity-verification-required",
          provider_failure_message: null,
          updated_at: "2026-07-12T00:00:00.000Z",
        },
      ],
    }));

    const items = await createBlockedPayoutAttentionSourceFromReadModel({ query } as never).load(CONTEXT);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), ["acct-1"]);
    expect(items[0]?.summary.params).toEqual({ reference: "PO-1", reason: "identity-verification-required" });
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
        params: { reference: "PYO-FAILED", reason: "recent-payout-failure" },
      },
    });
  });
});
