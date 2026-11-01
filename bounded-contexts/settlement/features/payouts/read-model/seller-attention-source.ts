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
import { selectBlockedPayoutSummaryRows, type PayoutSummaryBlockedPayout } from "./payout-summary";
import { payoutUnavailableReasonLabel } from "../domain/reason-codes";

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
  const payoutsById = new Map(payouts.map((payout) => [payout.payout_id, payout]));
  return selectBlockedPayoutSummaryRows(payouts, context.now).map((row) => ({
    payoutId: row.payout_id,
    reference: row.reference,
    blockReason: sellerBlockReason(row, payoutsById.get(row.payout_id)),
    kind: row.kind,
    nextAction: row.next_action,
    observedAt: row.observed_at,
  }));
}

// The shared block_reason is the machine code the API, dashboard and MCP publish.
// Sellers instead see the labelled failure_reason, else the provider's message as
// written, else a generic fallback; reconciliation kinds read as their label.
function sellerBlockReason(row: PayoutSummaryBlockedPayout, payout: SettlementPayoutRow | undefined) {
  if (row.kind !== "failed") return payoutUnavailableReasonLabel(row.block_reason);
  const failureReason = payout?.failure_reason ?? null;
  if (failureReason !== null) return codedReasonLabel(failureReason);
  return payout?.provider_failure_message ?? "Payout failed";
}

// Coded reasons read as their Settlement label; human failure text passes through.
function codedReasonLabel(reason: string) {
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(reason)
    ? payoutUnavailableReasonLabel(reason.replaceAll("_", "-"))
    : reason;
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
      // The summary reads newest first; the Desk keeps its oldest-first,
      // payout-ID order so equal-time blockers stay in a stable sequence.
      return selectBlockedPayoutAttentionRows(result.items, context)
        .slice()
        .sort(
          (left, right) =>
            Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.payoutId.localeCompare(right.payoutId),
        );
    },
  });
}
