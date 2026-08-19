import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { authIdentityProjectionSchemaSql } from "../auth-support/identity-projection";
import { authUcpOAuthSchemaSql } from "../ucp-support/oauth";
import { agentWebhookOutboxSchemaSql } from "../ucp-support/agent-webhooks/agent-webhook-outbox";
import { agentWebhookRegistrationSchemaSql } from "../ucp-support/agent-webhooks/agent-webhook-registration";

const authSessionSchemaSql = `
CREATE TABLE IF NOT EXISTS identity_sessions (
  session_id text PRIMARY KEY,
  user_id text NOT NULL,
  account_id text NOT NULL,
  available_account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  authentication_method text NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The moment-of-authentication fact recent-auth ("step-up") checks rely on.
-- Set once from the session's started event and never overwritten by later
-- account-switch/revoke/expire mutations -- see buildSessionProjectionHandlers.
ALTER TABLE identity_sessions
  ADD COLUMN IF NOT EXISTS started_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS identity_session_lookup (
  token_hash text PRIMARY KEY,
  session_id text NOT NULL,
  user_id text NOT NULL,
  account_id text NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;

const authCredentialSchemaSql = `
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
  sign_count integer NOT NULL DEFAULT 0,
  credential_device_type text NOT NULL DEFAULT 'unknown',
  credential_backed_up boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity_passkey_credentials
  ADD COLUMN IF NOT EXISTS sign_count integer NOT NULL DEFAULT 0;

ALTER TABLE identity_passkey_credentials
  ADD COLUMN IF NOT EXISTS credential_device_type text NOT NULL DEFAULT 'unknown';

ALTER TABLE identity_passkey_credentials
  ADD COLUMN IF NOT EXISTS credential_backed_up boolean NOT NULL DEFAULT false;

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
  delivery_token text NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity_magic_link_tokens
  ADD COLUMN IF NOT EXISTS delivery_token text NULL;

CREATE TABLE IF NOT EXISTS identity_phone_code_tokens (
  token_id text PRIMARY KEY,
  user_id text NULL,
  phone text NOT NULL,
  code_hash text NOT NULL,
  delivery_code text NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  invalidated_at timestamptz NULL,
  failed_attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity_phone_code_tokens
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz NULL;

ALTER TABLE identity_phone_code_tokens
  ADD COLUMN IF NOT EXISTS failed_attempt_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS identity_phone_code_tokens_lookup_idx
  ON identity_phone_code_tokens (phone, code_hash)
  WHERE consumed_at IS NULL;

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

CREATE TABLE IF NOT EXISTS identity_account_selection_tokens (
  token_id text PRIMARY KEY,
  user_id text NOT NULL,
  authentication_method text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_social_login_states (
  state_hash text PRIMARY KEY,
  provider_name text NOT NULL,
  journey text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_guest_checkout_tokens (
  token_id text PRIMARY KEY,
  account_id text NOT NULL,
  contact_email text NULL,
  contact_name text NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity_guest_checkout_tokens
  ALTER COLUMN contact_email DROP NOT NULL;

ALTER TABLE identity_guest_checkout_tokens
  ALTER COLUMN contact_name DROP NOT NULL;

CREATE TABLE IF NOT EXISTS identity_guest_checkout_claim_tokens (
  token_id text PRIMARY KEY,
  account_id text NOT NULL,
  payment_id text NOT NULL,
  email text NOT NULL,
  display_name text NULL,
  token_hash text NOT NULL UNIQUE,
  continuation_hash text NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity_guest_checkout_claim_tokens
  ADD COLUMN IF NOT EXISTS display_name text NULL;

ALTER TABLE identity_guest_checkout_claim_tokens
  ADD COLUMN IF NOT EXISTS continuation_hash text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS identity_guest_checkout_claim_tokens_continuation_hash_idx
  ON identity_guest_checkout_claim_tokens (continuation_hash)
  WHERE continuation_hash IS NOT NULL;`;

export const authSchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  authIdentityProjectionSchemaSql,
  authUcpOAuthSchemaSql,
  agentWebhookRegistrationSchemaSql,
  agentWebhookOutboxSchemaSql,
  authSessionSchemaSql,
  authCredentialSchemaSql,
].join("\n\n");
