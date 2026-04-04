export { buildDiscoveryApi } from "./api";
export { createDiscoveryServices } from "./services";
export type { DiscoveryServices } from "./services";
export { discoverySchemaSql } from "./schema";
export { rebuildDiscoverySearchIndex } from "./items/search/projection";

import type { BcModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { DiscoveryServices } from "./services";
import { buildDiscoveryApi } from "./api";
import { createDiscoveryServices } from "./services";
import { discoverySchemaSql } from "./schema";

export const module: BcModule<DiscoveryServices, PgTransactionalPool> = {
  routePrefix: "/api/marketplace",
  schemaSql: discoverySchemaSql,
  createServices: createDiscoveryServices,
  buildApi: buildDiscoveryApi,
  projectors: (services) => services.projectors,
};
