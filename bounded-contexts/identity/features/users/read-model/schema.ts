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
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revocation-requested', 'revoked')),
  revoked_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_name, provider_subject)
);

ALTER TABLE identity_user_social_login_links
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active';
ALTER TABLE identity_user_social_login_links
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL;`;

export const identityUserSchemaMigrations = [
  {
    migrationId: "20261020_identity_social_login_lifecycle",
    description: "Retain collision-safe social-login ownership lifecycle state.",
    statements: [
      "ALTER TABLE identity_user_social_login_links ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active'",
      "ALTER TABLE identity_user_social_login_links ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL",
      "ALTER TABLE identity_user_social_login_links DROP CONSTRAINT IF EXISTS identity_user_social_login_links_state_check",
      "ALTER TABLE identity_user_social_login_links ADD CONSTRAINT identity_user_social_login_links_state_check CHECK (state IN ('active', 'revocation-requested', 'revoked')) NOT VALID",
      "ALTER TABLE identity_user_social_login_links VALIDATE CONSTRAINT identity_user_social_login_links_state_check",
    ],
  },
] as const;
