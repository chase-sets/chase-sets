export { FulfillmentDomainError } from "./common";
export { buildFulfillmentApi } from "./api";
export type { FulfillmentApiEnv } from "./api";
export { createFulfillmentServices } from "./services";
export type { FulfillmentServices } from "./services";
export { fulfillmentSchemaSql } from "./schema";
export { seedFulfillmentDatabase } from "./seed";

import type { BcModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { FulfillmentServices } from "./services";
import { buildFulfillmentApi } from "./api";
import { createFulfillmentServices } from "./services";
import { fulfillmentSchemaSql } from "./schema";
import { seedFulfillmentDatabase } from "./seed";

export const module: BcModule<FulfillmentServices, PgTransactionalPool> = {
  routePrefix: "/api/marketplace",
  schemaSql: fulfillmentSchemaSql,
  createServices: createFulfillmentServices,
  buildApi: buildFulfillmentApi,
  projectors: (services) => services.projectors,
  seed: seedFulfillmentDatabase,
};
