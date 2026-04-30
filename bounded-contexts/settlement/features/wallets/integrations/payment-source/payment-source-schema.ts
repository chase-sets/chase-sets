export const settlementPaymentSourceSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_payment_sources (
  payment_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount numeric(12,2) NOT NULL,
  balance_credit_amount numeric(12,2) NOT NULL DEFAULT 0,
  processor_amount numeric(12,2) NOT NULL DEFAULT 0,
  currency_code text NOT NULL,
  processor_name text NOT NULL,
  processor_payment_reference text NOT NULL,
  processor_status text NOT NULL,
  status text NOT NULL,
  failure_code text NULL,
  failure_message text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  captured_at timestamptz NULL,
  failed_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  last_stream_version integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_payment_sources_status_idx
  ON settlement_payment_sources (status, updated_at DESC, payment_id DESC);

ALTER TABLE settlement_payment_sources
  ADD COLUMN IF NOT EXISTS balance_credit_amount numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE settlement_payment_sources
  ADD COLUMN IF NOT EXISTS processor_amount numeric(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS settlement_refund_sources (
  refund_id text PRIMARY KEY,
  payment_id text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount numeric(12,2) NOT NULL,
  currency_code text NOT NULL,
  reason text NOT NULL,
  processor_name text NOT NULL,
  processor_status text NOT NULL,
  processor_refund_reference text NULL,
  status text NOT NULL,
  failure_code text NULL,
  failure_message text NULL,
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  issued_at timestamptz NULL,
  failed_at timestamptz NULL,
  last_stream_version integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_refund_sources_payment_idx
  ON settlement_refund_sources (payment_id, updated_at DESC, refund_id DESC);

CREATE INDEX IF NOT EXISTS settlement_refund_sources_status_idx
  ON settlement_refund_sources (status, updated_at DESC, refund_id DESC);
`;
