import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { REVIEW_WINDOW_DAYS } from "../domain/common";

export const reviewSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_review_pages (
  review_id text PRIMARY KEY,
  order_id text NOT NULL,
  author_account_id text NOT NULL,
  subject_account_id text NOT NULL,
  author_role text NOT NULL,
  rating integer NOT NULL,
  feedback text NULL,
  status text NOT NULL,
  submitted_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  withdrawn_at timestamptz NULL,
  held boolean NOT NULL DEFAULT false
);

ALTER TABLE marketplace_review_pages
  ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false;

-- Double-blind reveal (m108). revealed_at IS NULL means the review is
-- hidden: excluded from public lists, summaries, and every downstream
-- reputation aggregate. review_window_expires_at is captured at submission
-- (eligible_at + REVIEW_WINDOW_DAYS) and never changes; it is the deadline
-- the expiry sweep reveals a singleton review by when its counterpart never
-- submits. reveal_reason is display-only ("counterpart-submitted" vs.
-- "window-expired").
ALTER TABLE marketplace_review_pages
  ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS review_window_expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reveal_reason text NULL;

-- Moderation + subject reply (m108, #4269). withdrawn_by_actor_type
-- distinguishes an author withdrawal from an operator one;
-- moderation_operator_user_id/moderation_reason hold the latest operator
-- withdraw-or-redact reason for display (the authoritative audit trail is
-- the event stream). Reply columns hold the single threaded subject reply.
ALTER TABLE marketplace_review_pages
  ADD COLUMN IF NOT EXISTS withdrawn_by_actor_type text NULL,
  ADD COLUMN IF NOT EXISTS moderation_operator_user_id text NULL,
  ADD COLUMN IF NOT EXISTS moderation_reason text NULL,
  ADD COLUMN IF NOT EXISTS feedback_redacted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reply_id text NULL,
  ADD COLUMN IF NOT EXISTS reply_feedback text NULL,
  ADD COLUMN IF NOT EXISTS reply_status text NULL,
  ADD COLUMN IF NOT EXISTS reply_submitted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reply_withdrawn_at timestamptz NULL;

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_active_review_direction_idx
  ON marketplace_review_pages (order_id, author_account_id, subject_account_id)
  WHERE status = 'active';

-- The expiry-sweep index (marketplace_review_pages_pending_reveal_idx) is
-- created by the 20260711_marketplace_review_window_reveal schema migration
-- below; boot-time indexes on migration-added columns are forbidden.
CREATE INDEX IF NOT EXISTS marketplace_review_pages_author_idx
  ON marketplace_review_pages (author_account_id, updated_at DESC, review_id DESC);

CREATE INDEX IF NOT EXISTS marketplace_review_pages_subject_idx
  ON marketplace_review_pages (subject_account_id, updated_at DESC, review_id DESC)
  WHERE status = 'active';

-- An account's as-seller reputation (reviews left by buyers) and as-buyer
-- reputation (reviews left by sellers) are distinct signals and must never be
-- blended: the "seller rating" a buyer sees at checkout must reflect only the
-- account's history as a seller, not its history as a buyer, and vice versa.
CREATE TABLE IF NOT EXISTS marketplace_review_summary_pages (
  account_id text PRIMARY KEY,
  average_rating_as_seller numeric(4, 2) NULL,
  review_count_as_seller integer NOT NULL DEFAULT 0,
  rating_1_count_as_seller integer NOT NULL DEFAULT 0,
  rating_2_count_as_seller integer NOT NULL DEFAULT 0,
  rating_3_count_as_seller integer NOT NULL DEFAULT 0,
  rating_4_count_as_seller integer NOT NULL DEFAULT 0,
  rating_5_count_as_seller integer NOT NULL DEFAULT 0,
  average_rating_as_buyer numeric(4, 2) NULL,
  review_count_as_buyer integer NOT NULL DEFAULT 0,
  rating_1_count_as_buyer integer NOT NULL DEFAULT 0,
  rating_2_count_as_buyer integer NOT NULL DEFAULT 0,
  rating_3_count_as_buyer integer NOT NULL DEFAULT 0,
  rating_4_count_as_buyer integer NOT NULL DEFAULT 0,
  rating_5_count_as_buyer integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);

ALTER TABLE marketplace_review_summary_pages
  ADD COLUMN IF NOT EXISTS average_rating_as_seller numeric(4, 2) NULL,
  ADD COLUMN IF NOT EXISTS review_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_1_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_2_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_3_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_4_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_5_count_as_seller integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS average_rating_as_buyer numeric(4, 2) NULL,
  ADD COLUMN IF NOT EXISTS review_count_as_buyer integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_1_count_as_buyer integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_2_count_as_buyer integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_3_count_as_buyer integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_4_count_as_buyer integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_5_count_as_buyer integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS marketplace_review_eligibility_pages (
  order_id text NOT NULL,
  author_account_id text NOT NULL,
  subject_account_id text NOT NULL,
  author_role text NOT NULL,
  eligible_at timestamptz NOT NULL,
  effective_deadline_at timestamptz NOT NULL,
  submission_state text NOT NULL,
  hold_started_at timestamptz NULL,
  paused_remaining_ms bigint NULL,
  reminder_armed_at timestamptz NOT NULL,
  hold_cycle integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (order_id, author_account_id, subject_account_id)
);

CREATE INDEX IF NOT EXISTS marketplace_review_eligibility_author_idx
  ON marketplace_review_eligibility_pages (author_account_id, eligible_at DESC, order_id DESC);

-- Post-delivery review nudges (m108, #4270). Both columns are scoped to the
-- eligibility row's PK (order_id, author_account_id, subject_account_id), so
-- suspension (row DELETE) followed by restoration (fresh row INSERT) always
-- starts a new, unnotified arm -- "restored eligibility re-arms them" falls
-- out of the eligibility lifecycle already implemented in eligibility-sync.ts
-- for free, with no separate cancellation bookkeeping required.
-- The reminder-sweep index (marketplace_review_eligibility_pages_reminder_idx)
-- is created by the 20260711_marketplace_review_nudge_reminder_index schema
-- migration below; boot-time indexes on migration-added columns are
-- forbidden.
ALTER TABLE marketplace_review_eligibility_pages
  ADD COLUMN IF NOT EXISTS opportunity_notified_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reminder_notified_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS effective_deadline_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS submission_state text NOT NULL DEFAULT 'allowed',
  ADD COLUMN IF NOT EXISTS hold_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS paused_remaining_ms bigint NULL,
  ADD COLUMN IF NOT EXISTS reminder_armed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS hold_cycle integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS marketplace_review_hold_pages (
  order_id text PRIMARY KEY,
  active_support_request_ids text[] NOT NULL DEFAULT '{}',
  held_directions text[] NOT NULL DEFAULT '{}',
  held_at timestamptz NULL,
  released_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);
`;

export const reviewSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260714_marketplace_review_hold_and_clock_pause",
    description: "Persist review hold visibility and pauseable directional review clocks.",
    statements: [
      `SET lock_timeout = '5s'`,
      `ALTER TABLE marketplace_review_pages
  ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false`,
      `ALTER TABLE marketplace_review_eligibility_pages
  ADD COLUMN IF NOT EXISTS effective_deadline_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS submission_state text NOT NULL DEFAULT 'allowed',
  ADD COLUMN IF NOT EXISTS hold_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS paused_remaining_ms bigint NULL,
  ADD COLUMN IF NOT EXISTS reminder_armed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS hold_cycle integer NOT NULL DEFAULT 0`,
      `UPDATE marketplace_review_eligibility_pages
   SET effective_deadline_at = eligible_at + make_interval(days => ${REVIEW_WINDOW_DAYS}),
       reminder_armed_at = eligible_at
   WHERE effective_deadline_at IS NULL OR reminder_armed_at IS NULL`,
      `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'marketplace_review_eligibility_clock_required'
      AND conrelid = 'marketplace_review_eligibility_pages'::regclass
  ) THEN
    ALTER TABLE marketplace_review_eligibility_pages
      ADD CONSTRAINT marketplace_review_eligibility_clock_required
      CHECK (effective_deadline_at IS NOT NULL AND reminder_armed_at IS NOT NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE marketplace_review_eligibility_pages
  VALIDATE CONSTRAINT marketplace_review_eligibility_clock_required;

ALTER TABLE marketplace_review_eligibility_pages
  ALTER COLUMN effective_deadline_at SET NOT NULL,
  ALTER COLUMN reminder_armed_at SET NOT NULL`,
      `CREATE TABLE IF NOT EXISTS marketplace_review_hold_pages (
  order_id text PRIMARY KEY,
  active_support_request_ids text[] NOT NULL DEFAULT '{}',
  held_directions text[] NOT NULL DEFAULT '{}',
  held_at timestamptz NULL,
  released_at timestamptz NULL,
  updated_at timestamptz NOT NULL
)`,
    ],
  },
  {
    migrationId: "20260710_marketplace_review_summary_role_split_drop_legacy_columns",
    description:
      "Drop the pre-role-split blended reputation columns from marketplace_review_summary_pages now that as-seller/as-buyer columns are populated (m108).",
    statements: [
      `SET lock_timeout = '2s'`,
      `ALTER TABLE marketplace_review_summary_pages
  DROP COLUMN IF EXISTS average_rating,
  DROP COLUMN IF EXISTS review_count,
  DROP COLUMN IF EXISTS rating_1_count,
  DROP COLUMN IF EXISTS rating_2_count,
  DROP COLUMN IF EXISTS rating_3_count,
  DROP COLUMN IF EXISTS rating_4_count,
  DROP COLUMN IF EXISTS rating_5_count`,
    ],
  },
  {
    migrationId: "20260711_marketplace_review_window_reveal",
    description:
      "Add double-blind reveal columns to marketplace_review_pages and migrate every existing (pre-launch) review to revealed (m108).",
    statements: [
      `SET lock_timeout = '5s'`,
      `ALTER TABLE marketplace_review_pages
  ADD COLUMN IF NOT EXISTS revealed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS review_window_expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reveal_reason text NULL`,
      // Every review that predates the reveal window is treated as revealed:
      // it already published under the old immediate-publication behavior, so
      // there is nothing left to hide.
      `UPDATE marketplace_review_pages
   SET revealed_at = submitted_at,
       review_window_expires_at = COALESCE(review_window_expires_at, submitted_at),
       reveal_reason = 'window-expired'
   WHERE status = 'active'
     AND revealed_at IS NULL`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS marketplace_review_pages_pending_reveal_idx
  ON marketplace_review_pages (review_window_expires_at ASC, review_id ASC)
  WHERE status = 'active' AND revealed_at IS NULL`,
    ],
  },
  {
    migrationId: "20260711_marketplace_review_nudge_reminder_index",
    description: "Add the reminder-sweep candidate index on marketplace_review_eligibility_pages (m108, #4270).",
    statements: [
      `SET lock_timeout = '5s'`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS marketplace_review_eligibility_pages_reminder_idx
  ON marketplace_review_eligibility_pages (eligible_at ASC, order_id ASC)
  WHERE reminder_notified_at IS NULL`,
    ],
  },
];
