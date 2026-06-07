export const postagePolicySchemaSql = `
CREATE TABLE IF NOT EXISTS ordering_postage_policy_pages (
  policy_id text PRIMARY KEY,
  label text NOT NULL,
  status text NOT NULL,
  policy_version text NOT NULL,
  payload jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  activation_reason text NULL,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  activated_at timestamptz NULL,
  retired_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS ordering_postage_policy_pages_status_idx
  ON ordering_postage_policy_pages (status, effective_from DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS ordering_postage_policy_pages_version_idx
  ON ordering_postage_policy_pages (policy_version, updated_at DESC);

CREATE TABLE IF NOT EXISTS ordering_postage_policy_history (
  history_id bigserial PRIMARY KEY,
  policy_id text NOT NULL,
  event_type text NOT NULL,
  actor_user_id text NOT NULL,
  reason text NULL,
  status text NOT NULL,
  policy_version text NOT NULL,
  payload jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ordering_postage_policy_history_policy_idx
  ON ordering_postage_policy_history (policy_id, recorded_at DESC, history_id DESC);
`;
