import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  createPricingListingAuthorityWriters,
  type PricingListingAuthorityWriters,
} from "../../features/repricing-engine/api/listing-authority-writers";
import type { PricingListingAuthorityPorts } from "../../features/repricing-engine/api/listing-authority";
import { createPricingWriterRecovery } from "../../features/repricing-engine/api/writer-recovery";
import { createPriceSignalRuntime } from "../../features/price-signals/api/runtime";
import { createPricingRecommendationRuntime } from "../../features/recommendations/api/runtime";
import { createMarketRollupsRuntime } from "../../features/market-rollups/api/runtime";
import { createPublicMarketPagesRuntime } from "../../features/public-market-pages/api/runtime";
import { createBulkRepriceIngestionRuntime } from "../../features/bulk-reprice-ingestion/api/runtime";
import { createRepricingEngineRuntime } from "../../features/repricing-engine/api/runtime";
import { createRepricingActivityDigestRunner } from "../../features/repricing-engine/api/activity-digest";
import type { CommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { ChannelConnectionIdentityReader } from "../../features/economics/domain/contracts";
import { createEconomicsServices, type EconomicsServices } from "../../features/economics/api/services";
import type { TcgplayerMarketTransportCapability } from "../../features/price-signals/integrations/tcgplayer/transport-port";
import type { TcgplayerMarketCaptureReceiptSinkCapability } from "../../features/price-signals/integrations/tcgplayer/capture-sanitizer";

export type PricingHostPorts = Readonly<{
  tcgplayerMarketTransport: TcgplayerMarketTransportCapability;
  tcgplayerMarketCaptureReceiptSink: TcgplayerMarketCaptureReceiptSinkCapability;
  commercialTermsResolver: CommercialTermsResolver;
  channelConnectionIdentityReader: ChannelConnectionIdentityReader;
  pricingListingAuthorityConsumer: PricingListingAuthorityPorts["consumer"];
}>;

export type PricingServices = Readonly<{
  priceSignals: ReturnType<typeof createPriceSignalRuntime>;
  recommendations: ReturnType<typeof createPricingRecommendationRuntime>;
  marketRollups: ReturnType<typeof createMarketRollupsRuntime>;
  marketEstimates: PricingListingAuthorityWriters["marketEstimates"];
  repricingPolicies: PricingListingAuthorityWriters["repricingPolicies"];
  listingAuthority: PricingListingAuthorityWriters["authority"];
  recoverListingAuthority: ReturnType<typeof createPricingWriterRecovery>;
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
  if (typeof ports.pricingListingAuthorityConsumer !== "function") {
    throw new Error("Pricing requires the Listing authority consumer resolver host port.");
  }
  const rawEventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "pricing" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const writers = createPricingListingAuthorityWriters(
    { eventStore: rawEventStore, pool },
    {
      consumer: ports.pricingListingAuthorityConsumer,
    },
  );
  const { policies, marketEstimates, repricingPolicies } = writers;
  const eventStore = writers.authority.eventStore;
  const recoverListingAuthority = createPricingWriterRecovery(db, writers);
  const economics = createEconomicsServices({
    eventStore,
    db,
    policies,
    commercialTermsResolver: ports.commercialTermsResolver,
    channelConnectionIdentityReader: ports.channelConnectionIdentityReader,
  });
  const priceSignals = createPriceSignalRuntime({
    db,
    pool,
    tcgplayerMarketTransport: ports.tcgplayerMarketTransport,
    tcgplayerMarketCaptureReceiptSink: ports.tcgplayerMarketCaptureReceiptSink,
  });
  const recommendations = createPricingRecommendationRuntime({
    eventStore,
    checkpointStore,
    db,
  });
  const marketRollupsBase = createMarketRollupsRuntime({ db, policies });
  const repricingEngine = createRepricingEngineRuntime({ eventStore, db: pool, productRounds: writers.productRounds });
  const runRepricingActivityDigest = createRepricingActivityDigestRunner({ pool, eventStore, policies });
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
      await recoverListingAuthority();
      const result = await marketRollupsBase.runDailyRollupCloser(params);
      await marketEstimates.runMarketPriceEstimateCloser({ now: params?.now, limit: params?.limit });
      await repricingEngine.enqueueDailyDriftSweep({ now: params?.now, limit: params?.limit });
      await runRepricingActivityDigest({ now: params?.now });
      return result;
    },
  };
  const publicMarketPages = createPublicMarketPagesRuntime({ db, policies });
  const bulkRepriceIngestion = createBulkRepriceIngestionRuntime({ db });

  return {
    priceSignals,
    recommendations,
    marketRollups,
    marketEstimates,
    repricingPolicies,
    listingAuthority: writers.authority,
    recoverListingAuthority,
    repricingEngine,
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
    ],
    pool,
    db,
  };
}
