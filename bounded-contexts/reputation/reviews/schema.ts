export const reputationReviewSchemaSql = `
CREATE TABLE IF NOT EXISTS reputation_review_pages (
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
  withdrawn_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS reputation_active_review_direction_idx
  ON reputation_review_pages (order_id, author_account_id, subject_account_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS reputation_review_pages_author_idx
  ON reputation_review_pages (author_account_id, updated_at DESC, review_id DESC);

CREATE INDEX IF NOT EXISTS reputation_review_pages_subject_idx
  ON reputation_review_pages (subject_account_id, updated_at DESC, review_id DESC)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS reputation_summary_pages (
  account_id text PRIMARY KEY,
  average_rating numeric(4, 2) NULL,
  review_count integer NOT NULL DEFAULT 0,
  rating_1_count integer NOT NULL DEFAULT 0,
  rating_2_count integer NOT NULL DEFAULT 0,
  rating_3_count integer NOT NULL DEFAULT 0,
  rating_4_count integer NOT NULL DEFAULT 0,
  rating_5_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS reputation_review_eligibility_pages (
  order_id text NOT NULL,
  author_account_id text NOT NULL,
  subject_account_id text NOT NULL,
  author_role text NOT NULL,
  eligible_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (order_id, author_account_id, subject_account_id)
);

CREATE INDEX IF NOT EXISTS reputation_review_eligibility_author_idx
  ON reputation_review_eligibility_pages (author_account_id, eligible_at DESC, order_id DESC);
`;
