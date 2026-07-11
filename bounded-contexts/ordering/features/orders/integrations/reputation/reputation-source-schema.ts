export const orderingReputationSourceSchemaSql = `
CREATE TABLE IF NOT EXISTS ordering_order_review_shipment_sources (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  delivered_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS ordering_order_review_shipment_sources_order_idx
  ON ordering_order_review_shipment_sources (order_id, updated_at DESC, shipment_id DESC);

CREATE TABLE IF NOT EXISTS ordering_order_review_support_request_sources (
  support_request_id text PRIMARY KEY,
  order_id text NOT NULL,
  status text NOT NULL,
  resolution_type text NULL,
  flow_type text NULL,
  opened_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz NULL,
  resolved_at timestamptz NULL
);

-- Distinguishes seller-caused cancellations (seller-cannot-fulfill) from
-- buyer-initiated ones in the review-eligibility matrix. Rows written before
-- the column existed backfill on replay (the table is unlogged/replayable).
ALTER TABLE ordering_order_review_support_request_sources
  ADD COLUMN IF NOT EXISTS flow_type text NULL;

CREATE INDEX IF NOT EXISTS ordering_order_review_support_request_sources_order_idx
  ON ordering_order_review_support_request_sources (order_id, status, updated_at DESC, support_request_id DESC);

CREATE TABLE IF NOT EXISTS ordering_order_review_eligibility_pages (
  order_id text NOT NULL,
  author_account_id text NOT NULL,
  subject_account_id text NOT NULL,
  author_role text NOT NULL,
  eligible_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (order_id, author_account_id, subject_account_id)
);

CREATE INDEX IF NOT EXISTS ordering_order_review_eligibility_author_idx
  ON ordering_order_review_eligibility_pages (author_account_id, eligible_at DESC, order_id DESC);

CREATE TABLE IF NOT EXISTS ordering_order_review_pages (
  review_id text PRIMARY KEY,
  order_id text NOT NULL,
  author_account_id text NOT NULL,
  subject_account_id text NOT NULL,
  author_role text NOT NULL,
  status text NOT NULL,
  submitted_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  withdrawn_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ordering_order_active_review_direction_idx
  ON ordering_order_review_pages (order_id, author_account_id, subject_account_id)
  WHERE status = 'active';
`;
