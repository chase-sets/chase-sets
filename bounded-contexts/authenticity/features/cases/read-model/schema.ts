export const authenticityCaseSchemaSql = `
CREATE TABLE IF NOT EXISTS authenticity_cases (
  case_id text PRIMARY KEY,
  order_id text NOT NULL,
  seller_account_id text NOT NULL,
  buyer_account_id text NOT NULL,
  order_snapshot jsonb NOT NULL,
  authenticity_plan jsonb NOT NULL,
  status text NOT NULL DEFAULT 'awaiting-inbound',
  inbound_tracking_identifier text NULL,
  verdict text NULL,
  verdict_reason_codes jsonb NOT NULL DEFAULT '[]',
  checklist_results jsonb NOT NULL DEFAULT '[]',
  evidence_photo_refs jsonb NOT NULL DEFAULT '[]',
  line_notes jsonb NOT NULL DEFAULT '[]',
  inspector_account_id text NULL,
  outbound_tracking_identifier text NULL,
  return_reason text NULL,
  opened_at timestamptz NOT NULL,
  received_at timestamptz NULL,
  inspection_started_at timestamptz NULL,
  verdict_recorded_at timestamptz NULL,
  forwarded_at timestamptz NULL,
  returned_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS authenticity_cases_order_idx
  ON authenticity_cases (order_id);

CREATE INDEX IF NOT EXISTS authenticity_cases_queue_idx
  ON authenticity_cases (status, opened_at);

CREATE INDEX IF NOT EXISTS authenticity_cases_seller_idx
  ON authenticity_cases (seller_account_id, status);
`;
