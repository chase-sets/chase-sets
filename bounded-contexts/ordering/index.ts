export { OrderingDomainError } from "./common";
export type {
  InventoryReservationGateway,
  MarketplaceDemand,
  MarketplaceSupplyCandidate,
  MarketplaceSupplyResolver,
  ShippingQuotePolicy,
  ShippingQuoteResult,
} from "./policies";
export { defaultShippingQuotePolicy } from "./policies";
export { buildOrderingApi } from "./api";
export type { OrderingApiEnv } from "./api";
export { createOrderingServices } from "./services";
export type { OrderingServices, OrderingServiceOptions } from "./services";
export { orderingSchemaSql } from "./schema";
export { seedOrderingDatabase } from "./seed";

import type { BcModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { OrderingServices, OrderingServiceOptions } from "./services";
import { buildOrderingApi } from "./api";
import { createOrderingServices } from "./services";
import { orderingSchemaSql } from "./schema";
import { seedOrderingDatabase } from "./seed";

export function createOrderingModule(
  options: OrderingServiceOptions = {},
): BcModule<OrderingServices, PgTransactionalPool> {
  return {
    routePrefix: "/api/marketplace",
    schemaSql: orderingSchemaSql,
    createServices: (pool) => createOrderingServices(pool, options),
    buildApi: buildOrderingApi,
    projectors: (services) => services.projectors,
    seed: seedOrderingDatabase,
  };
}
