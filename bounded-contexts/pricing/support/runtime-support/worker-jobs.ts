import type { WorkerRunner } from "@chase-sets/bounded-context-module";
import { createDurableJobLaneRunners } from "@chase-sets/platform-runtime/worker-jobs";
import {
  createScheduledJobRunner,
  type WorkerJobInput,
  type WorkerJobLogger,
} from "@chase-sets/platform-runtime/worker-jobs";
import type { InventoryServices } from "@chase-sets/inventory/server";
import type { PricingServices } from "./services";
import type { MarketplaceServices } from "@chase-sets/marketplace/server";
import type { RepricingEngineServices } from "../../features/repricing-engine/api/runtime";

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

type CreatePricingMarketRollupsCloserRunnersConfig = Readonly<{ marketRollupsCloserIntervalMs: number | null }>;
export function createPricingMarketRollupsCloserRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreatePricingMarketRollupsCloserRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const pricing = isPricingServices(services.pricing) ? services.pricing : undefined;
  const runDailyRollupCloser = pricing?.marketRollups?.runDailyRollupCloser;
  const runners: WorkerRunner[] = [];
  if (runDailyRollupCloser && input.marketRollupsCloserIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "pricing.market-rollups-closer",
        input.marketRollupsCloserIntervalMs,
        controlPlane,
        async () => {
          const result = await runDailyRollupCloser({ limit: 500 });
          logger.info("Pricing market-rollups closer completed.", {
            type: "pricing.market-rollups-closer",
            result,
          });
          return (
            result.rollupDaysRecomputed + result.marketStateSnapshotsRecomputed + result.productAggregatesRecomputed
          );
        },
      ),
    );
  }
  return runners;
}

type CreatePricingJobRunnersConfig = Readonly<{
  pricingRepricingDryRunJobLaneCount: number;
  workerId: string;
  leaseTtlMs: number;
  pricingRecommendationJobLaneCount: number;
  pricingRecommendationJobWorkflowMaxActiveClaims: number;
  pricingRecommendationJobMaxActiveClaimsPerJob: number;
  pricingRepricingEvaluationJobLaneCount: number;
}>;
export function createPricingJobRunners({
  services,
  config: input,
  logger,
}: Pick<WorkerJobInput<CreatePricingJobRunnersConfig>, "services" | "config" | "logger">): readonly WorkerRunner[] {
  const pricing = services.pricing as PricingServices | undefined;
  const marketplace = services.marketplace as MarketplaceServices | undefined;
  const processNextRecommendationJob = pricing?.recommendations?.processNextRecommendationJob;
  const processNextEvaluationJob = pricing?.repricingEngine?.processNextEvaluationJob;
  const processNextDryRunJob = pricing?.repricingEngine?.processNextDryRunJob;

  if (!processNextRecommendationJob && !processNextEvaluationJob && !processNextDryRunJob) {
    return [];
  }

  return [
    ...(processNextDryRunJob
      ? createDurableJobLaneRunners({
          workflowName: "pricing.repricing-dry-run-jobs",
          laneCount: input.pricingRepricingDryRunJobLaneCount,
          runLane: async (lane) => ({
            processed: await processNextDryRunJob({
              claimOwnerId: `${input.workerId}:${lane.laneName}`,
              claimTtlMs: input.leaseTtlMs * 4,
              signal: lane.runnerContext?.signal,
              throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
            }),
            lastGlobalPosition: "0" as never,
          }),
        })
      : []),
    ...(processNextRecommendationJob && marketplace?.listings
      ? createDurableJobLaneRunners({
          workflowName: "pricing.recommendation-jobs",
          laneCount: input.pricingRecommendationJobLaneCount,
          runLane: async (lane) => ({
            processed: await processNextRecommendationJob({
              claimOwnerId: `${input.workerId}:${lane.laneName}`,
              claimTtlMs: input.leaseTtlMs * 4,
              workflowMaxActiveClaims: input.pricingRecommendationJobWorkflowMaxActiveClaims,
              jobMaxActiveClaims: input.pricingRecommendationJobMaxActiveClaimsPerJob,
              laneName: lane.laneName,
              marketplaceListingGatewayForAccount: (accountId) => ({
                applyBulkListingPriceUpdates: async (body) => ({
                  items: await marketplace.listings!.applyBulkListingPriceUpdates!(
                    { accountId: accountId as never, ...body },
                    sellerSystemContext(accountId),
                  ),
                }),
                createListing: async (body) => {
                  const result = await marketplace.listings!.createListing!(
                    {
                      accountId: accountId as never,
                      ...body,
                      listingIdOverride: body.listingIdOverride as never,
                    },
                    sellerSystemContext(accountId),
                  );
                  return {
                    id: result.listingId,
                    listing_id: result.listingId,
                  };
                },
              }),
              signal: lane.runnerContext?.signal,
              throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
            }),
            lastGlobalPosition: "0" as never,
          }),
        })
      : []),
    ...(processNextEvaluationJob && marketplace?.listings
      ? createDurableJobLaneRunners({
          workflowName: "pricing.repricing-evaluation-jobs",
          laneCount: input.pricingRepricingEvaluationJobLaneCount,
          runLane: async (lane) => ({
            processed: await processRepricingEvaluationJob(
              processNextEvaluationJob,
              {
                claimOwnerId: `${input.workerId}:${lane.laneName}`,
                claimTtlMs: input.leaseTtlMs * 4,
                marketplaceGatewayForAccount: (accountId) => ({
                  applyBulkListingPriceUpdates: async (body) => ({
                    items: await marketplace.listings!.applyBulkListingPriceUpdates!(
                      { accountId, ...body },
                      sellerSystemContext(accountId),
                    ),
                  }),
                  pauseListing: (listingId, body) =>
                    marketplace.listings!.pauseListing!(
                      { accountId, listingId, reason: body.reason },
                      sellerSystemContext(accountId),
                    ),
                  publishListing: (listingId, body) =>
                    marketplace.listings!.publishListing!(
                      { accountId, listingId, idempotencyKey: body.idempotencyKey },
                      sellerSystemContext(accountId),
                    ),
                }),
                signal: lane.runnerContext?.signal,
                throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
              },
              logger,
            ),
            lastGlobalPosition: "0" as never,
          }),
        })
      : []),
  ];
}

type CreateBulkRepriceIngestionJobRunnersConfig = Readonly<{
  pricingBulkRepriceJobLaneCount: number;
  workerId: string;
  leaseTtlMs: number;
  pricingBulkRepriceJobWorkflowMaxActiveClaims: number;
  pricingBulkRepriceJobMaxActiveClaimsPerJob: number;
}>;
export function createBulkRepriceIngestionJobRunners({
  services,
  config: input,
}: Pick<WorkerJobInput<CreateBulkRepriceIngestionJobRunnersConfig>, "services" | "config">): readonly WorkerRunner[] {
  const pricing = services.pricing as PricingServices | undefined;
  const marketplace = services.marketplace as MarketplaceServices | undefined;
  const inventory = services.inventory as InventoryServices | undefined;
  const processNextBulkRepriceJob = pricing?.bulkRepriceIngestion?.processNextBulkRepriceJob;

  if (!processNextBulkRepriceJob || !marketplace?.listings || !inventory?.importBatches) {
    return [];
  }

  return createDurableJobLaneRunners({
    workflowName: "pricing.bulk-reprice-jobs",
    laneCount: input.pricingBulkRepriceJobLaneCount,
    runLane: async (lane) => ({
      processed: await processNextBulkRepriceJob({
        claimOwnerId: `${input.workerId}:${lane.laneName}`,
        claimTtlMs: input.leaseTtlMs * 4,
        workflowMaxActiveClaims: input.pricingBulkRepriceJobWorkflowMaxActiveClaims,
        jobMaxActiveClaims: input.pricingBulkRepriceJobMaxActiveClaimsPerJob,
        laneName: lane.laneName,
        marketplaceListingGatewayForAccount: (accountId) => ({
          applyBulkListingPriceUpdates: async (body) => ({
            items: await marketplace.listings!.applyBulkListingPriceUpdates!(
              { accountId, ...body },
              sellerSystemContext(accountId),
            ),
          }),
        }),
        inventorySkuGatewayForAccount: (accountId) => ({
          resolveSellerSkusToInventoryItems: (sellerSkus) =>
            inventory.importBatches!.resolveAccountSkuMappingsToInventoryItems!({
              accountId: accountId as `acc_${string}`,
              sellerSkus,
            }),
        }),
        signal: lane.runnerContext?.signal,
        throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
      }),
      lastGlobalPosition: "0" as never,
    }),
  });
}

export function processRepricingEvaluationJob(
  processNext: RepricingEngineServices["processNextEvaluationJob"],
  input: Parameters<RepricingEngineServices["processNextEvaluationJob"]>[0],
  logger: Pick<WorkerJobLogger, "info">,
): Promise<number> {
  return processNext({
    ...input,
    onSpiralBreakerTrip: (trip) => logger.info("pricing.repricing-spiral-breaker.tripped", { ...trip }),
  });
}

function sellerSystemContext(accountId: string) {
  return { ...SYSTEM_CONTEXT, audit: { ...SYSTEM_CONTEXT.audit, forAccountId: accountId as never } };
}
function isPricingServices(value: unknown): value is PricingServices {
  return typeof value === "object" && value !== null && "priceSignals" in value && "marketRollups" in value;
}
