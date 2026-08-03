import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const waitlistSchemaSql = `
CREATE TABLE IF NOT EXISTS public_presence_waitlist_signups (
  signup_id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  role text NOT NULL,
  interests jsonb NOT NULL DEFAULT '[]'::jsonb,
  email_consent_accepted_at timestamptz NOT NULL,
  page_path text NOT NULL,
  referrer text NULL,
  utm_source text NULL,
  utm_medium text NULL,
  utm_campaign text NULL,
  utm_content text NULL,
  utm_term text NULL,
  public_referral_code text NULL,
  public_referral_code_issued_at timestamptz NULL,
  submitted_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS marketing_consent_accepted_at timestamptz NULL;

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS referred_by_signup_id text NULL;

-- Wave-1 cohort quality signals (campaign-admission-bar-policy.ts), captured
-- only from sell/both-intent signups. See docs/GLOSSARY.md "Cohort Quality
-- Signal" and public-presence's own GLOSSARY.md.
ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS games jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS has_store_link boolean NOT NULL DEFAULT false;

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS store_url text NULL;

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS inventory_size text NULL;

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS admitted_wave integer NULL CHECK (admitted_wave BETWEEN 1 AND 3);

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS beta_invitation_id text NULL;

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS admitted_at timestamptz NULL;

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS public_referral_code text NULL;

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS public_referral_code_issued_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS public_presence_waitlist_signups_role_idx
  ON public_presence_waitlist_signups (role, updated_at DESC);

CREATE INDEX IF NOT EXISTS public_presence_waitlist_signups_utm_source_idx
  ON public_presence_waitlist_signups (utm_source, updated_at DESC);

-- No index on referred_by_signup_id yet: prelaunch waitlist volume is small
-- enough that the admin ranking query and referral-summary count scan the
-- table directly. Add CREATE INDEX CONCURRENTLY through the schemaMigrations
-- ledger in this module if volume grows enough to matter (structure gate
-- forbids boot-time indexes on migration-added columns).
`;

/**
 * Existing databases never re-run `CREATE TABLE`, so the two Public Referral
 * Code columns above reach them only through this ledger. The uniqueness index
 * is created here rather than in boot SQL because the structure gate forbids
 * boot-time indexes on migration-added columns, and it is partial so the
 * pre-existing signups the reconciliation slice backfills later stay valid
 * while their code column is still null.
 */
export const waitlistSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260802_public_presence_referral_codes",
    description:
      "Project immutable Public Referral Codes for operator review without using projection presence as coverage.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE public_presence_waitlist_signups ADD COLUMN IF NOT EXISTS public_referral_code text NULL;",
      "ALTER TABLE public_presence_waitlist_signups ADD COLUMN IF NOT EXISTS public_referral_code_issued_at timestamptz NULL;",
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS public_presence_waitlist_signups_public_referral_code_uidx ON public_presence_waitlist_signups (public_referral_code) WHERE public_referral_code IS NOT NULL;",
    ],
  },
];
