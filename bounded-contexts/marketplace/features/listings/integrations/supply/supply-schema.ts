import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const marketplaceSupplyProjectionSchemaSql = `
-- Reputation columns are role-split (m108): as-seller counters reflect
-- reviews authored by buyers about this account, as-buyer counters reflect
-- reviews authored by sellers. A "seller.average_rating" join must read the
-- as-seller columns and a "buyer.average_rating" join must read the as-buyer
-- columns; blending the two misrepresents the account's per-role reliability.
CREATE TABLE IF NOT EXISTS marketplace_account_pages (
  account_id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL,
  badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  average_rating_as_seller numeric(4, 2) NULL,
  review_count_as_seller integer NOT NULL DEFAULT 0,
  rating_1_count_as_seller integer NOT NULL DEFAULT 0,
  rating_2_count_as_seller integer NOT NULL DEFAULT 0,
  rating_3_count_as_seller integer NOT NULL DEFAULT 0,
  rating_4_count_as_seller integer NOT NULL DEFAULT 0,
  rating_5_count_as_seller integer NOT NULL DEFAULT 0,
  average_rating_as_buyer numeric(4, 2) NULL,
  review_count_as_buyer integer NOT NULL DEFAULT 0,
  rating_1_count_as_buyer integer NOT NULL DEFAULT 0,
  rating_2_count_as_buyer integer NOT NULL DEFAULT 0,
  rating_3_count_as_buyer integer NOT NULL DEFAULT 0,
  rating_4_count_as_buyer integer NOT NULL DEFAULT 0,
  rating_5_count_as_buyer integer NOT NULL DEFAULT 0,
  reputation_updated_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketplace_account_pages
  ADD COLUMN IF NOT EXISTS badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS average_rating_as_seller numeric(4, 2) NULL,
  ADD COLUMN IF NOT EXISTS review_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_1_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_2_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_3_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_4_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_5_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS average_rating_as_buyer numeric(4, 2) NULL,
  ADD COLUMN IF NOT EXISTS review_count_as_buyer integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_1_count_as_buyer integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_2_count_as_buyer integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_3_count_as_buyer integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_4_count_as_buyer integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_5_count_as_buyer integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reputation_updated_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS marketplace_account_reviews (
  review_id text PRIMARY KEY,
  order_id text NULL,
  subject_account_id text NOT NULL,
  author_role text NOT NULL DEFAULT '',
  rating integer NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL,
  held boolean NOT NULL DEFAULT false
);

ALTER TABLE marketplace_account_reviews
  ADD COLUMN IF NOT EXISTS author_role text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS order_id text NULL,
  ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false;

-- Double-blind reveal (m108): a review contributes to
-- marketplace_account_pages reputation counters only once revealed_at is set.
ALTER TABLE marketplace_account_reviews
  ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS marketplace_account_reviews_subject_idx
  ON marketplace_account_reviews (subject_account_id, status);

CREATE TABLE IF NOT EXISTS marketplace_catalog_items (
  catalog_item_id text PRIMARY KEY,
  language_code text NOT NULL DEFAULT 'en',
  title text NOT NULL,
  subtitle text NULL,
  blueprint_id text NULL,
  category_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL,
  product_measure_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_schema jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketplace_catalog_items
  ADD COLUMN IF NOT EXISTS category_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS marketplace_catalog_categories (
  category_id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_catalog_blueprints (
  blueprint_id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonical_dimension_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_catalog_dimensions (
  dimension_id text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_catalog_dimension_options (
  option_id text PRIMARY KEY,
  dimension_id text NOT NULL,
  code text NOT NULL,
  label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  label text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketplace_catalog_dimension_options
  ADD COLUMN IF NOT EXISTS label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';

ALTER TABLE marketplace_catalog_items
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS product_measure_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS marketplace_supply_locations (
  storage_location_id text PRIMARY KEY,
  account_id text NOT NULL,
  name text NOT NULL,
  ship_from_code text NOT NULL,
  ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_archived boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_supply_items (
  item_id text PRIMARY KEY,
  account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  graded_card jsonb NULL,
  storage_location_id text NOT NULL,
  total_quantity integer NOT NULL,
  acquisition_cost_amount numeric(12,2) NULL,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_supply_holds (
  hold_id text PRIMARY KEY,
  account_id text NOT NULL,
  item_id text NOT NULL,
  quantity integer NOT NULL,
  purpose text NOT NULL DEFAULT 'manual',
  source_ref jsonb NULL,
  expires_at timestamptz NULL,
  status text NOT NULL,
  released_at timestamptz NULL,
  release_reason text NULL,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_account_pages_status_idx
  ON marketplace_account_pages (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_catalog_items_blueprint_idx
  ON marketplace_catalog_items (blueprint_id);

CREATE INDEX IF NOT EXISTS marketplace_catalog_items_language_idx
  ON marketplace_catalog_items (language_code);

CREATE INDEX IF NOT EXISTS marketplace_catalog_items_status_idx
  ON marketplace_catalog_items (status);

CREATE INDEX IF NOT EXISTS marketplace_catalog_items_category_ids_idx
  ON marketplace_catalog_items USING gin (category_ids);

CREATE INDEX IF NOT EXISTS marketplace_catalog_dimension_options_dimension_idx
  ON marketplace_catalog_dimension_options (dimension_id);

CREATE INDEX IF NOT EXISTS marketplace_supply_locations_account_idx
  ON marketplace_supply_locations (account_id, is_archived, name);

CREATE INDEX IF NOT EXISTS marketplace_supply_items_account_idx
  ON marketplace_supply_items (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_supply_items_storage_location_idx
  ON marketplace_supply_items (storage_location_id);

CREATE INDEX IF NOT EXISTS marketplace_supply_items_catalog_version_idx
  ON marketplace_supply_items (product_id);

CREATE INDEX IF NOT EXISTS marketplace_supply_holds_item_idx
  ON marketplace_supply_holds (item_id, status);

ALTER TABLE marketplace_supply_locations
  ADD COLUMN IF NOT EXISTS ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE marketplace_supply_holds
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_ref jsonb NULL,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS release_reason text NULL;
`;

export const marketplaceSupplyProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260714_marketplace_account_review_holds",
    description: "Exclude held order reviews from Marketplace account reputation inputs.",
    statements: [
      `SET lock_timeout = '5s'`,
      `ALTER TABLE marketplace_account_reviews
  ADD COLUMN IF NOT EXISTS order_id text NULL,
  ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false`,
    ],
  },
  {
    migrationId: "20260710_marketplace_account_pages_role_split_drop_legacy_columns",
    description:
      "Drop the pre-role-split blended reputation columns from marketplace_account_pages now that as-seller/as-buyer columns are populated (m108).",
    statements: [
      `SET lock_timeout = '2s'`,
      `ALTER TABLE marketplace_account_pages
  DROP COLUMN IF EXISTS average_rating,
  DROP COLUMN IF EXISTS review_count,
  DROP COLUMN IF EXISTS rating_1_count,
  DROP COLUMN IF EXISTS rating_2_count,
  DROP COLUMN IF EXISTS rating_3_count,
  DROP COLUMN IF EXISTS rating_4_count,
  DROP COLUMN IF EXISTS rating_5_count`,
    ],
  },
  {
    migrationId: "20260711_marketplace_account_reviews_reveal",
    description:
      "Add the revealed_at gate to marketplace_account_reviews and mark every existing (pre-launch) row revealed (m108).",
    statements: [
      `SET lock_timeout = '5s'`,
      `ALTER TABLE marketplace_account_reviews ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL`,
      `UPDATE marketplace_account_reviews
   SET revealed_at = updated_at
   WHERE status = 'active'
     AND revealed_at IS NULL`,
    ],
  },
];
