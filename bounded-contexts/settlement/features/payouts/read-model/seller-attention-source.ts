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

const STALE_REQUESTED_AFTER_MS = 15 * 60 * 1_000;

function isStaleRequested(row: SettlementPayoutRow, now: string) {
  return row.status === "requested" && Date.parse(now) - Date.parse(row.updated_at) >= STALE_REQUESTED_AFTER_MS;
}

function failedReason(row: SettlementPayoutRow) {
  return row.failure_reason ?? row.provider_failure_code ?? "recent-payout-failure";
}

export function selectBlockedPayoutAttentionRows(
  payouts: readonly SettlementPayoutRow[],
  context: SellerAttentionContext,
): readonly BlockedPayoutAttentionRow[] {
  return payouts.flatMap((payout): readonly BlockedPayoutAttentionRow[] => {
    if (payout.status === "failed") {
      return [
        {
          payoutId: payout.payout_id,
          reference: payout.display_reference,
          blockReason: failedReason(payout),
          kind: "failed",
          nextAction: "retry",
          observedAt: payout.failed_at ?? payout.updated_at,
        },
      ];
    }

    if (isStaleRequested(payout, context.now)) {
      return [
        {
          payoutId: payout.payout_id,
          reference: payout.display_reference,
          blockReason: "payout-reconciliation-required",
          kind: "stale-requested",
          nextAction: "run-reconciliation",
          observedAt: payout.updated_at,
        },
      ];
    }

    if (payout.status === "in-transit" && !payout.provider_payout_reference) {
      return [
        {
          payoutId: payout.payout_id,
          reference: payout.display_reference,
          blockReason: "payout-reconciliation-required",
          kind: "missing-provider-reference",
          nextAction: "run-reconciliation",
          observedAt: payout.updated_at,
        },
      ];
    }

    return [];
  });
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
      const result = await db.query<{
        payout_id: string;
        display_reference: string;
        failure_reason: string | null;
        provider_failure_message: string | null;
        updated_at: string;
      }>(
        `SELECT payout_id, display_reference, failure_reason, provider_failure_message, updated_at
         FROM settlement_payout_pages
         WHERE account_id = $1
           AND status = 'failed'
         ORDER BY updated_at ASC, payout_id ASC`,
        [context.accountId],
      );

      return result.rows.map((row) => ({
        payoutId: row.payout_id,
        reference: row.display_reference || row.payout_id,
        blockReason: row.failure_reason ?? row.provider_failure_message ?? "Payout failed",
        observedAt: row.updated_at,
      }));
    },
  });
}
