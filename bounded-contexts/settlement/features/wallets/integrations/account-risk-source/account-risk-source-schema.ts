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

CREATE TABLE IF NOT EXISTS settlement_account_review_sources (
  review_id text PRIMARY KEY,
  order_id text NOT NULL DEFAULT '',
  subject_account_id text NOT NULL,
  rating integer NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_account_review_sources_subject_idx
  ON settlement_account_review_sources (subject_account_id, status);

ALTER TABLE settlement_account_review_sources
  ADD COLUMN IF NOT EXISTS order_id text NOT NULL DEFAULT '';

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
`;

export const settlementAccountRiskSourceSchemaMigrations: readonly BcSchemaMigration[] = [
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
] as const;
