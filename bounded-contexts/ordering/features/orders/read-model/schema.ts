import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const orderingOrderSchemaSql = `
CREATE TABLE IF NOT EXISTS ordering_order_pages (
  order_id text PRIMARY KEY,
  source_type text NOT NULL,
  source_reference_id text NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  shipping_option text NOT NULL,
  item_subtotal_amount numeric(12,2) NOT NULL,
  shipping_base_amount numeric(12,2) NOT NULL,
  shipping_discount_amount numeric(12,2) NOT NULL,
  shipping_allowance_amount numeric(12,2) NOT NULL DEFAULT 0,
  shipping_overage_amount numeric(12,2) NOT NULL DEFAULT 0,
  protection_amount numeric(12,2) NOT NULL DEFAULT 0,
  protection_allowance_amount numeric(12,2) NOT NULL DEFAULT 0,
  protection_overage_amount numeric(12,2) NOT NULL DEFAULT 0,
  shipping_charge_amount numeric(12,2) NOT NULL,
  sales_tax_amount numeric(12,2) NOT NULL DEFAULT 0,
  taxable_amount numeric(12,2) NOT NULL DEFAULT 0,
  tax_jurisdiction_country text NOT NULL DEFAULT 'US',
  tax_jurisdiction_state text NULL,
  tax_rate_bps integer NOT NULL DEFAULT 0,
  tax_provider_name text NOT NULL DEFAULT 'local-stub',
  tax_provider_quote_reference text NULL,
  tax_quoted_at timestamptz NOT NULL DEFAULT now(),
  total_amount numeric(12,2) NOT NULL,
  marketplace_sales_fee_amount numeric(12,2) NOT NULL,
  seller_net_amount numeric(12,2) NOT NULL,
  seller_item_net_amount numeric(12,2) NOT NULL DEFAULT 0,
  seller_payout_amount numeric(12,2) NOT NULL DEFAULT 0,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NOT NULL,
  shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_origin_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  pending_payment_at timestamptz NULL,
  payment_deadline_at timestamptz NULL,
  payment_deadline_policy text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancellation_reason text NULL,
  ready_for_fulfillment_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS ordering_order_pages_buyer_idx
  ON ordering_order_pages (buyer_account_id, updated_at DESC, order_id DESC);

CREATE INDEX IF NOT EXISTS ordering_order_pages_seller_idx
  ON ordering_order_pages (seller_account_id, updated_at DESC, order_id DESC);

ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS sales_tax_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS taxable_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS tax_jurisdiction_country text NOT NULL DEFAULT 'US';
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS tax_jurisdiction_state text NULL;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS tax_rate_bps integer NOT NULL DEFAULT 0;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS tax_provider_name text NOT NULL DEFAULT 'local-stub';
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS tax_provider_quote_reference text NULL;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS tax_quoted_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS shipping_allowance_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS shipping_overage_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS protection_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS protection_allowance_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS protection_overage_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS seller_item_net_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS seller_payout_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS shipping_origin_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS shipping_plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS display_reference text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS ordering_order_line_pages (
  order_id text NOT NULL,
  line_id text NOT NULL,
  line_index integer NOT NULL,
  listing_id text NOT NULL,
  inventory_item_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  unit_price_amount numeric(12,2) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  line_total_amount numeric(12,2) NOT NULL,
  marketplace_sales_fee_percentage_bps integer NOT NULL DEFAULT 0,
  marketplace_sales_fee_fixed_amount numeric(12,2) NOT NULL DEFAULT 0,
  marketplace_sales_fee_cap_amount numeric(12,2) NULL,
  marketplace_sales_fee_unit_amount numeric(12,2) NOT NULL,
  marketplace_sales_fee_total_amount numeric(12,2) NOT NULL,
  seller_net_unit_amount numeric(12,2) NOT NULL,
  seller_net_total_amount numeric(12,2) NOT NULL,
  PRIMARY KEY (order_id, line_id)
);

CREATE INDEX IF NOT EXISTS ordering_order_line_pages_order_idx
  ON ordering_order_line_pages (order_id, line_index ASC);

CREATE INDEX IF NOT EXISTS ordering_order_line_pages_catalog_version_idx
  ON ordering_order_line_pages (product_id);

ALTER TABLE ordering_order_line_pages
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_percentage_bps integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_fixed_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_cap_amount numeric(12,2) NULL;

CREATE TABLE IF NOT EXISTS ordering_order_hold_pages (
  hold_id text PRIMARY KEY,
  order_id text NOT NULL,
  seller_account_id text NOT NULL,
  inventory_item_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS ordering_order_hold_pages_order_idx
  ON ordering_order_hold_pages (order_id, created_at ASC);

CREATE TABLE IF NOT EXISTS ordering_listing_purchase_limit_claims (
  claim_id text PRIMARY KEY,
  source_type text NOT NULL,
  source_reference_id text NOT NULL,
  buyer_account_id text NOT NULL,
  listing_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'claimed',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz NULL,
  UNIQUE (source_type, source_reference_id, buyer_account_id, listing_id)
);

CREATE INDEX IF NOT EXISTS ordering_listing_purchase_limit_claims_usage_idx
  ON ordering_listing_purchase_limit_claims (buyer_account_id, listing_id, status);

CREATE TABLE IF NOT EXISTS ordering_listing_purchase_limit_usage (
  buyer_account_id text NOT NULL,
  listing_id text NOT NULL,
  marketplace_day date NOT NULL,
  day_quantity integer NOT NULL DEFAULT 0 CHECK (day_quantity >= 0),
  customer_account_quantity integer NOT NULL DEFAULT 0 CHECK (customer_account_quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (buyer_account_id, listing_id)
);
`;

export const orderingOrderSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260707_ordering_order_payment_deadline_columns",
    description: "Add payment-deadline read-model columns and due-order index outside boot-time schema SQL.",
    statements: [
      `ALTER TABLE ordering_order_pages ADD COLUMN IF NOT EXISTS pending_payment_at timestamptz NULL`,
      `ALTER TABLE ordering_order_pages ADD COLUMN IF NOT EXISTS payment_deadline_at timestamptz NULL`,
      `ALTER TABLE ordering_order_pages ADD COLUMN IF NOT EXISTS payment_deadline_policy text NULL`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ordering_order_pages_payment_deadline_idx
  ON ordering_order_pages (payment_deadline_at, order_id)
  WHERE status = 'pending-payment' AND payment_deadline_at IS NOT NULL`,
    ],
  },
  {
    migrationId: "20260711_ordering_order_display_reference_unique_idx",
    description:
      "Add the support-safe order display reference unique index outside boot-time schema SQL. Rows written " +
      "before this migration ran keep the empty-string default and are excluded from the uniqueness check; the " +
      "projector always populates a real reference for every order it creates.",
    statements: [
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ordering_order_pages_display_reference_key
  ON ordering_order_pages (display_reference)
  WHERE display_reference <> ''`,
    ],
  },
  {
    migrationId: "20260712_ordering_order_protection_economics",
    description: "Persist Order Protection amount and immutable allowance/overage funding split.",
    statements: [
      `ALTER TABLE ordering_order_pages
  ADD COLUMN IF NOT EXISTS protection_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS protection_allowance_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS protection_overage_amount numeric(12,2) NOT NULL DEFAULT 0`,
    ],
  },
  {
    migrationId: "20260712_ordering_order_line_fee_formula",
    description: "Persist each order line's locked marketplace sales fee formula for audit and replay.",
    statements: [
      `ALTER TABLE ordering_order_line_pages
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_percentage_bps integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_fixed_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_cap_amount numeric(12,2) NULL`,
    ],
  },
];
