// Settlement's contribution to the Seller Desk attention queue — the blocked
// payout source. A plain query module (no HTTP, no UI) that maps payouts held
// from settling into the shared attention item shape. Blocked money is urgent
// but undated: it carries no ship-by clock, so the ordering ranks it by severity
// and source priority rather than a deadline.

import {
  buildSellerAttentionItem,
  type SellerAttentionContext,
  type SellerAttentionItem,
  type SellerAttentionSource,
} from "@chase-sets/seller-attention-queue";

// The projected fields the source reads from the payout read model. Only payouts
// held from settling (blocked or failed, reconciliation-attention states) appear;
// the reason vocabulary mirrors the settlement refund/payout rework.
export type BlockedPayoutAttentionRow = Readonly<{
  payoutId: string;
  // Human display reference for the payout.
  reference: string;
  // Why the payout is held — carried through so the seller sees the blocker.
  blockReason: string;
  // ISO-8601 UTC time the payout became blocked and needed attention.
  observedAt: string;
}>;

// Pure mapping: blocked payout rows → attention items.
export function toBlockedPayoutAttentionItems(
  rows: readonly BlockedPayoutAttentionRow[],
): readonly SellerAttentionItem[] {
  return rows.map((row) =>
    buildSellerAttentionItem({
      source: "settlement-blocked-payout",
      entityId: row.payoutId,
      severity: "critical",
      summary: { code: "payout-blocked", params: { reference: row.reference, reason: row.blockReason } },
      observedAt: row.observedAt,
    }),
  );
}

export type BlockedPayoutAttentionSourceDependencies = Readonly<{
  loadBlockedPayoutRows: (context: SellerAttentionContext) => Promise<readonly BlockedPayoutAttentionRow[]>;
}>;

export function createBlockedPayoutAttentionSource(
  dependencies: BlockedPayoutAttentionSourceDependencies,
): SellerAttentionSource {
  return {
    id: "settlement-blocked-payout",
    load: async (context) => toBlockedPayoutAttentionItems(await dependencies.loadBlockedPayoutRows(context)),
  };
}
