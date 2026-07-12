import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createPriceSignalRuntime } from "../../features/price-signals/api/runtime";
import { createPricingRecommendationRuntime } from "../../features/recommendations/api/runtime";
import { createMarketRollupsRuntime } from "../../features/market-rollups/api/runtime";
import { createRepricingPolicyRuntime } from "../../features/repricing-policies/api/runtime";
import { createPublicMarketPagesRuntime } from "../../features/public-market-pages/api/runtime";

export type PricingServices = Readonly<{
  priceSignals: ReturnType<typeof createPriceSignalRuntime>;
  recommendations: ReturnType<typeof createPricingRecommendationRuntime>;
  marketRollups: ReturnType<typeof createMarketRollupsRuntime>;
  repricingPolicies: ReturnType<typeof createRepricingPolicyRuntime>;
  publicMarketPages: ReturnType<typeof createPublicMarketPagesRuntime>;
  /**
   * The shared platform-policy runtime, mounted for this context's
   * `definePolicy` documents (the market-stat-hygiene and market-analytics-
   * display policies). Exposed on services so the `platform-api`
   * composition root can register it as the policy console's write port for
   * pricing's policies (see `../../server.ts` and
   * `deployables/platform-api/src/app.ts`).
   */
  policies: PolicyRuntime;
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
  const policies = createPolicyRuntime({ eventStore, db });
  const priceSignals = createPriceSignalRuntime({ db });
  const recommendations = createPricingRecommendationRuntime({
    eventStore,
    checkpointStore,
    db,
  });
  const marketRollups = createMarketRollupsRuntime({ db, policies });
  const repricingPolicies = createRepricingPolicyRuntime({ eventStore, db });
  const publicMarketPages = createPublicMarketPagesRuntime({ db, policies });

  return {
    priceSignals,
    recommendations,
    marketRollups,
    repricingPolicies,
    publicMarketPages,
    policies,
    projectors: [
      ...priceSignals.projectors,
      ...recommendations.projectors,
      ...repricingPolicies.projectors,
      ...policies.projectors,
    ],
    pool,
    db,
  };
}
