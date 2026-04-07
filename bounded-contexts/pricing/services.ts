import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createPricingRecommendationRuntime } from "./recommendations/runtime";

export type PricingServices = Readonly<{
  recommendations: ReturnType<typeof createPricingRecommendationRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createPricingServices(
  pool: PgTransactionalPool,
): PricingServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const recommendations = createPricingRecommendationRuntime({
    eventStore,
    checkpointStore,
    db,
  });

  return {
    recommendations,
    projectors: [...recommendations.projectors],
    pool,
    db,
  };
}
