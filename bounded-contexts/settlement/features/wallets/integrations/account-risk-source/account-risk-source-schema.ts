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
  review_count integer NOT NULL DEFAULT 0,
  average_rating numeric(4, 2) NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS stripe_fraud_flag boolean NOT NULL DEFAULT false;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS stripe_fraud_flagged_at timestamptz NULL;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS stripe_fraud_signal_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS stripe_review_open_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS settlement_account_review_sources (
  review_id text PRIMARY KEY,
  subject_account_id text NOT NULL,
  rating integer NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_account_review_sources_subject_idx
  ON settlement_account_review_sources (subject_account_id, status);
`;
