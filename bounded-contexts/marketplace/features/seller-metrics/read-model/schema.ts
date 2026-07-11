export const marketplaceSellerMetricsSummarySchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_seller_metrics_summary_pages (
  seller_account_id text PRIMARY KEY,
  window_days integer NOT NULL,
  orders_created_count integer NOT NULL DEFAULT 0,
  seller_cancelled_count integer NOT NULL DEFAULT 0,
  cancellation_rate numeric(5, 4) NULL,
  shipments_dispatched_count integer NOT NULL DEFAULT 0,
  shipments_on_time_count integer NOT NULL DEFAULT 0,
  on_time_shipment_rate numeric(5, 4) NULL,
  disputes_resolved_count integer NOT NULL DEFAULT 0,
  disputes_against_seller_count integer NOT NULL DEFAULT 0,
  dispute_rate numeric(5, 4) NULL,
  computed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
`;
