import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const discoveryMarketSchemaSql = `CREATE TABLE IF NOT EXISTS discovery_market_accounts (
  account_id text PRIMARY KEY,
  seller_slug text NOT NULL DEFAULT '',
  seller_display_name text NULL,
  status text NOT NULL DEFAULT 'active',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_market_accounts
  ADD COLUMN IF NOT EXISTS seller_slug text NOT NULL DEFAULT '';

ALTER TABLE discovery_market_accounts
  ADD COLUMN IF NOT EXISTS seller_listing_availability_status text NOT NULL DEFAULT 'available',
  ADD COLUMN IF NOT EXISTS seller_listing_availability_reason_category text NULL,
  ADD COLUMN IF NOT EXISTS seller_listing_available_again_on date NULL;

-- Reputation columns are role-split (m108): as-seller counters reflect
-- reviews authored by buyers about this account, as-buyer counters reflect
-- reviews authored by sellers. seller_average_rating output columns must
-- read the as-seller columns and buyer_average_rating output columns must
-- read the as-buyer columns.
ALTER TABLE discovery_market_accounts
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

-- Public profile "member since" (m108, #4268): set once from
-- identity.account.created and never overwritten afterward.
ALTER TABLE discovery_market_accounts
  ADD COLUMN IF NOT EXISTS created_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS discovery_market_account_reviews (
  review_id text PRIMARY KEY,
  author_account_id text NOT NULL DEFAULT '',
  subject_account_id text NOT NULL,
  author_role text NOT NULL DEFAULT '',
  rating integer NOT NULL,
  feedback text NULL,
  status text NOT NULL,
  submitted_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE discovery_market_account_reviews
  ADD COLUMN IF NOT EXISTS author_account_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS author_role text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS feedback text NULL,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz NULL;

-- Double-blind reveal (m108): a review contributes to
-- discovery_market_accounts reputation counters only once revealed_at is set.
ALTER TABLE discovery_market_account_reviews
  ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS discovery_market_account_reviews_subject_idx
  ON discovery_market_account_reviews (subject_account_id, status);

CREATE TABLE IF NOT EXISTS discovery_market_listings (
  listing_id text PRIMARY KEY,
  listing_slug text NOT NULL DEFAULT '',
  product_slug text NOT NULL DEFAULT '',
  account_id text NOT NULL,
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
  price_amount text NOT NULL,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  quantity_cap integer NOT NULL DEFAULT 0,
  max_units_per_order integer NULL,
  max_units_per_day integer NULL,
  max_units_per_customer_account integer NULL,
  supply_total_quantity integer NULL,
  active_held_quantity integer NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_market_listings
  ADD COLUMN IF NOT EXISTS listing_slug text NOT NULL DEFAULT '';

ALTER TABLE discovery_market_listings
  ADD COLUMN IF NOT EXISTS product_slug text NOT NULL DEFAULT '';

ALTER TABLE discovery_market_listings
  ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500;

ALTER TABLE discovery_market_listings
  ADD COLUMN IF NOT EXISTS product_measure_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS graded_card jsonb NULL,
  ADD COLUMN IF NOT EXISTS supply_total_quantity integer NULL,
  ADD COLUMN IF NOT EXISTS active_held_quantity integer NULL;

ALTER TABLE discovery_market_listings
  ADD COLUMN IF NOT EXISTS max_units_per_order integer NULL,
  ADD COLUMN IF NOT EXISTS max_units_per_day integer NULL,
  ADD COLUMN IF NOT EXISTS max_units_per_customer_account integer NULL;

CREATE INDEX IF NOT EXISTS discovery_market_listings_catalog_item_idx
  ON discovery_market_listings (catalog_catalog_item_id);
CREATE INDEX IF NOT EXISTS discovery_market_listings_version_idx
  ON discovery_market_listings (product_id);
CREATE INDEX IF NOT EXISTS discovery_market_listings_account_idx
  ON discovery_market_listings (account_id);
CREATE INDEX IF NOT EXISTS discovery_market_listings_status_idx
  ON discovery_market_listings (status);
CREATE INDEX IF NOT EXISTS discovery_market_listings_selected_options_idx
  ON discovery_market_listings USING gin (selected_options);

CREATE TABLE IF NOT EXISTS discovery_market_supply_items (
  item_id text PRIMARY KEY,
  account_id text NULL,
  catalog_catalog_item_id text NULL,
  product_id text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  graded_card jsonb NULL,
  storage_location_id text NULL,
  total_quantity integer NOT NULL CHECK (total_quantity >= 0),
  last_stream_version integer NOT NULL CHECK (last_stream_version >= 1),
  updated_at timestamptz NOT NULL
);

ALTER TABLE discovery_market_supply_items
  ADD COLUMN IF NOT EXISTS account_id text NULL,
  ADD COLUMN IF NOT EXISTS catalog_catalog_item_id text NULL,
  ADD COLUMN IF NOT EXISTS product_id text NULL,
  ADD COLUMN IF NOT EXISTS selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS graded_card jsonb NULL,
  ADD COLUMN IF NOT EXISTS storage_location_id text NULL;

CREATE TABLE IF NOT EXISTS discovery_market_supply_holds (
  hold_id text PRIMARY KEY,
  item_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  status text NOT NULL,
  released_at timestamptz NULL,
  last_stream_version integer NOT NULL CHECK (last_stream_version >= 1),
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS discovery_market_supply_holds_item_idx
  ON discovery_market_supply_holds (item_id, status);

CREATE TABLE IF NOT EXISTS discovery_market_supply_locations (
  storage_location_id text PRIMARY KEY,
  account_id text NOT NULL,
  name text NOT NULL,
  ship_from_code text NOT NULL,
  ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_archived boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS discovery_market_supply_locations_account_idx
  ON discovery_market_supply_locations (account_id, is_archived);

CREATE TABLE IF NOT EXISTS discovery_market_product_measures (
  catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  measure_snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_item_id, product_id)
);

CREATE INDEX IF NOT EXISTS discovery_market_product_measures_catalog_idx
  ON discovery_market_product_measures (catalog_item_id);

CREATE TABLE IF NOT EXISTS discovery_offer_demand_matches (
  offer_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  price_amount text NOT NULL,
  quantity_requested integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'submitted',
  accepted_seller_account_id text NULL,
  accepted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_offer_demand_matches_catalog_item_idx
  ON discovery_offer_demand_matches (catalog_catalog_item_id);
CREATE INDEX IF NOT EXISTS discovery_offer_demand_matches_product_idx
  ON discovery_offer_demand_matches (product_id);
CREATE INDEX IF NOT EXISTS discovery_offer_demand_matches_buyer_idx
  ON discovery_offer_demand_matches (buyer_account_id);
CREATE INDEX IF NOT EXISTS discovery_offer_demand_matches_status_idx
  ON discovery_offer_demand_matches (status);
CREATE INDEX IF NOT EXISTS discovery_offer_demand_matches_selected_options_idx
  ON discovery_offer_demand_matches USING gin (selected_options);

CREATE TABLE IF NOT EXISTS discovery_item_detail_sell_list_lines (
  seller_account_id text NOT NULL,
  line_id text NOT NULL,
  line_type text NOT NULL,
  offer_id text NULL,
  catalog_catalog_item_id text NOT NULL DEFAULT '',
  product_id text NOT NULL DEFAULT '',
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (seller_account_id, line_id)
);

CREATE INDEX IF NOT EXISTS discovery_item_detail_sell_list_lines_seller_idx
  ON discovery_item_detail_sell_list_lines (seller_account_id, updated_at DESC, line_id ASC);

CREATE UNIQUE INDEX IF NOT EXISTS discovery_item_detail_sell_list_lines_offer_unique_idx
  ON discovery_item_detail_sell_list_lines (seller_account_id, offer_id)
  WHERE offer_id IS NOT NULL;`;

export const discoveryMarketSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260707_discovery_market_slug_and_supply_lookup_indexes",
    description: "Create Discovery market lookup indexes for seller, listing, product, and supply facts.",
    statements: [
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discovery_market_accounts_seller_slug_idx
  ON discovery_market_accounts (seller_slug) WHERE seller_slug <> '';`,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discovery_market_listings_listing_slug_idx
  ON discovery_market_listings (listing_slug) WHERE listing_slug <> '';`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_market_listings_product_slug_idx
  ON discovery_market_listings (product_slug);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_market_supply_items_account_catalog_idx
  ON discovery_market_supply_items (account_id, catalog_catalog_item_id);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_market_supply_items_storage_location_idx
  ON discovery_market_supply_items (storage_location_id);`,
    ],
  },
  {
    migrationId: "20260710_discovery_market_accounts_role_split_drop_legacy_columns",
    description:
      "Drop the pre-role-split blended reputation columns from discovery_market_accounts now that as-seller/as-buyer columns are populated (m108).",
    statements: [
      `SET lock_timeout = '2s'`,
      `ALTER TABLE discovery_market_accounts
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
    migrationId: "20260711_discovery_market_account_reviews_reveal",
    description:
      "Add the revealed_at gate to discovery_market_account_reviews and mark every existing (pre-launch) row revealed (m108).",
    statements: [
      `SET lock_timeout = '5s'`,
      `ALTER TABLE discovery_market_account_reviews ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL`,
      `UPDATE discovery_market_account_reviews
   SET revealed_at = updated_at
   WHERE status = 'active'
     AND revealed_at IS NULL`,
    ],
  },
  {
    migrationId: "20260711_discovery_market_accounts_created_at_backfill",
    description:
      "Backfill discovery_market_accounts.created_at for rows that predate the column (m108 public profile, #4268); best-effort approximation from updated_at since the true registration timestamp was never captured pre-launch.",
    statements: [
      `SET lock_timeout = '2s'`,
      `UPDATE discovery_market_accounts
   SET created_at = updated_at
   WHERE created_at IS NULL`,
    ],
  },
  {
    migrationId: "20260711_discovery_market_account_reviews_public_list_idx",
    description:
      "Index discovery_market_account_reviews for the public profile's revealed-only, role-filterable, paginated review list (m108, #4268).",
    statements: [
      `SET lock_timeout = '5s'`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_market_account_reviews_public_list_idx
  ON discovery_market_account_reviews (subject_account_id, revealed_at, updated_at DESC)
  WHERE status = 'active' AND revealed_at IS NOT NULL;`,
    ],
  },
];
