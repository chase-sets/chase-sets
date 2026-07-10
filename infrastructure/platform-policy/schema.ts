// Shared platform-policy tables. A context adopts this machinery by folding
// `platformPolicySchemaSql` into its own `schemaSql` (the same composition
// pattern `@chase-sets/notification-outbox` uses) -- each context gets its
// own copy of these tables in its own database, scoped implicitly by which
// context ever writes documents into it.
export const platformPolicySchemaSql = `
CREATE TABLE IF NOT EXISTS platform_policy_documents (
  document_id text PRIMARY KEY,
  policy_key text NOT NULL,
  context_name text NOT NULL,
  schema_summary text NOT NULL,
  status text NOT NULL,
  value jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_policy_documents_policy_key_idx
  ON platform_policy_documents (policy_key, effective_from DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_policy_document_history (
  history_id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  document_id text NOT NULL,
  policy_key text NOT NULL,
  event_type text NOT NULL,
  actor_user_id text NOT NULL,
  status text NOT NULL,
  value jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_policy_document_history_document_idx
  ON platform_policy_document_history (document_id, recorded_at DESC, history_id DESC);
`;

export const PLATFORM_POLICY_DOCUMENTS_TABLE_NAME = "platform_policy_documents";
export const PLATFORM_POLICY_DOCUMENT_HISTORY_TABLE_NAME = "platform_policy_document_history";
