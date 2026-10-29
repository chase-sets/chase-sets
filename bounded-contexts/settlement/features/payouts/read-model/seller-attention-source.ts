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
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { SettlementPayoutRow } from "./queries";
import { listPayoutSummaryRows } from "./queries";
import { selectBlockedPayoutSummaryRows } from "./payout-summary";
import { payoutUnavailableReasonLabel, payoutUnavailableReasonLabels } from "../domain/reason-codes";

export type BlockedPayoutKind = "failed" | "missing-provider-reference" | "stale-requested";
export type BlockedPayoutNextAction = "retry" | "run-reconciliation";

// The projected fields the source reads from the payout read model. Only payouts
// held from settling (blocked or failed, reconciliation-attention states) appear;
// the reason vocabulary mirrors the settlement refund/payout rework.
export type BlockedPayoutAttentionRow = Readonly<{
  payoutId: string;
  // Human display reference for the payout.
  reference: string;
  // Why the payout is held — carried through so the seller sees the blocker.
  blockReason: string;
  kind?: BlockedPayoutKind;
  nextAction?: BlockedPayoutNextAction;
  // ISO-8601 UTC time the payout became blocked and needed attention.
  observedAt: string;
}>;

export function selectBlockedPayoutAttentionRows(
  payouts: readonly SettlementPayoutRow[],
  context: SellerAttentionContext,
): readonly BlockedPayoutAttentionRow[] {
  return selectBlockedPayoutSummaryRows(payouts, context.now).map((row) => ({
    payoutId: row.payout_id,
    reference: row.reference,
    blockReason: row.block_reason,
    kind: row.kind,
    nextAction: row.next_action,
    observedAt: row.observed_at,
  }));
}

// Pure mapping: blocked payout rows → attention items.
export function toBlockedPayoutAttentionItems(
  rows: readonly BlockedPayoutAttentionRow[],
): readonly SellerAttentionItem[] {
  return rows.map((row) =>
    buildSellerAttentionItem({
      source: "settlement-blocked-payout",
      entityId: row.payoutId,
      severity: "critical",
      summary: {
        code: "payout-blocked",
        params: { reference: row.reference, reason: sellerBlockReason(row.blockReason) },
      },
      observedAt: row.observedAt,
    }),
  );
}

function sellerBlockReason(reason: string) {
  if (reason in payoutUnavailableReasonLabels) return payoutUnavailableReasonLabel(reason);
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(reason)) {
    return payoutUnavailableReasonLabel(reason.replaceAll("_", "-"));
  }
  return reason;
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

export function createBlockedPayoutAttentionSourceFromReadModel(db: PgQueryable): SellerAttentionSource {
  return createBlockedPayoutAttentionSource({
    loadBlockedPayoutRows: async (context) => {
      const result = await listPayoutSummaryRows(db, context.accountId);
      if (result.completeness.kind !== "complete") {
        console.warn("Settlement payout summary is incomplete; Seller Desk attention is bounded.", {
          accountId: context.accountId,
          total: result.completeness.total,
          cap: result.completeness.cap,
          reason: result.completeness.reason,
        });
        return [];
      }
      return selectBlockedPayoutAttentionRows(result.items, context);
    },
  });
}
