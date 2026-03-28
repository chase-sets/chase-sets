export const identityUserSchemaSql = `
CREATE TABLE IF NOT EXISTS identity_users (
  user_id text PRIMARY KEY,
  display_name text NOT NULL,
  given_name text NOT NULL,
  family_name text NOT NULL,
  primary_email text NOT NULL,
  status text NOT NULL,
  contact_methods jsonb NOT NULL DEFAULT '[]'::jsonb,
  auth_methods jsonb NOT NULL DEFAULT '[]'::jsonb,
  password_credential_id text NULL,
  passkey_credential_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_user_emails (
  email text PRIMARY KEY,
  user_id text NOT NULL,
  contact_method_id text NOT NULL,
  is_verified boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;
