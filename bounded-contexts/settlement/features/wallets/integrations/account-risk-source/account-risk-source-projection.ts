import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type ShippingAddressSnapshot = Readonly<{
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}>;

function normalizeClusterPart(value: string | null | undefined) {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function addressClusterKey(address: ShippingAddressSnapshot) {
  return [
    normalizeClusterPart(address.country),
    normalizeClusterPart(address.postalCode),
    normalizeClusterPart(address.state),
    normalizeClusterPart(address.city),
    normalizeClusterPart(address.line1),
    normalizeClusterPart(address.line2),
  ].join("|");
}

async function refreshSharedInstrumentClusters(db: PgQueryable, accountId: string, updatedAt: string) {
  await db.query(
    `INSERT INTO settlement_account_risk_sources (
       account_id,
       shared_instrument_cluster_count,
       updated_at
     )
     SELECT
       $1,
       COUNT(DISTINCT account_instruments.instrument_cluster_key)::integer,
       $2
     FROM settlement_account_instrument_risk_sources account_instruments
     WHERE account_instruments.account_id = $1
       AND account_instruments.active = TRUE
       AND account_instruments.instrument_cluster_key IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM settlement_account_instrument_risk_sources linked_instruments
         WHERE linked_instruments.instrument_cluster_key = account_instruments.instrument_cluster_key
           AND linked_instruments.active = TRUE
           AND linked_instruments.account_id <> $1
       )
     ON CONFLICT (account_id) DO UPDATE SET
       shared_instrument_cluster_count = EXCLUDED.shared_instrument_cluster_count,
       updated_at = EXCLUDED.updated_at`,
    [accountId, updatedAt],
  );
}

async function refreshInstrumentClusterAccounts(
  db: PgQueryable,
  instrumentClusterKey: string | null,
  updatedAt: string,
) {
  if (!instrumentClusterKey) {
    return;
  }
  const result = await db.query<{ account_id: string }>(
    `SELECT DISTINCT account_id
     FROM settlement_account_instrument_risk_sources
     WHERE instrument_cluster_key = $1
       AND active = TRUE`,
    [instrumentClusterKey],
  );
  for (const row of result.rows) {
    await refreshSharedInstrumentClusters(db, row.account_id, updatedAt);
  }
}

async function refreshSharedAddressClusters(db: PgQueryable, accountId: string, updatedAt: string) {
  await db.query(
    `INSERT INTO settlement_account_risk_sources (
       account_id,
       shared_address_cluster_count,
       updated_at
     )
     SELECT
       $1,
       COUNT(DISTINCT account_addresses.address_cluster_key)::integer,
       $2
     FROM settlement_account_address_risk_sources account_addresses
     WHERE account_addresses.account_id = $1
       AND account_addresses.active = TRUE
       AND account_addresses.address_cluster_key IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM settlement_account_address_risk_sources linked_addresses
         WHERE linked_addresses.address_cluster_key = account_addresses.address_cluster_key
           AND linked_addresses.active = TRUE
           AND linked_addresses.account_id <> $1
       )
     ON CONFLICT (account_id) DO UPDATE SET
       shared_address_cluster_count = EXCLUDED.shared_address_cluster_count,
       updated_at = EXCLUDED.updated_at`,
    [accountId, updatedAt],
  );
}

async function refreshAddressClusterAccounts(
  db: PgQueryable,
  addressClusterKeyValue: string | null,
  updatedAt: string,
) {
  if (!addressClusterKeyValue) {
    return;
  }
  const result = await db.query<{ account_id: string }>(
    `SELECT DISTINCT account_id
     FROM settlement_account_address_risk_sources
     WHERE address_cluster_key = $1
       AND active = TRUE`,
    [addressClusterKeyValue],
  );
  for (const row of result.rows) {
    await refreshSharedAddressClusters(db, row.account_id, updatedAt);
  }
}

type SellerPayoutComponent = Readonly<{ orderId: string; sellerAccountId: string; sellerPayoutAmount?: string }>;

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
          sellerPayoutAmount: typeof entry.sellerPayoutAmount === "string" ? entry.sellerPayoutAmount : undefined,
        }))
    : [];
}

function velocityFlagsSql(nowParam: string) {
  return `jsonb_strip_nulls(jsonb_build_object(
    'chargeback_velocity',
      CASE WHEN chargeback_30d_count >= 2 OR chargeback_30d_rate_bps >= 200 THEN jsonb_build_object(
        'manualPayoutReviewCandidate', TRUE,
        'chargeback30dCount', chargeback_30d_count,
        'chargeback30dRateBps', chargeback_30d_rate_bps
      ) END,
    'new_seller_listing_velocity',
      CASE WHEN account_created_at IS NOT NULL
             AND ${nowParam}::timestamptz - account_created_at < interval '30 days'
             AND listing_24h_value_cents >= 250000 THEN jsonb_build_object(
        'listing24hCount', listing_24h_count,
        'listing24hValueCents', listing_24h_value_cents
      ) END,
    'review_velocity',
      CASE WHEN review_24h_count >= 5
             AND review_24h_median_reviewer_age_days IS NOT NULL
             AND review_24h_median_reviewer_age_days < 7 THEN jsonb_build_object(
        'review24hCount', review_24h_count,
        'medianReviewerAgeDays', review_24h_median_reviewer_age_days
      ) END,
    'young_buyer_spend_velocity',
      CASE WHEN account_created_at IS NOT NULL
             AND ${nowParam}::timestamptz - account_created_at < interval '7 days'
             AND buyer_spend_24h_cents >= 200000 THEN jsonb_build_object(
        'buyerOrder24hCount', buyer_order_24h_count,
        'buyerSpend24hCents', buyer_spend_24h_cents
      ) END
  ))`;
}

async function refreshVelocityCounters(db: PgQueryable, accountId: string, now: string) {
  await db.query(
    `INSERT INTO settlement_account_risk_sources (
       account_id,
       chargeback_7d_count,
       chargeback_30d_count,
       chargeback_30d_rate_bps,
       listing_24h_count,
       listing_24h_value_cents,
       review_24h_count,
       review_24h_median_reviewer_age_days,
       buyer_order_24h_count,
       buyer_spend_24h_cents,
       velocity_alert_flags,
       updated_at
     )
     WITH counters AS (
       SELECT
         COUNT(*) FILTER (
           WHERE source_kind = 'chargeback-received'
             AND occurred_at >= $2::timestamptz - interval '7 days'
         )::integer AS chargeback_7d_count,
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
       FROM settlement_account_velocity_sources
       WHERE account_id = $1
     ), rollup AS (
       SELECT
         (SELECT account_created_at FROM settlement_account_risk_sources WHERE account_id = $1) AS account_created_at,
         chargeback_7d_count,
         chargeback_30d_count,
         CASE
           WHEN seller_payment_30d_count = 0 THEN 0
           ELSE FLOOR(chargeback_30d_count::numeric * 10000 / seller_payment_30d_count)::integer
         END AS chargeback_30d_rate_bps,
         listing_24h_count,
         listing_24h_value_cents,
         review_24h_count,
         review_24h_median_reviewer_age_days,
         buyer_order_24h_count,
         buyer_spend_24h_cents
       FROM counters
     )
     SELECT
       $1,
       chargeback_7d_count,
       chargeback_30d_count,
       chargeback_30d_rate_bps,
       listing_24h_count,
       listing_24h_value_cents,
       review_24h_count,
       review_24h_median_reviewer_age_days,
       buyer_order_24h_count,
       buyer_spend_24h_cents,
       ${velocityFlagsSql("$2")},
       $2
     FROM rollup
     ON CONFLICT (account_id) DO UPDATE SET
       chargeback_7d_count = EXCLUDED.chargeback_7d_count,
       chargeback_30d_count = EXCLUDED.chargeback_30d_count,
       chargeback_30d_rate_bps = EXCLUDED.chargeback_30d_rate_bps,
       listing_24h_count = EXCLUDED.listing_24h_count,
       listing_24h_value_cents = EXCLUDED.listing_24h_value_cents,
       review_24h_count = EXCLUDED.review_24h_count,
       review_24h_median_reviewer_age_days = EXCLUDED.review_24h_median_reviewer_age_days,
       buyer_order_24h_count = EXCLUDED.buyer_order_24h_count,
       buyer_spend_24h_cents = EXCLUDED.buyer_spend_24h_cents,
       velocity_alert_flags = EXCLUDED.velocity_alert_flags,
       updated_at = EXCLUDED.updated_at`,
    [accountId, now],
  );
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
    `INSERT INTO settlement_account_velocity_sources (
       source_kind,
       source_id,
       account_id,
       occurred_at,
       amount_cents,
       reviewer_account_id,
       reviewer_account_created_at,
       updated_at
     ) VALUES (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       (SELECT account_created_at FROM settlement_account_risk_sources WHERE account_id = $6),
       $7
     )
     ON CONFLICT (source_kind, source_id, account_id) DO UPDATE SET
       occurred_at = EXCLUDED.occurred_at,
       amount_cents = EXCLUDED.amount_cents,
       reviewer_account_id = EXCLUDED.reviewer_account_id,
       reviewer_account_created_at = COALESCE(
         EXCLUDED.reviewer_account_created_at,
         settlement_account_velocity_sources.reviewer_account_created_at
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
  await refreshVelocityCounters(db, params.accountId, params.updatedAt);
}

// review_count/average_rating are payout-risk inputs (m108): author_role = 'buyer'
// isolates reviews AUTHORED BY A BUYER, meaning the SUBJECT (this account) was
// reviewed acting AS A SELLER. Reviews the subject earned as a buyer must never
// count here — see the schema comment on settlement_account_review_sources.
// Composes with the m107 trust-signal-eligible join: both filters must hold
// for a review to count toward funds-release risk.
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
     INNER JOIN settlement_order_trust_signal_sources trust_source
       ON trust_source.order_id = settlement_account_review_sources.order_id
      AND trust_source.seller_account_id = settlement_account_review_sources.subject_account_id
      AND trust_source.trust_signal_eligible = TRUE
     WHERE subject_account_id = $1
       AND status = 'active'
       AND author_role = 'buyer'
       AND revealed_at IS NOT NULL
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
      await db.query(
        `UPDATE settlement_account_velocity_sources
         SET reviewer_account_created_at = $2,
             updated_at = $3
         WHERE reviewer_account_id = $1
           AND reviewer_account_created_at IS NULL`,
        [data.accountId, createdAt, event.timing.recordedAt],
      );
      const touched = await db.query<{ account_id: string }>(
        `SELECT DISTINCT account_id
         FROM settlement_account_velocity_sources
         WHERE reviewer_account_id = $1`,
        [data.accountId],
      );
      for (const row of touched.rows) {
        await refreshVelocityCounters(db, row.account_id, event.timing.recordedAt);
      }
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
    "identity.shipping-address.added": async (event) => {
      const data = event.data as {
        accountId: string;
        shippingAddressId: string;
        address: ShippingAddressSnapshot;
        addedAt: string;
      };
      const clusterKey = addressClusterKey(data.address);
      await db.query(
        `INSERT INTO settlement_account_address_risk_sources (
           account_id,
           shipping_address_id,
           address_cluster_key,
           active,
           updated_at
         ) VALUES ($1, $2, $3, TRUE, $4)
         ON CONFLICT (account_id, shipping_address_id) DO UPDATE SET
           address_cluster_key = EXCLUDED.address_cluster_key,
           active = TRUE,
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, data.shippingAddressId, clusterKey, data.addedAt],
      );
      await refreshSharedAddressClusters(db, data.accountId, data.addedAt);
      await refreshAddressClusterAccounts(db, clusterKey, data.addedAt);
    },
    "identity.shipping-address.updated": async (event) => {
      const data = event.data as {
        accountId: string;
        shippingAddressId: string;
        address: ShippingAddressSnapshot;
        updatedAt: string;
      };
      const previousResult = await db.query<{ address_cluster_key: string | null }>(
        `SELECT address_cluster_key
         FROM settlement_account_address_risk_sources
         WHERE account_id = $1
           AND shipping_address_id = $2`,
        [data.accountId, data.shippingAddressId],
      );
      const previousClusterKey = previousResult.rows[0]?.address_cluster_key ?? null;
      const clusterKey = addressClusterKey(data.address);
      await db.query(
        `INSERT INTO settlement_account_address_risk_sources (
           account_id,
           shipping_address_id,
           address_cluster_key,
           active,
           updated_at
         ) VALUES ($1, $2, $3, TRUE, $4)
         ON CONFLICT (account_id, shipping_address_id) DO UPDATE SET
           address_cluster_key = EXCLUDED.address_cluster_key,
           active = TRUE,
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, data.shippingAddressId, clusterKey, data.updatedAt],
      );
      await refreshSharedAddressClusters(db, data.accountId, data.updatedAt);
      await refreshAddressClusterAccounts(db, previousClusterKey, data.updatedAt);
      await refreshAddressClusterAccounts(db, clusterKey, data.updatedAt);
    },
    "identity.shipping-address.archived": async (event) => {
      const data = event.data as {
        accountId: string;
        shippingAddressId: string;
        archivedAt: string;
      };
      const previousResult = await db.query<{ address_cluster_key: string | null }>(
        `SELECT address_cluster_key
         FROM settlement_account_address_risk_sources
         WHERE account_id = $1
           AND shipping_address_id = $2`,
        [data.accountId, data.shippingAddressId],
      );
      const previousClusterKey = previousResult.rows[0]?.address_cluster_key ?? null;
      await db.query(
        `UPDATE settlement_account_address_risk_sources
         SET active = FALSE,
             updated_at = $3
         WHERE account_id = $1
           AND shipping_address_id = $2`,
        [data.accountId, data.shippingAddressId, data.archivedAt],
      );
      await refreshSharedAddressClusters(db, data.accountId, data.archivedAt);
      await refreshAddressClusterAccounts(db, previousClusterKey, data.archivedAt);
    },
  };
}

export function buildSettlementReputationAccountRiskSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
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
        orderId: string;
        authorAccountId?: string;
        subjectAccountId: string;
        authorRole: string;
        rating: number;
        submittedAt: string;
      };
      await db.query(
        `INSERT INTO settlement_account_review_sources (
           review_id,
           order_id,
           subject_account_id,
           author_role,
           rating,
           status,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', $6)
         ON CONFLICT (review_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           subject_account_id = EXCLUDED.subject_account_id,
           author_role = EXCLUDED.author_role,
           rating = EXCLUDED.rating,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [data.reviewId, data.orderId, data.subjectAccountId, data.authorRole, data.rating, data.submittedAt],
      );
      await refreshAccountReviews(db, data.subjectAccountId, data.submittedAt);
      await upsertVelocitySource(db, {
        sourceKind: "review-received",
        sourceId: data.reviewId,
        accountId: data.subjectAccountId,
        occurredAt: data.submittedAt,
        reviewerAccountId: data.authorAccountId ?? null,
        updatedAt: event.timing.recordedAt,
      });
    },
    "marketplace.review.updated": async (event) => {
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
    "marketplace.review.withdrawn": async (event) => {
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
    "marketplace.review.revealed": async (event) => {
      const data = event.data as { reviewId: string; revealedAt: string };
      const result = await db.query<{ subject_account_id: string }>(
        `UPDATE settlement_account_review_sources
         SET revealed_at = $2
         WHERE review_id = $1
           AND revealed_at IS NULL
         RETURNING subject_account_id`,
        [data.reviewId, data.revealedAt],
      );
      const accountId = result.rows[0]?.subject_account_id;
      if (accountId) {
        await refreshAccountReviews(db, accountId, data.revealedAt);
      }
    },
  };
}

export function buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
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
    "payments.payment-fraud-warning-received": async (event) => {
      const data = event.data as { buyerAccountId: string; receivedAt: string };
      await db.query(
        `INSERT INTO settlement_account_risk_sources (
           account_id,
           stripe_fraud_flag,
           stripe_fraud_flagged_at,
           stripe_fraud_signal_count,
           updated_at
         ) VALUES ($1, TRUE, $2, 1, $2)
         ON CONFLICT (account_id) DO UPDATE SET
           stripe_fraud_flag = TRUE,
           stripe_fraud_flagged_at = COALESCE(
             settlement_account_risk_sources.stripe_fraud_flagged_at,
             EXCLUDED.stripe_fraud_flagged_at
           ),
           stripe_fraud_signal_count = settlement_account_risk_sources.stripe_fraud_signal_count + 1,
           updated_at = EXCLUDED.updated_at`,
        [data.buyerAccountId, data.receivedAt],
      );
    },
    "payments.payment-fraud-review-opened": async (event) => {
      const data = event.data as { buyerAccountId: string; openedAt: string };
      await db.query(
        `INSERT INTO settlement_account_risk_sources (
           account_id,
           stripe_fraud_flag,
           stripe_fraud_flagged_at,
           stripe_review_open_count,
           updated_at
         ) VALUES ($1, TRUE, $2, 1, $2)
         ON CONFLICT (account_id) DO UPDATE SET
           stripe_fraud_flag = TRUE,
           stripe_fraud_flagged_at = COALESCE(
             settlement_account_risk_sources.stripe_fraud_flagged_at,
             EXCLUDED.stripe_fraud_flagged_at
           ),
           stripe_review_open_count = settlement_account_risk_sources.stripe_review_open_count + 1,
           updated_at = EXCLUDED.updated_at`,
        [data.buyerAccountId, data.openedAt],
      );
    },
    "payments.payment-fraud-review-closed": async (event) => {
      const data = event.data as { buyerAccountId: string; outcome: string | null; closedAt: string };
      await db.query(
        `INSERT INTO settlement_account_risk_sources (
           account_id,
           stripe_fraud_flag,
           stripe_review_open_count,
           updated_at
         ) VALUES ($1, $2, 0, $3)
         ON CONFLICT (account_id) DO UPDATE SET
           stripe_fraud_flag = CASE
             WHEN $2 = FALSE AND settlement_account_risk_sources.stripe_fraud_signal_count = 0 THEN FALSE
             ELSE settlement_account_risk_sources.stripe_fraud_flag
           END,
           stripe_review_open_count = GREATEST(0, settlement_account_risk_sources.stripe_review_open_count - 1),
           updated_at = EXCLUDED.updated_at`,
        [data.buyerAccountId, data.outcome !== "approved", data.closedAt],
      );
    },
    "payments.checkout-affordances-published": async (event) => {
      const data = event.data as {
        accountId: string;
        savedCheckoutInstruments: readonly {
          instrumentId: string;
          instrumentRiskClusterKey: string | null;
          readiness: string;
        }[];
        publishedAt: string;
      };
      for (const instrument of data.savedCheckoutInstruments) {
        const previousResult = await db.query<{ instrument_cluster_key: string | null }>(
          `SELECT instrument_cluster_key
           FROM settlement_account_instrument_risk_sources
           WHERE account_id = $1
             AND instrument_id = $2`,
          [data.accountId, instrument.instrumentId],
        );
        const previousClusterKey = previousResult.rows[0]?.instrument_cluster_key ?? null;
        await db.query(
          `INSERT INTO settlement_account_instrument_risk_sources (
             account_id,
             instrument_id,
             instrument_cluster_key,
             active,
             updated_at
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (account_id, instrument_id) DO UPDATE SET
             instrument_cluster_key = EXCLUDED.instrument_cluster_key,
             active = EXCLUDED.active,
             updated_at = EXCLUDED.updated_at`,
          [
            data.accountId,
            instrument.instrumentId,
            instrument.instrumentRiskClusterKey,
            instrument.readiness !== "removed" && instrument.instrumentRiskClusterKey !== null,
            data.publishedAt,
          ],
        );
        await refreshInstrumentClusterAccounts(db, previousClusterKey, data.publishedAt);
        await refreshInstrumentClusterAccounts(db, instrument.instrumentRiskClusterKey, data.publishedAt);
      }
      await refreshSharedInstrumentClusters(db, data.accountId, data.publishedAt);
    },
  };
}
