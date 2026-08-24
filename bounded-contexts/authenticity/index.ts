export { default as contextManifest } from "./context.json" with { type: "json" };

import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json" with { type: "json" };
import { buildAuthenticityApi } from "./api";
import { createAuthenticityCaseMcpHandlers } from "./features/cases/api/mcp";
import { authenticityRetentionExemptions } from "./support/runtime-support/retention-policy";
import { authenticitySchemaSql } from "./support/runtime-support/schema";
import {
  createAuthenticityServices,
  type AuthenticityHostPorts,
  type AuthenticityServices,
} from "./support/runtime-support/services";

export const module = defineBoundedContextModule<AuthenticityServices, PgTransactionalPool, AuthenticityHostPorts>({
  manifest: contextManifest,
  schemaSql: authenticitySchemaSql,
  retentionExemptions: authenticityRetentionExemptions,
  createServices: (pool, ports) => createAuthenticityServices(pool, ports),
  buildApis: (services) => [
    { mountPath: "/api/authenticity", contextMountOrdinal: 1, router: buildAuthenticityApi(services) },
  ],
  buildMcpHandlers: (services) => createAuthenticityCaseMcpHandlers(services.cases),
  projectionHandlerSets: (services) => services.projectors,
});
