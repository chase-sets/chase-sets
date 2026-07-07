export const riskAlertsSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_operations_risk_alert_account_sources (
  account_id text PRIMARY KEY,
  account_created_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_operations_risk_alert_velocity_sources (
  source_kind text NOT NULL,
  source_id text NOT NULL,
  account_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  amount_cents bigint NOT NULL DEFAULT 0,
  reviewer_account_id text NULL,
  reviewer_account_created_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (source_kind, source_id, account_id)
);

CREATE INDEX IF NOT EXISTS platform_operations_risk_alert_velocity_account_window_idx
  ON platform_operations_risk_alert_velocity_sources (account_id, source_kind, occurred_at DESC);

CREATE INDEX IF NOT EXISTS platform_operations_risk_alert_velocity_reviewer_idx
  ON platform_operations_risk_alert_velocity_sources (reviewer_account_id)
  WHERE reviewer_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_operations_risk_alert_queue_pages (
  alert_id text PRIMARY KEY,
  account_id text NOT NULL,
  alert_kind text NOT NULL,
  status text NOT NULL,
  severity text NOT NULL,
  manual_payout_review_candidate boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  threshold jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_triggered_at timestamptz NOT NULL,
  last_triggered_at timestamptz NOT NULL,
  last_action text NULL,
  last_action_at timestamptz NULL,
  last_action_note text NULL,
  last_action_by_user_id text NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (account_id, alert_kind)
);

CREATE INDEX IF NOT EXISTS platform_operations_risk_alert_queue_status_idx
  ON platform_operations_risk_alert_queue_pages (status, last_triggered_at DESC);
`;
