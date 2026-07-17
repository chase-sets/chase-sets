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
import { createMarketEstimatesRuntime } from "../../features/market-estimates/api/runtime";
import { createRepricingPolicyRuntime } from "../../features/repricing-policies/api/runtime";
import { createPublicMarketPagesRuntime } from "../../features/public-market-pages/api/runtime";
import { createBulkRepriceIngestionRuntime } from "../../features/bulk-reprice-ingestion/api/runtime";
import { createRepricingEngineRuntime } from "../../features/repricing-engine/api/runtime";

export type PricingServices = Readonly<{
  priceSignals: ReturnType<typeof createPriceSignalRuntime>;
  recommendations: ReturnType<typeof createPricingRecommendationRuntime>;
  marketRollups: ReturnType<typeof createMarketRollupsRuntime>;
  marketEstimates: ReturnType<typeof createMarketEstimatesRuntime>;
  repricingPolicies: ReturnType<typeof createRepricingPolicyRuntime>;
  repricingEngine: ReturnType<typeof createRepricingEngineRuntime>;
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
  bulkRepriceIngestion: ReturnType<typeof createBulkRepriceIngestionRuntime>;
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
  const marketRollupsBase = createMarketRollupsRuntime({ db, policies });
  const marketEstimates = createMarketEstimatesRuntime({ eventStore, db, policies });
  const repricingEngine = createRepricingEngineRuntime({ eventStore, db: pool });
  /**
   * The Market-Value Estimate recompute RIDES the market-rollups closer job
   * (the m112 blended-estimate slice): platform-worker already schedules
   * `marketRollups.runDailyRollupCloser` every few minutes, and every
   * estimate trigger -- new trades, fresh observations, the daily refresh --
   * is served by running the estimate pass right after the rollup pass on
   * that same cadence. The estimate closer is idempotent (the aggregate
   * decider no-ops unchanged same-day recomputes), so the ride-along costs
   * stream reads, not events. Composed here rather than inside the
   * market-rollups slice so neither slice imports the other.
   */
  const marketRollups: typeof marketRollupsBase = {
    ...marketRollupsBase,
    runDailyRollupCloser: async (params) => {
      const result = await marketRollupsBase.runDailyRollupCloser(params);
      await marketEstimates.runMarketPriceEstimateCloser({ now: params?.now, limit: params?.limit });
      await repricingEngine.enqueueDailyDriftSweep({ now: params?.now, limit: params?.limit });
      return result;
    },
  };
  const repricingPolicies = createRepricingPolicyRuntime({ eventStore, db });
  const publicMarketPages = createPublicMarketPagesRuntime({ db, policies });
  const bulkRepriceIngestion = createBulkRepriceIngestionRuntime({ db });

  return {
    priceSignals,
    recommendations,
    marketRollups,
    marketEstimates,
    repricingPolicies,
    repricingEngine,
    publicMarketPages,
    policies,
    bulkRepriceIngestion,
    projectors: [
      ...priceSignals.projectors,
      ...recommendations.projectors,
      ...marketEstimates.projectors,
      ...repricingPolicies.projectors,
      ...repricingEngine.projectors,
      ...policies.projectors,
    ],
    pool,
    db,
  };
}
