import { durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";
import { durableJobWorkUnitSchemaSql } from "@chase-sets/platform-runtime/durable-job-work-units";

export const pricingRecommendationSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_recommendation_pages (
  recommendation_id text PRIMARY KEY,
  catalog_catalog_item_id text NOT NULL,
  seller_account_id text NOT NULL,
  action_type text NOT NULL DEFAULT 'active-listing-price-update',
  status text NOT NULL DEFAULT 'proposed',
  listing_id text NULL,
  inventory_item_id text NULL,
  market_price_amount numeric(12, 2) NOT NULL,
  market_currency text NOT NULL,
  market_signal_type text NOT NULL DEFAULT 'competition',
  market_observed_at timestamptz NOT NULL,
  current_price_amount numeric(12, 2) NULL,
  recommended_list_amount numeric(12, 2) NULL,
  recommendation_reason text NULL,
  quantity_cap integer NULL,
  applied_listing_id text NULL,
  last_error text NULL,
  recommendation_published_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_recommendation_pages_seller_idx
  ON pricing_recommendation_pages (seller_account_id, updated_at DESC, recommendation_id DESC);

ALTER TABLE pricing_recommendation_pages
  ADD COLUMN IF NOT EXISTS action_type text NOT NULL DEFAULT 'active-listing-price-update',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'proposed',
  ADD COLUMN IF NOT EXISTS listing_id text NULL,
  ADD COLUMN IF NOT EXISTS inventory_item_id text NULL,
  ADD COLUMN IF NOT EXISTS market_signal_type text NOT NULL DEFAULT 'competition',
  ADD COLUMN IF NOT EXISTS current_price_amount numeric(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS quantity_cap integer NULL,
  ADD COLUMN IF NOT EXISTS applied_listing_id text NULL,
  ADD COLUMN IF NOT EXISTS last_error text NULL;

CREATE INDEX IF NOT EXISTS pricing_recommendation_pages_action_idx
  ON pricing_recommendation_pages (seller_account_id, status, action_type, updated_at DESC);

CREATE OR REPLACE VIEW pricing_recommendation_feed AS
SELECT
  recommendation.recommendation_id,
  recommendation.catalog_catalog_item_id,
  recommendation.seller_account_id,
  recommendation.action_type,
  recommendation.status,
  recommendation.listing_id,
  recommendation.inventory_item_id,
  catalog_input.language_code AS catalog_item_language_code,
  catalog_input.title AS catalog_item_title,
  catalog_input.subtitle AS catalog_item_subtitle,
  catalog_input.status AS catalog_item_status,
  recommendation.market_price_amount,
  recommendation.market_currency,
  recommendation.market_signal_type,
  recommendation.market_observed_at,
  recommendation.current_price_amount,
  recommendation.recommended_list_amount,
  recommendation.recommendation_reason,
  recommendation.quantity_cap,
  recommendation.applied_listing_id,
  recommendation.last_error,
  recommendation.recommendation_published_at,
  COALESCE(stock_signal.stock_on_hand_quantity, 0) AS stock_on_hand_quantity,
  COALESCE(stock_signal.stock_reserved_quantity, 0) AS stock_reserved_quantity,
  COALESCE(market_signal.active_listing_count, 0) AS active_listing_count,
  market_signal.lowest_listing_price_amount,
  COALESCE(market_signal.active_offer_count, 0) AS active_offer_count,
  market_signal.highest_offer_price_amount,
  COALESCE(order_signal.committed_order_quantity, 0) AS committed_order_quantity,
  COALESCE(fulfillment_signal.delivered_quantity, 0) AS delivered_quantity,
  COALESCE(fulfillment_signal.returned_quantity, 0) AS returned_quantity,
  recommendation.updated_at
FROM pricing_recommendation_pages AS recommendation
LEFT JOIN pricing_catalog_item_inputs AS catalog_input
  ON catalog_input.catalog_item_id = recommendation.catalog_catalog_item_id
LEFT JOIN (
  SELECT
    item_input.seller_account_id,
    item_input.catalog_catalog_item_id,
    SUM(item_input.total_quantity)::integer AS stock_on_hand_quantity,
    COALESCE(
      SUM(
        CASE
          WHEN hold_input.status = 'active' THEN hold_input.quantity
          ELSE 0
        END
      ),
      0
    )::integer AS stock_reserved_quantity
  FROM pricing_inventory_item_inputs AS item_input
  LEFT JOIN pricing_inventory_hold_inputs AS hold_input
    ON hold_input.item_id = item_input.item_id
  GROUP BY item_input.seller_account_id, item_input.catalog_catalog_item_id
) AS stock_signal
  ON stock_signal.seller_account_id = recommendation.seller_account_id
 AND stock_signal.catalog_catalog_item_id = recommendation.catalog_catalog_item_id
LEFT JOIN (
  SELECT
    catalog_catalog_item_id,
    COUNT(*) FILTER (WHERE status = 'active')::integer AS active_listing_count,
    MIN(price_amount) FILTER (WHERE status = 'active') AS lowest_listing_price_amount,
    COUNT(*) FILTER (WHERE status = 'submitted')::integer AS active_offer_count,
    MAX(price_amount) FILTER (WHERE status = 'submitted') AS highest_offer_price_amount
  FROM (
    SELECT
      catalog_catalog_item_id,
      price_amount,
      status
    FROM pricing_market_listing_inputs
    UNION ALL
    SELECT
      catalog_catalog_item_id,
      price_amount,
      status
    FROM pricing_buyer_offer_inputs
  ) AS market_inputs
  GROUP BY catalog_catalog_item_id
) AS market_signal
  ON market_signal.catalog_catalog_item_id = recommendation.catalog_catalog_item_id
LEFT JOIN (
  SELECT
    seller_account_id,
    catalog_catalog_item_id,
    COALESCE(
      SUM(
        CASE
          WHEN status = 'ready-for-fulfillment' THEN quantity
          ELSE 0
        END
      ),
      0
    )::integer AS committed_order_quantity
  FROM pricing_order_signal_lines
  GROUP BY seller_account_id, catalog_catalog_item_id
) AS order_signal
  ON order_signal.seller_account_id = recommendation.seller_account_id
 AND order_signal.catalog_catalog_item_id = recommendation.catalog_catalog_item_id
LEFT JOIN (
  SELECT
    order_signal.seller_account_id,
    fulfillment_input.catalog_catalog_item_id,
    COALESCE(
      SUM(
        CASE
          WHEN fulfillment_input.status = 'delivered' THEN fulfillment_input.quantity
          ELSE 0
        END
      ),
      0
    )::integer AS delivered_quantity,
    COALESCE(
      SUM(
        CASE
          WHEN fulfillment_input.status = 'returned' THEN fulfillment_input.quantity
          ELSE 0
        END
      ),
      0
    )::integer AS returned_quantity
  FROM pricing_fulfillment_signal_lines AS fulfillment_input
  INNER JOIN pricing_order_signal_lines AS order_signal
    ON order_signal.order_id = fulfillment_input.order_id
  GROUP BY order_signal.seller_account_id, fulfillment_input.catalog_catalog_item_id
) AS fulfillment_signal
  ON fulfillment_signal.seller_account_id = recommendation.seller_account_id
 AND fulfillment_signal.catalog_catalog_item_id = recommendation.catalog_catalog_item_id;

${durableJobSchemaSql({
  jobsTable: "pricing_recommendation_jobs",
  eventsTable: "pricing_recommendation_job_events",
})}

${durableJobWorkUnitSchemaSql({
  jobsTable: "pricing_recommendation_jobs",
  workUnitsTable: "pricing_recommendation_work_units",
})}
`;
