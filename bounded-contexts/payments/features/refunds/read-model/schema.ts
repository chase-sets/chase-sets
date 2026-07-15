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
  remedy_id text NULL,
  coverage_id text NULL,
  liability_funding_kind text NULL,
  seller_funded_amount numeric(12, 2) NULL,
  platform_funded_amount numeric(12, 2) NULL,
  refund_trigger text NULL,
  reason_code text NULL,
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  issued_at timestamptz NULL,
  failed_at timestamptz NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS payments_refund_pages_pending_idx
  ON payments_refund_pages (status, updated_at)
  WHERE status NOT IN ('issued', 'failed');

CREATE INDEX IF NOT EXISTS payments_refund_pages_order_ids_idx
  ON payments_refund_pages USING GIN (order_ids jsonb_ops);
`;

export const paymentsRefundSchemaMigrations = [
  {
    migrationId: "20260714_payments_refund_pages_causation",
    description:
      "Carry remedy and liability-allocation causation on the refund read model so completed refunds preserve who authorized them and how liability is allocated, and so stuck refunds are queryable.",
    statements: [
      `ALTER TABLE payments_refund_pages ADD COLUMN IF NOT EXISTS remedy_id text NULL`,
      `ALTER TABLE payments_refund_pages ADD COLUMN IF NOT EXISTS coverage_id text NULL`,
      `ALTER TABLE payments_refund_pages ADD COLUMN IF NOT EXISTS liability_funding_kind text NULL`,
      `ALTER TABLE payments_refund_pages ADD COLUMN IF NOT EXISTS seller_funded_amount numeric(12, 2) NULL`,
      `ALTER TABLE payments_refund_pages ADD COLUMN IF NOT EXISTS platform_funded_amount numeric(12, 2) NULL`,
      `ALTER TABLE payments_refund_pages ADD COLUMN IF NOT EXISTS refund_trigger text NULL`,
      `ALTER TABLE payments_refund_pages ADD COLUMN IF NOT EXISTS reason_code text NULL`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_refund_pages_pending_idx
  ON payments_refund_pages (status, updated_at)
  WHERE status NOT IN ('issued', 'failed')`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_refund_pages_remedy_idx
  ON payments_refund_pages (remedy_id)
  WHERE remedy_id IS NOT NULL`,
    ],
  },
  {
    migrationId: "20260715_payments_refund_pages_order_lookup",
    description: "Index the order-keyed customer refund timeline lookup.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_refund_pages_order_ids_idx
  ON payments_refund_pages USING GIN (order_ids jsonb_ops)`,
    ],
  },
] as const;
