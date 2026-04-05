export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
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
  apiMounts: contextManifest.apiMounts as BcApiModule<InventoryServices, PgTransactionalPool, void>["apiMounts"],
  createServices: (pool) => createInventoryServices(pool),
  buildApis: (services) => [buildInventoryApi(services)],
  projectors: (services) => services.projectors,
  seed: seedInventoryDatabase,
};
