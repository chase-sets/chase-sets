export { OrderingDomainError } from "./common";
export { default as contextManifest } from "./context.json";
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

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import { resolveContextApiMounts } from "@chase-sets/bounded-context-runtime";
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
  createServices: (pool, options) => createOrderingServices(pool, options),
  buildApi: buildOrderingApi,
  projectors: (services) => services.projectors,
  seed: seedOrderingDatabase,
};

export function createOrderingModule(
  options: OrderingServiceOptions = {},
): BcApiModule<OrderingServices, PgTransactionalPool, void> {
  return {
    ...module,
    createServices: (pool) => createOrderingServices(pool, options),
  };
}

export function resolveApiMounts(services: OrderingServices) {
  return resolveContextApiMounts(contextManifest.contextName, contextManifest.apiMounts, [
    buildOrderingApi(services),
  ]);
}
