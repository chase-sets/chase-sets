import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Projection handlers for the Wallet Adjustment lifecycle (ADR 0020). These
 * are merged into the settlement wallet projection handler set so the read
 * model advances on the same same-context self-projection as wallet balances.
 *
 * Every handler is idempotent and monotonic: the creating `requested` event
 * inserts with ON CONFLICT DO NOTHING and each later transition advances the
 * row forward only from its immediately prior status. Re-delivery or full
 * replay therefore reconstructs the same row and the same ledger linkage
 * without regressing an already-advanced adjustment.
 */
export function buildWalletAdjustmentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "settlement.wallet-adjustment.requested": async (event) => {
      const data = event.data as {
        adjustmentId: string;
        targetAccountId: string;
        direction: string;
        amount: string;
        currencyCode: string;
        reasonCode: string;
        explanation: string | null;
        evidenceReferences: readonly string[];
        reversalOfAdjustmentId: string | null;
        requestedBy: string;
        requestedAt: string;
        selfBenefiting: boolean;
      };

      await db.query(
        `INSERT INTO settlement_wallet_adjustment_pages (
           adjustment_id,
           status,
           target_account_id,
           direction,
           amount,
           currency_code,
           reason_code,
           explanation,
           evidence_references,
           reversal_of_adjustment_id,
           requested_by,
           requested_at,
           self_benefiting,
           updated_at
         ) VALUES (
           $1, 'requested', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $11
         )
         ON CONFLICT (adjustment_id) DO NOTHING`,
        [
          data.adjustmentId,
          data.targetAccountId,
          data.direction,
          data.amount,
          data.currencyCode,
          data.reasonCode,
          data.explanation,
          JSON.stringify(data.evidenceReferences ?? []),
          data.reversalOfAdjustmentId,
          data.requestedBy,
          data.requestedAt,
          data.selfBenefiting,
        ],
      );
    },
    "settlement.wallet-adjustment.approved": async (event) => {
      const data = event.data as {
        adjustmentId: string;
        approvedBy: string;
        approvedAt: string;
        controls: {
          highValueCreditThresholdAmount: string;
          highValueDebitThresholdAmount: string;
          recentAuthMaxAgeMinutes: number;
        };
        elevationRequired: boolean;
        elevationReasons: readonly string[];
        elevationApprovedBy: string | null;
        createsOrIncreasesNegativeBalance: boolean;
        reversalAfterFundsSettled: boolean;
      };

      await db.query(
        `UPDATE settlement_wallet_adjustment_pages
         SET status = 'approved',
             approved_by = $2,
             approved_at = $3,
             elevation_required = $4,
             elevation_reasons = $5::jsonb,
             elevation_approved_by = $6,
             creates_or_increases_negative_balance = $7,
             reversal_after_funds_settled = $8,
             high_value_credit_threshold_amount = $9,
             high_value_debit_threshold_amount = $10,
             recent_auth_max_age_minutes = $11,
             updated_at = $3
         WHERE adjustment_id = $1
           AND status = 'requested'`,
        [
          data.adjustmentId,
          data.approvedBy,
          data.approvedAt,
          data.elevationRequired,
          JSON.stringify(data.elevationReasons ?? []),
          data.elevationApprovedBy,
          data.createsOrIncreasesNegativeBalance,
          data.reversalAfterFundsSettled,
          data.controls.highValueCreditThresholdAmount,
          data.controls.highValueDebitThresholdAmount,
          data.controls.recentAuthMaxAgeMinutes,
        ],
      );
    },
    "settlement.wallet-adjustment.rejected": async (event) => {
      const data = event.data as {
        adjustmentId: string;
        rejectedBy: string;
        rejectedAt: string;
        rejectionReason: string | null;
      };

      await db.query(
        `UPDATE settlement_wallet_adjustment_pages
         SET status = 'rejected',
             rejected_by = $2,
             rejected_at = $3,
             rejection_reason = $4,
             updated_at = $3
         WHERE adjustment_id = $1
           AND status = 'requested'`,
        [data.adjustmentId, data.rejectedBy, data.rejectedAt, data.rejectionReason],
      );
    },
    "settlement.wallet-adjustment.posted": async (event) => {
      const data = event.data as {
        adjustmentId: string;
        ledgerEntryId: string;
        postedAt: string;
        availableBalanceBefore: string;
        availableBalanceAfter: string;
      };

      await db.query(
        `UPDATE settlement_wallet_adjustment_pages
         SET status = 'posted',
             posted_ledger_entry_id = $2,
             posted_at = $3,
             available_balance_before = $4,
             available_balance_after = $5,
             updated_at = $3
         WHERE adjustment_id = $1
           AND status = 'approved'`,
        [data.adjustmentId, data.ledgerEntryId, data.postedAt, data.availableBalanceBefore, data.availableBalanceAfter],
      );
    },
    "settlement.wallet-adjustment.reversed": async (event) => {
      const data = event.data as {
        adjustmentId: string;
        reversalAdjustmentId: string;
        reversedAt: string;
      };

      await db.query(
        `UPDATE settlement_wallet_adjustment_pages
         SET status = 'reversed',
             reversed_by_adjustment_id = $2,
             reversed_at = $3,
             updated_at = $3
         WHERE adjustment_id = $1
           AND status = 'posted'`,
        [data.adjustmentId, data.reversalAdjustmentId, data.reversedAt],
      );
    },
  };
}
