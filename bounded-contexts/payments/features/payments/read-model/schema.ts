export const paymentsPaymentSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_payment_pages (
  payment_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  order_refund_caps jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  three_d_secure_request text NULL,
  three_d_secure_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  liability_shift_status text NULL,
  liability_shift_authentication_result text NULL,
  liability_shift_radar_risk_level text NULL,
  liability_shift_recorded_at timestamptz NULL,
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
  refunded_amount numeric(12, 2) NOT NULL DEFAULT 0,
  order_refunded_amounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  disputed_at timestamptz NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments_payment_orders (
  payment_id text NOT NULL REFERENCES payments_payment_pages (payment_id) ON DELETE CASCADE,
  order_id text NOT NULL,
  PRIMARY KEY (payment_id, order_id)
);

CREATE TABLE IF NOT EXISTS payments_payment_creation_reservations (
  payment_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  order_set_key text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_context text NULL,
  source_reference_id text NULL,
  status text NOT NULL CHECK (status IN ('active', 'failed', 'released')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_payment_pages_buyer_idx
  ON payments_payment_pages (buyer_account_id, updated_at DESC, payment_id DESC);

CREATE INDEX IF NOT EXISTS payments_payment_pages_processor_idx
  ON payments_payment_pages (processor_name, processor_payment_reference);

CREATE UNIQUE INDEX IF NOT EXISTS payments_payment_pages_source_idx
  ON payments_payment_pages (source_context, source_reference_id)
  WHERE source_context IS NOT NULL AND source_reference_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_payment_creation_reservations_source_active_idx
  ON payments_payment_creation_reservations (source_context, source_reference_id)
  WHERE status = 'active' AND source_context IS NOT NULL AND source_reference_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_payment_creation_reservations_order_set_active_idx
  ON payments_payment_creation_reservations (buyer_account_id, order_set_key)
  WHERE status = 'active';

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
  agent_grant_id text NULL,
  payment_method_category text NOT NULL CHECK (payment_method_category IN ('card', 'bank-account', 'platform-credit')),
  provider text NOT NULL,
  provider_customer_reference text NULL,
  provider_reference text NOT NULL,
  provider_fingerprint text NULL,
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

CREATE INDEX IF NOT EXISTS payments_saved_checkout_instruments_agent_grant_idx
  ON payments_saved_checkout_instruments (account_id, agent_grant_id, readiness, updated_at DESC, instrument_id)
  WHERE agent_grant_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS payments_revoked_agent_grants (
  account_id text NOT NULL,
  agent_grant_id text NOT NULL,
  revoked_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, agent_grant_id)
);

CREATE TABLE IF NOT EXISTS payments_saved_checkout_setup_sessions (
  setup_reference_id text PRIMARY KEY,
  account_id text NOT NULL,
  agent_grant_id text NULL,
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

CREATE TABLE IF NOT EXISTS payments_account_risk_sources (
  account_id text PRIMARY KEY,
  manual_payout_review boolean NOT NULL DEFAULT false,
  stripe_fraud_flag boolean NOT NULL DEFAULT false,
  stripe_fraud_flagged_at timestamptz NULL,
  stripe_fraud_signal_count integer NOT NULL DEFAULT 0,
  stripe_review_open_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const paymentsPaymentSchemaMigrations = [
  {
    migrationId: "20260703_payments_payment_pages_checkout_columns",
    description: "Add checkout handoff, payout, refund, and dispute columns to existing payment page read models.",
    statements: [
      `SET lock_timeout = '5s'`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS balance_credit_amount numeric(12, 2) NULL`,
      `UPDATE payments_payment_pages SET balance_credit_amount = 0 WHERE balance_credit_amount IS NULL`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN balance_credit_amount SET DEFAULT 0`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN balance_credit_amount SET NOT NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS processor_amount numeric(12, 2) NULL`,
      `UPDATE payments_payment_pages SET processor_amount = 0 WHERE processor_amount IS NULL`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN processor_amount SET DEFAULT 0`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN processor_amount SET NOT NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS marketplace_checkout_fee_amount numeric(12, 2) NULL`,
      `UPDATE payments_payment_pages SET marketplace_checkout_fee_amount = 0 WHERE marketplace_checkout_fee_amount IS NULL`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN marketplace_checkout_fee_amount SET DEFAULT 0`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN marketplace_checkout_fee_amount SET NOT NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS marketplace_checkout_fee_policy_version text NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS marketplace_checkout_fee_quote_fingerprint text NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS payment_method_category text NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS saved_checkout_instrument_id text NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS seller_payout_amount numeric(12, 2) NULL`,
      `UPDATE payments_payment_pages SET seller_payout_amount = 0 WHERE seller_payout_amount IS NULL`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN seller_payout_amount SET DEFAULT 0`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN seller_payout_amount SET NOT NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS seller_payouts jsonb NULL`,
      `UPDATE payments_payment_pages SET seller_payouts = '[]'::jsonb WHERE seller_payouts IS NULL`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN seller_payouts SET DEFAULT '[]'::jsonb`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN seller_payouts SET NOT NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS processor_payment_kind text NULL`,
      `UPDATE payments_payment_pages SET processor_payment_kind = 'payment-intent' WHERE processor_payment_kind IS NULL`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN processor_payment_kind SET DEFAULT 'payment-intent'`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN processor_payment_kind SET NOT NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS processor_redirect_url text NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS source_context text NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS source_reference_id text NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS refunded_at timestamptz NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS refunded_amount numeric(12, 2) NULL`,
      `UPDATE payments_payment_pages SET refunded_amount = 0 WHERE refunded_amount IS NULL`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN refunded_amount SET DEFAULT 0`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN refunded_amount SET NOT NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS disputed_at timestamptz NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS last_stream_version bigint NULL`,
      `UPDATE payments_payment_pages SET last_stream_version = 0 WHERE last_stream_version IS NULL`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN last_stream_version SET DEFAULT 0`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN last_stream_version SET NOT NULL`,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS payments_payment_pages_source_idx
  ON payments_payment_pages (source_context, source_reference_id)
  WHERE source_context IS NOT NULL AND source_reference_id IS NOT NULL`,
    ],
  },
  {
    migrationId: "20260703_payments_payment_orders_lookup",
    description: "Backfill payment-to-order lookup rows and index order-scoped payment reads.",
    statements: [
      `CREATE TABLE IF NOT EXISTS payments_payment_orders (
  payment_id text NOT NULL REFERENCES payments_payment_pages (payment_id) ON DELETE CASCADE,
  order_id text NOT NULL,
  PRIMARY KEY (payment_id, order_id)
)`,
      `INSERT INTO payments_payment_orders (payment_id, order_id)
SELECT payment_id, order_id
FROM payments_payment_pages
CROSS JOIN LATERAL jsonb_array_elements_text(order_ids) AS payment_order_ids(order_id)
ON CONFLICT (payment_id, order_id) DO NOTHING`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_payment_orders_order_idx
  ON payments_payment_orders (order_id, payment_id)`,
    ],
  },
  {
    migrationId: "20260703_payments_order_refund_amounts",
    description: "Track order-level refundable caps and refunded amounts on payment read models.",
    statements: [
      `SET lock_timeout = '5s'`,
      `ALTER TABLE payments_payment_pages
  ADD COLUMN IF NOT EXISTS order_refund_caps jsonb NULL`,
      `UPDATE payments_payment_pages SET order_refund_caps = '[]'::jsonb WHERE order_refund_caps IS NULL`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN order_refund_caps SET DEFAULT '[]'::jsonb`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN order_refund_caps SET NOT NULL`,
      `ALTER TABLE payments_payment_pages
  ADD COLUMN IF NOT EXISTS order_refunded_amounts jsonb NULL`,
      `UPDATE payments_payment_pages SET order_refunded_amounts = '[]'::jsonb WHERE order_refunded_amounts IS NULL`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN order_refunded_amounts SET DEFAULT '[]'::jsonb`,
      `ALTER TABLE payments_payment_pages ALTER COLUMN order_refunded_amounts SET NOT NULL`,
    ],
  },
  {
    migrationId: "20260703_payments_payment_creation_reservations",
    description: "Reserve payment creation by source and active order set before provider session creation.",
    statements: [
      `CREATE TABLE IF NOT EXISTS payments_payment_creation_reservations (
  payment_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  order_set_key text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_context text NULL,
  source_reference_id text NULL,
  status text NOT NULL CHECK (status IN ('active', 'failed', 'released')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
)`,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS payments_payment_creation_reservations_source_active_idx
  ON payments_payment_creation_reservations (source_context, source_reference_id)
  WHERE status = 'active' AND source_context IS NOT NULL AND source_reference_id IS NOT NULL`,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS payments_payment_creation_reservations_order_set_active_idx
  ON payments_payment_creation_reservations (buyer_account_id, order_set_key)
  WHERE status = 'active'`,
    ],
  },
  {
    migrationId: "20260706_payments_risk_based_3ds",
    description: "Track risk-based card authentication decisions and liability-shift outcomes for payments.",
    statements: [
      `SET lock_timeout = '2s'`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS three_d_secure_request text NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS three_d_secure_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS liability_shift_status text NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS liability_shift_authentication_result text NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS liability_shift_radar_risk_level text NULL`,
      `ALTER TABLE payments_payment_pages ADD COLUMN IF NOT EXISTS liability_shift_recorded_at timestamptz NULL`,
      `CREATE TABLE IF NOT EXISTS payments_account_risk_sources (
  account_id text PRIMARY KEY,
  manual_payout_review boolean NOT NULL DEFAULT false,
  stripe_fraud_flag boolean NOT NULL DEFAULT false,
  stripe_fraud_flagged_at timestamptz NULL,
  stripe_fraud_signal_count integer NOT NULL DEFAULT 0,
  stripe_review_open_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
    ],
  },
  {
    migrationId: "20260706_payments_saved_checkout_instrument_fingerprint",
    description: "Persist provider card fingerprints for payment decline velocity enforcement.",
    statements: [
      `ALTER TABLE payments_saved_checkout_instruments ADD COLUMN IF NOT EXISTS provider_fingerprint text NULL`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_saved_checkout_instruments_provider_fingerprint_idx
  ON payments_saved_checkout_instruments (provider, provider_fingerprint)
  WHERE provider_fingerprint IS NOT NULL`,
    ],
  },
  {
    migrationId: "20260709_payments_saved_checkout_instrument_agent_grant",
    description: "Track agent grant ownership for saved checkout instruments so grant revocation can detach them.",
    statements: [
      `ALTER TABLE payments_saved_checkout_instruments ADD COLUMN IF NOT EXISTS agent_grant_id text NULL`,
      `ALTER TABLE payments_saved_checkout_setup_sessions ADD COLUMN IF NOT EXISTS agent_grant_id text NULL`,
      `CREATE TABLE IF NOT EXISTS payments_revoked_agent_grants (
  account_id text NOT NULL,
  agent_grant_id text NOT NULL,
  revoked_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, agent_grant_id)
)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_saved_checkout_instruments_agent_grant_idx
  ON payments_saved_checkout_instruments (account_id, agent_grant_id, readiness, updated_at DESC, instrument_id)
  WHERE agent_grant_id IS NOT NULL`,
    ],
  },
] as const;
