export { InventoryDomainError } from "./common";
export { buildInventoryApi } from "./api";
export type { InventoryActor, InventoryApiEnv } from "./api";
export {
  createInventoryReservationGateway,
} from "./integration";
export type { InventoryReservationPort } from "./integration";
export { createInventoryServices } from "./services";
export type { InventoryServices } from "./services";
export { inventorySchemaSql } from "./schema";
export { seedInventoryDatabase } from "./seed";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
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
