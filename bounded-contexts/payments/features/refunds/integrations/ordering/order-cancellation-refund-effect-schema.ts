export const paymentsOrderCancellationRefundEffectSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_order_cancellation_refund_effects (
  order_id text PRIMARY KEY,
  payment_id text NULL,
  refund_id text NULL,
  requested_amount numeric(12, 2) NULL,
  status text NOT NULL,
  failure_message text NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_order_cancellation_refund_effects_payment_idx
  ON payments_order_cancellation_refund_effects (payment_id, updated_at DESC)
  WHERE payment_id IS NOT NULL;
`;

export const paymentsOrderCancellationRefundEffectSchemaMigrations = [
  {
    migrationId: "20260716_payments_cancellation_refund_effect_attempts",
    description: "Track cancellation refund effect retry attempts for bounded automatic retries",
    statements: [
      "ALTER TABLE payments_order_cancellation_refund_effects ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;",
    ],
  },
] as const;
