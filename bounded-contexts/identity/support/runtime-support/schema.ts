import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { identityAccountSchemaSql } from "../../features/accounts/read-model/schema";
import { identityApiKeySchemaSql } from "../../features/api-keys/read-model/schema";
import { identityConsentSchemaSql } from "../../features/consents/read-model/schema";
import { identityInvitationSchemaSql } from "../../features/invitations/read-model/schema";
import { identityMembershipSchemaSql } from "../../features/memberships/read-model/schema";
import { identityUserSchemaSql } from "../../features/users/read-model/schema";

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
