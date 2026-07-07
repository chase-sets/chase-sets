export const reportedContentSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_operations_reported_content_queue_pages (
  target_type text NOT NULL,
  target_id text NOT NULL,
  target_owner_account_id text NULL,
  status text NOT NULL,
  report_count integer NOT NULL DEFAULT 0,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  reports jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_reported_at timestamptz NOT NULL,
  last_reported_at timestamptz NOT NULL,
  auto_unlisted_at timestamptz NULL,
  auto_unlist_report_id text NULL,
  auto_unlist_threshold integer NULL,
  last_action text NULL,
  last_action_at timestamptz NULL,
  last_action_note text NULL,
  last_action_by_user_id text NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (target_type, target_id)
);

CREATE INDEX IF NOT EXISTS platform_operations_reported_content_status_idx
  ON platform_operations_reported_content_queue_pages (status, last_reported_at DESC);
`;
