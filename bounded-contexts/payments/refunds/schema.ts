export const paymentsRefundSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_refund_pages (
  refund_id text PRIMARY KEY,
  payment_id text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  reason text NOT NULL,
  processor_name text NOT NULL,
  processor_refund_reference text NULL,
  processor_status text NOT NULL,
  status text NOT NULL,
  failure_code text NULL,
  failure_message text NULL,
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  issued_at timestamptz NULL,
  failed_at timestamptz NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);
`;
