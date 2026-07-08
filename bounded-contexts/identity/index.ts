export { default as contextManifest } from "./context.json";

import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { IdentityHostPorts, IdentityServices } from "./support/runtime-support/services";
import { buildIdentityApi } from "./api";
import { createAccountMcpHandlers } from "./features/accounts/api/mcp";
import { createIdentityServices } from "./support/runtime-support/services";
import { identitySchemaSql } from "./support/runtime-support/schema";
import { seedIdentityDatabase } from "./support/runtime-support/seed";

export const module = defineBoundedContextModule<IdentityServices, PgTransactionalPool, IdentityHostPorts>({
  manifest: contextManifest,
  schemaSql: identitySchemaSql,
  createServices: (pool, options) => createIdentityServices(pool, options ?? {}),
  buildApis: (services) => [buildIdentityApi(services)],
  buildMcpHandlers: (services) => createAccountMcpHandlers(services.accounts),
  projectionHandlerSets: (services) => services.projectors,
  seedProfiles: ["scenario-seed", "representative-commerce-state"],
  seed: seedIdentityDatabase,
});
