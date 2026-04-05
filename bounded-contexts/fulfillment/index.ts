export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { FulfillmentServices } from "./services";
import { buildFulfillmentApi } from "./api";
import { createFulfillmentServices } from "./services";
import { fulfillmentSchemaSql } from "./schema";
import { seedFulfillmentDatabase } from "./seed";

export const module: BcApiModule<FulfillmentServices, PgTransactionalPool, void> = {
  contextName: "fulfillment",
  routePrefix: "/api/marketplace",
  streamPrefix: "fulfillment.",
  schemaSql: fulfillmentSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<FulfillmentServices, PgTransactionalPool, void>["apiMounts"],
  createServices: (pool) => createFulfillmentServices(pool),
  buildApis: (services) => [buildFulfillmentApi(services)],
  projectors: (services) => services.projectors,
  seed: seedFulfillmentDatabase,
};
