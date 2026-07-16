import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { AccountId, WalletAdjustmentId } from "@chase-sets/primitives/typed-ids";
import { withWalletAdjustmentDisplayReference } from "./wallet-adjustment-display-reference";
import { getPayoutReadiness } from "../../payout-readiness/read-model/queries";
import type { WalletAdjustmentReasonCode } from "../domain/wallet-adjustment";
import type { LedgerEntryDirection } from "../../../support/runtime-support/common";
import {
  mapWalletAdjustmentPostedToNotification,
  mapWalletAdjustmentReversedToNotification,
} from "../integrations/transactional-notifications/wallet-adjustment-notification-intents";

/**
 * Best-effort account contact email for a Wallet Adjustment notice's email
 * channel. Settlement has no generic account-directory read model -- every
 * other notification producer in this codebase carries the recipient's email
 * inside its own already-captured domain data (order shipping destination,
 * payout notification email). A Wallet Adjustment is admin-initiated against
 * an arbitrary target account, so no such captured email exists here either;
 * this reuses the payout-readiness contact email already on file for the
 * account when present, and otherwise the notice still sends web-only rather
 * than silently failing to notify at all.
 */
async function targetAccountEmail(db: PgQueryable, targetAccountId: string): Promise<string | null> {
  const payoutReadiness = await getPayoutReadiness(db, targetAccountId);
  return payoutReadiness.contact_email;
}

function correlationIdFromEvent(event: { id: string; trace: { traceId?: string | null } }): string {
  return event.trace.traceId ?? event.id;
}

/**
 * Projection handlers for the Wallet Adjustment lifecycle (ADR 0020). These
 * are merged into the settlement wallet projection handler set so the read
 * model advances on the same same-context self-projection as wallet balances.
 * Wallet Adjustment account notices (see `../integrations/transactional-notifications`)
 * are enqueued from the same `posted`/`reversed` handlers rather than a
 * separate projection group, since Notifications consumption reads directly
 * off this stream instead of a new outgoing integration event (ADR 0020,
 * Command/Event/API vocabulary).
 *
 * Every handler is idempotent and monotonic: the creating `requested` event
 * inserts with ON CONFLICT DO NOTHING and each later transition advances the
 * row forward only from its immediately prior status. Re-delivery or full
 * replay therefore reconstructs the same row and the same ledger linkage
 * without regressing an already-advanced adjustment. The notification
 * outbox's own idempotency key dedupes retries/replay of the notice itself.
 *
 * Every handler resolves the transaction-scoped projection connection via
 * `resolveProjectionDb(context, db)` so its writes commit inside the projector's
 * single BEGIN/COMMIT alongside the checkpoint. A crash before the checkpoint
 * commits rolls the status advance (and its recorded balance-before/after and
 * ledger linkage) back with it, so redelivery re-applies the transition rather
 * than leaving a committed-but-uncheckpointed page drifting from the wallet
 * balance; the monotonic status guards keep a full redelivery a no-op.
 */
export function buildWalletAdjustmentProjectionHandlers(
  db: PgQueryable,
  notificationOutbox?: NotificationOutbox,
): ProjectorHandlerMap {
  return {
    "settlement.wallet-adjustment.requested": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
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

      await withWalletAdjustmentDisplayReference(data.adjustmentId as WalletAdjustmentId, (displayReference) =>
        projectionDb.query(
          `INSERT INTO settlement_wallet_adjustment_pages (
             adjustment_id,
             status,
             target_account_id,
             display_reference,
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
             $1, 'requested', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $12
           )
           ON CONFLICT (adjustment_id) DO NOTHING`,
          [
            data.adjustmentId,
            data.targetAccountId,
            displayReference,
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
        ),
      );
    },
    "settlement.wallet-adjustment.approved": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
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

      await projectionDb.query(
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
    "settlement.wallet-adjustment.rejected": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        adjustmentId: string;
        rejectedBy: string;
        rejectedAt: string;
        rejectionReason: string | null;
      };

      await projectionDb.query(
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
    "settlement.wallet-adjustment.posted": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        adjustmentId: string;
        ledgerEntryId: string;
        postedAt: string;
        availableBalanceBefore: string;
        availableBalanceAfter: string;
      };

      const result = await projectionDb.query<{
        target_account_id: string;
        direction: string;
        amount: string;
        currency_code: string;
        reason_code: string;
        reversal_of_adjustment_id: string | null;
      }>(
        `UPDATE settlement_wallet_adjustment_pages
         SET status = 'posted',
             posted_ledger_entry_id = $2,
             posted_at = $3,
             available_balance_before = $4,
             available_balance_after = $5,
             updated_at = $3
         WHERE adjustment_id = $1
           AND status = 'approved'
         RETURNING target_account_id, direction, amount::text AS amount, currency_code, reason_code, reversal_of_adjustment_id`,
        [data.adjustmentId, data.ledgerEntryId, data.postedAt, data.availableBalanceBefore, data.availableBalanceAfter],
      );

      const posted = result.rows[0];
      // A reversal's own correcting entry is not announced on its own -- the
      // `reversed` handler below sends the single linked notice once the
      // original adjustment's status update lands.
      if (posted && !posted.reversal_of_adjustment_id && notificationOutbox) {
        const targetAccountId = posted.target_account_id as AccountId;
        await notificationOutbox.enqueueNotification({
          message: mapWalletAdjustmentPostedToNotification({
            adjustmentId: data.adjustmentId,
            targetAccountId,
            targetAccountEmail: await targetAccountEmail(projectionDb, posted.target_account_id),
            direction: posted.direction as LedgerEntryDirection,
            amount: posted.amount,
            currencyCode: posted.currency_code,
            reasonCode: posted.reason_code as WalletAdjustmentReasonCode,
            resultingBalanceAmount: data.availableBalanceAfter,
            isReversalPosting: false,
            correlationId: correlationIdFromEvent(event),
          }),
          source: {
            sourceEventId: event.id,
            sourceGlobalPosition: event.globalPosition,
            projectionName: "settlement-wallet-projection",
            occurredAt: event.timing.occurredAt,
          },
        });
      }
    },
    "settlement.wallet-adjustment.reversed": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        adjustmentId: string;
        reversalAdjustmentId: string;
        reversedAt: string;
      };

      const result = await projectionDb.query<{
        target_account_id: string;
        direction: string;
        amount: string;
        currency_code: string;
      }>(
        `UPDATE settlement_wallet_adjustment_pages
         SET status = 'reversed',
             reversed_by_adjustment_id = $2,
             reversed_at = $3,
             updated_at = $3
         WHERE adjustment_id = $1
           AND status = 'posted'
         RETURNING target_account_id, direction, amount::text AS amount, currency_code`,
        [data.adjustmentId, data.reversalAdjustmentId, data.reversedAt],
      );

      const original = result.rows[0];
      if (original && notificationOutbox) {
        const reversalRow = await projectionDb.query<{ available_balance_after: string | null }>(
          `SELECT available_balance_after::text AS available_balance_after
           FROM settlement_wallet_adjustment_pages
           WHERE adjustment_id = $1`,
          [data.reversalAdjustmentId],
        );
        const resultingBalanceAmount = reversalRow.rows[0]?.available_balance_after ?? "0.00";
        const targetAccountId = original.target_account_id as AccountId;

        await notificationOutbox.enqueueNotification({
          message: mapWalletAdjustmentReversedToNotification({
            originalAdjustmentId: data.adjustmentId,
            reversalAdjustmentId: data.reversalAdjustmentId,
            targetAccountId,
            targetAccountEmail: await targetAccountEmail(projectionDb, original.target_account_id),
            originalDirection: original.direction as LedgerEntryDirection,
            amount: original.amount,
            currencyCode: original.currency_code,
            resultingBalanceAmount,
            correlationId: correlationIdFromEvent(event),
          }),
          source: {
            sourceEventId: event.id,
            sourceGlobalPosition: event.globalPosition,
            projectionName: "settlement-wallet-projection",
            occurredAt: event.timing.occurredAt,
          },
        });
      }
    },
  };
}
