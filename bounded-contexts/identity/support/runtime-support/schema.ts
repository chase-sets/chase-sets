import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { identityListingCredentialSchemaStatements } from "../../features/access-hub/api/listing-credentials";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { identityAccountSchemaSql } from "../../features/accounts/read-model/schema";
import { identityApiKeySchemaSql } from "../../features/api-keys/read-model/schema";
import { identityConsentSchemaSql } from "../../features/consents/read-model/schema";
import { identityInvitationSchemaSql } from "../../features/invitations/read-model/schema";
import { identityFoundersCohortSchemaSql } from "../../features/founders-cohort/read-model/schema";
import { identityMembershipSchemaSql } from "../../features/memberships/read-model/schema";
import { identityUserPreferencesSchemaSql } from "../../features/preferences/read-model/schema";
import { identityShippingAddressSchemaSql } from "../../features/shipping-addresses/read-model/schema";
import { identityUserSchemaSql } from "../../features/users/read-model/schema";
import { identityLinkedPlatformAuthorizationSchemaSql } from "../ucp-support/linked-platform-authorizations";

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
  identityFoundersCohortSchemaSql,
  identityApiKeySchemaSql,
  identityConsentSchemaSql,
  identityUserPreferencesSchemaSql,
  identityLinkedPlatformAuthorizationSchemaSql,
  identityShippingAddressSchemaSql,
  identityApiKeySecretSchemaSql,
  ...identityListingCredentialSchemaStatements,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for the Terms of Service active-version registry -- see
  // ../../features/consents/domain/terms-of-service-policy.ts.
  platformPolicySchemaSql,
].join("\n\n");

export const identityListingAuthorityMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260928_identity_listing_authority",
    description: "Persist Identity credential revisions and owner-local idempotent mutation receipts.",
    statements: identityListingCredentialSchemaStatements,
  },
];
