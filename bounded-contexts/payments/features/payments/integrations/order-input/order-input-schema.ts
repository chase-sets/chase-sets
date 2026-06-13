export const paymentsOrderInputSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_order_inputs (
  order_id text PRIMARY KEY,
  source_type text NULL,
  source_reference_id text NULL,
  buyer_account_id text NOT NULL,
  buyer_email text NULL,
  seller_account_id text NOT NULL DEFAULT '',
  total_amount numeric(12, 2) NOT NULL,
  marketplace_sales_fee_amount numeric(12, 2) NOT NULL,
  marketplace_checkout_fee_amount numeric(12, 2) NOT NULL,
  seller_net_amount numeric(12, 2) NOT NULL,
  seller_item_net_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_allowance_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_overage_amount numeric(12, 2) NOT NULL DEFAULT 0,
  seller_shipping_payout_amount numeric(12, 2) NOT NULL DEFAULT 0,
  seller_payout_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz NULL,
  ready_for_fulfillment_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS payments_order_inputs_buyer_status_idx
  ON payments_order_inputs (buyer_account_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS payments_order_inputs_source_idx
  ON payments_order_inputs (source_type, source_reference_id)
  WHERE source_type IS NOT NULL AND source_reference_id IS NOT NULL;
`;
