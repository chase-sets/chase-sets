export const catalogProductContentsSchemaSql = `
CREATE TABLE IF NOT EXISTS catalog_product_content_types (
  content_type_id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  display_name jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  sort_order integer NOT NULL DEFAULT 100,
  discovery_search_weight numeric NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_product_content_types_status_idx
  ON catalog_product_content_types (status, sort_order, key);

CREATE TABLE IF NOT EXISTS catalog_product_content_inclusion_policies (
  inclusion_policy_id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  display_name jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  sort_order integer NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_product_content_inclusion_policies_status_idx
  ON catalog_product_content_inclusion_policies (status, sort_order, key);

CREATE TABLE IF NOT EXISTS catalog_resolved_product_contents (
  line_id text PRIMARY KEY,
  container_catalog_item_id text NOT NULL REFERENCES catalog_items(catalog_item_id) ON DELETE CASCADE,
  container_selected_options jsonb NULL,
  container_product_id text NULL,
  contained_catalog_item_id text NULL REFERENCES catalog_items(catalog_item_id) ON DELETE SET NULL,
  contained_selected_options jsonb NULL,
  contained_product_id text NULL,
  quantity integer NULL,
  content_type_id text NOT NULL REFERENCES catalog_product_content_types(content_type_id),
  content_type_display_name jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  content_type_discovery_search_weight numeric NULL,
  inclusion_policy_id text NULL REFERENCES catalog_product_content_inclusion_policies(inclusion_policy_id),
  inclusion_policy_display_name jsonb NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution_status text NOT NULL DEFAULT 'resolved',
  target_lifecycle_status text NULL,
  resolved_fact_hash text NOT NULL,
  resolver_version integer NOT NULL DEFAULT 1,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE catalog_resolved_product_contents
  ADD COLUMN IF NOT EXISTS content_type_display_name jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS content_type_discovery_search_weight numeric NULL,
  ADD COLUMN IF NOT EXISTS inclusion_policy_display_name jsonb NULL;

CREATE INDEX IF NOT EXISTS catalog_resolved_product_contents_container_idx
  ON catalog_resolved_product_contents (container_catalog_item_id, container_product_id, content_type_id);

CREATE INDEX IF NOT EXISTS catalog_resolved_product_contents_contained_idx
  ON catalog_resolved_product_contents (contained_catalog_item_id, contained_product_id, content_type_id)
  WHERE contained_catalog_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS catalog_resolved_product_contents_hash_idx
  ON catalog_resolved_product_contents (resolved_fact_hash);
`;
