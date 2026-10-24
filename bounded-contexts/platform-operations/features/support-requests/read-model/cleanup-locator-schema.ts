export const supportEvidenceCleanupLocatorSchemaSql = `
CREATE UNLOGGED TABLE IF NOT EXISTS support_evidence_cleanup_locators (
  operation_stream_id text PRIMARY KEY,
  support_request_id text NOT NULL,
  operation_id text NOT NULL,
  state text NOT NULL,
  stream_version integer NOT NULL,
  last_activity_at timestamptz NOT NULL,
  eligible_at timestamptz NULL
);`;
export const supportEvidenceCleanupLocatorIndexSql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS support_evidence_cleanup_locators_state_idx
  ON support_evidence_cleanup_locators (state, eligible_at)`;
