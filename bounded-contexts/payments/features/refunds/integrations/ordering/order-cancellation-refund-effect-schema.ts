export const paymentsOrderCancellationRefundEffectSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_order_cancellation_refund_effects (
  order_id text PRIMARY KEY,
  payment_id text NULL,
  refund_id text NULL,
  requested_amount numeric(12, 2) NULL,
  status text NOT NULL,
  failure_message text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_order_cancellation_refund_effects_payment_idx
  ON payments_order_cancellation_refund_effects (payment_id, updated_at DESC)
  WHERE payment_id IS NOT NULL;
`;
