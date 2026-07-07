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
    "marketplace.review.submitted": async (event) => {
      const data = event.data as {
        reviewId: string;
        orderId: string;
        subjectAccountId: string;
        rating: number;
        submittedAt: string;
      };
      await db.query(
        `INSERT INTO settlement_account_review_sources (
           review_id,
           order_id,
           subject_account_id,
           rating,
           status,
           updated_at
         ) VALUES ($1, $2, $3, $4, 'active', $5)
         ON CONFLICT (review_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           subject_account_id = EXCLUDED.subject_account_id,
           rating = EXCLUDED.rating,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [data.reviewId, data.orderId, data.subjectAccountId, data.rating, data.submittedAt],
      );
      await refreshAccountReviews(db, data.subjectAccountId, data.submittedAt);
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
  };
}

export function buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
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
