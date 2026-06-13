import { durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";

export const discoveryGoogleShoppingSchemaSql = `CREATE TABLE IF NOT EXISTS discovery_google_shopping_feed_rows (
  row_id text PRIMARY KEY,
  listing_id text NOT NULL,
  account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  merchant_offer_id text NOT NULL,
  external_seller_id text NOT NULL,
  canonical_url text NOT NULL,
  target_country text NOT NULL,
  content_language text NOT NULL,
  feed_label text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash text NULL,
  eligibility_status text NOT NULL DEFAULT 'excluded',
  exclusion_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_eligibility_status text NOT NULL DEFAULT 'excluded',
  image_exclusion_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  shipping_policy_url text NULL,
  return_policy_url text NULL,
  return_policy_label text NULL,
  sync_status text NOT NULL DEFAULT 'never-submitted',
  last_submitted_payload_hash text NULL,
  last_submitted_at timestamptz NULL,
  last_accepted_at timestamptz NULL,
  last_sync_attempted_at timestamptz NULL,
  last_sync_error_code text NULL,
  last_sync_error_message text NULL,
  last_provider_request_id text NULL,
  last_provider_operation text NULL,
  last_provider_response jsonb NULL,
  diagnostic_status text NULL,
  diagnostic_destination_statuses jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostic_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_diagnostic_at timestamptz NULL,
  tombstone_status text NOT NULL DEFAULT 'live',
  delete_submitted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_google_shopping_feed_rows
  ADD COLUMN IF NOT EXISTS target_country text NOT NULL DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS content_language text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS feed_label text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS payload_hash text NULL,
  ADD COLUMN IF NOT EXISTS eligibility_status text NOT NULL DEFAULT 'excluded',
  ADD COLUMN IF NOT EXISTS exclusion_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS image_eligibility_status text NOT NULL DEFAULT 'excluded',
  ADD COLUMN IF NOT EXISTS image_exclusion_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS shipping_policy_url text NULL,
  ADD COLUMN IF NOT EXISTS return_policy_url text NULL,
  ADD COLUMN IF NOT EXISTS return_policy_label text NULL,
  ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'never-submitted',
  ADD COLUMN IF NOT EXISTS last_submitted_payload_hash text NULL,
  ADD COLUMN IF NOT EXISTS last_submitted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_accepted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_sync_attempted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_sync_error_code text NULL,
  ADD COLUMN IF NOT EXISTS last_sync_error_message text NULL,
  ADD COLUMN IF NOT EXISTS last_provider_request_id text NULL,
  ADD COLUMN IF NOT EXISTS last_provider_operation text NULL,
  ADD COLUMN IF NOT EXISTS last_provider_response jsonb NULL,
  ADD COLUMN IF NOT EXISTS diagnostic_status text NULL,
  ADD COLUMN IF NOT EXISTS diagnostic_destination_statuses jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS diagnostic_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_diagnostic_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS tombstone_status text NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS delete_submitted_at timestamptz NULL;

CREATE UNIQUE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_listing_idx
  ON discovery_google_shopping_feed_rows (listing_id);

CREATE UNIQUE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_merchant_offer_idx
  ON discovery_google_shopping_feed_rows (merchant_offer_id);

CREATE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_account_idx
  ON discovery_google_shopping_feed_rows (account_id);

CREATE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_product_idx
  ON discovery_google_shopping_feed_rows (catalog_catalog_item_id, product_id);

CREATE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_eligibility_idx
  ON discovery_google_shopping_feed_rows (eligibility_status, updated_at);

CREATE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_image_eligibility_idx
  ON discovery_google_shopping_feed_rows (image_eligibility_status, updated_at);

CREATE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_pending_sync_idx
  ON discovery_google_shopping_feed_rows (sync_status, updated_at)
  WHERE eligibility_status = 'eligible'
    AND tombstone_status = 'live'
    AND (payload_hash IS DISTINCT FROM last_submitted_payload_hash);

CREATE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_stale_refresh_idx
  ON discovery_google_shopping_feed_rows (last_submitted_at)
  WHERE eligibility_status = 'eligible'
    AND tombstone_status = 'live';

CREATE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_tombstone_idx
  ON discovery_google_shopping_feed_rows (tombstone_status, updated_at)
  WHERE tombstone_status <> 'live';

CREATE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_full_sync_scan_idx
  ON discovery_google_shopping_feed_rows (row_id ASC);

CREATE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_sync_error_idx
  ON discovery_google_shopping_feed_rows (last_sync_attempted_at DESC)
  WHERE sync_status = 'failed';

CREATE INDEX IF NOT EXISTS discovery_google_shopping_feed_rows_diagnostics_idx
  ON discovery_google_shopping_feed_rows (diagnostic_status, last_diagnostic_at DESC);

CREATE TABLE IF NOT EXISTS discovery_google_shopping_incremental_sync_requests (
  listing_id text PRIMARY KEY,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  not_before timestamptz NOT NULL DEFAULT now(),
  last_job_id text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_google_shopping_incremental_sync_requests
  ADD COLUMN IF NOT EXISTS reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS requested_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS not_before timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_job_id text NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS discovery_google_shopping_incremental_sync_requests_due_idx
  ON discovery_google_shopping_incremental_sync_requests (not_before, requested_at);

${durableJobSchemaSql({
  jobsTable: "discovery_google_shopping_sync_jobs",
  eventsTable: "discovery_google_shopping_sync_job_events",
  notifyChannel: "discovery_google_shopping_sync_job_events",
})}`;
