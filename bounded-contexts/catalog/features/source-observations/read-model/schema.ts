import { durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";
import { durableJobWorkUnitSchemaSql } from "@chase-sets/platform-runtime/durable-job-work-units";

export const catalogSourceObservationSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_source_observations (
  observation_id text PRIMARY KEY,
  provider_key text NOT NULL,
  external_key text NOT NULL,
  source_url text NOT NULL,
  language_code text NOT NULL,
  source_record_hash text NOT NULL,
  source_updated_at timestamptz NULL,
  observed_at timestamptz NOT NULL,
  normalized jsonb NOT NULL,
  source_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'observed',
  status_reason text NULL,
  promoted_catalog_item_id text NULL,
  promoted_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_key, language_code, external_key)
);

CREATE INDEX IF NOT EXISTS catalog_source_observations_provider_idx
  ON catalog_source_observations (provider_key, language_code);
CREATE INDEX IF NOT EXISTS catalog_source_observations_status_idx
  ON catalog_source_observations (status);
CREATE INDEX IF NOT EXISTS catalog_source_observations_name_idx
  ON catalog_source_observations USING gin (
    to_tsvector(
      'simple',
      coalesce(normalized->>'name', '') || ' ' || coalesce(normalized->>'expansionName', normalized->>'setName', '') || ' ' || external_key
    )
  );

${durableJobSchemaSql({
  jobsTable: "catalog_source_observation_bulk_review_jobs",
  eventsTable: "catalog_source_observation_bulk_review_job_events",
  notifyChannel: "catalog_source_observation_durable_job_events",
})}

${durableJobWorkUnitSchemaSql({
  jobsTable: "catalog_source_observation_bulk_review_jobs",
  workUnitsTable: "catalog_source_observation_bulk_review_work_units",
})}

${durableJobSchemaSql({
  jobsTable: "catalog_source_observation_integration_durable_jobs",
  eventsTable: "catalog_source_observation_integration_job_events",
  notifyChannel: "catalog_source_observation_durable_job_events",
})}
`;
