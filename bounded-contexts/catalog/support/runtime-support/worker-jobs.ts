import type { WorkerRunner } from "@chase-sets/bounded-context-module";
import { createDurableJobLaneRunners } from "@chase-sets/platform-runtime/worker";
import { createScheduledJobRunner, type WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";
import type { CatalogServices } from "../authoring-support/services";

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

type CreateCatalogProviderScopeRefreshRunnersConfig = Readonly<{
  catalogProviderScopeRefreshIntervalMs: number | null;
}>;
export function createCatalogProviderScopeRefreshRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateCatalogProviderScopeRefreshRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const catalogProviderScopeDiscovery = (services.catalog as CatalogServices | undefined)?.providerScopeDiscovery;
  const runners: WorkerRunner[] = [];
  if (catalogProviderScopeDiscovery && input.catalogProviderScopeRefreshIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "catalog.provider-scope-refresh",
        input.catalogProviderScopeRefreshIntervalMs,
        controlPlane,
        async () => {
          const result = await catalogProviderScopeDiscovery.processScheduledRefresh({
            context: SYSTEM_CONTEXT,
            triggeredBy: "schedule",
          });
          logger.info("Catalog provider scope refresh sweep completed.", {
            type: "catalog.provider-scope-refresh",
            result,
          });
          // m72 lesson: scheduled failures must never pass silently. Every
          // provider outcome is recorded on the schedule row first (the
          // scheduled-alerting watch reads those rows), then a failed provider
          // fails the runner so the worker logs an error for this sweep too.
          if (result.failures > 0) {
            const failed = result.providers
              .filter((provider) => provider.status === "failed")
              .map((provider) => `${provider.providerKey}: ${provider.errorMessage ?? "unknown error"}`)
              .join("; ");
            throw new Error(`Catalog provider scope refresh failed for ${result.failures} provider(s): ${failed}`);
          }
          return result.observationsRecorded + result.mappingsProposed;
        },
      ),
    );
  }
  return runners;
}

type CreateCatalogBulkJobRunnersConfig = Readonly<{
  sourceObservationBulkJobLaneCount: number;
  workerId: string;
  leaseTtlMs: number;
  sourceObservationBulkJobWorkflowMaxActiveClaims: number;
  sourceObservationBulkJobMaxActiveClaimsPerJob: number;
  sourceObservationIntegrationJobLaneCount: number;
  sourceObservationIntegrationJobWorkflowMaxActiveClaims: number;
  sourceObservationIntegrationJobMaxActiveClaimsPerJob: number;
  catalogAuthoringBulkJobLaneCount: number;
  catalogAuthoringBulkJobWorkflowMaxActiveClaims: number;
  catalogAuthoringBulkJobMaxActiveClaimsPerJob: number;
}>;
export function createCatalogBulkJobRunners({
  services,
  config: input,
}: Pick<WorkerJobInput<CreateCatalogBulkJobRunnersConfig>, "services" | "config">): readonly WorkerRunner[] {
  const catalog = services.catalog as CatalogServices | undefined;
  const processNextBulkReviewJob = catalog?.sourceObservations?.processNextBulkReviewJob;
  const processNextIntegrationJob = catalog?.sourceObservations?.processNextIntegrationJob;
  const processNextAuthoringBulkJob = catalog?.authoringBulkJobs?.processNext;

  if (!processNextBulkReviewJob && !processNextIntegrationJob && !processNextAuthoringBulkJob) {
    return [];
  }

  const runners: WorkerRunner[] = [];

  if (processNextBulkReviewJob) {
    runners.push(
      ...createDurableJobLaneRunners({
        workflowName: "catalog.source-observation-bulk-jobs",
        laneCount: input.sourceObservationBulkJobLaneCount,
        runLane: async (lane) => ({
          processed: await processNextBulkReviewJob({
            claimOwnerId: `${input.workerId}:${lane.laneName}`,
            claimTtlMs: input.leaseTtlMs * 4,
            workflowMaxActiveClaims: input.sourceObservationBulkJobWorkflowMaxActiveClaims,
            jobMaxActiveClaims: input.sourceObservationBulkJobMaxActiveClaimsPerJob,
            laneName: lane.laneName,
            signal: lane.runnerContext?.signal,
            throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
          }),
          lastGlobalPosition: "0" as never,
        }),
      }),
    );
  }

  if (processNextIntegrationJob) {
    runners.push(
      ...createDurableJobLaneRunners({
        workflowName: "catalog.source-observation-integration-jobs",
        laneCount: input.sourceObservationIntegrationJobLaneCount,
        runLane: async (lane) => ({
          processed: await processNextIntegrationJob({
            claimOwnerId: `${input.workerId}:${lane.laneName}`,
            claimTtlMs: input.leaseTtlMs * 4,
            workflowMaxActiveClaims: input.sourceObservationIntegrationJobWorkflowMaxActiveClaims,
            jobMaxActiveClaims: input.sourceObservationIntegrationJobMaxActiveClaimsPerJob,
            laneName: lane.laneName,
            signal: lane.runnerContext?.signal,
            throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
          }),
          lastGlobalPosition: "0" as never,
        }),
      }),
    );
  }

  if (processNextAuthoringBulkJob && catalog) {
    runners.push(
      ...createDurableJobLaneRunners({
        workflowName: "catalog.authoring-bulk-jobs",
        laneCount: input.catalogAuthoringBulkJobLaneCount,
        runLane: async (lane) => ({
          processed: (await processNextAuthoringBulkJob({
            claimOwnerId: `${input.workerId}:${lane.laneName}`,
            claimTtlMs: input.leaseTtlMs * 4,
            services: catalog,
            workflowMaxActiveClaims: input.catalogAuthoringBulkJobWorkflowMaxActiveClaims,
            jobMaxActiveClaims: input.catalogAuthoringBulkJobMaxActiveClaimsPerJob,
            laneName: lane.laneName,
            signal: lane.runnerContext?.signal,
            throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
          }))
            ? 1
            : 0,
          lastGlobalPosition: "0" as never,
        }),
      }),
    );
  }

  return runners;
}
