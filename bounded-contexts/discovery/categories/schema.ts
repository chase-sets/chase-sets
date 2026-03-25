export const discoveryCategorySchemaSql = `CREATE TABLE IF NOT EXISTS discovery_categories (
  category_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  parent_category_id text NULL,
  parent_category jsonb NULL,
  display_order integer NOT NULL DEFAULT 0,
  item_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_categories_status_idx ON discovery_categories (status);
CREATE INDEX IF NOT EXISTS discovery_categories_parent_idx ON discovery_categories (parent_category_id);`;
