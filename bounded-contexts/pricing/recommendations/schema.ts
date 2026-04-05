export const pricingRecommendationSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_recommendation_pages (
  recommendation_id text PRIMARY KEY,
  catalog_item_id text NOT NULL,
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
`;
