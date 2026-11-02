export { default as contextManifest } from "./context.json" with { type: "json" };

import {
  buildEventReactionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json" with { type: "json" };
import { identityRetentionExemptions } from "./support/runtime-support/retention-policy";
import type { IdentityHostPorts, IdentityServices } from "./support/runtime-support/services";
import { buildIdentityApi, buildIdentityPublicApi } from "./api";
import { createAccountMcpHandlers } from "./features/accounts/api/mcp";
import { createUserMcpHandlers } from "./features/users/api/mcp";
import { createAccessHubMcpHandlers } from "./features/access-hub/api/mcp";
import { createInvitationMcpHandlers } from "./features/invitations/api/mcp";
import { createMembershipMcpHandlers } from "./features/memberships/api/mcp";
import { createApiKeyMcpHandlers } from "./features/api-keys/api/mcp";
import { createIdentityServices } from "./support/runtime-support/services";
import { identitySchemaSql } from "./support/runtime-support/schema";
import { identityUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { identityAccountSchemaMigrations } from "./features/accounts/read-model/schema";
import { identityAgentGrantRevocationSchemaMigrations } from "./features/agent-grants/read-model/schema";
import { inspectIdentitySeedState, seedIdentityDatabase } from "./support/runtime-support/seed";
import { buildFounderClaimReactionHandlers } from "./features/founders-cohort/integrations/marketplace/founder-claim-reaction";

const identityContextManifest = contextManifest as BcContextManifest;

export const module = defineBoundedContextModule<IdentityServices, PgTransactionalPool, IdentityHostPorts>({
  manifest: identityContextManifest,
  schemaSql: identitySchemaSql,
  schemaMigrations: [
    ...identityAccountSchemaMigrations,
    ...identityUnloggedProjectionSchemaMigrations,
    ...identityAgentGrantRevocationSchemaMigrations,
  ],
  retentionExemptions: identityRetentionExemptions,
  createServices: (pool, options) => createIdentityServices(pool, options!),
  buildApis: (services) => [
    { mountPath: "/api/identity", contextMountOrdinal: 1, router: buildIdentityApi(services) },
    { mountPath: "/api/public/identity", contextMountOrdinal: 2, router: buildIdentityPublicApi(services) },
  ],
  buildMcpHandlers: (services) => {
    const accountHandlers = createAccountMcpHandlers(services.accounts);
    const userHandlers = createUserMcpHandlers(services.users);
    const accessHubHandlers = createAccessHubMcpHandlers(services.accessHub);
    const invitationHandlers = createInvitationMcpHandlers(services.invitations, services.accounts);
    const membershipHandlers = createMembershipMcpHandlers(services.memberships, services.accounts);
    const apiKeyHandlers = createApiKeyMcpHandlers(services.apiKeys, services.db);
    return {
      toolHandlers: {
        ...accountHandlers.toolHandlers,
        ...userHandlers.toolHandlers,
        ...accessHubHandlers.toolHandlers,
        ...invitationHandlers.toolHandlers,
        ...membershipHandlers.toolHandlers,
        ...apiKeyHandlers.toolHandlers,
      },
      resourceHandlers: {
        ...accountHandlers.resourceHandlers,
        ...userHandlers.resourceHandlers,
        ...accessHubHandlers.resourceHandlers,
        ...invitationHandlers.resourceHandlers,
        ...membershipHandlers.resourceHandlers,
        ...apiKeyHandlers.resourceHandlers,
      },
    };
  },
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventReactionsFromManifest({
      contextName: "identity",
      manifest: identityContextManifest,
      handlers: {
        "marketplace.identity-founder-claim-reaction": () =>
          buildFounderClaimReactionHandlers(services.foundersCohort.claimFounderNumber),
      },
    }),
  seedProfiles: ["critical-bootstrap", "scenario-seed", "representative-commerce-state", "admin-qa-actor-fixtures"],
  seed: seedIdentityDatabase,
  inspectSeedState: (pool, options) => inspectIdentitySeedState(pool, options),
});
