export const settlementPayoutReadinessSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_payout_readiness_pages (
  account_id text PRIMARY KEY,
  status text NOT NULL,
  missing_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  advisory_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  disabled_reason text NULL,
  requirements_deadline timestamptz NULL,
  provider_reference text NULL,
  contact_email text NULL,
  onboarding_status text NOT NULL DEFAULT 'not-started',
  transfer_capability_status text NOT NULL DEFAULT 'inactive',
  payout_capability_status text NOT NULL DEFAULT 'inactive',
  payout_destination_status text NOT NULL DEFAULT 'missing',
  payout_destination_fingerprint text NULL,
  payout_destination_changed_at timestamptz NULL,
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
`;

export const settlementPayoutReadinessSchemaMigrations = [
  {
    migrationId: "20260707_settlement_payout_destination_friction",
    description: "Track safe payout destination change metadata for takeover-friction enforcement.",
    statements: [
      `SET lock_timeout = '2s'`,
      `ALTER TABLE settlement_payout_readiness_pages ADD COLUMN IF NOT EXISTS contact_email text NULL`,
      `ALTER TABLE settlement_payout_readiness_pages ADD COLUMN IF NOT EXISTS payout_destination_fingerprint text NULL`,
      `ALTER TABLE settlement_payout_readiness_pages ADD COLUMN IF NOT EXISTS payout_destination_changed_at timestamptz NULL`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_payout_readiness_pages_provider_posture_idx
  ON settlement_payout_readiness_pages (
    payout_account_dashboard,
    requirements_collector,
    provider_reference
  )
  WHERE provider_reference IS NOT NULL`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_payout_readiness_destination_changed_idx
  ON settlement_payout_readiness_pages (payout_destination_changed_at DESC, account_id)
      WHERE payout_destination_changed_at IS NOT NULL`,
    ],
  },
  {
    migrationId: "20260712_settlement_payout_requirement_tiers",
    description: "Separate advisory payout requirements and retain provider restriction timing.",
    statements: [
      `ALTER TABLE settlement_payout_readiness_pages ADD COLUMN IF NOT EXISTS advisory_requirements jsonb NOT NULL DEFAULT '[]'::jsonb`,
      `ALTER TABLE settlement_payout_readiness_pages ADD COLUMN IF NOT EXISTS disabled_reason text NULL`,
      `ALTER TABLE settlement_payout_readiness_pages ADD COLUMN IF NOT EXISTS requirements_deadline timestamptz NULL`,
    ],
  },
] as const;
