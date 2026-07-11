export const marketplaceReviewSourceProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_review_account_sources (
  account_id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS marketplace_review_account_sources_status_idx
  ON marketplace_review_account_sources (status, updated_at DESC, account_id ASC);

-- Mirrors discovery's account seller slug (same deterministic
-- displayName+accountId derivation, computed independently -- see the
-- source-projection.ts comment) so the reputation MCP tools can resolve
-- subjectAccountSlug without a cross-context runtime dependency.
ALTER TABLE marketplace_review_account_sources
  ADD COLUMN IF NOT EXISTS slug text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_review_account_sources_slug_idx
  ON marketplace_review_account_sources (slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketplace_review_order_sources (
  order_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz NULL,
  ready_for_fulfillment_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS marketplace_review_order_sources_buyer_idx
  ON marketplace_review_order_sources (buyer_account_id, updated_at DESC, order_id DESC);

CREATE INDEX IF NOT EXISTS marketplace_review_order_sources_seller_idx
  ON marketplace_review_order_sources (seller_account_id, updated_at DESC, order_id DESC);

CREATE TABLE IF NOT EXISTS marketplace_review_shipment_sources (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  dispatched_at timestamptz NULL,
  delivered_at timestamptz NULL,
  returned_at timestamptz NULL,
  exception_raised_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS marketplace_review_shipment_sources_order_idx
  ON marketplace_review_shipment_sources (order_id, updated_at DESC, shipment_id DESC);

CREATE TABLE IF NOT EXISTS marketplace_review_support_request_sources (
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

CREATE INDEX IF NOT EXISTS marketplace_review_support_request_sources_order_idx
  ON marketplace_review_support_request_sources (order_id, updated_at DESC, support_request_id DESC);
`;
