import { describe, expect, it } from "vitest";
import { isSellerAttentionItem, type SellerAttentionContext } from "@chase-sets/seller-attention-queue";
import {
  createBlockedPayoutAttentionSource,
  toBlockedPayoutAttentionItems,
  type BlockedPayoutAttentionRow,
} from "./seller-attention-source";

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
