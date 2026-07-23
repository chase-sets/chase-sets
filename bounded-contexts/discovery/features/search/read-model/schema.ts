import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const discoverySearchSchemaSql = `CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS discovery_search_catalog_items (
  catalog_item_id text PRIMARY KEY,
  slug text NOT NULL DEFAULT '',
  language_code text NOT NULL DEFAULT 'en',
  title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  title text NOT NULL DEFAULT '',
  subtitle_i18n jsonb NULL,
  subtitle text NULL,
  display_badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  status text NOT NULL DEFAULT 'draft',
  field_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  category_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_fallback jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_search_catalog_items
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '';

ALTER TABLE discovery_search_catalog_items
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS display_badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS image_fallback jsonb NULL;

-- Resolved Catalog alias facts (#1910) consumed by Discovery search (#1911).
-- The published alias list per language is stored on the search source table so
-- rebuild folds aliases into the tsvectors idempotently and a retracted (empty)
-- resolved fact removes them. Display (title/subtitle/slug) is owned elsewhere
-- (#1914); these columns never feed display.
ALTER TABLE discovery_search_catalog_items
  ADD COLUMN IF NOT EXISTS resolved_aliases jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS discovery_search_catalog_items_blueprint_idx ON discovery_search_catalog_items (blueprint_id);
CREATE INDEX IF NOT EXISTS discovery_search_catalog_items_status_idx ON discovery_search_catalog_items (status);
CREATE INDEX IF NOT EXISTS discovery_search_catalog_items_category_ids_idx ON discovery_search_catalog_items USING gin (category_ids);

CREATE TABLE IF NOT EXISTS discovery_search_catalog_blueprints (
  blueprint_id text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_search_catalog_blueprint_dimensions (
  blueprint_id text NOT NULL,
  dimension_id text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  allowed_option_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  applies_when jsonb NOT NULL DEFAULT '[]'::jsonb,
  display_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blueprint_id, dimension_id)
);

CREATE INDEX IF NOT EXISTS discovery_search_catalog_blueprint_dimensions_blueprint_idx
  ON discovery_search_catalog_blueprint_dimensions (blueprint_id, display_order);

CREATE TABLE IF NOT EXISTS discovery_search_catalog_categories (
  category_id text PRIMARY KEY,
  slug text NOT NULL DEFAULT '',
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_global_position bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_search_catalog_categories
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_global_position bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS discovery_search_catalog_fields (
  field_id text PRIMARY KEY,
  name text NOT NULL,
  value_type text NOT NULL DEFAULT 'string',
  filterable boolean NOT NULL DEFAULT false,
  searchable boolean NOT NULL DEFAULT false,
  sortable boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Catalog's authored field key (Catalog's "card-number" and similar slugs), kept
-- alongside the display name so the search projection can identify well-known
-- natural-key fields by ubiquitous-language key instead of a fragile label match
-- or a typed-id import that would couple Discovery to Catalog at runtime.
ALTER TABLE discovery_search_catalog_fields
  ADD COLUMN IF NOT EXISTS key text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS discovery_search_catalog_fields_filterable_idx ON discovery_search_catalog_fields (filterable);

CREATE TABLE IF NOT EXISTS discovery_search_catalog_reference_records (
  reference_record_id text PRIMARY KEY,
  type_key text NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  relationships jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_search_catalog_reference_records_type_key_idx
  ON discovery_search_catalog_reference_records (type_key);

-- Set/expansion browse-page addressing. Slug is the reference record's
-- own natural key (game + set code, already normalized lowercase/hyphenated by
-- the Catalog reference-record contract), not a display-title-derived slug, so
-- the URL is the natural key rather than an opaque hash-suffixed string. Only
-- set-like reference records (see SET_LIKE_REFERENCE_TYPE_KEYS) carry a
-- non-empty slug; every other reference type keeps '' and stays unaddressed.
ALTER TABLE discovery_search_catalog_reference_records
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS discovery_search_catalog_dimensions (
  dimension_id text PRIMARY KEY,
  name text NOT NULL,
  value_kind text NOT NULL DEFAULT 'unordered',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_search_catalog_dimension_options (
  option_id text PRIMARY KEY,
  dimension_id text NOT NULL,
  code text NOT NULL DEFAULT '',
  label text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  numeric_value numeric NULL,
  status text NOT NULL DEFAULT 'active',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_search_catalog_dimension_options_dimension_idx
  ON discovery_search_catalog_dimension_options (dimension_id, display_order);

CREATE TABLE IF NOT EXISTS discovery_search_items (
  catalog_item_id text PRIMARY KEY,
  slug text NOT NULL DEFAULT '',
  language_code text NOT NULL DEFAULT 'en',
  title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  title text NOT NULL DEFAULT '',
  subtitle_i18n jsonb NULL,
  subtitle text NULL,
  display_badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  blueprint_name text NULL,
  status text NOT NULL DEFAULT 'draft',
  category_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  category_slugs jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_values_text text NOT NULL DEFAULT '',
  field_filter_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  reference_filter_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  dimension_filter_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_fallback jsonb NULL,
  search_text tsvector,
  search_text_simple tsvector,
  search_embedding halfvec(1024),
  embedding_model text NULL,
  embedded_text_hash text NULL,
  embedding_updated_at timestamptz NULL,
  lowest_price_amount numeric NULL,
  visible_quantity integer NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_search_items
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '';

ALTER TABLE discovery_search_items
  ADD COLUMN IF NOT EXISTS category_slugs jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE discovery_search_items
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS display_badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE discovery_search_items
  ADD COLUMN IF NOT EXISTS field_filter_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reference_filter_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS dimension_filter_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS image_fallback jsonb NULL,
  ADD COLUMN IF NOT EXISTS embedding_model text NULL,
  ADD COLUMN IF NOT EXISTS embedded_text_hash text NULL,
  ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz NULL;

ALTER TABLE discovery_search_items
  ADD COLUMN IF NOT EXISTS lowest_price_amount numeric NULL,
  ADD COLUMN IF NOT EXISTS visible_quantity integer NULL;

-- Structured set-code + collector-number natural key, denormalized from the
-- Catalog "card-number" field and the "set"/"expansion" reference record onto
-- the search row. Normalized per the Catalog natural-key contract: trimmed
-- lowercase set code, unpadded numeric card number. Nullable because not every
-- catalog item (blueprints without a card-number field, or without a resolvable
-- set/expansion reference) carries a natural key.
ALTER TABLE discovery_search_items
  ADD COLUMN IF NOT EXISTS set_code text NULL,
  ADD COLUMN IF NOT EXISTS card_number text NULL;

CREATE INDEX IF NOT EXISTS discovery_search_items_search_text_idx ON discovery_search_items USING gin (search_text);
CREATE INDEX IF NOT EXISTS discovery_search_items_search_text_simple_idx ON discovery_search_items USING gin (search_text_simple);
CREATE INDEX IF NOT EXISTS discovery_search_items_status_idx ON discovery_search_items (status);
CREATE INDEX IF NOT EXISTS discovery_search_items_blueprint_idx ON discovery_search_items (blueprint_id);
CREATE INDEX IF NOT EXISTS discovery_search_items_tags_idx ON discovery_search_items USING gin (tags);
CREATE INDEX IF NOT EXISTS discovery_search_items_category_slugs_idx ON discovery_search_items USING gin (category_slugs);
CREATE INDEX IF NOT EXISTS discovery_search_items_category_names_idx ON discovery_search_items USING gin (category_names);
CREATE INDEX IF NOT EXISTS discovery_search_items_field_filter_values_idx ON discovery_search_items USING gin (field_filter_values);
CREATE INDEX IF NOT EXISTS discovery_search_items_reference_filter_values_idx ON discovery_search_items USING gin (reference_filter_values);
CREATE INDEX IF NOT EXISTS discovery_search_items_dimension_filter_values_idx ON discovery_search_items USING gin (dimension_filter_values);

CREATE TABLE IF NOT EXISTS discovery_search_product_contents (
  line_id text PRIMARY KEY,
  container_catalog_item_id text NOT NULL,
  container_product_id text NULL,
  contained_catalog_item_id text NOT NULL,
  contained_product_id text NULL,
  content_type_id text NOT NULL,
  content_type_search_weight numeric NOT NULL DEFAULT 0.2,
  content_search_text text NOT NULL DEFAULT '',
  content_search_text_simple text NOT NULL DEFAULT '',
  search_text tsvector,
  search_text_simple tsvector,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_search_product_contents
  ADD COLUMN IF NOT EXISTS content_type_search_weight numeric NOT NULL DEFAULT 0.2,
  ADD COLUMN IF NOT EXISTS content_search_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS content_search_text_simple text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS search_text tsvector,
  ADD COLUMN IF NOT EXISTS search_text_simple tsvector;

CREATE INDEX IF NOT EXISTS discovery_search_product_contents_container_idx
  ON discovery_search_product_contents (container_catalog_item_id, container_product_id);

CREATE INDEX IF NOT EXISTS discovery_search_product_contents_contained_idx
  ON discovery_search_product_contents (contained_catalog_item_id, contained_product_id);

CREATE INDEX IF NOT EXISTS discovery_search_product_contents_search_text_idx
  ON discovery_search_product_contents USING gin (search_text);

CREATE INDEX IF NOT EXISTS discovery_search_product_contents_search_text_simple_idx
  ON discovery_search_product_contents USING gin (search_text_simple);`;

export const discoverySearchSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260703_discovery_search_keyset_indexes",
    description: "Create Discovery search composite indexes for status-filtered keyset sorts.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_status_title_catalog_item_idx
  ON discovery_search_items (status, title, catalog_item_id);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_status_updated_catalog_item_idx
  ON discovery_search_items (status, updated_at DESC, catalog_item_id DESC);`,
    ],
  },
  {
    migrationId: "20260710_discovery_search_slug_language_indexes",
    description:
      "Move slug/language indexes on migration-added Discovery search columns into the ledger (pre-existing structure debt surfaced by the gate).",
    statements: [
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_catalog_items_slug_idx
  ON discovery_search_catalog_items (slug) WHERE slug <> ''`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_catalog_items_language_idx
  ON discovery_search_catalog_items (language_code)`,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_catalog_categories_slug_idx
  ON discovery_search_catalog_categories (slug) WHERE slug <> ''`,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_slug_idx
  ON discovery_search_items (slug) WHERE slug <> ''`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_language_idx
  ON discovery_search_items (language_code)`,
    ],
  },
  {
    migrationId: "20260710_discovery_search_voyage_embeddings",
    description:
      "Move Discovery search embeddings to Voyage 4 dimensions and create the filtered HNSW inner-product index.",
    statements: [
      `SET lock_timeout = '5s';`,
      `ALTER TABLE discovery_search_items
  ALTER COLUMN search_embedding TYPE halfvec(1024)
  USING NULL::halfvec(1024);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_embedding_hnsw_idx
  ON discovery_search_items USING hnsw (search_embedding halfvec_ip_ops)
      WHERE search_embedding IS NOT NULL;`,
    ],
  },
  {
    migrationId: "20260710_discovery_search_active_embedding_hnsw",
    description:
      "Restrict the Discovery inner-product HNSW index to active embedded Search Index rows used by semantic retrieval.",
    statements: [
      `SET lock_timeout = '5s';`,
      `DROP INDEX CONCURRENTLY IF EXISTS discovery_search_items_embedding_hnsw_idx;`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_embedding_hnsw_idx
  ON discovery_search_items USING hnsw (search_embedding halfvec_ip_ops)
  WHERE status = 'active' AND search_embedding IS NOT NULL;`,
    ],
  },
  {
    migrationId: "20260710_discovery_search_natural_key_indexes",
    description:
      "Create btree indexes on the denormalized set-code + card-number natural key for structured point lookups ahead of full-text fallback.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_set_code_card_number_idx
  ON discovery_search_items (set_code, card_number);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_blueprint_set_code_card_number_idx
  ON discovery_search_items (blueprint_id, set_code, card_number);`,
    ],
  },
  {
    migrationId: "20260710_discovery_search_reference_record_slug_index",
    description:
      "Create the unique index on the set/expansion browse-page slug so the natural-key-derived slug addresses exactly one reference record.",
    statements: [
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_catalog_reference_records_slug_idx
  ON discovery_search_catalog_reference_records (slug) WHERE slug <> ''`,
    ],
  },
  {
    migrationId: "20260714_discovery_search_market_signal_indexes",
    description:
      "Create status-filtered Search Index keyset indexes for buyer-visible lowest-price sorting in both directions.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_status_price_asc_idx
  ON discovery_search_items (status, lowest_price_amount ASC NULLS LAST, catalog_item_id ASC);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_items_status_price_desc_idx
  ON discovery_search_items (status, lowest_price_amount DESC NULLS LAST, catalog_item_id DESC);`,
    ],
  },
  {
    migrationId: "20260723_discovery_search_category_lifecycle",
    description:
      "Track Search Index category lifecycle and source revision so deprecated or archived categories stop contributing filters without stale-event overwrite.",
    statements: [
      `ALTER TABLE discovery_search_catalog_categories
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_global_position bigint NOT NULL DEFAULT 0;`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_search_catalog_categories_status_idx
  ON discovery_search_catalog_categories (status);`,
    ],
  },
];
