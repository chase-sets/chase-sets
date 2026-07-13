export const feedbackCaseProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS customer_feedback_feedback_cases (
  case_id text PRIMARY KEY,
  stream_id text NOT NULL UNIQUE,
  invitation_id text NOT NULL UNIQUE,
  survey_kind text NOT NULL,
  survey_version text NOT NULL,
  question_version text NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  submission_idempotency_key text NOT NULL,
  submitted_at timestamptz NOT NULL,
  open_reason text NOT NULL CHECK (open_reason IN ('low-score', 'flagged')),
  status text NOT NULL CHECK (status IN ('new', 'triaged', 'actioned', 'closed')),
  owner_id text NULL,
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_at timestamptz NULL,
  disposition text NULL CHECK (
    disposition IS NULL OR disposition IN (
      'support-resolved', 'product-change', 'customer-education', 'no-action', 'duplicate', 'spam', 'redacted'
    )
  ),
  duplicate_of_case_id text NULL,
  work_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  consent_status text NOT NULL CHECK (consent_status IN ('granted', 'not-granted', 'withdrawn')),
  consent_version text NOT NULL,
  consent_granted_at timestamptz NULL,
  consent_withdrawn_at timestamptz NULL,
  follow_up_status text NOT NULL CHECK (
    follow_up_status IN ('not-requested', 'requested', 'sent', 'completed', 'cancelled')
  ),
  follow_up_delivery_status text NOT NULL DEFAULT 'not-requested' CHECK (
    follow_up_delivery_status IN ('not-requested', 'pending', 'sent', 'failed', 'suppressed', 'retry-exhausted', 'no-recipient')
  ),
  follow_up_delivery_reference text NULL,
  follow_up_channel text NULL CHECK (follow_up_channel IS NULL OR follow_up_channel IN ('web', 'email', 'sms', 'rcs')),
  follow_up_template_version integer NULL,
  follow_up_sent_at timestamptz NULL,
  follow_up_outcome text NULL CHECK (
    follow_up_outcome IS NULL OR follow_up_outcome IN ('resolved', 'unresolved', 'no-response', 'declined')
  ),
  opened_at timestamptz NOT NULL,
  triaged_at timestamptz NULL,
  actioned_at timestamptz NULL,
  closed_at timestamptz NULL,
  reopened_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_stream_version bigint NOT NULL DEFAULT 0
);

ALTER TABLE customer_feedback_feedback_cases
  ADD COLUMN IF NOT EXISTS follow_up_delivery_status text NOT NULL DEFAULT 'not-requested',
  ADD COLUMN IF NOT EXISTS follow_up_channel text NULL,
  ADD COLUMN IF NOT EXISTS follow_up_template_version integer NULL,
  ADD COLUMN IF NOT EXISTS follow_up_sent_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS customer_feedback_feedback_cases_queue_idx
  ON customer_feedback_feedback_cases (status, priority, due_at, opened_at, case_id);

CREATE INDEX IF NOT EXISTS customer_feedback_feedback_cases_owner_queue_idx
  ON customer_feedback_feedback_cases (owner_id, status, priority, due_at, case_id);

CREATE INDEX IF NOT EXISTS customer_feedback_feedback_cases_duplicate_idx
  ON customer_feedback_feedback_cases (duplicate_of_case_id, case_id)
  WHERE duplicate_of_case_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_feedback_feedback_case_timeline (
  case_id text NOT NULL,
  stream_version bigint NOT NULL,
  event_type text NOT NULL,
  actor_id text NOT NULL,
  acted_at timestamptz NOT NULL,
  event_data jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (case_id, stream_version)
);

CREATE INDEX IF NOT EXISTS customer_feedback_feedback_case_timeline_case_idx
  ON customer_feedback_feedback_case_timeline (case_id, stream_version);
`;
