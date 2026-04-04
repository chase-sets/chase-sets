export { FulfillmentDomainError } from "./common";
export { default as contextManifest } from "./context.json";
export { buildFulfillmentApi } from "./api";
export type { FulfillmentApiEnv } from "./api";
export { createFulfillmentServices } from "./services";
export type { FulfillmentServices } from "./services";
export { fulfillmentSchemaSql } from "./schema";
export { seedFulfillmentDatabase } from "./seed";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import { resolveContextApiMounts } from "@chase-sets/bounded-context-runtime";
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
  createServices: (pool) => createFulfillmentServices(pool),
  buildApi: buildFulfillmentApi,
  projectors: (services) => services.projectors,
  seed: seedFulfillmentDatabase,
};

export function resolveApiMounts(services: FulfillmentServices) {
  return resolveContextApiMounts(contextManifest.contextName, contextManifest.apiMounts, [
    buildFulfillmentApi(services),
  ]);
}
