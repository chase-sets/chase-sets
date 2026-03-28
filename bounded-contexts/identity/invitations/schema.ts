export const identityInvitationSchemaSql = `CREATE TABLE IF NOT EXISTS identity_invitations (
  invitation_id text PRIMARY KEY,
  account_id text NOT NULL,
  email text NOT NULL,
  role_key text NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_by_user_id text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;
