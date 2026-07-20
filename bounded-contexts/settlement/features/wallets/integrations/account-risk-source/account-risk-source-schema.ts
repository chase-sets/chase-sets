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
  chargeback_7d_count integer NOT NULL DEFAULT 0,
  chargeback_30d_count integer NOT NULL DEFAULT 0,
  chargeback_30d_rate_bps integer NOT NULL DEFAULT 0,
  listing_24h_count integer NOT NULL DEFAULT 0,
  listing_24h_value_cents bigint NOT NULL DEFAULT 0,
  review_24h_count integer NOT NULL DEFAULT 0,
  review_24h_median_reviewer_age_days numeric(10, 2) NULL,
  buyer_order_24h_count integer NOT NULL DEFAULT 0,
  buyer_spend_24h_cents bigint NOT NULL DEFAULT 0,
  velocity_alert_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_count integer NOT NULL DEFAULT 0,
  average_rating numeric(4, 2) NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS chargeback_7d_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS chargeback_30d_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS chargeback_30d_rate_bps integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS listing_24h_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS listing_24h_value_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS review_24h_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS review_24h_median_reviewer_age_days numeric(10, 2) NULL;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS buyer_order_24h_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS buyer_spend_24h_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS velocity_alert_flags jsonb NOT NULL DEFAULT '[]'::jsonb;

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

-- Durable keyset cursor for the scheduled aggregate-driving closer. It is
-- operational progress only; the Account Linkage event streams remain the
-- publication source of truth.
CREATE TABLE IF NOT EXISTS settlement_account_linkage_closer_cursors (
  closer_name text PRIMARY KEY,
  after_signal_kind text NOT NULL,
  after_cluster_key text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS settlement_account_velocity_sources (
  source_kind text NOT NULL,
  source_id text NOT NULL,
  account_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  amount_cents bigint NOT NULL DEFAULT 0,
  reviewer_account_id text NULL,
  reviewer_account_created_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (source_kind, source_id, account_id)
);

CREATE INDEX IF NOT EXISTS settlement_account_velocity_sources_account_window_idx
  ON settlement_account_velocity_sources (account_id, source_kind, occurred_at DESC);

CREATE INDEX IF NOT EXISTS settlement_account_velocity_sources_reviewer_idx
  ON settlement_account_velocity_sources (reviewer_account_id)
  WHERE reviewer_account_id IS NOT NULL;
`;

export const settlementAccountRiskSourceSchemaMigrations: readonly BcSchemaMigration[] = [
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
    migrationId: "20260707_settlement_account_velocity_risk_sources",
    description: "Track account velocity counters as Settlement account risk sources.",
    statements: [
      `CREATE TABLE IF NOT EXISTS settlement_account_velocity_sources (
  source_kind text NOT NULL,
  source_id text NOT NULL,
  account_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  amount_cents bigint NOT NULL DEFAULT 0,
  reviewer_account_id text NULL,
  reviewer_account_created_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (source_kind, source_id, account_id)
)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_account_velocity_sources_account_window_idx
  ON settlement_account_velocity_sources (account_id, source_kind, occurred_at DESC)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_account_velocity_sources_reviewer_idx
  ON settlement_account_velocity_sources (reviewer_account_id)
  WHERE reviewer_account_id IS NOT NULL`,
      `SET lock_timeout = '2s'`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS chargeback_7d_count integer NULL`,
      `UPDATE settlement_account_risk_sources SET chargeback_7d_count = 0 WHERE chargeback_7d_count IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN chargeback_7d_count SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN chargeback_7d_count SET NOT NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS chargeback_30d_count integer NULL`,
      `UPDATE settlement_account_risk_sources SET chargeback_30d_count = 0 WHERE chargeback_30d_count IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN chargeback_30d_count SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN chargeback_30d_count SET NOT NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS chargeback_30d_rate_bps integer NULL`,
      `UPDATE settlement_account_risk_sources SET chargeback_30d_rate_bps = 0 WHERE chargeback_30d_rate_bps IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN chargeback_30d_rate_bps SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN chargeback_30d_rate_bps SET NOT NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS listing_24h_count integer NULL`,
      `UPDATE settlement_account_risk_sources SET listing_24h_count = 0 WHERE listing_24h_count IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN listing_24h_count SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN listing_24h_count SET NOT NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS listing_24h_value_cents bigint NULL`,
      `UPDATE settlement_account_risk_sources SET listing_24h_value_cents = 0 WHERE listing_24h_value_cents IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN listing_24h_value_cents SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN listing_24h_value_cents SET NOT NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS review_24h_count integer NULL`,
      `UPDATE settlement_account_risk_sources SET review_24h_count = 0 WHERE review_24h_count IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN review_24h_count SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN review_24h_count SET NOT NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS review_24h_median_reviewer_age_days numeric(10, 2) NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS buyer_order_24h_count integer NULL`,
      `UPDATE settlement_account_risk_sources SET buyer_order_24h_count = 0 WHERE buyer_order_24h_count IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN buyer_order_24h_count SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN buyer_order_24h_count SET NOT NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS buyer_spend_24h_cents bigint NULL`,
      `UPDATE settlement_account_risk_sources SET buyer_spend_24h_cents = 0 WHERE buyer_spend_24h_cents IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN buyer_spend_24h_cents SET DEFAULT 0`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN buyer_spend_24h_cents SET NOT NULL`,
      `ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS velocity_alert_flags jsonb NULL`,
      `UPDATE settlement_account_risk_sources SET velocity_alert_flags = '[]'::jsonb WHERE velocity_alert_flags IS NULL`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN velocity_alert_flags SET DEFAULT '[]'::jsonb`,
      `ALTER TABLE settlement_account_risk_sources ALTER COLUMN velocity_alert_flags SET NOT NULL`,
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
] as const;
