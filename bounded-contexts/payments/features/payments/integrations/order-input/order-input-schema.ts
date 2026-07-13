export const paymentsOrderInputSchemaSql = `
CREATE TABLE IF NOT EXISTS payments_order_inputs (
  order_id text PRIMARY KEY,
  source_type text NULL,
  source_reference_id text NULL,
  buyer_account_id text NOT NULL,
  buyer_email text NULL,
  seller_account_id text NOT NULL DEFAULT '',
  sales_tax_amount numeric(12, 2) NOT NULL DEFAULT 0,
  total_amount numeric(12, 2) NOT NULL,
  marketplace_sales_fee_amount numeric(12, 2) NOT NULL,
  marketplace_sales_fee_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  authenticity_fee_amount numeric(12, 2) NOT NULL DEFAULT 0,
  marketplace_checkout_fee_amount numeric(12, 2) NOT NULL,
  seller_net_amount numeric(12, 2) NOT NULL,
  seller_item_net_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_allowance_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_overage_amount numeric(12, 2) NOT NULL DEFAULT 0,
  seller_shipping_payout_amount numeric(12, 2) NOT NULL DEFAULT 0,
  protection_amount numeric(12, 2) NOT NULL DEFAULT 0,
  protection_allowance_amount numeric(12, 2) NOT NULL DEFAULT 0,
  protection_overage_amount numeric(12, 2) NOT NULL DEFAULT 0,
  seller_payout_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NOT NULL,
  status text NOT NULL,
  pending_payment_at timestamptz NULL,
  payment_deadline_at timestamptz NULL,
  payment_deadline_policy text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz NULL,
  ready_for_fulfillment_at timestamptz NULL,
  shipping_destination_snapshot jsonb NULL
);

CREATE INDEX IF NOT EXISTS payments_order_inputs_buyer_status_idx
  ON payments_order_inputs (buyer_account_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS payments_order_inputs_source_idx
  ON payments_order_inputs (source_type, source_reference_id)
  WHERE source_type IS NOT NULL AND source_reference_id IS NOT NULL;
`;

export const paymentsOrderInputSchemaMigrations = [
  {
    migrationId: "20260703_payments_order_inputs_checkout_terms_columns",
    description: "Add checkout fee, tax, seller payout, and terms columns to existing payment order-input mirrors.",
    statements: [
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS source_type text NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS source_reference_id text NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS buyer_email text NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS seller_account_id text NOT NULL DEFAULT ''`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS sales_tax_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS marketplace_checkout_fee_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS seller_item_net_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS shipping_allowance_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS shipping_overage_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS seller_shipping_payout_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS seller_payout_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS terms_schedule_id text NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS terms_agreement_id text NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS terms_resolved_at timestamptz NOT NULL DEFAULT now()`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS ready_for_fulfillment_at timestamptz NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS pending_payment_at timestamptz NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS payment_deadline_at timestamptz NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS payment_deadline_policy text NULL`,
      `CREATE INDEX IF NOT EXISTS payments_order_inputs_buyer_status_idx
  ON payments_order_inputs (buyer_account_id, status, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS payments_order_inputs_source_idx
  ON payments_order_inputs (source_type, source_reference_id)
  WHERE source_type IS NOT NULL AND source_reference_id IS NOT NULL`,
    ],
  },
  {
    migrationId: "20260707_payments_order_inputs_checkout_terms_convergence",
    description: "Converge partially migrated order-input mirrors after checkout terms migration reshuffles.",
    statements: [
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS source_type text NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS source_reference_id text NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS buyer_account_id text NOT NULL DEFAULT ''`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS buyer_email text NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS seller_account_id text NOT NULL DEFAULT ''`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS sales_tax_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS total_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS marketplace_sales_fee_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS marketplace_checkout_fee_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS seller_net_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS seller_item_net_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS shipping_allowance_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS shipping_overage_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS seller_shipping_payout_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS seller_payout_amount numeric(12, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS terms_schedule_id text NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS terms_agreement_id text NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS terms_resolved_at timestamptz NOT NULL DEFAULT now()`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending-reservation'`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS ready_for_fulfillment_at timestamptz NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS pending_payment_at timestamptz NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS payment_deadline_at timestamptz NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS payment_deadline_policy text NULL`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
      `ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`,
      `CREATE INDEX IF NOT EXISTS payments_order_inputs_buyer_status_idx
  ON payments_order_inputs (buyer_account_id, status, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS payments_order_inputs_source_idx
  ON payments_order_inputs (source_type, source_reference_id)
  WHERE source_type IS NOT NULL AND source_reference_id IS NOT NULL`,
    ],
  },
  {
    migrationId: "20260712_payments_order_inputs_order_protection",
    description: "Carry immutable Order Protection amount and funding split into Payments.",
    statements: [
      `ALTER TABLE payments_order_inputs
  ADD COLUMN IF NOT EXISTS protection_amount numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS protection_allowance_amount numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS protection_overage_amount numeric(12, 2) NOT NULL DEFAULT 0`,
    ],
  },
  {
    migrationId: "20260712_payments_order_inputs_marketplace_sales_fee_lines",
    description: "Carry Ordering's per-line marketplace sales fee formula snapshots into payment seller economics.",
    statements: [
      `ALTER TABLE payments_order_inputs
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_lines jsonb NOT NULL DEFAULT '[]'::jsonb`,
    ],
  },
  {
    migrationId: "20260713_payments_order_inputs_shipping_destination_snapshot",
    description: "Carry Ordering's immutable buyer destination snapshot into the payment entry read model.",
    statements: [`ALTER TABLE payments_order_inputs ADD COLUMN IF NOT EXISTS shipping_destination_snapshot jsonb NULL`],
  },
] as const;
