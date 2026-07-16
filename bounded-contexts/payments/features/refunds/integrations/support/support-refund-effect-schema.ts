// return-for-refund gate progression before issueRefund is ever called:
// awaiting-return (resolved, refund not yet claimed), then return-received
// (return delivered back, inspection window running), then either
// return-condition-disputed (seller disputed within the window; needs a
// support release) or straight through to the existing processing,
// refund-requested, and failed terminal states once the gate opens.
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
  updated_at timestamptz NOT NULL,
  return_delivered_at timestamptz NULL,
  refund_release_due_at timestamptz NULL,
  return_condition_disputed_at timestamptz NULL,
  return_shipping_deduction_amount numeric(12, 2) NOT NULL DEFAULT 0
);

CREATE UNLOGGED TABLE IF NOT EXISTS payments_return_label_sources (
  return_shipment_id text PRIMARY KEY,
  support_request_id text NOT NULL,
  cost_payer text NOT NULL,
  postage_amount numeric(12, 2) NOT NULL DEFAULT 0,
  currency_code text NULL,
  label_status text NOT NULL DEFAULT 'requested',
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_return_label_sources_case_idx
  ON payments_return_label_sources (support_request_id, return_shipment_id);

CREATE UNIQUE INDEX IF NOT EXISTS payments_support_refund_effects_effect_id_idx
  ON payments_support_refund_effects (refund_effect_id);

CREATE INDEX IF NOT EXISTS payments_support_refund_effects_order_idx
  ON payments_support_refund_effects (order_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS payments_support_refund_effects_status_idx
  ON payments_support_refund_effects (status, updated_at DESC);
`;
