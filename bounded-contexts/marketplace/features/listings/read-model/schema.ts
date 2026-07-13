import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const marketplaceListingSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_listing_pages (
  listing_id text PRIMARY KEY,
  account_id text NOT NULL,
  inventory_item_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_language_code text NULL,
  item_title text NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  product_measure_snapshot jsonb NULL,
  graded_card jsonb NULL,
  storage_location_name text NULL,
  ship_from_code text NULL,
  ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_amount numeric(12,2) NOT NULL,
  marketplace_sales_fee_unit_amount numeric(12,2) NOT NULL,
  seller_net_unit_amount numeric(12,2) NOT NULL,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NULL,
  fee_quote_fingerprint text NOT NULL,
  fee_locks jsonb NOT NULL DEFAULT '[]'::jsonb,
  quantity_cap integer NOT NULL CHECK (quantity_cap > 0),
  max_units_per_order integer NULL CHECK (max_units_per_order IS NULL OR max_units_per_order > 0),
  max_units_per_day integer NULL CHECK (max_units_per_day IS NULL OR max_units_per_day > 0),
  max_units_per_customer_account integer NULL CHECK (max_units_per_customer_account IS NULL OR max_units_per_customer_account > 0),
  evidence_requirements jsonb NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_account_idx
  ON marketplace_listing_pages (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_catalog_item_idx
  ON marketplace_listing_pages (catalog_catalog_item_id, status, price_amount);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_catalog_version_idx
  ON marketplace_listing_pages (product_id, status, price_amount);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_inventory_item_idx
  ON marketplace_listing_pages (inventory_item_id, status, updated_at DESC);

ALTER TABLE marketplace_listing_pages
  ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS item_language_code text NULL,
  ADD COLUMN IF NOT EXISTS product_measure_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS max_units_per_order integer NULL,
  ADD COLUMN IF NOT EXISTS max_units_per_day integer NULL,
  ADD COLUMN IF NOT EXISTS max_units_per_customer_account integer NULL,
  ADD COLUMN IF NOT EXISTS fee_locks jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS marketplace_anonymous_listing_draft_intents (
  intent_id text PRIMARY KEY,
  anonymous_owner_id text NOT NULL,
  source_path text NOT NULL,
  catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  price_amount numeric(12,2) NOT NULL,
  quantity_cap integer NOT NULL CHECK (quantity_cap > 0),
  max_units_per_order integer NULL CHECK (max_units_per_order IS NULL OR max_units_per_order > 0),
  max_units_per_day integer NULL CHECK (max_units_per_day IS NULL OR max_units_per_day > 0),
  max_units_per_customer_account integer NULL CHECK (
    max_units_per_customer_account IS NULL OR max_units_per_customer_account > 0
  ),
  status text NOT NULL DEFAULT 'active',
  claimed_account_id text NULL,
  claimed_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_anonymous_listing_draft_owner_idx
  ON marketplace_anonymous_listing_draft_intents (anonymous_owner_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_anonymous_listing_draft_expiry_idx
  ON marketplace_anonymous_listing_draft_intents (status, expires_at);

CREATE TABLE IF NOT EXISTS marketplace_seller_listing_availability_pages (
  account_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'available',
  disabled_reason_category text NULL,
  available_again_on date NULL,
  available_again_at timestamptz NULL,
  disabled_at timestamptz NULL,
  enabled_at timestamptz NULL,
  away_window_starts_at timestamptz NULL,
  away_window_ends_at timestamptz NULL,
  away_window_reason_category text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_seller_listing_availability_status_idx
  ON marketplace_seller_listing_availability_pages (status, updated_at DESC);

ALTER TABLE marketplace_seller_listing_availability_pages
  ADD COLUMN IF NOT EXISTS available_again_at timestamptz NULL;

-- Away Window: a seller-scheduled future away period. At most one pending
-- window per account (enforced by the aggregate, not the schema). The
-- partial due-indexes for the auto-resume sweep and the away-window start
-- sweep live in marketplaceListingReadModelSchemaMigrations (boot-time
-- indexes on migration-added columns are forbidden -- see
-- boot-schema-ddl-discipline).
ALTER TABLE marketplace_seller_listing_availability_pages
  ADD COLUMN IF NOT EXISTS away_window_starts_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS away_window_ends_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS away_window_reason_category text NULL;

-- Order Capacity is the seller-set cap on concurrently Open Orders. Absent
-- row (or a NULL max_open_orders) means unlimited, the default. Inert until
-- the enforcement slice starts reading this table.
CREATE TABLE IF NOT EXISTS marketplace_seller_order_capacity_pages (
  account_id text PRIMARY KEY,
  max_open_orders integer NULL CHECK (max_open_orders IS NULL OR max_open_orders > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- marketplace_seller_listing_availability_due_restore_idx moved to the schemaMigrations ledger
-- (boot-time indexes on migration-added columns are forbidden by the structure gate).
`;

export const marketplaceListingSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260713_marketplace_listing_evidence_requirements_and_container",
    description:
      "Record resolved Listing Evidence requirements and rename the legacy listing-photo collection column to generic evidence.",
    statements: [
      "SET lock_timeout = '5s';",
      `DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'marketplace_listing_pages' AND column_name = 'listing_photos'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'marketplace_listing_pages' AND column_name = 'evidence'
  ) THEN
    ALTER TABLE marketplace_listing_pages RENAME COLUMN listing_photos TO evidence;
  END IF;
END
$migration$`,
      `ALTER TABLE marketplace_listing_pages
  ADD COLUMN IF NOT EXISTS evidence_requirements jsonb NULL`,
    ],
  },
  {
    migrationId: "20260713_marketplace_seller_listing_availability_due_restore_idx",
    description:
      "Auto-resume sweep due-index: a partial index so the sweep's due query scans only accounts " +
      "that are both away AND carry an authoritative Resume Instant, matching the legacy ruling that " +
      "a bare availableAgainOn date never participates in automated resume.",
    statements: [
      "SET lock_timeout = '5s';",
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS marketplace_seller_listing_availability_due_restore_idx
  ON marketplace_seller_listing_availability_pages (available_again_at)
  WHERE status = 'unavailable' AND available_again_at IS NOT NULL`,
    ],
  },
];

export const marketplaceListingReadModelSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260713_marketplace_seller_away_window_due_start_index",
    description:
      "Away Window start sweep due-index: a partial index so the sweep's due query scans only accounts with a pending window whose start has arrived (#4880).",
    statements: [
      `SET lock_timeout = '5s'`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS marketplace_seller_listing_availability_due_away_window_idx
  ON marketplace_seller_listing_availability_pages (away_window_starts_at)
  WHERE away_window_starts_at IS NOT NULL`,
    ],
  },
];
