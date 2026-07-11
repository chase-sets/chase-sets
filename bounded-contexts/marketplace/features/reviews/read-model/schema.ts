import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

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
  resolution_context text NULL,
  submitted_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  withdrawn_at timestamptz NULL
);

-- Neutral display marker for reviews unlocked by a refund-class support
-- resolution ("resolved via refund"). Display-only: summary math never reads
-- it — a review is a review.
ALTER TABLE marketplace_review_pages
  ADD COLUMN IF NOT EXISTS resolution_context text NULL;

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
  resolution_context text NULL,
  eligible_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (order_id, author_account_id, subject_account_id)
);

ALTER TABLE marketplace_review_eligibility_pages
  ADD COLUMN IF NOT EXISTS resolution_context text NULL;

CREATE INDEX IF NOT EXISTS marketplace_review_eligibility_author_idx
  ON marketplace_review_eligibility_pages (author_account_id, eligible_at DESC, order_id DESC);
`;

export const reviewSchemaMigrations: readonly BcSchemaMigration[] = [
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
];
