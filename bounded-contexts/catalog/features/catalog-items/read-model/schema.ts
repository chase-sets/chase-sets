export const catalogCatalogItemSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_items (
  catalog_item_id text PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS catalog_external_product_references (
  provider_key text NOT NULL,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL REFERENCES catalog_items(catalog_item_id) ON DELETE CASCADE,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, external_key)
);

CREATE TABLE IF NOT EXISTS catalog_admin_catalog_item_list_pages (
  catalog_item_id text PRIMARY KEY REFERENCES catalog_items(catalog_item_id) ON DELETE CASCADE,
  language_code text NOT NULL DEFAULT 'en',
  title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  title text NOT NULL DEFAULT '',
  subtitle_i18n jsonb NULL,
  subtitle text NULL,
  blueprint_id text NULL,
  blueprint jsonb NULL,
  status text NOT NULL DEFAULT 'draft',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_admin_catalog_item_detail_pages (
  catalog_item_id text PRIMARY KEY REFERENCES catalog_items(catalog_item_id) ON DELETE CASCADE,
  language_code text NOT NULL DEFAULT 'en',
  title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  title text NOT NULL DEFAULT '',
  subtitle_i18n jsonb NULL,
  subtitle text NULL,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  blueprint jsonb NULL,
  status text NOT NULL DEFAULT 'draft',
  field_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_product_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_status_idx
  ON catalog_admin_catalog_item_list_pages (status);
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_blueprint_idx
  ON catalog_admin_catalog_item_list_pages (blueprint_id);
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_language_idx
  ON catalog_admin_catalog_item_list_pages (language_code);
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_title_idx
  ON catalog_admin_catalog_item_list_pages USING gin (to_tsvector('simple', title || ' ' || COALESCE(subtitle, '')));
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_tags_idx
  ON catalog_admin_catalog_item_list_pages USING gin (tags);
CREATE INDEX IF NOT EXISTS catalog_external_product_references_catalog_item_idx
  ON catalog_external_product_references (catalog_item_id);

ALTER TABLE catalog_items
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb;

ALTER TABLE catalog_admin_catalog_item_list_pages
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL;

ALTER TABLE catalog_admin_catalog_item_detail_pages
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS external_product_references jsonb NOT NULL DEFAULT '[]'::jsonb;`;
