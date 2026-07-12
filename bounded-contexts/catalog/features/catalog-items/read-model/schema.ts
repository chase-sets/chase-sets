import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

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
  product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_fallback jsonb NULL,
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

CREATE TABLE IF NOT EXISTS catalog_external_catalog_item_references (
  provider_key text NOT NULL,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL REFERENCES catalog_items(catalog_item_id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, external_key)
);

CREATE TABLE IF NOT EXISTS catalog_item_gtins (
  gtin text PRIMARY KEY,
  catalog_item_id text NOT NULL REFERENCES catalog_items(catalog_item_id) ON DELETE CASCADE,
  product_form text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_item_gtins_catalog_item_idx
  ON catalog_item_gtins (catalog_item_id);

CREATE TABLE IF NOT EXISTS catalog_admin_catalog_item_list_pages (
  catalog_item_id text PRIMARY KEY REFERENCES catalog_items(catalog_item_id) ON DELETE CASCADE,
  language_code text NOT NULL DEFAULT 'en',
  title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  title text NOT NULL DEFAULT '',
  subtitle_i18n jsonb NULL,
  subtitle text NULL,
  display_template_key text NULL,
  display_identity_hash text NULL,
  display_identity_resolved_at timestamptz NULL,
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
  display_template_key text NULL,
  display_identity_hash text NULL,
  display_identity_resolved_at timestamptz NULL,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  blueprint jsonb NULL,
  status text NOT NULL DEFAULT 'draft',
  field_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_catalog_item_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_product_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_fallback jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_item_display_identities (
  catalog_item_id text NOT NULL REFERENCES catalog_items(catalog_item_id) ON DELETE CASCADE,
  language_code text NOT NULL DEFAULT 'en',
  title text NOT NULL,
  subtitle text NULL,
  display_template_key text NULL,
  display_template_target_kind text NULL,
  display_template_target_id text NULL,
  display_identity_hash text NOT NULL,
  resolver_version integer NOT NULL,
  resolved_at timestamptz NOT NULL,
  last_published_display_identity_hash text NULL,
  last_published_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (catalog_item_id, language_code)
);

CREATE TABLE IF NOT EXISTS catalog_item_display_identity_recompute_work (
  catalog_item_id text PRIMARY KEY REFERENCES catalog_items(catalog_item_id) ON DELETE CASCADE,
  reason text NOT NULL,
  source_event_type text NULL,
  source_stream_id text NULL,
  source_recorded_at timestamptz NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

ALTER TABLE catalog_items
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS image_fallback jsonb NULL;

ALTER TABLE catalog_admin_catalog_item_list_pages
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS display_template_key text NULL,
  ADD COLUMN IF NOT EXISTS display_identity_hash text NULL,
  ADD COLUMN IF NOT EXISTS display_identity_resolved_at timestamptz NULL;

ALTER TABLE catalog_admin_catalog_item_detail_pages
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS display_template_key text NULL,
  ADD COLUMN IF NOT EXISTS display_identity_hash text NULL,
  ADD COLUMN IF NOT EXISTS display_identity_resolved_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS external_catalog_item_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS external_product_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS image_fallback jsonb NULL;

ALTER TABLE catalog_item_display_identities
  ADD COLUMN IF NOT EXISTS display_template_target_kind text NULL,
  ADD COLUMN IF NOT EXISTS display_template_target_id text NULL,
  ADD COLUMN IF NOT EXISTS resolver_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_published_display_identity_hash text NULL,
  ADD COLUMN IF NOT EXISTS last_published_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE catalog_item_display_identity_recompute_work
  ADD COLUMN IF NOT EXISTS source_event_type text NULL,
  ADD COLUMN IF NOT EXISTS source_stream_id text NULL,
  ADD COLUMN IF NOT EXISTS source_recorded_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text NULL,
  ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_status_idx
  ON catalog_admin_catalog_item_list_pages (status);
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_blueprint_idx
  ON catalog_admin_catalog_item_list_pages (blueprint_id);
-- catalog_admin_catalog_item_list_pages_language_idx moved to the schemaMigrations ledger
-- (boot-time indexes on migration-added columns are forbidden by the structure gate).
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_title_idx
  ON catalog_admin_catalog_item_list_pages USING gin (to_tsvector('simple', title || ' ' || COALESCE(subtitle, '')));
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_tags_idx
  ON catalog_admin_catalog_item_list_pages USING gin (tags);
CREATE INDEX IF NOT EXISTS catalog_external_product_references_catalog_item_idx
  ON catalog_external_product_references (catalog_item_id);

CREATE INDEX IF NOT EXISTS catalog_external_catalog_item_references_catalog_item_idx
  ON catalog_external_catalog_item_references (catalog_item_id);

CREATE INDEX IF NOT EXISTS catalog_item_display_identities_hash_idx
  ON catalog_item_display_identities (display_identity_hash);
CREATE INDEX IF NOT EXISTS catalog_item_display_identities_template_idx
  ON catalog_item_display_identities (display_template_key);
-- catalog_item_display_identity_recompute_work_status_idx moved to the schemaMigrations ledger
-- (boot-time indexes on migration-added columns are forbidden by the structure gate).`;

export const catalogCatalogItemSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260711_catalog_admin_list_pages_language_idx",
    description: "Recreate the admin list-pages language filter index through the ledger.",
    statements: [
      "SET lock_timeout = '5s';",
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_admin_catalog_item_list_pages_language_idx
  ON catalog_admin_catalog_item_list_pages (language_code)`,
    ],
  },
  {
    migrationId: "20260711_catalog_display_identity_recompute_work_status_idx",
    description: "Recreate the display-identity recompute work-queue index through the ledger.",
    statements: [
      "SET lock_timeout = '5s';",
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_item_display_identity_recompute_work_status_idx
  ON catalog_item_display_identity_recompute_work (status, available_at, updated_at)`,
    ],
  },
];
