export const paymentsPaymentSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_payment_pages (
  payment_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount numeric(12, 2) NOT NULL,
  balance_credit_amount numeric(12, 2) NOT NULL DEFAULT 0,
  processor_amount numeric(12, 2) NOT NULL DEFAULT 0,
  marketplace_fee_amount numeric(12, 2) NOT NULL,
  payment_fee_amount numeric(12, 2) NOT NULL,
  seller_net_amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  processor_name text NOT NULL,
  processor_payment_kind text NOT NULL DEFAULT 'payment-intent',
  processor_payment_reference text NOT NULL UNIQUE,
  processor_client_secret text NULL,
  processor_redirect_url text NULL,
  processor_status text NOT NULL,
  source_context text NULL,
  source_reference_id text NULL,
  status text NOT NULL,
  failure_code text NULL,
  failure_message text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  captured_at timestamptz NULL,
  failed_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS payments_payment_pages_buyer_idx
  ON payments_payment_pages (buyer_account_id, updated_at DESC, payment_id DESC);

CREATE INDEX IF NOT EXISTS payments_payment_pages_processor_idx
  ON payments_payment_pages (processor_name, processor_payment_reference);

CREATE UNIQUE INDEX IF NOT EXISTS payments_payment_pages_source_idx
  ON payments_payment_pages (source_context, source_reference_id)
  WHERE source_context IS NOT NULL AND source_reference_id IS NOT NULL;

ALTER TABLE payments_payment_pages
  ADD COLUMN IF NOT EXISTS balance_credit_amount numeric(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE payments_payment_pages
  ADD COLUMN IF NOT EXISTS processor_amount numeric(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE payments_payment_pages
  ADD COLUMN IF NOT EXISTS processor_payment_kind text NOT NULL DEFAULT 'payment-intent';

ALTER TABLE payments_payment_pages
  ADD COLUMN IF NOT EXISTS processor_redirect_url text NULL;

CREATE TABLE IF NOT EXISTS payments_provider_idempotency_keys (
  operation_key text PRIMARY KEY,
  provider_name text NOT NULL,
  operation_kind text NOT NULL,
  account_id text NULL,
  provider_object_reference text NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_provider_idempotency_keys_account_idx
  ON payments_provider_idempotency_keys (account_id, created_at DESC)
  WHERE account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payments_reconciliation_runs (
  reconciliation_run_id text PRIMARY KEY,
  kind text NOT NULL,
  checked_count integer NOT NULL,
  attention_count integer NOT NULL,
  status text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_reconciliation_runs_completed_idx
  ON payments_reconciliation_runs (completed_at DESC);

CREATE TABLE IF NOT EXISTS payments_provider_webhook_events (
  provider_event_id text PRIMARY KEY,
  provider_name text NOT NULL,
  event_kind text NOT NULL,
  provider_object_reference text NULL,
  received_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_provider_webhook_events_received_idx
  ON payments_provider_webhook_events (received_at DESC);
`;
