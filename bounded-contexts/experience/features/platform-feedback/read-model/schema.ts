export const platformFeedbackSchemaSql = `
CREATE TABLE IF NOT EXISTS experience_platform_feedback_pages (
  feedback_id text PRIMARY KEY,
  user_id text NOT NULL,
  account_id text NOT NULL,
  rating integer NOT NULL,
  topic text NOT NULL,
  comment text NULL,
  follow_up_consent boolean NOT NULL DEFAULT false,
  workflow text NOT NULL,
  source_route_path text NOT NULL,
  related_entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_entity_key text NULL,
  status text NOT NULL,
  submitted_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  reviewed_by_user_id text NULL,
  reviewed_at timestamptz NULL,
  archived_by_user_id text NULL,
  archived_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS experience_platform_feedback_entity_unique_idx
  ON experience_platform_feedback_pages (account_id, workflow, related_entity_key)
  WHERE related_entity_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS experience_platform_feedback_list_idx
  ON experience_platform_feedback_pages (status, submitted_at DESC, feedback_id DESC);

CREATE INDEX IF NOT EXISTS experience_platform_feedback_workflow_idx
  ON experience_platform_feedback_pages (workflow, submitted_at DESC, feedback_id DESC);

CREATE TABLE IF NOT EXISTS experience_platform_feedback_prompt_pages (
  prompt_id text PRIMARY KEY,
  user_id text NOT NULL,
  account_id text NOT NULL,
  workflow text NOT NULL,
  source_route_path text NOT NULL,
  related_entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_entity_key text NULL,
  dismissed_at timestamptz NOT NULL,
  snoozed_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS experience_platform_feedback_prompt_lookup_idx
  ON experience_platform_feedback_prompt_pages (account_id, workflow, related_entity_key, snoozed_until DESC);

CREATE INDEX IF NOT EXISTS experience_platform_feedback_prompt_window_idx
  ON experience_platform_feedback_prompt_pages (account_id, workflow, snoozed_until DESC)
  WHERE related_entity_key IS NULL;
`;
