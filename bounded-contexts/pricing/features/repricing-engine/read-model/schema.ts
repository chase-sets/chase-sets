import { durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";

/**
 * Durable signal work, seller-visible evaluation facts, and the two small
 * coordination ledgers owned by the reactive repricing engine.
 */
export const pricingRepricingEngineSchemaSql = `
${durableJobSchemaSql({
  jobsTable: "pricing_repricing_evaluation_jobs",
  eventsTable: "pricing_repricing_evaluation_job_events",
})}

CREATE TABLE IF NOT EXISTS pricing_repricing_policy_evaluations (
  evaluation_id text PRIMARY KEY,
  policy_id text NOT NULL,
  policy_revision text NOT NULL,
  seller_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  trigger_kind text NOT NULL,
  trigger_event_id text NOT NULL,
  trigger_signal_version text NOT NULL,
  listings_evaluated integer NOT NULL,
  listings_changed integer NOT NULL,
  listings_skipped integer NOT NULL,
  listing_traces jsonb NOT NULL,
  signal_to_evaluation_latency_ms integer NOT NULL,
  evaluated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_repricing_policy_evaluations_policy_idx
  ON pricing_repricing_policy_evaluations (policy_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS pricing_repricing_policy_evaluations_product_idx
  ON pricing_repricing_policy_evaluations (catalog_catalog_item_id, product_id, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS pricing_repricing_daily_change_budgets (
  policy_id text NOT NULL,
  budget_day date NOT NULL,
  changes_reserved integer NOT NULL CHECK (changes_reserved >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (policy_id, budget_day)
);

CREATE TABLE IF NOT EXISTS pricing_repricing_daily_sweep_cursor (
  sweep_name text PRIMARY KEY,
  sweep_day date NOT NULL,
  after_catalog_item_id text NULL,
  after_product_id text NULL,
  completed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL
);
`;
