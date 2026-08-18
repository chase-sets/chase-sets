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
import { createIdentityServices } from "./support/runtime-support/services";
import { identitySchemaSql } from "./support/runtime-support/schema";
import { identityUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { identityAccountSchemaMigrations } from "./features/accounts/read-model/schema";
import { inspectIdentitySeedState, seedIdentityDatabase } from "./support/runtime-support/seed";
import { buildFounderClaimReactionHandlers } from "./features/founders-cohort/integrations/marketplace/founder-claim-reaction";

const identityContextManifest = contextManifest as BcContextManifest;

export const module = defineBoundedContextModule<IdentityServices, PgTransactionalPool, IdentityHostPorts>({
  manifest: identityContextManifest,
  schemaSql: identitySchemaSql,
  schemaMigrations: [...identityAccountSchemaMigrations, ...identityUnloggedProjectionSchemaMigrations],
  retentionExemptions: identityRetentionExemptions,
  createServices: (pool, options) => createIdentityServices(pool, options ?? {}),
  buildApis: (services) => [
    { mountPath: "/api/identity", contextMountOrdinal: 1, router: buildIdentityApi(services) },
    { mountPath: "/api/public/identity", contextMountOrdinal: 2, router: buildIdentityPublicApi(services) },
  ],
  buildMcpHandlers: (services) => createAccountMcpHandlers(services.accounts),
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
  seedProfiles: ["scenario-seed", "representative-commerce-state", "admin-qa-actor-fixtures"],
  seed: seedIdentityDatabase,
  inspectSeedState: (pool, options) => inspectIdentitySeedState(pool, options),
});
