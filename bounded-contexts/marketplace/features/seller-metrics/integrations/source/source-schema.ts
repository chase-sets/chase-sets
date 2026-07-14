// Self-contained source mirrors for the seller-behavioral-metrics slice
// (m108 reputation). These tables are structurally similar to
// `marketplace_review_*_sources` (../../../reviews/integrations/source) --
// each consuming slice keeps its own local mirror fed by the same upstream
// events, exactly like `ordering`'s own reputation-projection source tables
// duplicate the same shipment/support shape independently. That duplication
// is this codebase's established convention for fan-out read models (see
// PR description for the alternatives considered), not an oversight.
export const marketplaceSellerMetricsSourceSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_seller_metrics_order_sources (
  order_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  created_at timestamptz NOT NULL,
  ready_for_fulfillment_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  cancellation_reason text NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS marketplace_seller_metrics_order_sources_seller_idx
  ON marketplace_seller_metrics_order_sources (seller_account_id, created_at DESC, order_id DESC);

CREATE TABLE IF NOT EXISTS marketplace_seller_metrics_shipment_sources (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  seller_account_id text NOT NULL,
  created_at timestamptz NOT NULL,
  dispatched_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS marketplace_seller_metrics_shipment_sources_seller_idx
  ON marketplace_seller_metrics_shipment_sources (seller_account_id, dispatched_at DESC, shipment_id DESC);

CREATE INDEX IF NOT EXISTS marketplace_seller_metrics_shipment_sources_order_idx
  ON marketplace_seller_metrics_shipment_sources (order_id);

-- The responsibility column is the canonical Support factual-responsibility
-- fact and is the sole input to the seller-responsible issue rate. resolution_type
-- and flow_type are retained only as private operational context for excluded
-- causes (carrier, platform, buyer, shared, or undetermined); they never decide
-- responsibility. A NULL responsibility marks a resolution whose Support fact
-- was missing or unrecognized -- excluded from the numerator and reported as a
-- missing-responsibility signal, never reinterpreted as seller fault.
CREATE TABLE IF NOT EXISTS marketplace_seller_metrics_support_request_sources (
  support_request_id text PRIMARY KEY,
  order_id text NOT NULL,
  seller_account_id text NOT NULL,
  resolution_type text NULL,
  flow_type text NULL,
  responsibility text NULL,
  resolved_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS marketplace_seller_metrics_support_request_sources_seller_idx
  ON marketplace_seller_metrics_support_request_sources (seller_account_id, resolved_at DESC, support_request_id DESC);
`;
