export const paymentsPaymentSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_payment_pages (
  payment_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount numeric(12, 2) NOT NULL,
  balance_credit_amount numeric(12, 2) NOT NULL DEFAULT 0,
  processor_amount numeric(12, 2) NOT NULL DEFAULT 0,
  marketplace_sales_fee_amount numeric(12, 2) NOT NULL,
  marketplace_checkout_fee_amount numeric(12, 2) NOT NULL,
  marketplace_checkout_fee_policy_version text NULL,
  marketplace_checkout_fee_quote_fingerprint text NULL,
  payment_method_category text NULL,
  saved_checkout_instrument_id text NULL,
  seller_net_amount numeric(12, 2) NOT NULL,
  seller_payout_amount numeric(12, 2) NOT NULL DEFAULT 0,
  seller_payouts jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  refunded_at timestamptz NULL,
  disputed_at timestamptz NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS payments_payment_pages_buyer_idx
  ON payments_payment_pages (buyer_account_id, updated_at DESC, payment_id DESC);

CREATE INDEX IF NOT EXISTS payments_payment_pages_processor_idx
  ON payments_payment_pages (processor_name, processor_payment_reference);

CREATE UNIQUE INDEX IF NOT EXISTS payments_payment_pages_source_idx
  ON payments_payment_pages (source_context, source_reference_id)
  WHERE source_context IS NOT NULL AND source_reference_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS payments_provider_operations (
  operation_key text PRIMARY KEY,
  provider_name text NOT NULL,
  operation_kind text NOT NULL,
  account_id text NULL,
  payment_id text NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_object_reference text NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS payments_provider_operations_status_idx
  ON payments_provider_operations (status, updated_at);

CREATE TABLE IF NOT EXISTS payments_provider_customers (
  account_id text NOT NULL,
  provider text NOT NULL,
  provider_customer_reference text NOT NULL,
  display_name text NULL,
  email text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider),
  UNIQUE (provider, provider_customer_reference)
);

CREATE TABLE IF NOT EXISTS payments_saved_checkout_instruments (
  instrument_id text PRIMARY KEY,
  account_id text NOT NULL,
  payment_method_category text NOT NULL CHECK (payment_method_category IN ('card', 'bank-account', 'platform-credit')),
  provider text NOT NULL,
  provider_customer_reference text NULL,
  provider_reference text NOT NULL,
  display_label text NOT NULL,
  confirmation_experience text NOT NULL CHECK (confirmation_experience IN ('trusted-payment-step', 'off-session-token')),
  readiness text NOT NULL CHECK (readiness IN ('ready', 'setup-required', 'removed')),
  allow_redisplay text NOT NULL DEFAULT 'unspecified',
  consent_id text NULL,
  consent_text text NULL,
  removed_at timestamptz NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_saved_checkout_instruments_account_idx
  ON payments_saved_checkout_instruments (account_id, is_default DESC, updated_at DESC, instrument_id);

CREATE UNIQUE INDEX IF NOT EXISTS payments_saved_checkout_instruments_provider_ref_idx
  ON payments_saved_checkout_instruments (provider, provider_reference);

CREATE TABLE IF NOT EXISTS payments_saved_checkout_instrument_audit (
  audit_id text PRIMARY KEY,
  instrument_id text NOT NULL,
  account_id text NOT NULL,
  action text NOT NULL,
  reason text NULL,
  performed_by_account_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_saved_checkout_instrument_audit_account_idx
  ON payments_saved_checkout_instrument_audit (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payments_saved_checkout_setup_sessions (
  setup_reference_id text PRIMARY KEY,
  account_id text NOT NULL,
  provider text NOT NULL,
  provider_customer_reference text NOT NULL,
  processor_setup_reference text NOT NULL UNIQUE,
  processor_client_secret text NULL,
  processor_redirect_url text NULL,
  processor_status text NOT NULL,
  consent_id text NOT NULL,
  consent_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS payments_saved_checkout_setup_sessions_account_idx
  ON payments_saved_checkout_setup_sessions (account_id, updated_at DESC);

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
