import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import {
  normalizeMarketplaceReviewScoringFact,
  normalizeMarketplaceReviewSubmittedScoring,
} from "@chase-sets/event-core/review-scoring-facts";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  settlementFraudVelocityPolicy,
  type SettlementFraudVelocityPolicyValue,
} from "../../domain/fraud-velocity-policy";

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

/** Optional platform-policy dependency threaded through every builder in this file; absent falls back to the compiled launch default (see `resolveFraudVelocityPolicy`). */
export type AccountRiskSourcePolicyDeps = Readonly<{
  policies?: Pick<PolicyRuntime, "resolvePolicy">;
}>;

/**
 * Resolves the settlement fraud/velocity policy, failing SAFE to the
 * compiled launch default both when no `policies` runtime is wired
 * (standalone/test usage) and when resolution itself throws (policy store
 * unavailable) -- mirroring the rate-limit policy's posture
 * (`bounded-contexts/platform-operations/features/rate-limit-policy/api/rate-limit-policy-resolver.ts`):
 * an unavailable policy store must never disable fraud/velocity detection.
 */
async function resolveFraudVelocityPolicy(
  policies: Pick<PolicyRuntime, "resolvePolicy"> | undefined,
): Promise<SettlementFraudVelocityPolicyValue> {
  if (!policies) {
    return settlementFraudVelocityPolicy.defaultValue;
  }
  try {
    const resolved = await policies.resolvePolicy(settlementFraudVelocityPolicy);
    return resolved.value;
  } catch {
    return settlementFraudVelocityPolicy.defaultValue;
  }
}

function velocityFlagsSql(
  params: Readonly<{
    now: string;
    chargebackMinCount: string;
    chargebackMinRateBps: string;
    newSellerAgeDays: string;
    newSellerMinValueCents: string;
    reviewMinCount: string;
    reviewMaxMedianAgeDays: string;
    youngBuyerAgeDays: string;
    youngBuyerMinSpendCents: string;
  }>,
) {
  return `jsonb_strip_nulls(jsonb_build_object(
    'chargeback_velocity',
      CASE WHEN chargeback_30d_count >= ${params.chargebackMinCount}::integer
             OR chargeback_30d_rate_bps >= ${params.chargebackMinRateBps}::integer THEN jsonb_build_object(
        'manualPayoutReviewCandidate', TRUE,
        'chargeback30dCount', chargeback_30d_count,
        'chargeback30dRateBps', chargeback_30d_rate_bps
      ) END,
    'new_seller_listing_velocity',
      CASE WHEN account_created_at IS NOT NULL
             AND ${params.now}::timestamptz - account_created_at < (${params.newSellerAgeDays}::text || ' days')::interval
             AND listing_24h_value_cents >= ${params.newSellerMinValueCents}::bigint THEN jsonb_build_object(
        'listing24hCount', listing_24h_count,
        'listing24hValueCents', listing_24h_value_cents
      ) END,
    'review_velocity',
      CASE WHEN review_24h_count >= ${params.reviewMinCount}::integer
             AND review_24h_median_reviewer_age_days IS NOT NULL
             AND review_24h_median_reviewer_age_days < ${params.reviewMaxMedianAgeDays}::numeric THEN jsonb_build_object(
        'review24hCount', review_24h_count,
        'medianReviewerAgeDays', review_24h_median_reviewer_age_days
      ) END,
    'young_buyer_spend_velocity',
      CASE WHEN account_created_at IS NOT NULL
             AND ${params.now}::timestamptz - account_created_at < (${params.youngBuyerAgeDays}::text || ' days')::interval
             AND buyer_spend_24h_cents >= ${params.youngBuyerMinSpendCents}::bigint THEN jsonb_build_object(
        'buyerOrder24hCount', buyer_order_24h_count,
        'buyerSpend24hCents', buyer_spend_24h_cents
      ) END
  ))`;
}

async function refreshVelocityCounters(
  db: PgQueryable,
  accountId: string,
  now: string,
  policies: Pick<PolicyRuntime, "resolvePolicy"> | undefined,
) {
  const policy = await resolveFraudVelocityPolicy(policies);
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
             AND occurred_at >= $2::timestamptz - ($3::text || ' days')::interval
         )::integer AS chargeback_7d_count,
         COUNT(*) FILTER (
           WHERE source_kind = 'chargeback-received'
             AND occurred_at >= $2::timestamptz - ($4::text || ' days')::interval
         )::integer AS chargeback_30d_count,
         COUNT(*) FILTER (
           WHERE source_kind = 'seller-payment-created'
             AND occurred_at >= $2::timestamptz - ($4::text || ' days')::interval
         )::integer AS seller_payment_30d_count,
         COUNT(*) FILTER (
           WHERE source_kind = 'listing-created'
             AND occurred_at >= $2::timestamptz - ($5::text || ' hours')::interval
         )::integer AS listing_24h_count,
         COALESCE(SUM(amount_cents) FILTER (
           WHERE source_kind = 'listing-created'
             AND occurred_at >= $2::timestamptz - ($5::text || ' hours')::interval
         ), 0)::bigint AS listing_24h_value_cents,
         COUNT(*) FILTER (
           WHERE source_kind = 'review-received'
             AND occurred_at >= $2::timestamptz - ($6::text || ' hours')::interval
         )::integer AS review_24h_count,
         ROUND((
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (occurred_at - reviewer_account_created_at)) / 86400
           ) FILTER (
             WHERE source_kind = 'review-received'
               AND occurred_at >= $2::timestamptz - ($6::text || ' hours')::interval
               AND reviewer_account_created_at IS NOT NULL
           )
         )::numeric, 2) AS review_24h_median_reviewer_age_days,
         COUNT(*) FILTER (
           WHERE source_kind = 'buyer-payment-created'
             AND occurred_at >= $2::timestamptz - ($7::text || ' hours')::interval
         )::integer AS buyer_order_24h_count,
         COALESCE(SUM(amount_cents) FILTER (
           WHERE source_kind = 'buyer-payment-created'
             AND occurred_at >= $2::timestamptz - ($7::text || ' hours')::interval
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
       ${velocityFlagsSql({
         now: "$2",
         chargebackMinCount: "$8",
         chargebackMinRateBps: "$9",
         newSellerAgeDays: "$10",
         newSellerMinValueCents: "$11",
         reviewMinCount: "$12",
         reviewMaxMedianAgeDays: "$13",
         youngBuyerAgeDays: "$14",
         youngBuyerMinSpendCents: "$15",
       })},
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
    [
      accountId,
      now,
      policy.chargebackReportingWindowDays,
      policy.chargebackVelocity.lookbackDays,
      policy.newSellerListingVelocity.windowHours,
      policy.reviewVelocity.windowHours,
      policy.youngBuyerSpendVelocity.windowHours,
      policy.chargebackVelocity.minCount,
      policy.chargebackVelocity.minRateBps,
      policy.newSellerListingVelocity.newAccountAgeDays,
      policy.newSellerListingVelocity.minValueCents,
      policy.reviewVelocity.minCount,
      policy.reviewVelocity.maxMedianReviewerAgeDays,
      policy.youngBuyerSpendVelocity.newAccountAgeDays,
      policy.youngBuyerSpendVelocity.minSpendCents,
    ],
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
  policies: Pick<PolicyRuntime, "resolvePolicy"> | undefined,
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
  await refreshVelocityCounters(db, params.accountId, params.updatedAt, policies);
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
       AND held = false
       AND scoring_disposition = 'included'
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

export function buildSettlementIdentityAccountRiskSourceProjectionHandlers(
  db: PgQueryable,
  deps: AccountRiskSourcePolicyDeps = {},
): ProjectorHandlerMap {
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
        await refreshVelocityCounters(db, row.account_id, event.timing.recordedAt, deps.policies);
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

export function buildSettlementReputationAccountRiskSourceProjectionHandlers(
  db: PgQueryable,
  deps: AccountRiskSourcePolicyDeps = {},
): ProjectorHandlerMap {
  return {
    "marketplace.listing.created": async (event) => {
      const data = event.data as { listingId: string; accountId: string; priceAmount: string };
      await upsertVelocitySource(
        db,
        {
          sourceKind: "listing-created",
          sourceId: data.listingId,
          accountId: data.accountId,
          occurredAt: event.timing.occurredAt ?? event.timing.recordedAt,
          amountCents: moneyToCents(data.priceAmount),
          updatedAt: event.timing.recordedAt,
        },
        deps.policies,
      );
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
      const scoring = normalizeMarketplaceReviewSubmittedScoring(event.data);
      await db.query(
        `INSERT INTO settlement_account_review_sources (
           review_id,
           order_id,
           subject_account_id,
           author_role,
           rating,
           status,
           updated_at,
           scoring_disposition,
           scoring_reason_code,
           scoring_policy_version,
           scoring_source_fact_versions,
           scoring_operational_signal
         ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10::jsonb, $11)
         ON CONFLICT (review_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           subject_account_id = EXCLUDED.subject_account_id,
           author_role = EXCLUDED.author_role,
           rating = EXCLUDED.rating,
           status = EXCLUDED.status,
           scoring_disposition = EXCLUDED.scoring_disposition,
           scoring_reason_code = EXCLUDED.scoring_reason_code,
           scoring_policy_version = EXCLUDED.scoring_policy_version,
           scoring_source_fact_versions = EXCLUDED.scoring_source_fact_versions,
           scoring_operational_signal = EXCLUDED.scoring_operational_signal,
           updated_at = EXCLUDED.updated_at`,
        [
          data.reviewId,
          data.orderId,
          data.subjectAccountId,
          data.authorRole,
          data.rating,
          data.submittedAt,
          scoring.scoringDisposition,
          scoring.reasonCode,
          scoring.policyVersion,
          JSON.stringify(scoring.sourceFactVersions),
          scoring.operationalSignal,
        ],
      );
      await refreshAccountReviews(db, data.subjectAccountId, data.submittedAt);
      await upsertVelocitySource(
        db,
        {
          sourceKind: "review-received",
          sourceId: data.reviewId,
          accountId: data.subjectAccountId,
          occurredAt: data.submittedAt,
          reviewerAccountId: data.authorAccountId ?? null,
          updatedAt: event.timing.recordedAt,
        },
        deps.policies,
      );
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
    "marketplace.review-scoring.disposition-projected.v1": async (event) => {
      const fact = normalizeMarketplaceReviewScoringFact(event.data);
      const affected = await db.query<{ subject_account_id: string }>(
        `UPDATE settlement_account_review_sources
         SET scoring_disposition = CASE WHEN author_role = 'buyer' THEN $2 ELSE $4 END,
             scoring_reason_code = CASE WHEN author_role = 'buyer' THEN $3 ELSE $5 END,
             scoring_policy_version = $6,
             scoring_source_fact_versions = $7::jsonb,
             scoring_operational_signal = $8,
             last_scoring_stream_version = $9,
             updated_at = GREATEST(updated_at, $10::timestamptz)
         WHERE order_id = $1
           AND last_scoring_stream_version <= $9
         RETURNING subject_account_id`,
        [
          fact.orderId,
          fact.buyerToSeller.scoringDisposition,
          fact.buyerToSeller.reasonCode,
          fact.sellerToBuyer.scoringDisposition,
          fact.sellerToBuyer.reasonCode,
          fact.buyerToSeller.policyVersion,
          JSON.stringify(fact.buyerToSeller.sourceFactVersions),
          fact.buyerToSeller.operationalSignal ?? fact.sellerToBuyer.operationalSignal,
          event.streamVersion,
          fact.projectedAt,
        ],
      );
      for (const accountId of new Set(affected.rows.map((row) => row.subject_account_id))) {
        await refreshAccountReviews(db, accountId, fact.projectedAt);
      }
    },
    ...Object.fromEntries(
      [
        "marketplace.review-hold.placed",
        "marketplace.review-hold.extended",
        "marketplace.review-hold.reduced",
        "marketplace.review-hold.released",
        "marketplace.review-hold.terminal-recorded",
      ].map((eventType) => [
        eventType,
        async (event: Parameters<ProjectorHandlerMap[string]>[0]) => {
          const data = event.data as { orderId: string; heldDirections: readonly string[]; lifecycleAt: string };
          const affected = await db.query<{ subject_account_id: string }>(
            `UPDATE settlement_account_review_sources
             SET held = CASE WHEN author_role = 'buyer'
               THEN 'buyer-to-seller' = ANY($2::text[])
               ELSE 'seller-to-buyer' = ANY($2::text[])
             END,
                 updated_at = GREATEST(updated_at, $3::timestamptz)
             WHERE order_id = $1
             RETURNING subject_account_id`,
            [data.orderId, data.heldDirections, data.lifecycleAt],
          );
          for (const accountId of new Set(affected.rows.map((row) => row.subject_account_id))) {
            await refreshAccountReviews(db, accountId, data.lifecycleAt);
          }
        },
      ]),
    ),
  };
}

export function buildSettlementPaymentsAccountRiskSourceProjectionHandlers(
  db: PgQueryable,
  deps: AccountRiskSourcePolicyDeps = {},
): ProjectorHandlerMap {
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
      await upsertVelocitySource(
        db,
        {
          sourceKind: "buyer-payment-created",
          sourceId: data.paymentId,
          accountId: data.buyerAccountId,
          occurredAt,
          amountCents: moneyToCents(data.amount),
          updatedAt: event.timing.recordedAt,
        },
        deps.policies,
      );
      for (const payout of normalizeSellerPayouts(data.sellerPayouts)) {
        await upsertVelocitySource(
          db,
          {
            sourceKind: "seller-payment-created",
            sourceId: `${data.paymentId}:${payout.orderId}`,
            accountId: payout.sellerAccountId,
            occurredAt,
            updatedAt: event.timing.recordedAt,
          },
          deps.policies,
        );
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
        await upsertVelocitySource(
          db,
          {
            sourceKind: "chargeback-received",
            sourceId: `${data.providerDisputeId ?? data.paymentId}:${payout.orderId}`,
            accountId: payout.sellerAccountId,
            occurredAt,
            updatedAt: event.timing.recordedAt,
          },
          deps.policies,
        );
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
