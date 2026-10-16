/**
 * The Forecast Ledger, projected from `pricing.repricing-policy.evaluated`,
 * and the grading job's versioned cache. An entry is written once and never
 * rewritten; a grade is replaced only when its grading rules or the inputs its
 * cohort read change.
 */
export const pricingForecastLedgerSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_forecast_ledger_entries (
  entry_id text PRIMARY KEY,
  global_position bigint NOT NULL,
  evaluation_id text NOT NULL,
  seller_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  listing_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('incumbent', 'shadow')),
  goal_id text NOT NULL,
  goal_version integer NOT NULL CHECK (goal_version > 0),
  curve_version bigint NULL,
  price_amount numeric(12, 2) NOT NULL,
  quantity integer NULL CHECK (quantity IS NULL OR quantity >= 0),
  priced_at timestamptz NOT NULL,
  forecasts jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_forecast_ledger_entries_listing_idx
  ON pricing_forecast_ledger_entries (listing_id, goal_id, goal_version, priced_at);

CREATE INDEX IF NOT EXISTS pricing_forecast_ledger_entries_scope_idx
  ON pricing_forecast_ledger_entries (goal_id, goal_version, role, priced_at);

CREATE INDEX IF NOT EXISTS pricing_forecast_ledger_entries_priced_idx
  ON pricing_forecast_ledger_entries (priced_at);

CREATE TABLE IF NOT EXISTS pricing_forecast_grading_inputs (
  goal_id text NOT NULL,
  goal_version integer NOT NULL,
  role text NOT NULL CHECK (role IN ('incumbent', 'shadow')),
  closed_on date NOT NULL,
  rules_version text NOT NULL,
  input_version text NOT NULL,
  graded_at timestamptz NOT NULL,
  checked_at timestamptz NOT NULL,
  PRIMARY KEY (goal_id, goal_version, role, closed_on)
);

CREATE TABLE IF NOT EXISTS pricing_forecast_grades (
  goal_id text NOT NULL,
  goal_version integer NOT NULL,
  role text NOT NULL CHECK (role IN ('incumbent', 'shadow')),
  forecast_kind text NOT NULL,
  model text NOT NULL,
  horizon_days integer NOT NULL CHECK (horizon_days > 0),
  closed_on date NOT NULL,
  rules_version text NOT NULL,
  input_version text NOT NULL,
  grade jsonb NOT NULL,
  graded_at timestamptz NOT NULL,
  PRIMARY KEY (goal_id, goal_version, role, forecast_kind, model, horizon_days, closed_on)
);
`;
