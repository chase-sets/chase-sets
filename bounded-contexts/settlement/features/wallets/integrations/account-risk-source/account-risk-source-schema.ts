import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const settlementAccountRiskSourceSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_account_risk_sources (
  account_id text PRIMARY KEY,
  account_created_at timestamptz NULL,
  trusted_seller boolean NOT NULL DEFAULT false,
  manual_payout_review boolean NOT NULL DEFAULT false,
  stripe_fraud_flag boolean NOT NULL DEFAULT false,
  stripe_fraud_flagged_at timestamptz NULL,
  stripe_fraud_signal_count integer NOT NULL DEFAULT 0,
  stripe_review_open_count integer NOT NULL DEFAULT 0,
  shared_instrument_cluster_count integer NOT NULL DEFAULT 0,
  shared_address_cluster_count integer NOT NULL DEFAULT 0,
  review_count integer NOT NULL DEFAULT 0,
  average_rating numeric(4, 2) NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- author_role records the review AUTHOR's role (m108): the SUBJECT played the
-- opposite role, so payout-risk inputs must filter WHERE author_role = 'buyer'
-- to isolate reviews earned AS A SELLER. Buyer-role reputation (being a
-- pleasant buyer) is not evidence a seller ships cards and must never move
-- review_count/average_rating on settlement_account_risk_sources.
CREATE TABLE IF NOT EXISTS settlement_account_review_sources (
  review_id text PRIMARY KEY,
  order_id text NOT NULL DEFAULT '',
  subject_account_id text NOT NULL,
  author_role text NOT NULL DEFAULT '',
  rating integer NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL,
  held boolean NOT NULL DEFAULT false,
  scoring_disposition text NOT NULL DEFAULT 'included',
  scoring_reason_code text NOT NULL DEFAULT 'normal-completion',
  scoring_policy_version text NOT NULL DEFAULT 'resolution-aware-v1',
  scoring_source_fact_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  scoring_operational_signal text NULL,
  last_scoring_stream_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_account_review_sources_subject_idx
  ON settlement_account_review_sources (subject_account_id, status);

ALTER TABLE settlement_account_review_sources
  ADD COLUMN IF NOT EXISTS order_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS author_role text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scoring_disposition text NOT NULL DEFAULT 'included',
  ADD COLUMN IF NOT EXISTS scoring_reason_code text NOT NULL DEFAULT 'normal-completion',
  ADD COLUMN IF NOT EXISTS scoring_policy_version text NOT NULL DEFAULT 'resolution-aware-v1',
  ADD COLUMN IF NOT EXISTS scoring_source_fact_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scoring_operational_signal text NULL,
  ADD COLUMN IF NOT EXISTS last_scoring_stream_version bigint NOT NULL DEFAULT 0;

-- Double-blind reveal (m108): a review contributes to the payout-risk
-- review_count/average_rating inputs only once revealed_at is set. A hidden
-- (unrevealed) review must never move payout risk or the clearance tier.
ALTER TABLE settlement_account_review_sources
  ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS settlement_order_trust_signal_sources (
  order_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  trust_signal_eligible boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_order_trust_signal_sources_seller_idx
  ON settlement_order_trust_signal_sources (seller_account_id, trust_signal_eligible);

CREATE TABLE IF NOT EXISTS settlement_account_instrument_risk_sources (
  account_id text NOT NULL,
  instrument_id text NOT NULL,
  instrument_cluster_key text NULL,
  active boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, instrument_id)
);

CREATE TABLE IF NOT EXISTS settlement_account_address_risk_sources (
  account_id text NOT NULL,
  shipping_address_id text NOT NULL,
  address_cluster_key text NULL,
  active boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, shipping_address_id)
);

-- Settlement-owned opaque cluster identifiers and durable publication state.
-- Private source keys never cross the context boundary; consumers receive only
-- the random cluster_hash assigned here.
CREATE TABLE IF NOT EXISTS settlement_account_linkage_clusters (
  signal_kind text NOT NULL,
  cluster_key text NOT NULL,
  cluster_hash text NOT NULL UNIQUE CHECK (cluster_hash ~ '^[a-f0-9]{64}$'),
  flagged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (signal_kind, cluster_key)
);

-- Durable keyset cursor for the scheduled aggregate-driving closer. It is
-- operational progress only; the Account Linkage event streams remain the
-- publication source of truth.
CREATE TABLE IF NOT EXISTS settlement_account_linkage_closer_cursors (
  closer_name text PRIMARY KEY,
  after_signal_kind text NOT NULL,
  after_cluster_key text NOT NULL,
  updated_at timestamptz NOT NULL
);
`;

export const settlementPayoutReviewHoldFallbackGuardMigrationId =
  "20261120_settlement_payout_review_hold_fallback_guard";

export const settlementAccountRiskSourceSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260720_settlement_account_linkage_clusters",
    description: "Map private risk clusters to opaque identifiers and track their publication lifecycle.",
    statements: [
      `CREATE TABLE IF NOT EXISTS settlement_account_linkage_clusters (
  signal_kind text NOT NULL,
  cluster_key text NOT NULL,
  cluster_hash text NOT NULL UNIQUE CHECK (cluster_hash ~ '^[a-f0-9]{64}$'),
  flagged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (signal_kind, cluster_key)
)`,
    ],
  },
  {
    migrationId: "20260720_settlement_account_linkage_closer_cursor",
    description: "Persist bounded Account Linkage closer progress across scheduled passes.",
    statements: [
      `CREATE TABLE IF NOT EXISTS settlement_account_linkage_closer_cursors (
  closer_name text PRIMARY KEY,
  after_signal_kind text NOT NULL,
  after_cluster_key text NOT NULL,
  updated_at timestamptz NOT NULL
)`,
    ],
  },
  {
    migrationId: "20260715_settlement_review_scoring_disposition",
    description: "Persist canonical scoring disposition for seller reputation risk inputs.",
    statements: [
      `SET lock_timeout = '5s'`,
      `ALTER TABLE settlement_account_review_sources
  ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scoring_disposition text NOT NULL DEFAULT 'included',
  ADD COLUMN IF NOT EXISTS scoring_reason_code text NOT NULL DEFAULT 'normal-completion',
  ADD COLUMN IF NOT EXISTS scoring_policy_version text NOT NULL DEFAULT 'resolution-aware-v1',
  ADD COLUMN IF NOT EXISTS scoring_source_fact_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scoring_operational_signal text NULL,
  ADD COLUMN IF NOT EXISTS last_scoring_stream_version bigint NOT NULL DEFAULT 0`,
    ],
  },
  {
    migrationId: "20260706_settlement_payments_fraud_risk_sources",
    description: "Track processor fraud signals as Settlement account risk sources.",
    statements: [
      `SET lock_timeout = '2s'`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS stripe_fraud_flag boolean NULL`,
      `UPDATE settlement_account_risk_sources SET stripe_fraud_flag = false WHERE stripe_fraud_flag IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN stripe_fraud_flag SET DEFAULT false`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN stripe_fraud_flag SET NOT NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS stripe_fraud_flagged_at timestamptz NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS stripe_fraud_signal_count integer NULL`,
      `UPDATE settlement_account_risk_sources SET stripe_fraud_signal_count = 0 WHERE stripe_fraud_signal_count IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN stripe_fraud_signal_count SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN stripe_fraud_signal_count SET NOT NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS stripe_review_open_count integer NULL`,
      `UPDATE settlement_account_risk_sources SET stripe_review_open_count = 0 WHERE stripe_review_open_count IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN stripe_review_open_count SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN stripe_review_open_count SET NOT NULL`,
    ],
  },
  {
    migrationId: "20260707_settlement_linked_account_risk_sources",
    description: "Track shared payment instrument and shipping address clusters as Settlement account risk sources.",
    statements: [
      `CREATE TABLE IF NOT EXISTS settlement_account_instrument_risk_sources (
  account_id text NOT NULL,
  instrument_id text NOT NULL,
  instrument_cluster_key text NULL,
  active boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, instrument_id)
)`,
      `CREATE TABLE IF NOT EXISTS settlement_account_address_risk_sources (
  account_id text NOT NULL,
  shipping_address_id text NOT NULL,
  address_cluster_key text NULL,
  active boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, shipping_address_id)
)`,
      `SET lock_timeout = '2s'`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS shared_instrument_cluster_count integer NULL`,
      `UPDATE settlement_account_risk_sources SET shared_instrument_cluster_count = 0 WHERE shared_instrument_cluster_count IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN shared_instrument_cluster_count SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN shared_instrument_cluster_count SET NOT NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS shared_address_cluster_count integer NULL`,
      `UPDATE settlement_account_risk_sources SET shared_address_cluster_count = 0 WHERE shared_address_cluster_count IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN shared_address_cluster_count SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN shared_address_cluster_count SET NOT NULL`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_account_instrument_risk_sources_cluster_idx
  ON settlement_account_instrument_risk_sources (instrument_cluster_key, account_id)
  WHERE active = TRUE AND instrument_cluster_key IS NOT NULL`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_account_address_risk_sources_cluster_idx
  ON settlement_account_address_risk_sources (address_cluster_key, account_id)
  WHERE active = TRUE AND address_cluster_key IS NOT NULL`,
    ],
  },
  {
    migrationId: "20260711_settlement_account_review_sources_reveal",
    description:
      "Add the revealed_at gate to settlement_account_review_sources and mark every existing (pre-launch) row revealed (m108).",
    statements: [
      `SET lock_timeout = '5s'`,
      `ALTER TABLE settlement_account_review_sources ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL`,
      `UPDATE settlement_account_review_sources
   SET revealed_at = updated_at
   WHERE status = 'active'
     AND revealed_at IS NULL`,
    ],
  },
  {
    migrationId: "20261104_settlement_account_risk_source_revision",
    description:
      "Introduce the publication revision after immutable legacy normalization; existing rows start at zero.",
    statements: [
      `ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0`,
    ],
  },
  {
    migrationId: "20261120_settlement_payout_review_hold",
    description: "Persist Settlement payout review hold projection state and stream version.",
    statements: [
      `ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS payout_review_hold boolean NOT NULL DEFAULT false`,
      `ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS payout_review_hold_stream_version bigint NOT NULL DEFAULT 0`,
    ],
  },
  {
    migrationId: settlementPayoutReviewHoldFallbackGuardMigrationId,
    description:
      "Refuse to retire the payout review badge fallback until every badged account has projected a hold decision.",
    statements: [
      `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'settlement_account_risk_sources'
      AND column_name = 'manual_payout_review'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM settlement_account_risk_sources
      WHERE manual_payout_review AND payout_review_hold_stream_version = 0
    ) THEN
      RAISE EXCEPTION 'Payout review hold fallback cannot be retired: unmigrated manual payout review badges remain. Drain the hold migration or place or release the affected holds, then redeploy.';
    END IF;
  END IF;
END;
$$`,
    ],
  },
  {
    migrationId: "20261123_settlement_drop_account_velocity_storage",
    description: "Drop the account velocity source table and counters that Settlement no longer reads or writes.",
    statements: [
      `SET lock_timeout = '5s'`,
      `DROP TABLE IF EXISTS settlement_account_velocity_sources`,
      `ALTER TABLE settlement_account_risk_sources
  DROP COLUMN IF EXISTS chargeback_7d_count,
  DROP COLUMN IF EXISTS chargeback_30d_count,
  DROP COLUMN IF EXISTS chargeback_30d_rate_bps,
  DROP COLUMN IF EXISTS listing_24h_count,
  DROP COLUMN IF EXISTS listing_24h_value_cents,
  DROP COLUMN IF EXISTS review_24h_count,
  DROP COLUMN IF EXISTS review_24h_median_reviewer_age_days,
  DROP COLUMN IF EXISTS buyer_order_24h_count,
  DROP COLUMN IF EXISTS buyer_spend_24h_cents,
  DROP COLUMN IF EXISTS velocity_alert_flags`,
    ],
  },
] as const;
