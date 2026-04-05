export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { DiscoveryServices } from "./services";
import { buildDiscoveryApi } from "./api";
import { createDiscoveryServices } from "./services";
import { discoverySchemaSql } from "./schema";

export const module: BcApiModule<DiscoveryServices, PgTransactionalPool, void> = {
  contextName: "discovery",
  routePrefix: "/api/marketplace",
  streamPrefix: "discovery.",
  schemaSql: discoverySchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<DiscoveryServices, PgTransactionalPool, void>["apiMounts"],
  createServices: (pool) => createDiscoveryServices(pool),
  buildApis: (services) => [buildDiscoveryApi(services)],
  projectors: (services) => services.projectors,
};
