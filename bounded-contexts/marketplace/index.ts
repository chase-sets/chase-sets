export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
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
  apiMounts: contextManifest.apiMounts as BcApiModule<MarketplaceServices, PgTransactionalPool, void>["apiMounts"],
  createServices: (pool) => createMarketplaceServices(pool),
  buildApis: (services) => [buildMarketplaceApi(services)],
  projectors: (services) => services.projectors,
  seed: seedMarketplaceDatabase,
};
