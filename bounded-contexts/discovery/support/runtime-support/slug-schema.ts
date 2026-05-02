export const discoverySlugSchemaSql = `CREATE TABLE IF NOT EXISTS discovery_slug_redirects (
  entity_kind text NOT NULL,
  slug text NOT NULL,
  entity_id text NOT NULL,
  target_slug text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_kind, slug)
);

CREATE INDEX IF NOT EXISTS discovery_slug_redirects_target_idx
  ON discovery_slug_redirects (entity_kind, target_slug);`;
