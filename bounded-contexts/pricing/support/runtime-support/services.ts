import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createPriceSignalRuntime } from "../../features/price-signals/api/runtime";
import { createPricingRecommendationRuntime } from "../../features/recommendations/api/runtime";
import { createMarketRollupsRuntime } from "../../features/market-rollups/api/runtime";
import { createRepricingPolicyRuntime } from "../../features/repricing-policies/api/runtime";

export type PricingServices = Readonly<{
  priceSignals: ReturnType<typeof createPriceSignalRuntime>;
  recommendations: ReturnType<typeof createPricingRecommendationRuntime>;
  marketRollups: ReturnType<typeof createMarketRollupsRuntime>;
  repricingPolicies: ReturnType<typeof createRepricingPolicyRuntime>;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createPricingServices(pool: PgTransactionalPool): PricingServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "pricing" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const priceSignals = createPriceSignalRuntime({ db });
  const recommendations = createPricingRecommendationRuntime({
    eventStore,
    checkpointStore,
    db,
  });
  const marketRollups = createMarketRollupsRuntime({ db });
  const repricingPolicies = createRepricingPolicyRuntime({ eventStore, db });

  return {
    priceSignals,
    recommendations,
    marketRollups,
    repricingPolicies,
    projectors: [...priceSignals.projectors, ...recommendations.projectors, ...repricingPolicies.projectors],
    pool,
    db,
  };
}
