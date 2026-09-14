import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";

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
