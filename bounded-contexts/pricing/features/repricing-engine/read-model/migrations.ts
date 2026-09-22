import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";

export const pricingListingOutcomeSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_repricing_listing_outcome_facts (
  listing_id text NOT NULL,
  evaluation_id text NOT NULL,
  seller_account_id text NOT NULL,
  policy_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  global_position bigint NOT NULL,
  trace jsonb NOT NULL,
  floor_binding boolean NOT NULL,
  frozen_until timestamptz NULL,
  PRIMARY KEY (listing_id, evaluation_id)
);
CREATE INDEX IF NOT EXISTS pricing_listing_outcome_facts_position_idx
  ON pricing_repricing_listing_outcome_facts (global_position);
CREATE INDEX IF NOT EXISTS pricing_listing_outcome_facts_order_idx
  ON pricing_repricing_listing_outcome_facts (listing_id, evaluated_at, evaluation_id);
CREATE TABLE IF NOT EXISTS pricing_repricing_listing_outcomes (
  listing_id text PRIMARY KEY,
  evaluation_id text NOT NULL,
  seller_account_id text NOT NULL,
  policy_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  global_position bigint NOT NULL,
  trace jsonb NOT NULL,
  floor_binding boolean NOT NULL,
  frozen_until timestamptz NULL,
  floor_binding_since timestamptz NULL,
  compacted_through_at timestamptz NULL,
  compacted_through_evaluation_id text NULL,
  compaction_run_since timestamptz NULL,
  CHECK ((compacted_through_at IS NULL) = (compacted_through_evaluation_id IS NULL))
);
CREATE INDEX IF NOT EXISTS pricing_listing_outcomes_account_policy_idx
  ON pricing_repricing_listing_outcomes (seller_account_id, policy_id, listing_id);
CREATE INDEX IF NOT EXISTS pricing_listing_outcomes_floor_idx
  ON pricing_repricing_listing_outcomes (seller_account_id, floor_binding_since)
  WHERE floor_binding_since IS NOT NULL;
CREATE INDEX IF NOT EXISTS pricing_listing_outcomes_freeze_idx
  ON pricing_repricing_listing_outcomes (seller_account_id, frozen_until)
  WHERE frozen_until IS NOT NULL;
`;

export const pricingRepricingDryRunSchemaSql = `
${durableJobSchemaSql({
  jobsTable: "pricing_repricing_dry_run_jobs",
  eventsTable: "pricing_repricing_dry_run_job_events",
})}
CREATE TABLE IF NOT EXISTS pricing_repricing_dry_runs (
  dry_run_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  replacing_policy_id text NULL,
  body jsonb NOT NULL,
  body_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  requested_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  consumed_at timestamptz NULL,
  summary jsonb NULL,
  cursor jsonb NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pricing_repricing_dry_runs_account_idx
  ON pricing_repricing_dry_runs (seller_account_id, requested_at DESC, dry_run_id);
CREATE TABLE IF NOT EXISTS pricing_repricing_dry_run_traces (
  dry_run_id text NOT NULL REFERENCES pricing_repricing_dry_runs(dry_run_id),
  seller_account_id text NOT NULL,
  listing_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('changed', 'skipped', 'pause-requested', 'notify-only')),
  skip_reason text NULL,
  flags text[] NOT NULL,
  delta_cents bigint NULL,
  trace jsonb NOT NULL,
  PRIMARY KEY (dry_run_id, listing_id)
);
CREATE INDEX IF NOT EXISTS pricing_repricing_dry_run_traces_outcome_idx
  ON pricing_repricing_dry_run_traces (dry_run_id, outcome, listing_id);
`;

export const pricingRepricingDryRunSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260914_pricing_repricing_dry_runs",
    description: "Persist candidate repricing dry runs, resumable product cursors and listing traces.",
    statements: [pricingRepricingDryRunSchemaSql],
  },
];
