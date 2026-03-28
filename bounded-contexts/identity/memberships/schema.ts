export const identityMembershipSchemaSql = `
CREATE TABLE IF NOT EXISTS identity_memberships (
  membership_id text PRIMARY KEY,
  user_id text NOT NULL,
  account_id text NOT NULL,
  role_key text NOT NULL,
  role_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_user_memberships (
  membership_id text PRIMARY KEY,
  user_id text NOT NULL,
  account_id text NOT NULL,
  role_key text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;
