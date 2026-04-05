export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildPricingApi } from "./api";
import { pricingSchemaSql } from "./schema";
import { seedPricingDatabase } from "./seed";
import type { PricingServicePorts, PricingServices } from "./services";
import { createPricingServices } from "./services";

export const module: BcApiModule<
  PricingServices,
  PgTransactionalPool,
  PricingServicePorts
> = {
  contextName: "pricing",
  routePrefix: "/api/marketplace",
  streamPrefix: "pricing.",
  schemaSql: pricingSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    PricingServices,
    PgTransactionalPool,
    PricingServicePorts
  >["apiMounts"],
  createServices: (pool, ports) => createPricingServices(pool, ports),
  buildApis: (services) => [buildPricingApi(services)],
  projectors: (services) => services.projectors,
  seed: seedPricingDatabase,
};
