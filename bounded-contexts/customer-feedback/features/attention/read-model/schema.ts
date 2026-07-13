export const feedbackAttentionProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS customer_feedback_case_attention (
  attention_id text PRIMARY KEY,
  case_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'resolved')),
  reason text NOT NULL CHECK (reason IN ('low-score', 'reopened', 'sla-breach')),
  rule_version text NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  owner_id text NULL,
  opened_at timestamptz NOT NULL,
  triaged_at timestamptz NULL,
  due_at timestamptz NULL,
  triage_due_at timestamptz NOT NULL,
  closed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_stream_version bigint NOT NULL DEFAULT 0,
  UNIQUE (case_id, attention_id)
);

CREATE INDEX IF NOT EXISTS customer_feedback_case_attention_queue_idx
  ON customer_feedback_case_attention (state, priority, due_at, triage_due_at, attention_id);

CREATE INDEX IF NOT EXISTS customer_feedback_case_attention_owner_idx
  ON customer_feedback_case_attention (owner_id, state, priority, attention_id);
`;
