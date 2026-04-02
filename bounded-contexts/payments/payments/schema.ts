export const paymentsPaymentSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_payment_pages (
  payment_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  processor_name text NOT NULL,
  processor_payment_reference text NOT NULL UNIQUE,
  processor_client_secret text NULL,
  processor_status text NOT NULL,
  status text NOT NULL,
  failure_code text NULL,
  failure_message text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  captured_at timestamptz NULL,
  failed_at timestamptz NULL,
  cancelled_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS payments_payment_pages_buyer_idx
  ON payments_payment_pages (buyer_account_id, updated_at DESC, payment_id DESC);

CREATE INDEX IF NOT EXISTS payments_payment_pages_processor_idx
  ON payments_payment_pages (processor_name, processor_payment_reference);
`;
