import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

async function refreshAccountReviews(db: PgQueryable, accountId: string, updatedAt: string) {
  await db.query(
    `INSERT INTO settlement_account_risk_sources (
       account_id,
       review_count,
       average_rating,
       updated_at
     )
     SELECT
       $1,
       COUNT(*)::integer,
       CASE WHEN COUNT(*) = 0 THEN NULL ELSE ROUND(AVG(rating)::numeric, 2) END,
       $2
     FROM settlement_account_review_sources
     WHERE subject_account_id = $1
       AND status = 'active'
     ON CONFLICT (account_id) DO UPDATE SET
       review_count = EXCLUDED.review_count,
       average_rating = EXCLUDED.average_rating,
       updated_at = EXCLUDED.updated_at`,
    [accountId, updatedAt],
  );
}

async function updateBadge(
  db: PgQueryable,
  params: Readonly<{ accountId: string; badgeKey: string; assigned: boolean; updatedAt: string }>,
) {
  if (!["trusted-seller", "manual-payout-review"].includes(params.badgeKey)) {
    return;
  }
  const columnName = params.badgeKey === "trusted-seller" ? "trusted_seller" : "manual_payout_review";

  await db.query(
    `INSERT INTO settlement_account_risk_sources (
       account_id,
       ${columnName},
       updated_at
     ) VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE SET
       ${columnName} = EXCLUDED.${columnName},
       updated_at = EXCLUDED.updated_at`,
    [params.accountId, params.assigned, params.updatedAt],
  );
}

export function buildSettlementIdentityAccountRiskSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const data = event.data as { accountId: string; createdAt?: string | null };
      const createdAt = data.createdAt ?? event.timing.recordedAt;

      await db.query(
        `INSERT INTO settlement_account_risk_sources (
           account_id,
           account_created_at,
           updated_at
         ) VALUES ($1, $2, $2)
         ON CONFLICT (account_id) DO UPDATE SET
           account_created_at = COALESCE(settlement_account_risk_sources.account_created_at, EXCLUDED.account_created_at),
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, createdAt],
      );
    },
    "identity.account.badge-assigned": async (event) => {
      const data = event.data as { badgeKey: string };
      await updateBadge(db, {
        accountId: extractIdFromStreamId(event.streamId, "identity.account-"),
        badgeKey: data.badgeKey,
        assigned: true,
        updatedAt: event.timing.recordedAt,
      });
    },
    "identity.account.badge-removed": async (event) => {
      const data = event.data as { badgeKey: string };
      await updateBadge(db, {
        accountId: extractIdFromStreamId(event.streamId, "identity.account-"),
        badgeKey: data.badgeKey,
        assigned: false,
        updatedAt: event.timing.recordedAt,
      });
    },
  };
}

export function buildSettlementReputationAccountRiskSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "reputation.review.submitted": async (event) => {
      const data = event.data as {
        reviewId: string;
        subjectAccountId: string;
        rating: number;
        submittedAt: string;
      };
      await db.query(
        `INSERT INTO settlement_account_review_sources (
           review_id,
           subject_account_id,
           rating,
           status,
           updated_at
         ) VALUES ($1, $2, $3, 'active', $4)
         ON CONFLICT (review_id) DO UPDATE SET
           subject_account_id = EXCLUDED.subject_account_id,
           rating = EXCLUDED.rating,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [data.reviewId, data.subjectAccountId, data.rating, data.submittedAt],
      );
      await refreshAccountReviews(db, data.subjectAccountId, data.submittedAt);
    },
    "reputation.review.updated": async (event) => {
      const data = event.data as { reviewId: string; rating: number; updatedAt: string };
      const result = await db.query<{ subject_account_id: string }>(
        `UPDATE settlement_account_review_sources
         SET rating = $2,
             updated_at = $3
         WHERE review_id = $1
         RETURNING subject_account_id`,
        [data.reviewId, data.rating, data.updatedAt],
      );
      const accountId = result.rows[0]?.subject_account_id;
      if (accountId) {
        await refreshAccountReviews(db, accountId, data.updatedAt);
      }
    },
    "reputation.review.withdrawn": async (event) => {
      const data = event.data as { reviewId: string; withdrawnAt: string };
      const result = await db.query<{ subject_account_id: string }>(
        `UPDATE settlement_account_review_sources
         SET status = 'withdrawn',
             updated_at = $2
         WHERE review_id = $1
         RETURNING subject_account_id`,
        [data.reviewId, data.withdrawnAt],
      );
      const accountId = result.rows[0]?.subject_account_id;
      if (accountId) {
        await refreshAccountReviews(db, accountId, data.withdrawnAt);
      }
    },
  };
}
