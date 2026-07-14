export const savedListSharedPageSchemaSql = `
CREATE TABLE IF NOT EXISTS collections_saved_list_shared_pages (
  list_id text PRIMARY KEY,
  title text NOT NULL,
  description text NULL,
  visibility text NOT NULL,
  lifecycle text NOT NULL,
  cover_line_id text NULL,
  ordered_line_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  line_count integer NOT NULL DEFAULT 0,
  show_tracked_quantities boolean NOT NULL DEFAULT false,
  show_current_estimated_value boolean NOT NULL DEFAULT false,
  source_changed_at timestamptz NOT NULL,
  source_version integer NOT NULL,
  policy_version integer NOT NULL DEFAULT 0,
  policy_changed_at timestamptz NULL,
  CHECK (visibility IN ('private', 'unlisted', 'public')),
  CHECK (lifecycle IN ('active', 'archived')),
  CHECK (jsonb_typeof(ordered_line_ids) = 'array')
);

CREATE TABLE IF NOT EXISTS collections_saved_list_shared_lines (
  list_id text NOT NULL REFERENCES collections_saved_list_shared_pages(list_id) ON DELETE CASCADE,
  line_id text NOT NULL,
  product jsonb NOT NULL,
  tracked_quantity integer NOT NULL,
  PRIMARY KEY (list_id, line_id),
  CHECK (jsonb_typeof(product) = 'object'),
  CHECK (tracked_quantity > 0)
);

CREATE TABLE IF NOT EXISTS collections_saved_list_access_policies (
  list_id text PRIMARY KEY REFERENCES collections_saved_list_shared_pages(list_id) ON DELETE CASCADE,
  owner_account_id text NOT NULL,
  unlisted_verifier text NULL,
  unlisted_generation integer NOT NULL DEFAULT 0,
  policy_version integer NOT NULL DEFAULT 0,
  changed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS collections_saved_list_shared_visibility_idx
  ON collections_saved_list_shared_pages (visibility, source_changed_at DESC)
  WHERE lifecycle = 'active' AND visibility <> 'private';
`;
