export { buildMarketplaceApi } from "./api";
export type { MarketplaceApiEnv } from "./api";
export { createMarketplaceSupplyResolver } from "./supply-resolver";
export { createMarketplaceServices } from "./services";
export type { MarketplaceServices } from "./services";
export { marketplaceSchemaSql } from "./schema";
export { seedMarketplaceDatabase } from "./seed";

import type { BcModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { MarketplaceServices } from "./services";
import { buildMarketplaceApi } from "./api";
import { createMarketplaceServices } from "./services";
import { marketplaceSchemaSql } from "./schema";
import { seedMarketplaceDatabase } from "./seed";

export const module: BcModule<MarketplaceServices, PgTransactionalPool> = {
  routePrefix: "/api/marketplace",
  schemaSql: marketplaceSchemaSql,
  createServices: createMarketplaceServices,
  buildApi: buildMarketplaceApi,
  projectors: (services) => services.projectors,
  seed: seedMarketplaceDatabase,
};
