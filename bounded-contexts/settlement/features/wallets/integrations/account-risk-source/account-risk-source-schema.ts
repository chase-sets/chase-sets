export const settlementAccountRiskSourceSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_account_risk_sources (
  account_id text PRIMARY KEY,
  account_created_at timestamptz NULL,
  trusted_seller boolean NOT NULL DEFAULT false,
  manual_payout_review boolean NOT NULL DEFAULT false,
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
`;
