export { default as contextManifest } from "./context.json";
export { buildMarketplaceApi } from "./api";
export type { MarketplaceApiEnv } from "./api";
export { createMarketplaceServices } from "./services";
export type { MarketplaceServices } from "./services";
export { marketplaceSchemaSql } from "./schema";
export { seedMarketplaceDatabase } from "./seed";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import { resolveContextApiMounts } from "@chase-sets/bounded-context-runtime";
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
  createServices: (pool) => createMarketplaceServices(pool),
  buildApi: buildMarketplaceApi,
  projectors: (services) => services.projectors,
  seed: seedMarketplaceDatabase,
};

export function resolveApiMounts(services: MarketplaceServices) {
  return resolveContextApiMounts(contextManifest.contextName, contextManifest.apiMounts, [
    buildMarketplaceApi(services),
  ]);
}
