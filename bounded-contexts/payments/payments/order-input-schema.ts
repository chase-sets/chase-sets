export const paymentsOrderInputSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_order_inputs (
  order_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  total_amount numeric(12, 2) NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz NULL,
  ready_for_fulfillment_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS payments_order_inputs_buyer_status_idx
  ON payments_order_inputs (buyer_account_id, status, updated_at DESC);
`;
