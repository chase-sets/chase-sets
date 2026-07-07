import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type RiskAlertKind =
  | "chargeback-velocity"
  | "new-seller-listing-velocity"
  | "review-velocity"
  | "young-buyer-spend-velocity";
type SellerPayoutComponent = Readonly<{ orderId: string; sellerAccountId: string }>;

export const riskAlertThresholdDefaults = {
  chargeback30dCount: 2,
  chargeback30dRateBps: 200,
  newSellerAgeDays: 30,
  newSellerListingValue24hCents: 250000,
  review24hCount: 5,
  medianReviewerAgeDays: 7,
  youngBuyerAgeDays: 7,
  youngBuyerSpend24hCents: 200000,
} as const;

function moneyToCents(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function normalizeSellerPayouts(value: unknown): SellerPayoutComponent[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry?.sellerAccountId))
        .map((entry) => ({
          orderId: String(entry.orderId ?? ""),
          sellerAccountId: String(entry.sellerAccountId),
        }))
    : [];
}

function alertId(accountId: string, kind: RiskAlertKind) {
  return `risk_${accountId}_${kind}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

async function upsertAlert(
  db: PgQueryable,
  params: Readonly<{
    accountId: string;
    kind: RiskAlertKind;
    severity: "medium" | "high";
    manualPayoutReviewCandidate?: boolean;
    evidence: Record<string, unknown>;
    threshold: Record<string, unknown>;
    triggeredAt: string;
    updatedAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO platform_operations_risk_alert_queue_pages (
       alert_id,
       account_id,
       alert_kind,
       status,
       severity,
       manual_payout_review_candidate,
       evidence,
       threshold,
       first_triggered_at,
       last_triggered_at,
       updated_at
     ) VALUES ($1, $2, $3, 'needs-review', $4, $5, $6::jsonb, $7::jsonb, $8, $8, $9)
     ON CONFLICT (account_id, alert_kind) DO UPDATE SET
       status = CASE
         WHEN platform_operations_risk_alert_queue_pages.status = 'acknowledged' THEN 'needs-review'
         ELSE platform_operations_risk_alert_queue_pages.status
       END,
       severity = EXCLUDED.severity,
       manual_payout_review_candidate = EXCLUDED.manual_payout_review_candidate,
       evidence = EXCLUDED.evidence,
       threshold = EXCLUDED.threshold,
       last_triggered_at = EXCLUDED.last_triggered_at,
       updated_at = EXCLUDED.updated_at`,
    [
      alertId(params.accountId, params.kind),
      params.accountId,
      params.kind,
      params.severity,
      params.manualPayoutReviewCandidate ?? false,
      JSON.stringify(params.evidence),
      JSON.stringify(params.threshold),
      params.triggeredAt,
      params.updatedAt,
    ],
  );
}

async function refreshAccountAlerts(db: PgQueryable, accountId: string, now: string) {
  const result = await db.query<{
    account_created_at: string | null;
    chargeback_30d_count: string;
    chargeback_30d_rate_bps: string;
    listing_24h_count: string;
    listing_24h_value_cents: string;
    review_24h_count: string;
    review_24h_median_reviewer_age_days: string | null;
    buyer_order_24h_count: string;
    buyer_spend_24h_cents: string;
  }>(
    `WITH counters AS (
       SELECT
         COUNT(*) FILTER (
           WHERE source_kind = 'chargeback-received'
             AND occurred_at >= $2::timestamptz - interval '30 days'
         )::integer AS chargeback_30d_count,
         COUNT(*) FILTER (
           WHERE source_kind = 'seller-payment-created'
             AND occurred_at >= $2::timestamptz - interval '30 days'
         )::integer AS seller_payment_30d_count,
         COUNT(*) FILTER (
           WHERE source_kind = 'listing-created'
             AND occurred_at >= $2::timestamptz - interval '24 hours'
         )::integer AS listing_24h_count,
         COALESCE(SUM(amount_cents) FILTER (
           WHERE source_kind = 'listing-created'
             AND occurred_at >= $2::timestamptz - interval '24 hours'
         ), 0)::bigint AS listing_24h_value_cents,
         COUNT(*) FILTER (
           WHERE source_kind = 'review-received'
             AND occurred_at >= $2::timestamptz - interval '24 hours'
         )::integer AS review_24h_count,
         ROUND((
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (occurred_at - reviewer_account_created_at)) / 86400
           ) FILTER (
             WHERE source_kind = 'review-received'
               AND occurred_at >= $2::timestamptz - interval '24 hours'
               AND reviewer_account_created_at IS NOT NULL
           )
         )::numeric, 2) AS review_24h_median_reviewer_age_days,
         COUNT(*) FILTER (
           WHERE source_kind = 'buyer-payment-created'
             AND occurred_at >= $2::timestamptz - interval '24 hours'
         )::integer AS buyer_order_24h_count,
         COALESCE(SUM(amount_cents) FILTER (
           WHERE source_kind = 'buyer-payment-created'
             AND occurred_at >= $2::timestamptz - interval '24 hours'
         ), 0)::bigint AS buyer_spend_24h_cents
       FROM platform_operations_risk_alert_velocity_sources
       WHERE account_id = $1
     )
     SELECT
       account.account_created_at::text AS account_created_at,
       counters.chargeback_30d_count::text AS chargeback_30d_count,
       CASE
         WHEN counters.seller_payment_30d_count = 0 THEN '0'
         ELSE FLOOR(counters.chargeback_30d_count::numeric * 10000 / counters.seller_payment_30d_count)::text
       END AS chargeback_30d_rate_bps,
       counters.listing_24h_count::text AS listing_24h_count,
       counters.listing_24h_value_cents::text AS listing_24h_value_cents,
       counters.review_24h_count::text AS review_24h_count,
       counters.review_24h_median_reviewer_age_days::text AS review_24h_median_reviewer_age_days,
       counters.buyer_order_24h_count::text AS buyer_order_24h_count,
       counters.buyer_spend_24h_cents::text AS buyer_spend_24h_cents
     FROM counters
     LEFT JOIN platform_operations_risk_alert_account_sources account ON account.account_id = $1`,
    [accountId, now],
  );
  const row = result.rows[0];
  if (!row) return;

  const chargeback30dCount = Number(row.chargeback_30d_count);
  const chargeback30dRateBps = Number(row.chargeback_30d_rate_bps);
  if (
    chargeback30dCount >= riskAlertThresholdDefaults.chargeback30dCount ||
    chargeback30dRateBps >= riskAlertThresholdDefaults.chargeback30dRateBps
  ) {
    await upsertAlert(db, {
      accountId,
      kind: "chargeback-velocity",
      severity: "high",
      manualPayoutReviewCandidate: true,
      evidence: { chargeback30dCount, chargeback30dRateBps },
      threshold: {
        chargeback30dCount: riskAlertThresholdDefaults.chargeback30dCount,
        chargeback30dRateBps: riskAlertThresholdDefaults.chargeback30dRateBps,
      },
      triggeredAt: now,
      updatedAt: now,
    });
  }

  const accountCreatedAt = row.account_created_at ? new Date(row.account_created_at).getTime() : null;
  const ageDays = accountCreatedAt === null ? null : (new Date(now).getTime() - accountCreatedAt) / 86400000;
  const listing24hValueCents = Number(row.listing_24h_value_cents);
  if (
    ageDays !== null &&
    ageDays < riskAlertThresholdDefaults.newSellerAgeDays &&
    listing24hValueCents >= riskAlertThresholdDefaults.newSellerListingValue24hCents
  ) {
    await upsertAlert(db, {
      accountId,
      kind: "new-seller-listing-velocity",
      severity: "medium",
      evidence: {
        accountAgeDays: Math.floor(ageDays),
        listing24hCount: Number(row.listing_24h_count),
        listing24hValueCents,
      },
      threshold: {
        accountAgeDaysLessThan: riskAlertThresholdDefaults.newSellerAgeDays,
        listing24hValueCents: riskAlertThresholdDefaults.newSellerListingValue24hCents,
      },
      triggeredAt: now,
      updatedAt: now,
    });
  }

  const review24hCount = Number(row.review_24h_count);
  const medianReviewerAgeDays =
    row.review_24h_median_reviewer_age_days === null ? null : Number(row.review_24h_median_reviewer_age_days);
  if (
    review24hCount >= riskAlertThresholdDefaults.review24hCount &&
    medianReviewerAgeDays !== null &&
    medianReviewerAgeDays < riskAlertThresholdDefaults.medianReviewerAgeDays
  ) {
    await upsertAlert(db, {
      accountId,
      kind: "review-velocity",
      severity: "medium",
      evidence: { review24hCount, medianReviewerAgeDays },
      threshold: {
        review24hCount: riskAlertThresholdDefaults.review24hCount,
        medianReviewerAgeDaysLessThan: riskAlertThresholdDefaults.medianReviewerAgeDays,
      },
      triggeredAt: now,
      updatedAt: now,
    });
  }

  const buyerSpend24hCents = Number(row.buyer_spend_24h_cents);
  if (
    ageDays !== null &&
    ageDays < riskAlertThresholdDefaults.youngBuyerAgeDays &&
    buyerSpend24hCents >= riskAlertThresholdDefaults.youngBuyerSpend24hCents
  ) {
    await upsertAlert(db, {
      accountId,
      kind: "young-buyer-spend-velocity",
      severity: "medium",
      evidence: {
        accountAgeDays: Math.floor(ageDays),
        buyerOrder24hCount: Number(row.buyer_order_24h_count),
        buyerSpend24hCents,
      },
      threshold: {
        accountAgeDaysLessThan: riskAlertThresholdDefaults.youngBuyerAgeDays,
        buyerSpend24hCents: riskAlertThresholdDefaults.youngBuyerSpend24hCents,
      },
      triggeredAt: now,
      updatedAt: now,
    });
  }
}

async function upsertVelocitySource(
  db: PgQueryable,
  params: Readonly<{
    sourceKind: string;
    sourceId: string;
    accountId: string;
    occurredAt: string;
    amountCents?: number;
    reviewerAccountId?: string | null;
    updatedAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO platform_operations_risk_alert_velocity_sources (
       source_kind,
       source_id,
       account_id,
       occurred_at,
       amount_cents,
       reviewer_account_id,
       reviewer_account_created_at,
       updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       (SELECT account_created_at FROM platform_operations_risk_alert_account_sources WHERE account_id = $6),
       $7
     )
     ON CONFLICT (source_kind, source_id, account_id) DO UPDATE SET
       occurred_at = EXCLUDED.occurred_at,
       amount_cents = EXCLUDED.amount_cents,
       reviewer_account_id = EXCLUDED.reviewer_account_id,
       reviewer_account_created_at = COALESCE(
         EXCLUDED.reviewer_account_created_at,
         platform_operations_risk_alert_velocity_sources.reviewer_account_created_at
       ),
       updated_at = EXCLUDED.updated_at`,
    [
      params.sourceKind,
      params.sourceId,
      params.accountId,
      params.occurredAt,
      params.amountCents ?? 0,
      params.reviewerAccountId ?? null,
      params.updatedAt,
    ],
  );
  await refreshAccountAlerts(db, params.accountId, params.updatedAt);
}

export function buildIdentityRiskAlertProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const data = event.data as { accountId: string; createdAt?: string | null };
      const createdAt = data.createdAt ?? event.timing.recordedAt;
      await db.query(
        `INSERT INTO platform_operations_risk_alert_account_sources (account_id, account_created_at, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET
           account_created_at = COALESCE(
             platform_operations_risk_alert_account_sources.account_created_at,
             EXCLUDED.account_created_at
           ),
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, createdAt, event.timing.recordedAt],
      );
      await db.query(
        `UPDATE platform_operations_risk_alert_velocity_sources
         SET reviewer_account_created_at = $2,
             updated_at = $3
         WHERE reviewer_account_id = $1
           AND reviewer_account_created_at IS NULL`,
        [data.accountId, createdAt, event.timing.recordedAt],
      );
      const touched = await db.query<{ account_id: string }>(
        `SELECT DISTINCT account_id
         FROM platform_operations_risk_alert_velocity_sources
         WHERE reviewer_account_id = $1
            OR account_id = $1`,
        [data.accountId],
      );
      for (const row of touched.rows) {
        await refreshAccountAlerts(db, row.account_id, event.timing.recordedAt);
      }
    },
  };
}

export function buildMarketplaceRiskAlertProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "marketplace.listing.created": async (event) => {
      const data = event.data as { listingId: string; accountId: string; priceAmount: string };
      await upsertVelocitySource(db, {
        sourceKind: "listing-created",
        sourceId: data.listingId,
        accountId: data.accountId,
        occurredAt: event.timing.occurredAt ?? event.timing.recordedAt,
        amountCents: moneyToCents(data.priceAmount),
        updatedAt: event.timing.recordedAt,
      });
    },
    "marketplace.review.submitted": async (event) => {
      const data = event.data as {
        reviewId: string;
        authorAccountId?: string;
        subjectAccountId: string;
        submittedAt: string;
      };
      await upsertVelocitySource(db, {
        sourceKind: "review-received",
        sourceId: data.reviewId,
        accountId: data.subjectAccountId,
        occurredAt: data.submittedAt,
        reviewerAccountId: data.authorAccountId ?? null,
        updatedAt: event.timing.recordedAt,
      });
    },
  };
}

export function buildPaymentsRiskAlertProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "payments.payment-created": async (event) => {
      const data = event.data as {
        paymentId: string;
        buyerAccountId: string;
        amount: string;
        createdAt?: string;
        sellerPayouts?: unknown;
      };
      const occurredAt = data.createdAt ?? event.timing.occurredAt ?? event.timing.recordedAt;
      await upsertVelocitySource(db, {
        sourceKind: "buyer-payment-created",
        sourceId: data.paymentId,
        accountId: data.buyerAccountId,
        occurredAt,
        amountCents: moneyToCents(data.amount),
        updatedAt: event.timing.recordedAt,
      });
      for (const payout of normalizeSellerPayouts(data.sellerPayouts)) {
        await upsertVelocitySource(db, {
          sourceKind: "seller-payment-created",
          sourceId: `${data.paymentId}:${payout.orderId}`,
          accountId: payout.sellerAccountId,
          occurredAt,
          updatedAt: event.timing.recordedAt,
        });
      }
    },
    "payments.payment-disputed": async (event) => {
      const data = event.data as {
        providerDisputeId?: string | null;
        paymentId: string;
        disputedAt?: string;
        sellerPayouts?: unknown;
      };
      const occurredAt = data.disputedAt ?? event.timing.occurredAt ?? event.timing.recordedAt;
      for (const payout of normalizeSellerPayouts(data.sellerPayouts)) {
        await upsertVelocitySource(db, {
          sourceKind: "chargeback-received",
          sourceId: `${data.providerDisputeId ?? data.paymentId}:${payout.orderId}`,
          accountId: payout.sellerAccountId,
          occurredAt,
          updatedAt: event.timing.recordedAt,
        });
      }
    },
  };
}

export function buildPlatformOperationsRiskAlertProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "platform-operations.risk-alert.action-recorded": async (event) => {
      const data = event.data as {
        alertId: string;
        action: string;
        note: string | null;
        operatorUserId: string | null;
        recordedAt: string;
      };
      const status =
        data.action === "request-manual-payout-review"
          ? "manual-payout-review-requested"
          : data.action === "acknowledge"
            ? "acknowledged"
            : null;
      if (!status) return;
      await db.query(
        `UPDATE platform_operations_risk_alert_queue_pages
         SET status = $2,
             last_action = $3,
             last_action_at = $4,
             last_action_note = $5,
             last_action_by_user_id = $6,
             updated_at = $4
         WHERE alert_id = $1`,
        [data.alertId, status, data.action, data.recordedAt, data.note, data.operatorUserId],
      );
    },
  };
}

export function buildRiskAlertProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    ...buildIdentityRiskAlertProjectionHandlers(db),
    ...buildMarketplaceRiskAlertProjectionHandlers(db),
    ...buildPaymentsRiskAlertProjectionHandlers(db),
    ...buildPlatformOperationsRiskAlertProjectionHandlers(db),
  };
}
