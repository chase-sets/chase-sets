export const pricingRecommendationSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_recommendation_pages (
  recommendation_id text PRIMARY KEY,
  catalog_catalog_item_id text NOT NULL,
  seller_account_id text NOT NULL,
  market_price_amount numeric(12, 2) NOT NULL,
  market_currency text NOT NULL,
  market_observed_at timestamptz NOT NULL,
  recommended_list_amount numeric(12, 2) NULL,
  recommendation_reason text NULL,
  recommendation_published_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_recommendation_pages_seller_idx
  ON pricing_recommendation_pages (seller_account_id, updated_at DESC, recommendation_id DESC);

CREATE OR REPLACE VIEW pricing_recommendation_feed AS
SELECT
  recommendation.recommendation_id,
  recommendation.catalog_catalog_item_id,
  recommendation.seller_account_id,
  catalog_input.title AS catalog_item_title,
  catalog_input.subtitle AS catalog_item_subtitle,
  catalog_input.status AS catalog_item_status,
  recommendation.market_price_amount,
  recommendation.market_currency,
  recommendation.market_observed_at,
  recommendation.recommended_list_amount,
  recommendation.recommendation_reason,
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
    record_input.seller_account_id,
    record_input.catalog_catalog_item_id,
    SUM(record_input.total_quantity)::integer AS stock_on_hand_quantity,
    COALESCE(
      SUM(
        CASE
          WHEN hold_input.status = 'active' THEN hold_input.quantity
          ELSE 0
        END
      ),
      0
    )::integer AS stock_reserved_quantity
  FROM pricing_inventory_record_inputs AS record_input
  LEFT JOIN pricing_inventory_hold_inputs AS hold_input
    ON hold_input.record_id = record_input.record_id
  GROUP BY record_input.seller_account_id, record_input.catalog_catalog_item_id
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
    FROM pricing_market_offer_inputs
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
`;
