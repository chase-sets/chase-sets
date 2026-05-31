export const paymentsSupportRefundEffectSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_support_refund_effects (
  support_request_id text PRIMARY KEY,
  refund_effect_id text NOT NULL,
  order_id text NOT NULL,
  payment_id text NULL,
  refund_id text NULL,
  resolution_type text NOT NULL,
  requested_amount numeric(12, 2) NULL,
  status text NOT NULL,
  failure_message text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE payments_support_refund_effects
  ADD COLUMN IF NOT EXISTS refund_effect_id text;

UPDATE payments_support_refund_effects
SET refund_effect_id = 'sre_' || regexp_replace(support_request_id, '^sup_', '')
WHERE refund_effect_id IS NULL;

ALTER TABLE payments_support_refund_effects
  ALTER COLUMN refund_effect_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_support_refund_effects_effect_id_idx
  ON payments_support_refund_effects (refund_effect_id);

CREATE INDEX IF NOT EXISTS payments_support_refund_effects_order_idx
  ON payments_support_refund_effects (order_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS payments_support_refund_effects_status_idx
  ON payments_support_refund_effects (status, updated_at DESC);
`;
