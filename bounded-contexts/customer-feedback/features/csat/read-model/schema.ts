export const csatInvitationProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS customer_feedback_csat_invitations (
  invitation_id text PRIMARY KEY,
  stream_id text NOT NULL,
  public_reference text NULL,
  state text NOT NULL,
  survey_kind text NOT NULL,
  survey_version text NOT NULL,
  question_version text NOT NULL,
  outcome_code text NOT NULL,
  source_context text NOT NULL,
  source_entity_type text NOT NULL,
  source_entity_id text NOT NULL,
  outcome_occurred_at timestamptz NOT NULL,
  outcome_idempotency_key text NOT NULL,
  correlation_id text NULL,
  subject_account_id text NOT NULL,
  subject_kind text NOT NULL,
  sampling_decision jsonb NULL,
  sampling_policy_schema_version integer NULL,
  suppression_diagnostic jsonb NULL,
  rating smallint NULL,
  comment text NULL,
  follow_up_consent boolean NULL,
  follow_up_consent_version text NULL,
  follow_up_consent_at timestamptz NULL,
  submission_idempotency_key text NULL,
  eligible_at timestamptz NOT NULL,
  issued_at timestamptz NULL,
  expires_at timestamptz NULL,
  presented_at timestamptz NULL,
  submitted_at timestamptz NULL,
  dismissed_at timestamptz NULL,
  expired_at timestamptz NULL,
  suppressed_at timestamptz NULL,
  revoked_at timestamptz NULL,
  revocation_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_feedback_csat_invitations_public_reference_idx
  ON customer_feedback_csat_invitations (public_reference)
  WHERE public_reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS customer_feedback_csat_invitations_stream_idx
  ON customer_feedback_csat_invitations (stream_id);

CREATE UNIQUE INDEX IF NOT EXISTS customer_feedback_csat_invitations_outcome_idx
  ON customer_feedback_csat_invitations (source_context, outcome_idempotency_key);

CREATE INDEX IF NOT EXISTS customer_feedback_csat_invitations_subject_cooldown_idx
  ON customer_feedback_csat_invitations (subject_account_id, outcome_code, issued_at DESC)
  WHERE issued_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_feedback_csat_invitations_expiry_idx
  ON customer_feedback_csat_invitations (expires_at)
  WHERE state IN ('issued', 'presented', 'dismissed');
`;

export const csatAnalyticsProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS customer_feedback_csat_analytics_facts (
  invitation_id text PRIMARY KEY,
  survey_kind text NULL,
  survey_version text NULL,
  question_version text NULL,
  outcome_code text NULL,
  customer_role text NULL,
  sampling_cohort text NULL,
  eligible_at timestamptz NULL,
  issued_at timestamptz NULL,
  presented_at timestamptz NULL,
  dismissed_at timestamptz NULL,
  expired_at timestamptz NULL,
  submitted_at timestamptz NULL,
  rating smallint NULL CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  last_global_position bigint NOT NULL,
  last_event_recorded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_feedback_csat_analytics_submitted_idx
  ON customer_feedback_csat_analytics_facts
  (survey_kind, survey_version, question_version, submitted_at, invitation_id)
  WHERE submitted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_feedback_csat_analytics_presented_idx
  ON customer_feedback_csat_analytics_facts
  (survey_kind, survey_version, question_version, presented_at, invitation_id)
  WHERE presented_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_feedback_csat_analytics_eligible_idx
  ON customer_feedback_csat_analytics_facts
  (survey_kind, survey_version, question_version, eligible_at, invitation_id)
  WHERE eligible_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_feedback_csat_analytics_issued_idx
  ON customer_feedback_csat_analytics_facts
  (survey_kind, survey_version, question_version, issued_at, invitation_id)
  WHERE issued_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_feedback_csat_analytics_dismissed_idx
  ON customer_feedback_csat_analytics_facts
  (survey_kind, survey_version, question_version, dismissed_at, invitation_id)
  WHERE dismissed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_feedback_csat_analytics_expired_idx
  ON customer_feedback_csat_analytics_facts
  (survey_kind, survey_version, question_version, expired_at, invitation_id)
  WHERE expired_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_feedback_csat_analytics_dimensions_idx
  ON customer_feedback_csat_analytics_facts
  (outcome_code, customer_role, sampling_cohort, invitation_id);
`;

export const csatAdminExportSchemaSql = `
CREATE TABLE IF NOT EXISTS customer_feedback_csat_export_audits (
  export_id text PRIMARY KEY,
  actor_id text NOT NULL,
  filters jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  result text NOT NULL CHECK (result IN ('completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS customer_feedback_csat_export_audits_started_idx
  ON customer_feedback_csat_export_audits (started_at DESC);
`;
