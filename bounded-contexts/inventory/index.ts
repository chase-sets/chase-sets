export { InventoryDomainError } from "./common";
export { default as contextManifest } from "./context.json";
export { buildInventoryApi } from "./api";
export type { InventoryActor, InventoryApiEnv } from "./api";
export { createInventoryServices } from "./services";
export type { InventoryServices } from "./services";
export { inventorySchemaSql } from "./schema";
export { seedInventoryDatabase } from "./seed";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import { resolveContextApiMounts } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { InventoryServices } from "./services";
import { buildInventoryApi } from "./api";
import { createInventoryServices } from "./services";
import { inventorySchemaSql } from "./schema";
import { seedInventoryDatabase } from "./seed";

export const module: BcApiModule<InventoryServices, PgTransactionalPool, void> = {
  contextName: "inventory",
  routePrefix: "/api/inventory",
  streamPrefix: "inventory.",
  schemaSql: inventorySchemaSql,
  createServices: (pool) => createInventoryServices(pool),
  buildApi: buildInventoryApi,
  projectors: (services) => services.projectors,
  seed: seedInventoryDatabase,
};

export function resolveApiMounts(services: InventoryServices) {
  return resolveContextApiMounts(contextManifest.contextName, contextManifest.apiMounts, [
    buildInventoryApi(services),
  ]);
}
