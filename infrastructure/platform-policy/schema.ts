// Shared platform-policy tables. A context adopts this machinery by folding
// `platformPolicySchemaSql` into its own `schemaSql` (the same composition
// pattern `@chase-sets/notification-outbox` uses) -- each context gets its
// own copy of these tables in its own database, scoped implicitly by which
// context ever writes documents into it.
//
// `stream_version` is the stream version of the revision a document row
// holds. The projection applies an event only when its version is higher, so
// a replay over kept rows never moves a row back to an earlier revision.
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
  updated_at timestamptz NOT NULL,
  stream_version bigint NOT NULL DEFAULT 0
);

ALTER TABLE platform_policy_documents
  ADD COLUMN IF NOT EXISTS stream_version bigint NOT NULL DEFAULT 0;

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

// A context that folds `platformPolicySchemaSql` also spreads this ledger into
// its `schemaMigrations`. A row projected before `stream_version` existed sits
// at 0, so the first replay over it would move it back to its first revision.
// The backfill takes the version from the events the projection has applied
// (the row's history), not the stream head, because the projection may lag.
export const platformPolicySchemaMigrations: readonly Readonly<{
  migrationId: string;
  description: string;
  statements: readonly string[];
}>[] = [
  {
    migrationId: "20261123_platform_policy_document_stream_version",
    description:
      "Record on each policy document row the stream version of the revision it holds, so a replay applies only newer revisions.",
    statements: [
      `ALTER TABLE platform_policy_documents
  ADD COLUMN IF NOT EXISTS stream_version bigint NOT NULL DEFAULT 0`,
      `UPDATE platform_policy_documents AS policy_document
SET stream_version = projected.stream_version
FROM (
  SELECT history.document_id, max(stored_event.stream_version) AS stream_version
  FROM platform_policy_document_history AS history
  JOIN event_store_events AS stored_event ON stored_event.event_id = history.event_id
  GROUP BY history.document_id
) AS projected
WHERE projected.document_id = policy_document.document_id
  AND policy_document.stream_version < projected.stream_version`,
    ],
  },
];
