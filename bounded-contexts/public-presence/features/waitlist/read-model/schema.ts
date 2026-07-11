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
  submitted_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS marketing_consent_accepted_at timestamptz NULL;

ALTER TABLE public_presence_waitlist_signups
  ADD COLUMN IF NOT EXISTS referred_by_signup_id text NULL;

CREATE INDEX IF NOT EXISTS public_presence_waitlist_signups_role_idx
  ON public_presence_waitlist_signups (role, updated_at DESC);

CREATE INDEX IF NOT EXISTS public_presence_waitlist_signups_utm_source_idx
  ON public_presence_waitlist_signups (utm_source, updated_at DESC);

-- No index on referred_by_signup_id yet: prelaunch waitlist volume is small
-- enough that the admin ranking query and referral-summary count scan the
-- table directly. Add CREATE INDEX CONCURRENTLY through the schemaMigrations
-- ledger in unlogged-projection-migrations.ts if volume grows enough to
-- matter (structure gate forbids boot-time indexes on migration-added
-- columns).
`;
