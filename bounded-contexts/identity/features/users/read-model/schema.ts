import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const identityUserSchemaSql = `
CREATE TABLE IF NOT EXISTS identity_users (
  user_id text PRIMARY KEY,
  display_name text NOT NULL,
  given_name text NOT NULL,
  family_name text NOT NULL,
  primary_email text NULL,
  status text NOT NULL,
  contact_methods jsonb NOT NULL DEFAULT '[]'::jsonb,
  auth_methods jsonb NOT NULL DEFAULT '[]'::jsonb,
  password_credential_id text NULL,
  passkey_credential_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  social_login_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity_users
  ADD COLUMN IF NOT EXISTS social_login_links jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE identity_users
  ALTER COLUMN primary_email DROP NOT NULL;

CREATE TABLE IF NOT EXISTS identity_user_emails (
  email text PRIMARY KEY,
  user_id text NOT NULL,
  contact_method_id text NOT NULL,
  is_verified boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_user_phones (
  phone text PRIMARY KEY,
  user_id text NOT NULL,
  contact_method_id text NOT NULL,
  is_verified boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_user_social_login_links (
  provider_name text NOT NULL,
  provider_subject text NOT NULL,
  user_id text NOT NULL,
  email text NOT NULL,
  linked_at timestamptz NOT NULL,
  link_key text NOT NULL,
  state text NOT NULL DEFAULT 'active' CONSTRAINT identity_social_login_link_state CHECK (state IN ('active', 'revocation-requested', 'revoked')),
  revoked_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_name, provider_subject)
);`;

export const identitySocialLoginSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261105_identity_social_login_link_lifecycle",
    description: "Retain Social Login Link revocation state and backfill legacy active links.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE identity_user_social_login_links ADD COLUMN IF NOT EXISTS link_key text, ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active', ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL;",
      "UPDATE identity_user_social_login_links SET link_key = encode(sha256(convert_to(provider_name || ':' || btrim(provider_subject), 'UTF8')), 'hex') WHERE link_key IS NULL;",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'identity_user_social_login_links'::regclass AND conname = 'identity_social_login_link_key_required') THEN ALTER TABLE identity_user_social_login_links ADD CONSTRAINT identity_social_login_link_key_required CHECK (link_key IS NOT NULL) NOT VALID; END IF; END $$;",
      "ALTER TABLE identity_user_social_login_links VALIDATE CONSTRAINT identity_social_login_link_key_required;",
      "ALTER TABLE identity_user_social_login_links ALTER COLUMN link_key SET NOT NULL;",
      "ALTER TABLE identity_user_social_login_links DROP CONSTRAINT IF EXISTS identity_social_login_link_key_required;",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'identity_user_social_login_links'::regclass AND conname = 'identity_social_login_link_state') THEN ALTER TABLE identity_user_social_login_links ADD CONSTRAINT identity_social_login_link_state CHECK (state IN ('active', 'revocation-requested', 'revoked')) NOT VALID; END IF; END $$;",
      "ALTER TABLE identity_user_social_login_links VALIDATE CONSTRAINT identity_social_login_link_state;",
      "UPDATE identity_users SET social_login_links = COALESCE((SELECT jsonb_agg(link || jsonb_build_object('state', COALESCE(link->>'state', 'active'))) FROM jsonb_array_elements(social_login_links) AS link), '[]'::jsonb);",
      "RESET lock_timeout;",
    ],
  },
];
