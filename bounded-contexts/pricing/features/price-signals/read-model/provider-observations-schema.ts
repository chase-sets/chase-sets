import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const pricingProviderObservationsSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_external_catalog_item_reference_inputs (
  provider_key text NOT NULL,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider_key, external_key)
);

CREATE INDEX IF NOT EXISTS pricing_external_catalog_item_reference_inputs_catalog_idx
  ON pricing_external_catalog_item_reference_inputs (catalog_item_id, external_key);

CREATE TABLE IF NOT EXISTS pricing_external_market_capture_cursors (
  provider_key text PRIMARY KEY,
  after_external_key text NOT NULL DEFAULT '',
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing_external_market_captures (
  capture_id text PRIMARY KEY,
  provider_key text NOT NULL,
  catalog_item_id text NOT NULL,
  external_key text NOT NULL,
  signal_pass_started_at timestamptz NOT NULL,
  signal_policy_revision_id text NOT NULL,
  products_per_pass integer NOT NULL CHECK (products_per_pass BETWEEN 1 AND 5),
  capture_started_at timestamptz NOT NULL,
  capture_completed_at timestamptz NOT NULL,
  observation_policy_revision_id text NULL,
  stat_hygiene_policy_revision_id text NULL,
  captures_per_pass integer NULL CHECK (captures_per_pass IS NULL OR captures_per_pass BETWEEN 1 AND 5),
  currency text NULL CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$'),
  authenticated_request boolean NOT NULL,
  recorded_signal_count integer NOT NULL CHECK (recorded_signal_count >= 0),
  unresolved_signal_count integer NOT NULL CHECK (unresolved_signal_count >= 0),
  outcome_kind text NOT NULL CHECK (outcome_kind IN ('recorded','recorded-with-rejections','no-secondary-observations','mapping-unresolved','provider-unavailable','configuration-invalid','disabled')),
  reason_code text NULL CHECK (reason_code IS NULL OR reason_code IN ('observation-policy-invalid','stat-hygiene-policy-invalid','transport-not-mounted')),
  rejected_row_count integer NOT NULL CHECK (rejected_row_count >= 0),
  sales_status text NULL CHECK (sales_status IS NULL OR sales_status IN ('observed','unavailable','disabled','not-requested')),
  sales_requested_at timestamptz NULL,
  sales_response_observed_at timestamptz NULL,
  sales_coverage text NULL CHECK (sales_coverage IS NULL OR sales_coverage IN ('complete','request-cap-truncated','page-budget-truncated','inconsistent','unknown')),
  sales_pages_fetched integer NOT NULL DEFAULT 0 CHECK (sales_pages_fetched >= 0),
  sales_returned_count integer NOT NULL DEFAULT 0 CHECK (sales_returned_count >= 0),
  sales_first_reported_total integer NULL CHECK (sales_first_reported_total IS NULL OR sales_first_reported_total >= 0),
  sales_last_reported_total integer NULL CHECK (sales_last_reported_total IS NULL OR sales_last_reported_total >= 0),
  sales_last_next_page text NULL CHECK (sales_last_next_page IS NULL OR sales_last_next_page IN ('Yes','')),
  listings_status text NULL CHECK (listings_status IS NULL OR listings_status IN ('observed','unavailable','disabled','not-requested')),
  listings_requested_at timestamptz NULL,
  listings_response_observed_at timestamptz NULL,
  listings_coverage text NULL CHECK (listings_coverage IS NULL OR listings_coverage IN ('complete','ceiling-truncated','page-budget-truncated','inconsistent','unknown')),
  listings_pages_fetched integer NOT NULL DEFAULT 0 CHECK (listings_pages_fetched >= 0),
  listings_returned_count integer NOT NULL DEFAULT 0 CHECK (listings_returned_count >= 0),
  listings_reported_total integer NULL CHECK (listings_reported_total IS NULL OR listings_reported_total >= 0),
  own_seller_exclusion_applied boolean NOT NULL DEFAULT false,
  history_status text NULL CHECK (history_status IS NULL OR history_status IN ('observed','unavailable','disabled','not-requested')),
  history_requested_at timestamptz NULL,
  history_response_observed_at timestamptz NULL,
  history_coverage text NULL CHECK (history_coverage IS NULL OR history_coverage IN ('observed','inconsistent','unknown')),
  history_result_count integer NOT NULL DEFAULT 0 CHECK (history_result_count >= 0),
  history_bucket_count integer NOT NULL DEFAULT 0 CHECK (history_bucket_count >= 0),
  request_posture jsonb NULL,
  sales_first_result_count integer NULL CHECK (sales_first_result_count IS NULL OR sales_first_result_count >= 0),
  sales_last_result_count integer NULL CHECK (sales_last_result_count IS NULL OR sales_last_result_count >= 0),
  sales_http_status_class text NULL CHECK (sales_http_status_class IS NULL OR sales_http_status_class IN ('none','4xx','5xx','other')),
  listings_http_status_class text NULL CHECK (listings_http_status_class IS NULL OR listings_http_status_class IN ('none','4xx','5xx','other')),
  history_http_status_class text NULL CHECK (history_http_status_class IS NULL OR history_http_status_class IN ('none','4xx','5xx','other')),
  history_range text NULL CHECK (history_range IS NULL OR history_range = 'annual')
);

CREATE INDEX IF NOT EXISTS pricing_external_market_captures_lookup_idx
  ON pricing_external_market_captures (provider_key, catalog_item_id, capture_started_at DESC, capture_id DESC);

CREATE TABLE IF NOT EXISTS pricing_external_sale_observations (
  capture_id text NOT NULL REFERENCES pricing_external_market_captures(capture_id),
  sale_fingerprint text NOT NULL,
  observed_occurrence_count integer NOT NULL CHECK (observed_occurrence_count > 0),
  provider_condition text NOT NULL,
  provider_variant text NOT NULL,
  provider_language text NOT NULL,
  listing_type text NOT NULL,
  sold_at timestamptz NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  order_shipping numeric(12,2) NOT NULL CHECK (order_shipping >= 0),
  PRIMARY KEY (capture_id, sale_fingerprint)
);

CREATE INDEX IF NOT EXISTS pricing_external_sale_observations_sold_idx
  ON pricing_external_sale_observations (sold_at, capture_id);

CREATE TABLE IF NOT EXISTS pricing_external_weekly_sale_buckets (
  provider_key text NOT NULL,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL,
  catalog_product_key text NULL,
  week_start date NOT NULL,
  provider_condition text NOT NULL,
  provider_variant text NOT NULL,
  provider_language text NOT NULL,
  transaction_count integer NOT NULL CHECK (transaction_count > 0),
  quantity_sold integer NOT NULL CHECK (quantity_sold >= 0),
  low_sale_amount numeric(12,2) NULL,
  high_sale_amount numeric(12,2) NULL,
  low_delivered_amount numeric(12,2) NULL,
  high_delivered_amount numeric(12,2) NULL,
  provider_market_amount numeric(12,2) NULL,
  last_capture_id text NOT NULL REFERENCES pricing_external_market_captures(capture_id),
  last_observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider_key, external_key, week_start)
);

CREATE INDEX IF NOT EXISTS pricing_external_weekly_sale_buckets_catalog_idx
  ON pricing_external_weekly_sale_buckets (provider_key, catalog_item_id, week_start, external_key);

CREATE TABLE IF NOT EXISTS pricing_external_listing_snapshots (
  provider_key text NOT NULL,
  catalog_item_id text NOT NULL,
  provider_variant text NOT NULL,
  provider_language text NOT NULL,
  provider_condition text NOT NULL,
  observed_on date NOT NULL,
  distinct_seller_count integer NOT NULL CHECK (distinct_seller_count >= 0),
  cheapest_delivered_amount numeric(12,2) NULL,
  second_cheapest_delivered_amount numeric(12,2) NULL,
  last_capture_id text NOT NULL REFERENCES pricing_external_market_captures(capture_id),
  last_observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider_key, catalog_item_id, provider_variant, provider_language, provider_condition, observed_on)
);

CREATE TABLE IF NOT EXISTS pricing_external_listing_ask_depth (
  capture_id text NOT NULL REFERENCES pricing_external_market_captures(capture_id),
  anonymous_capture_seller_ordinal integer NOT NULL CHECK (anonymous_capture_seller_ordinal > 0),
  provider_condition text NOT NULL,
  delivered_amount numeric(12,2) NOT NULL CHECK (delivered_amount >= 0),
  coverage text NOT NULL CHECK (coverage IN ('complete','ceiling-truncated','page-budget-truncated','inconsistent','unknown')),
  PRIMARY KEY (capture_id, anonymous_capture_seller_ordinal, provider_condition, delivered_amount)
);

CREATE INDEX IF NOT EXISTS pricing_external_listing_ask_depth_price_idx
  ON pricing_external_listing_ask_depth (capture_id, delivered_amount, provider_condition);
`;

const tables = pricingProviderObservationsSchemaSql
  .split(";\n")
  .map((statement) => statement.trim())
  .filter((statement) => statement.startsWith("CREATE TABLE"));

export const pricingProviderObservationsSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260907_pricing_provider_market_capture",
    description: "Add logged provider market capture evidence and its replayable Catalog product-reference input.",
    statements: [
      ...tables.map((statement) => `${statement};`),
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS pricing_external_catalog_item_reference_inputs_catalog_idx
  ON pricing_external_catalog_item_reference_inputs (catalog_item_id, external_key)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS pricing_external_market_captures_lookup_idx
  ON pricing_external_market_captures (provider_key, catalog_item_id, capture_started_at DESC, capture_id DESC)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS pricing_external_sale_observations_sold_idx
  ON pricing_external_sale_observations (sold_at, capture_id)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS pricing_external_weekly_sale_buckets_catalog_idx
  ON pricing_external_weekly_sale_buckets (provider_key, catalog_item_id, week_start, external_key)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS pricing_external_listing_ask_depth_price_idx
  ON pricing_external_listing_ask_depth (capture_id, delivered_amount, provider_condition)`,
    ],
  },
];
