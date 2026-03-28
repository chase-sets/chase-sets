import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { identityAccountSchemaSql } from "./accounts/schema";
import { identityApiKeySchemaSql } from "./api-keys/schema";
import { identityConsentSchemaSql } from "./consents/schema";
import { identityInvitationSchemaSql } from "./invitations/schema";
import { identityMembershipSchemaSql } from "./memberships/schema";
import { identitySessionSchemaSql } from "./sessions/schema";
import { identityUserSchemaSql } from "./users/schema";

const identityAuthSchemaSql = `
CREATE TABLE IF NOT EXISTS identity_password_credentials (
  credential_id text PRIMARY KEY,
  user_id text NOT NULL,
  secret_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_passkey_credentials (
  credential_id text PRIMARY KEY,
  user_id text NOT NULL,
  external_credential_id text NOT NULL UNIQUE,
  label text NOT NULL,
  public_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_passkey_lookup (
  external_credential_id text PRIMARY KEY,
  credential_id text NOT NULL,
  user_id text NOT NULL,
  label text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_magic_link_tokens (
  token_id text PRIMARY KEY,
  user_id text NULL,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_auth_challenges (
  challenge_id text PRIMARY KEY,
  purpose text NOT NULL,
  email text NULL,
  user_id text NULL,
  challenge_value text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_session_tokens (
  session_id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_api_key_secrets (
  api_key_id text PRIMARY KEY,
  user_id text NOT NULL,
  key_prefix text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);`;

export const identitySchemaSql = [
  eventCorePostgresSchemaSql,
  identityAccountSchemaSql,
  identityUserSchemaSql,
  identityMembershipSchemaSql,
  identityInvitationSchemaSql,
  identitySessionSchemaSql,
  identityApiKeySchemaSql,
  identityConsentSchemaSql,
  identityAuthSchemaSql,
].join("\n\n");
