import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const orderingSupplySourceSchemaSql = `
CREATE TABLE IF NOT EXISTS ordering_market_listing_inputs (
  listing_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  inventory_item_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  product_measure_snapshot jsonb NULL,
  graded_card jsonb NULL,
  storage_location_name text NULL,
  ship_from_code text NULL,
  ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_amount numeric(12, 2) NOT NULL,
  marketplace_sales_fee_unit_amount numeric(12, 2) NOT NULL,
  seller_net_unit_amount numeric(12, 2) NOT NULL,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NOT NULL,
  fee_locks jsonb NOT NULL DEFAULT '[]'::jsonb,
  quantity_cap integer NOT NULL CHECK (quantity_cap >= 0),
  max_units_per_order integer NULL CHECK (max_units_per_order IS NULL OR max_units_per_order > 0),
  max_units_per_day integer NULL CHECK (max_units_per_day IS NULL OR max_units_per_day > 0),
  max_units_per_customer_account integer NULL CHECK (max_units_per_customer_account IS NULL OR max_units_per_customer_account > 0),
  seller_listing_availability_status text NOT NULL DEFAULT 'available',
  status text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ordering_market_listing_inputs_lookup_idx
  ON ordering_market_listing_inputs (product_id, status, price_amount, updated_at);

CREATE INDEX IF NOT EXISTS ordering_market_listing_inputs_item_idx
  ON ordering_market_listing_inputs (inventory_item_id, status, updated_at);

CREATE TABLE IF NOT EXISTS ordering_seller_listing_availability_inputs (
  account_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'available',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ordering_inventory_item_inputs (
  item_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  total_quantity integer NOT NULL CHECK (total_quantity >= 0),
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL CHECK (last_stream_version >= 1)
);

CREATE INDEX IF NOT EXISTS ordering_inventory_item_inputs_lookup_idx
  ON ordering_inventory_item_inputs (seller_account_id, catalog_catalog_item_id, product_id);

CREATE TABLE IF NOT EXISTS ordering_inventory_hold_inputs (
  hold_id text PRIMARY KEY,
  item_id text NOT NULL,
  seller_account_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  status text NOT NULL,
  released_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL CHECK (last_stream_version >= 1)
);

CREATE INDEX IF NOT EXISTS ordering_inventory_hold_inputs_item_idx
  ON ordering_inventory_hold_inputs (item_id, status);

CREATE TABLE IF NOT EXISTS ordering_offer_acceptance_inputs (
  offer_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  listing_id text NOT NULL,
  inventory_item_id text NOT NULL,
  listing_version integer NOT NULL CHECK (listing_version > 0),
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  price_amount numeric(12, 2) NOT NULL,
  marketplace_sales_fee_percentage_bps integer NOT NULL DEFAULT 0,
  marketplace_sales_fee_fixed_amount numeric(12, 2) NOT NULL DEFAULT 0,
  marketplace_sales_fee_cap_amount numeric(12, 2) NULL,
  marketplace_sales_fee_unit_amount numeric(12, 2) NOT NULL,
  seller_net_unit_amount numeric(12, 2) NOT NULL,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NOT NULL,
  fee_quote_fingerprint text NOT NULL,
  listing_evidence_policy_id text NULL,
  listing_evidence_policy_version integer NULL,
  listing_evidence_policy_hash text NOT NULL,
  listing_evidence_snapshot jsonb NOT NULL,
  quantity_requested integer NOT NULL CHECK (quantity_requested > 0),
  shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepted_at timestamptz NOT NULL,
  acceptance_batch_id text NULL,
  acceptance_batch_size integer NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE ordering_market_listing_inputs
  ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS product_measure_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS graded_card jsonb NULL,
  ADD COLUMN IF NOT EXISTS ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS max_units_per_order integer NULL,
  ADD COLUMN IF NOT EXISTS max_units_per_day integer NULL,
  ADD COLUMN IF NOT EXISTS max_units_per_customer_account integer NULL,
  ADD COLUMN IF NOT EXISTS seller_listing_availability_status text NOT NULL DEFAULT 'available';

ALTER TABLE ordering_market_listing_inputs
  ADD COLUMN IF NOT EXISTS fee_locks jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE ordering_market_listing_inputs
  ALTER COLUMN terms_resolved_at DROP NOT NULL;

ALTER TABLE ordering_offer_acceptance_inputs
  ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500;

ALTER TABLE ordering_offer_acceptance_inputs
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_percentage_bps integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_fixed_amount numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_cap_amount numeric(12, 2) NULL;

ALTER TABLE ordering_offer_acceptance_inputs
  ADD COLUMN IF NOT EXISTS acceptance_batch_id text NULL;

ALTER TABLE ordering_offer_acceptance_inputs
  ADD COLUMN IF NOT EXISTS acceptance_batch_size integer NULL;

ALTER TABLE ordering_offer_acceptance_inputs
  ADD COLUMN IF NOT EXISTS shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ordering_offer_acceptance_inputs
  ADD COLUMN IF NOT EXISTS listing_id text NULL,
  ADD COLUMN IF NOT EXISTS inventory_item_id text NULL,
  ADD COLUMN IF NOT EXISTS listing_version integer NULL,
  ADD COLUMN IF NOT EXISTS fee_quote_fingerprint text NULL,
  ADD COLUMN IF NOT EXISTS listing_evidence_policy_id text NULL,
  ADD COLUMN IF NOT EXISTS listing_evidence_policy_version integer NULL,
  ADD COLUMN IF NOT EXISTS listing_evidence_policy_hash text NULL,
  ADD COLUMN IF NOT EXISTS listing_evidence_snapshot jsonb NULL;

CREATE TABLE IF NOT EXISTS ordering_payment_capture_inputs (
  payment_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  processor_name text NOT NULL,
  processor_payment_reference text NOT NULL,
  processor_status text NOT NULL,
  captured_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ordering_payment_deadline_inputs (
  order_id text PRIMARY KEY,
  payment_id text NULL,
  payment_method_category text NULL,
  payment_deadline_at timestamptz NOT NULL,
  payment_deadline_policy text NOT NULL,
  terminal_failure_at timestamptz NULL,
  failure_code text NULL,
  updated_at timestamptz NOT NULL
);
`;

export const orderingSupplySourceSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260707_ordering_payment_deadline_input_indexes",
    description: "Build payment-deadline input lookup indexes outside boot-time schema SQL.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ordering_payment_deadline_inputs_due_idx
  ON ordering_payment_deadline_inputs (payment_deadline_at, order_id)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ordering_payment_deadline_inputs_payment_idx
  ON ordering_payment_deadline_inputs (payment_id)
  WHERE payment_id IS NOT NULL`,
    ],
  },
  {
    migrationId: "20260712_ordering_offer_acceptance_fee_formula",
    description: "Snapshot marketplace sales fee percentage, fixed amount, and per-item cap on accepted offers.",
    statements: [
      `ALTER TABLE ordering_offer_acceptance_inputs
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_percentage_bps integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_fixed_amount numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marketplace_sales_fee_cap_amount numeric(12, 2) NULL`,
    ],
  },
  {
    migrationId: "20260713_ordering_exact_offer_commitment_input",
    description:
      "Replace ambiguous accepted-offer inputs with exact Listing, Inventory, policy, and evidence commitments.",
    statements: [
      `TRUNCATE TABLE ordering_offer_acceptance_inputs`,
      `ALTER TABLE ordering_offer_acceptance_inputs
  ALTER COLUMN listing_id SET NOT NULL,
  ALTER COLUMN inventory_item_id SET NOT NULL,
  ALTER COLUMN listing_version SET NOT NULL,
  ALTER COLUMN fee_quote_fingerprint SET NOT NULL,
  ALTER COLUMN listing_evidence_policy_hash SET NOT NULL,
  ALTER COLUMN listing_evidence_snapshot SET NOT NULL`,
      `ALTER TABLE ordering_offer_acceptance_inputs
  DROP CONSTRAINT IF EXISTS ordering_offer_acceptance_inputs_listing_version_check,
  ADD CONSTRAINT ordering_offer_acceptance_inputs_listing_version_check CHECK (listing_version > 0)`,
    ],
  },
];
