import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const supportRequestDisplayReferenceUniqueIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS support_request_pages_display_reference_key
  ON support_request_pages (display_reference)
  WHERE display_reference <> '';`;

export const supportRequestSchemaSql = `
CREATE TABLE IF NOT EXISTS support_request_pages (
  support_request_id text PRIMARY KEY,
  display_reference text NOT NULL DEFAULT '',
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
  affected_line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  ADD COLUMN IF NOT EXISTS display_reference text NOT NULL DEFAULT '';

ALTER TABLE support_request_pages
  ADD COLUMN IF NOT EXISTS affected_line_items jsonb NOT NULL DEFAULT '[]'::jsonb;

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

ALTER TABLE support_request_pages
  ADD COLUMN IF NOT EXISTS return_refund_gate_status text NULL,
  ADD COLUMN IF NOT EXISTS return_delivered_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS return_refund_release_due_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS return_condition_disputed_at timestamptz NULL;

ALTER TABLE support_request_pages
  ADD COLUMN IF NOT EXISTS remedy jsonb NULL,
  ADD COLUMN IF NOT EXISTS deferred_remedy_effect_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS case_presentation text NOT NULL DEFAULT 'decision-pending',
  ADD COLUMN IF NOT EXISTS closure_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS closure_blocking_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS next_remedy_action text NULL,
  ADD COLUMN IF NOT EXISTS remedy_repair_guidance jsonb NOT NULL DEFAULT '[]'::jsonb;

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


CREATE INDEX IF NOT EXISTS support_request_pages_return_refund_disputed_idx
  ON support_request_pages (updated_at DESC)
  WHERE return_refund_gate_status = 'return-condition-disputed';

CREATE INDEX IF NOT EXISTS support_request_pages_remedy_attention_idx
  ON support_request_pages (updated_at ASC)
  WHERE case_presentation = 'action-required';

`;

export const supportRequestSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260712_support_request_display_reference_unique_idx",
    description:
      "Add the support-safe support-case display reference unique index outside boot-time schema SQL. Rows written " +
      "before this migration ran keep the empty-string default and are excluded from the uniqueness check; the " +
      "projector always populates a real reference for every live support request.",
    statements: [`SET lock_timeout = '5s'`, supportRequestDisplayReferenceUniqueIndexSql],
  },
];
