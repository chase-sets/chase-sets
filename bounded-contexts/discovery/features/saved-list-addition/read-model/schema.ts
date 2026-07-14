/** Discovery-local, replayable Saved List picker view. */
export const discoverySavedListPickerSchemaSql = `
CREATE TABLE IF NOT EXISTS discovery_saved_list_picker (
  list_id text PRIMARY KEY,
  owner_account_id text NOT NULL,
  title text NOT NULL,
  lifecycle text NOT NULL,
  line_count integer NOT NULL,
  tracked_unit_count integer NOT NULL,
  line_quantities jsonb NOT NULL DEFAULT '{}'::jsonb,
  list_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  changed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS discovery_saved_list_picker_owner_recent_idx
  ON discovery_saved_list_picker (owner_account_id, changed_at DESC, list_id DESC)
  WHERE lifecycle = 'active';
`;
