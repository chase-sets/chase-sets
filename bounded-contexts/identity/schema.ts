import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { identityAccountSchemaSql } from "./accounts/schema";
import { identityApiKeySchemaSql } from "./api-keys/schema";
import { identityConsentSchemaSql } from "./consents/schema";
import { identityInvitationSchemaSql } from "./invitations/schema";
import { identityMembershipSchemaSql } from "./memberships/schema";
import { identityUserSchemaSql } from "./users/schema";

const identityApiKeySecretSchemaSql = `
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
  identityApiKeySchemaSql,
  identityConsentSchemaSql,
  identityApiKeySecretSchemaSql,
].join("\n\n");
