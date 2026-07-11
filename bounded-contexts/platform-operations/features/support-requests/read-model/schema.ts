export const supportRequestSchemaSql = `
CREATE TABLE IF NOT EXISTS support_request_pages (
  support_request_id text PRIMARY KEY,
  order_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  flow_type text NOT NULL,
  status text NOT NULL,
  priority text NOT NULL,
  opened_by_account_id text NOT NULL,
  opened_by_role text NOT NULL,
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  seller_response_due_at timestamptz NULL,
  support_review_due_at timestamptz NULL,
  seller_condition_attestation_due_at timestamptz NULL,
  order_return_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  return_investigation jsonb NULL,
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  responses jsonb NOT NULL DEFAULT '[]'::jsonb,
  offers jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_offer jsonb NULL,
  resolution jsonb NULL,
  closed_at timestamptz NULL,
  cancellation_reason text NULL
);

ALTER TABLE support_request_pages
  ADD COLUMN IF NOT EXISTS offers jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE support_request_pages
  ADD COLUMN IF NOT EXISTS pending_offer jsonb NULL;

ALTER TABLE support_request_pages
  ADD COLUMN IF NOT EXISTS seller_condition_attestation_due_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS order_return_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS return_investigation jsonb NULL;

ALTER TABLE support_request_pages
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS escalated_by_account_id text NULL,
  ADD COLUMN IF NOT EXISTS escalated_by_role text NULL,
  ADD COLUMN IF NOT EXISTS escalation_reason text NULL;

ALTER TABLE support_request_pages
  ADD COLUMN IF NOT EXISTS seller_response_reminder_sent_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS support_review_reminder_sent_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS auto_close_due_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS support_request_pages_buyer_idx
  ON support_request_pages (buyer_account_id, updated_at DESC, support_request_id DESC);

CREATE INDEX IF NOT EXISTS support_request_pages_seller_idx
  ON support_request_pages (seller_account_id, updated_at DESC, support_request_id DESC);

CREATE INDEX IF NOT EXISTS support_request_pages_order_idx
  ON support_request_pages (order_id, updated_at DESC);

-- Deadline sweep candidate indexes: each is a narrow partial index over the
-- exact predicate the sweep queries use, so the scheduled runner never scans
-- the full table.
CREATE INDEX IF NOT EXISTS support_request_pages_seller_silence_sweep_idx
  ON support_request_pages (seller_response_due_at)
  WHERE status = 'waiting-on-seller';

CREATE INDEX IF NOT EXISTS support_request_pages_review_sweep_idx
  ON support_request_pages (support_review_due_at)
  WHERE status = 'ready-for-support';

`;
