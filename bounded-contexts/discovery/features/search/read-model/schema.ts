export const discoverySearchSchemaSql = `CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS discovery_search_catalog_items (
  catalog_item_id text PRIMARY KEY,
  slug text NOT NULL DEFAULT '',
  language_code text NOT NULL DEFAULT 'en',
  title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  title text NOT NULL DEFAULT '',
  subtitle_i18n jsonb NULL,
  subtitle text NULL,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  status text NOT NULL DEFAULT 'draft',
  field_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  category_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_search_catalog_items
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '';

ALTER TABLE discovery_search_catalog_items
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS discovery_search_catalog_items_slug_idx ON discovery_search_catalog_items (slug) WHERE slug <> '';
CREATE INDEX IF NOT EXISTS discovery_search_catalog_items_language_idx ON discovery_search_catalog_items (language_code);
CREATE INDEX IF NOT EXISTS discovery_search_catalog_items_blueprint_idx ON discovery_search_catalog_items (blueprint_id);
CREATE INDEX IF NOT EXISTS discovery_search_catalog_items_status_idx ON discovery_search_catalog_items (status);
CREATE INDEX IF NOT EXISTS discovery_search_catalog_items_category_ids_idx ON discovery_search_catalog_items USING gin (category_ids);

CREATE TABLE IF NOT EXISTS discovery_search_catalog_blueprints (
  blueprint_id text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_search_catalog_categories (
  category_id text PRIMARY KEY,
  slug text NOT NULL DEFAULT '',
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_search_catalog_categories
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS discovery_search_catalog_categories_slug_idx ON discovery_search_catalog_categories (slug) WHERE slug <> '';

CREATE TABLE IF NOT EXISTS discovery_search_items (
  catalog_item_id text PRIMARY KEY,
  slug text NOT NULL DEFAULT '',
  language_code text NOT NULL DEFAULT 'en',
  title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  title text NOT NULL DEFAULT '',
  subtitle_i18n jsonb NULL,
  subtitle text NULL,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  blueprint_name text NULL,
  status text NOT NULL DEFAULT 'draft',
  category_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  category_slugs jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_values_text text NOT NULL DEFAULT '',
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  search_text tsvector,
  search_text_simple tsvector,
  search_embedding vector(1536),
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
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS discovery_search_items_slug_idx ON discovery_search_items (slug) WHERE slug <> '';
CREATE INDEX IF NOT EXISTS discovery_search_items_language_idx ON discovery_search_items (language_code);
CREATE INDEX IF NOT EXISTS discovery_search_items_search_text_idx ON discovery_search_items USING gin (search_text);
CREATE INDEX IF NOT EXISTS discovery_search_items_search_text_simple_idx ON discovery_search_items USING gin (search_text_simple);
CREATE INDEX IF NOT EXISTS discovery_search_items_status_idx ON discovery_search_items (status);
CREATE INDEX IF NOT EXISTS discovery_search_items_blueprint_idx ON discovery_search_items (blueprint_id);
CREATE INDEX IF NOT EXISTS discovery_search_items_tags_idx ON discovery_search_items USING gin (tags);
CREATE INDEX IF NOT EXISTS discovery_search_items_category_slugs_idx ON discovery_search_items USING gin (category_slugs);
CREATE INDEX IF NOT EXISTS discovery_search_items_category_names_idx ON discovery_search_items USING gin (category_names);`;
