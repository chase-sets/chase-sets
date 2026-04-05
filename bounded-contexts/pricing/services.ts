import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import {
  createPricingRecommendationRuntime,
  type PricingRecommendationPorts,
} from "./recommendations/runtime";

export type PricingServicePorts = Readonly<{
  resolveCatalogSellableUnit: (params: Readonly<Record<string, never>>) => Promise<unknown>;
  resolveMarketSupply: (params: Readonly<Record<string, never>>) => Promise<unknown>;
  reserveInventorySignal: (params: Readonly<Record<string, never>>) => Promise<unknown>;
  loadOrderSnapshot: (params: Readonly<Record<string, never>>) => Promise<unknown>;
}>;

export type PricingServices = Readonly<{
  recommendations: ReturnType<typeof createPricingRecommendationRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

function toRecommendationPorts(ports: PricingServicePorts): PricingRecommendationPorts {
  return {
    resolveCatalogSellableUnit: ports.resolveCatalogSellableUnit,
    resolveMarketSupply: ports.resolveMarketSupply,
    reserveInventorySignal: ports.reserveInventorySignal,
    loadOrderSnapshot: ports.loadOrderSnapshot,
  };
}

export function createPricingServices(
  pool: PgTransactionalPool,
  ports: PricingServicePorts,
): PricingServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const recommendations = createPricingRecommendationRuntime({
    eventStore,
    checkpointStore,
    db,
    ports: toRecommendationPorts(ports),
  });

  return {
    recommendations,
    projectors: [...recommendations.projectors],
    pool,
    db,
  };
}
