export const settlementPayoutReadinessSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_payout_readiness_pages (
  account_id text PRIMARY KEY,
  status text NOT NULL,
  missing_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_reference text NULL,
  onboarding_status text NOT NULL DEFAULT 'not-started',
  transfer_capability_status text NOT NULL DEFAULT 'inactive',
  payout_capability_status text NOT NULL DEFAULT 'inactive',
  payout_destination_status text NOT NULL DEFAULT 'missing',
  payout_account_dashboard text NOT NULL DEFAULT 'unknown',
  losses_collector text NOT NULL DEFAULT 'unknown',
  fees_collector text NOT NULL DEFAULT 'unknown',
  requirements_collector text NOT NULL DEFAULT 'unknown',
  updated_at timestamptz NOT NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_payout_readiness_pages_status_idx
  ON settlement_payout_readiness_pages (status, updated_at DESC, account_id DESC);

CREATE INDEX IF NOT EXISTS settlement_payout_readiness_pages_provider_reference_idx
  ON settlement_payout_readiness_pages (provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS settlement_payout_readiness_pages_provider_posture_idx
  ON settlement_payout_readiness_pages (
    payout_account_dashboard,
    requirements_collector,
    provider_reference
  )
  WHERE provider_reference IS NOT NULL;

ALTER TABLE settlement_payout_readiness_pages
  ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'not-started';

ALTER TABLE settlement_payout_readiness_pages
  ADD COLUMN IF NOT EXISTS transfer_capability_status text NOT NULL DEFAULT 'inactive';

ALTER TABLE settlement_payout_readiness_pages
  ADD COLUMN IF NOT EXISTS payout_capability_status text NOT NULL DEFAULT 'inactive';

ALTER TABLE settlement_payout_readiness_pages
  ADD COLUMN IF NOT EXISTS payout_destination_status text NOT NULL DEFAULT 'missing';

ALTER TABLE settlement_payout_readiness_pages
  ADD COLUMN IF NOT EXISTS payout_account_dashboard text NOT NULL DEFAULT 'unknown';

ALTER TABLE settlement_payout_readiness_pages
  ADD COLUMN IF NOT EXISTS losses_collector text NOT NULL DEFAULT 'unknown';

ALTER TABLE settlement_payout_readiness_pages
  ADD COLUMN IF NOT EXISTS fees_collector text NOT NULL DEFAULT 'unknown';

ALTER TABLE settlement_payout_readiness_pages
  ADD COLUMN IF NOT EXISTS requirements_collector text NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS settlement_payout_readiness_pages_provider_posture_idx
  ON settlement_payout_readiness_pages (
    payout_account_dashboard,
    requirements_collector,
    provider_reference
  )
  WHERE provider_reference IS NOT NULL;
`;
