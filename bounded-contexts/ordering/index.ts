export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { OrderingServices, OrderingServiceOptions } from "./services";
import { buildOrderingApi } from "./api";
import { createOrderingServices } from "./services";
import { orderingSchemaSql } from "./schema";
import { seedOrderingDatabase } from "./seed";

export const module: BcApiModule<OrderingServices, PgTransactionalPool, OrderingServiceOptions> = {
  contextName: "ordering",
  routePrefix: "/api/marketplace",
  streamPrefix: "ordering.",
  schemaSql: orderingSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<OrderingServices, PgTransactionalPool, OrderingServiceOptions>["apiMounts"],
  createServices: (pool, options) => createOrderingServices(pool, options),
  buildApis: (services) => [buildOrderingApi(services)],
  projectors: (services) => services.projectors,
  seed: seedOrderingDatabase,
};
