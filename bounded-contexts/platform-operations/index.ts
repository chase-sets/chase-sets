export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildPlatformOperationsApi } from "./api";
import contextManifest from "./context.json";
import { platformOperationsSchemaSql } from "./support/runtime-support/schema";
import { createPlatformOperationsServices, type PlatformOperationsServices } from "./support/runtime-support/services";

export const module: BcApiModule<PlatformOperationsServices, PgTransactionalPool, void> = {
  contextName: "platform-operations",
  routePrefix: "/api/platform",
  streamPrefix: "platform-operations.",
  schemaSql: platformOperationsSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    PlatformOperationsServices,
    PgTransactionalPool,
    void
  >["apiMounts"],
  createServices: (pool) => createPlatformOperationsServices(pool),
  buildApis: (services) => [buildPlatformOperationsApi(services)],
};
