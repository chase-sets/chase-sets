export { buildMarketplaceApi } from "./api";
export type { MarketplaceApiEnv } from "./api";
export { createMarketplaceSupplyResolver } from "./integration";
export { createMarketplaceServices } from "./services";
export type { MarketplaceServices } from "./services";
export { marketplaceSchemaSql } from "./schema";
export { seedMarketplaceDatabase } from "./seed";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { MarketplaceServices } from "./services";
import { buildMarketplaceApi } from "./api";
import { createMarketplaceServices } from "./services";
import { marketplaceSchemaSql } from "./schema";
import { seedMarketplaceDatabase } from "./seed";

export const module: BcApiModule<MarketplaceServices, PgTransactionalPool, void> = {
  contextName: "marketplace",
  routePrefix: "/api/marketplace",
  streamPrefix: "marketplace.",
  schemaSql: marketplaceSchemaSql,
  createServices: (pool) => createMarketplaceServices(pool),
  buildApi: buildMarketplaceApi,
  projectors: (services) => services.projectors,
  seed: seedMarketplaceDatabase,
};
