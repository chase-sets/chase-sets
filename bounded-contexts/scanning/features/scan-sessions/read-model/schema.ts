export const scanSessionSchemaSql = `
CREATE TABLE IF NOT EXISTS scanning_scan_sessions (
  session_id text PRIMARY KEY,
  account_id text NOT NULL,
  purpose text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  confirmed_count integer NOT NULL DEFAULT 0,
  corrected_count integer NOT NULL DEFAULT 0,
  unidentified_count integer NOT NULL DEFAULT 0,
  discarded_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS scanning_scan_records (
  session_id text NOT NULL REFERENCES scanning_scan_sessions(session_id) ON DELETE CASCADE,
  scan_id text NOT NULL,
  asset_ref text NOT NULL,
  status text NOT NULL,
  candidates jsonb NOT NULL DEFAULT '[]',
  product jsonb NULL,
  candidate_source text NULL,
  rejected_candidate_ref text NULL,
  reason text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_stream_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, scan_id)
);
CREATE INDEX IF NOT EXISTS scanning_scan_sessions_account_idx ON scanning_scan_sessions(account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS scanning_scan_records_status_idx ON scanning_scan_records(session_id, status);
`;
