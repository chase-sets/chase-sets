import {
  normalizePayoutReviewHoldPayload,
  payoutReviewHoldFactTypes,
} from "@chase-sets/event-core/payout-review-hold-facts";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

async function updateManualPayoutReview(
  db: PgQueryable,
  params: Readonly<{ accountId: string; assigned: boolean; updatedAt: string }>,
) {
  await db.query(
    `INSERT INTO payments_account_risk_sources (
       account_id,
       manual_payout_review,
       updated_at
     ) VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE SET
       manual_payout_review = EXCLUDED.manual_payout_review,
       updated_at = EXCLUDED.updated_at`,
    [params.accountId, params.assigned, params.updatedAt],
  );
}

export function buildPaymentsSettlementAccountRiskSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const update =
    (assigned: boolean): NonNullable<ProjectorHandlerMap[string]> =>
    async (event) => {
      const { accountId } = normalizePayoutReviewHoldPayload(event.data);
      await updateManualPayoutReview(db, { accountId, assigned, updatedAt: event.timing.recordedAt });
    };
  return {
    [payoutReviewHoldFactTypes.placed]: update(true),
    [payoutReviewHoldFactTypes.released]: update(false),
  };
}

export function buildPaymentsPaymentsAccountRiskSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "payments.payment-fraud-warning-received": async (event) => {
      const data = event.data as { buyerAccountId: string; receivedAt: string };
      await db.query(
        `INSERT INTO payments_account_risk_sources (
           account_id,
           stripe_fraud_flag,
           stripe_fraud_flagged_at,
           stripe_fraud_signal_count,
           updated_at
         ) VALUES ($1, TRUE, $2, 1, $2)
         ON CONFLICT (account_id) DO UPDATE SET
           stripe_fraud_flag = TRUE,
           stripe_fraud_flagged_at = COALESCE(
             payments_account_risk_sources.stripe_fraud_flagged_at,
             EXCLUDED.stripe_fraud_flagged_at
           ),
           stripe_fraud_signal_count = payments_account_risk_sources.stripe_fraud_signal_count + 1,
           updated_at = EXCLUDED.updated_at`,
        [data.buyerAccountId, data.receivedAt],
      );
    },
    "payments.payment-fraud-review-opened": async (event) => {
      const data = event.data as { buyerAccountId: string; openedAt: string };
      await db.query(
        `INSERT INTO payments_account_risk_sources (
           account_id,
           stripe_fraud_flag,
           stripe_fraud_flagged_at,
           stripe_review_open_count,
           updated_at
         ) VALUES ($1, TRUE, $2, 1, $2)
         ON CONFLICT (account_id) DO UPDATE SET
           stripe_fraud_flag = TRUE,
           stripe_fraud_flagged_at = COALESCE(
             payments_account_risk_sources.stripe_fraud_flagged_at,
             EXCLUDED.stripe_fraud_flagged_at
           ),
           stripe_review_open_count = payments_account_risk_sources.stripe_review_open_count + 1,
           updated_at = EXCLUDED.updated_at`,
        [data.buyerAccountId, data.openedAt],
      );
    },
    "payments.payment-fraud-review-closed": async (event) => {
      const data = event.data as { buyerAccountId: string; outcome: string | null; closedAt: string };
      await db.query(
        `INSERT INTO payments_account_risk_sources (
           account_id,
           stripe_fraud_flag,
           stripe_review_open_count,
           updated_at
         ) VALUES ($1, $2, 0, $3)
         ON CONFLICT (account_id) DO UPDATE SET
           stripe_fraud_flag = CASE
             WHEN $2 = FALSE AND payments_account_risk_sources.stripe_fraud_signal_count = 0 THEN FALSE
             ELSE payments_account_risk_sources.stripe_fraud_flag
           END,
           stripe_review_open_count = GREATEST(0, payments_account_risk_sources.stripe_review_open_count - 1),
           updated_at = EXCLUDED.updated_at`,
        [data.buyerAccountId, data.outcome !== "approved", data.closedAt],
      );
    },
  };
}
