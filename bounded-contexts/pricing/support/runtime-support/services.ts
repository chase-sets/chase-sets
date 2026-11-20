import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  ownerPredicateKey,
  withConfigurationEpochTransaction,
  withOwnerPredicateWrite,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { ConfigurationConsumer } from "@chase-sets/event-core/configuration-epoch";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createPriceSignalRuntime } from "../../features/price-signals/api/runtime";
import { createPricingRecommendationRuntime } from "../../features/recommendations/api/runtime";
import { createMarketRollupsRuntime } from "../../features/market-rollups/api/runtime";
import { createMarketEstimatesRuntime } from "../../features/market-estimates/api/runtime";
import { createDemandCurveCloser } from "../../features/market-estimates/api/demand-curve-closer";
import { createRepricingPolicyRuntime } from "../../features/repricing-policies/api/runtime";
import { createRepricingPolicyActivationServices } from "../../features/repricing-policies/api/activation";
import {
  createRepricingConfigurationWriter,
  createRepricingStandingEpochStore,
  lockRepricingStanding,
  type RepricingStanding,
} from "../../features/repricing-policies/api/configuration";
import { createPublicMarketPagesRuntime } from "../../features/public-market-pages/api/runtime";
import { createBulkRepriceIngestionRuntime } from "../../features/bulk-reprice-ingestion/api/runtime";
import { createRepricingEngineRuntime } from "../../features/repricing-engine/api/runtime";
import { repricingEnginePolicy } from "../../features/repricing-engine/domain/policy";
import { createRepricingActivityDigestRunner } from "../../features/repricing-engine/api/activity-digest";
import { createForecastLedgerRuntime } from "../../features/forecast-ledger/api/runtime";
import { pricingGoalDefinitions } from "../../features/repricing-policies/domain/domain";
import type { CommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { ChannelConnectionIdentityReader } from "../../features/economics/domain/contracts";
import { createEconomicsServices, type EconomicsServices } from "../../features/economics/api/services";
import {
  createPricingEvaluationAuthority,
  repricingPlatformSelector,
  type PricingEvaluationAuthority,
} from "../../features/repricing-engine/api/evaluation-authority";
import { evaluationOwnerIdentity } from "../../features/repricing-engine/api/evaluation-owner-inputs";

export type PricingHostPorts = Readonly<{
  pricingPredicateConsumerPool?: PgTransactionalPool | undefined;
  pricingEvaluationOwners?: Readonly<{
    marketplace: PgTransactionalPool;
    inventory: PgTransactionalPool;
    catalog: PgTransactionalPool;
  }>;
  pricingEvaluationConsumers?: readonly Readonly<{ identity: ConfigurationConsumer; pool: PgTransactionalPool }>[];
  commercialTermsResolver: CommercialTermsResolver;
  channelConnectionIdentityReader: ChannelConnectionIdentityReader;
}>;

export type PricingServices = Readonly<{
  priceSignals: ReturnType<typeof createPriceSignalRuntime>;
  recommendations: ReturnType<typeof createPricingRecommendationRuntime>;
  marketRollups: ReturnType<typeof createMarketRollupsRuntime>;
  marketEstimates: ReturnType<typeof createMarketEstimatesRuntime>;
  demandCurves: ReturnType<typeof createDemandCurveCloser>;
  repricingPolicies: Omit<ReturnType<typeof createRepricingPolicyRuntime>, "commandHandler"> &
    ReturnType<typeof createRepricingPolicyActivationServices>;
  repricingEngine: ReturnType<typeof createRepricingEngineRuntime>;
  evaluationAuthority?: PricingEvaluationAuthority;
  forecastLedger: ReturnType<typeof createForecastLedgerRuntime>;
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
  economics: EconomicsServices;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createPricingServices(pool: PgTransactionalPool, ports: PricingHostPorts): PricingServices {
  if (
    typeof ports?.commercialTermsResolver?.resolveListingTerms !== "function" ||
    typeof ports?.channelConnectionIdentityReader?.resolve !== "function"
  ) {
    throw new Error("Pricing requires Commercial Terms and Channel Connection Economics host ports.");
  }
  const affectsPlatformPolicy = (inputs: readonly AppendToStreamInput[]) =>
    inputs.some(({ events }) =>
      events.some(
        (event) =>
          (event.eventType === "platform-policy.document.created" ||
            event.eventType === "platform-policy.document.revised") &&
          event.payload.policyKey === repricingEnginePolicy.policyKey,
      ),
    );
  const store = createPostgresEventStore({
    pool,
    ownerPredicates: {
      ...(ports.pricingPredicateConsumerPool ? { consumerPool: ports.pricingPredicateConsumerPool } : {}),
      keys: (inputs) =>
        affectsPlatformPolicy(inputs)
          ? [ownerPredicateKey("repricing-platform-policy", repricingEnginePolicy.policyKey)]
          : [],
    },
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "pricing" }),
  });
  const standing: RepricingStanding = {
    async source() {
      const { incarnation } = await evaluationOwnerIdentity(pool, "pricing");
      return {
        incarnation,
        epochs: createRepricingStandingEpochStore({
          pool,
          sourceIncarnation: incarnation,
          consumers: ports.pricingEvaluationConsumers ?? [],
        }),
      };
    },
  };
  async function writePlatformPolicy<T>(
    write: (client: Parameters<typeof store.appendToStreamInTransaction>[0]) => Promise<T>,
  ) {
    const { incarnation, epochs } = await standing.source();
    const closing = await withConfigurationEpochTransaction(pool, async (db) => {
      await lockRepricingStanding(db, repricingPlatformSelector, incarnation);
      return epochs.beginClosureInTransaction(db, repricingPlatformSelector);
    });
    const closed = await epochs.driveClosure(repricingPlatformSelector);
    if (closed.epoch !== closing.epoch || closed.pendingConsumers.length)
      throw new Error("Platform pricing policy installation is waiting for its consumers.");
    return withOwnerPredicateWrite(pool, ports.pricingPredicateConsumerPool, async (db) => {
      if ((await lockRepricingStanding(db, repricingPlatformSelector, incarnation)) !== closing.epoch)
        throw new Error("Platform pricing policy installation was superseded.");
      const installed = await epochs.installClosureInTransaction(db, repricingPlatformSelector);
      const result = await write(db);
      await db.query("UPDATE pricing_repricing_standing SET epoch = $2 WHERE key = $1", [
        repricingPlatformSelector,
        installed.epoch,
      ]);
      return result;
    });
  }
  const eventStore = {
    ...store,
    appendToStream: (input: AppendToStreamInput) =>
      affectsPlatformPolicy([input])
        ? writePlatformPolicy((db) => store.appendToStreamInTransaction(db, input))
        : store.appendToStream(input),
    appendToStreams: (inputs: readonly AppendToStreamInput[]) =>
      affectsPlatformPolicy(inputs)
        ? writePlatformPolicy((db) => store.appendToStreamsInTransaction(db, inputs))
        : store.appendToStreams!(inputs),
  };
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const policies = createPolicyRuntime({ eventStore, db });
  const economics = createEconomicsServices({
    eventStore,
    db,
    policies,
    commercialTermsResolver: ports.commercialTermsResolver,
    channelConnectionIdentityReader: ports.channelConnectionIdentityReader,
  });
  const priceSignals = createPriceSignalRuntime({ db });
  const recommendations = createPricingRecommendationRuntime({
    eventStore,
    checkpointStore,
    db,
  });
  const marketRollupsBase = createMarketRollupsRuntime({ db, policies });
  const marketEstimates = createMarketEstimatesRuntime({ eventStore, db, policies });
  const demandCurves = createDemandCurveCloser({ pool, eventStore, policies });
  const pricingPredicateConsumerPool = ports.pricingPredicateConsumerPool;
  const repricingEngine = createRepricingEngineRuntime({
    eventStore,
    db: pool,
    economics,
    pricingPredicateConsumerPool,
  });
  const runRepricingActivityDigest = createRepricingActivityDigestRunner({ pool, eventStore, policies });
  const forecastLedger = createForecastLedgerRuntime({
    pool,
    eventStore,
    policies,
    goalDefinitions: pricingGoalDefinitions,
  });
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
      await demandCurves.runDemandCurveCloser({ now: params?.now, limit: params?.limit });
      await repricingEngine.enqueueDailyDriftSweep({ now: params?.now, limit: params?.limit });
      await runRepricingActivityDigest({ now: params?.now });
      await forecastLedger.runForecastGrading({ now: params?.now });
      return result;
    },
  };
  const configuration = createRepricingConfigurationWriter({
    pool,
    eventStore,
    pricingPredicateConsumerPool,
    standing,
  });
  const evaluationAuthority =
    ports.pricingEvaluationOwners &&
    pricingPredicateConsumerPool === ports.pricingEvaluationOwners.marketplace &&
    ports.pricingEvaluationConsumers &&
    createPricingEvaluationAuthority({
      pool,
      owners: ports.pricingEvaluationOwners,
      eventStore,
      economy: economics,
      configuration,
      standing,
      hasConsumerRoute: (expected) =>
        ports.pricingEvaluationConsumers?.some(
          ({ identity, pool: consumer }) =>
            identity.storeId === expected.storeId &&
            identity.incarnation === expected.incarnation &&
            consumer === ports.pricingEvaluationOwners?.marketplace,
        ) === true,
    });
  const { commandHandler: _standaloneCommandHandler, ...policyControls } = createRepricingPolicyRuntime({
    eventStore,
    db,
    configuration,
    goalAdoptions: () => forecastLedger.listGoalAdoptions(),
  });
  const repricingPolicies = {
    ...policyControls,
    ...createRepricingPolicyActivationServices({ eventStore, pool, configuration }),
  };
  const publicMarketPages = createPublicMarketPagesRuntime({ db, policies });
  const bulkRepriceIngestion = createBulkRepriceIngestionRuntime({ db });

  return {
    priceSignals,
    recommendations,
    marketRollups,
    marketEstimates,
    demandCurves,
    repricingPolicies,
    repricingEngine,
    ...(evaluationAuthority ? { evaluationAuthority } : {}),
    forecastLedger,
    publicMarketPages,
    policies,
    bulkRepriceIngestion,
    economics,
    projectors: [
      ...priceSignals.projectors,
      ...recommendations.projectors,
      ...marketEstimates.projectors,
      ...repricingPolicies.projectors,
      ...repricingEngine.projectors,
      ...economics.overrides.projectors,
      ...policies.projectors,
      ...forecastLedger.projectors,
    ],
    pool,
    db,
  };
}
