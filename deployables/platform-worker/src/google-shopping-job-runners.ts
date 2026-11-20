import type { GoogleShoppingSyncMode, DiscoveryServices } from "@chase-sets/discovery/server";
import {
  createGoogleMerchantApiClient,
  createGoogleMerchantServiceAccountAccessTokenProvider,
  type GoogleMerchantConfig,
} from "@chase-sets/google-merchant";
import { createDurableJobLaneRunners } from "@chase-sets/platform-runtime/worker";
import type { WorkerRunner } from "@chase-sets/bounded-context-module";
import type { PlatformWorkerConfig } from "./config";
export function createGoogleShoppingJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<
    PlatformWorkerConfig,
    "workerId" | "leaseTtlMs" | "googleMerchant" | "googleShoppingDiagnosticsPreviousIssueChunkSize"
  >,
  logger: Parameters<typeof createGoogleMerchantApiClient>[0]["logger"],
): readonly WorkerRunner[] {
  const discovery = services.discovery as DiscoveryServices | undefined;
  const processNextFullSyncJob = discovery?.googleShoppingSync?.processNextFullSyncJob;
  const processNextIncrementalSyncJob = discovery?.googleShoppingSync?.processNextIncrementalSyncJob;
  const processNextDiagnosticsRefreshJob = discovery?.googleShoppingSync?.processNextDiagnosticsRefreshJob;

  if (!processNextFullSyncJob && !processNextIncrementalSyncJob && !processNextDiagnosticsRefreshJob) {
    return [];
  }

  return [
    ...(processNextFullSyncJob
      ? createDurableJobLaneRunners({
          workflowName: "discovery.google-shopping-full-sync-jobs",
          laneCount: 1,
          runLane: async (lane) => ({
            processed: await processNextFullSyncJob({
              claimOwnerId: `${input.workerId}:${lane.laneName}`,
              claimTtlMs: input.leaseTtlMs * 4,
              merchantClientForMode: (mode) => createGoogleShoppingMerchantClient(input.googleMerchant, mode, logger),
              signal: lane.runnerContext?.signal,
              throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
            }),
            lastGlobalPosition: "0" as never,
          }),
        })
      : []),
    ...(processNextIncrementalSyncJob
      ? createDurableJobLaneRunners({
          workflowName: "discovery.google-shopping-incremental-sync-jobs",
          laneCount: 1,
          runLane: async (lane) => ({
            processed: await processNextIncrementalSyncJob({
              claimOwnerId: `${input.workerId}:${lane.laneName}`,
              claimTtlMs: input.leaseTtlMs * 4,
              mode: input.googleMerchant.syncEnabled && !input.googleMerchant.dryRun ? "live" : "dry-run",
              merchantClientForMode: (mode) => createGoogleShoppingMerchantClient(input.googleMerchant, mode, logger),
              signal: lane.runnerContext?.signal,
              throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
            }),
            lastGlobalPosition: "0" as never,
          }),
        })
      : []),
    ...(processNextDiagnosticsRefreshJob
      ? createDurableJobLaneRunners({
          workflowName: "discovery.google-shopping-diagnostics-jobs",
          laneCount: 1,
          runLane: async (lane) => ({
            processed: await processNextDiagnosticsRefreshJob({
              claimOwnerId: `${input.workerId}:${lane.laneName}`,
              claimTtlMs: input.leaseTtlMs * 4,
              previousIssueChunkSize: input.googleShoppingDiagnosticsPreviousIssueChunkSize,
              merchantClientForMode: (mode) => createGoogleShoppingMerchantClient(input.googleMerchant, mode, logger),
              signal: lane.runnerContext?.signal,
              throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
            }),
            lastGlobalPosition: "0" as never,
          }),
        })
      : []),
  ];
}
function createGoogleShoppingMerchantClient(
  config: GoogleMerchantConfig,
  mode: GoogleShoppingSyncMode,
  logger: Parameters<typeof createGoogleMerchantApiClient>[0]["logger"],
) {
  if (mode === "live" && config.syncEnabled && config.dryRun) {
    throw new Error("Google Shopping live sync requested while GOOGLE_MERCHANT_DRY_RUN=true.");
  }

  const clientConfig = config.syncEnabled && mode === "dry-run" ? { ...config, dryRun: true } : config;
  const accessTokenProvider =
    clientConfig.syncEnabled && !clientConfig.dryRun
      ? createGoogleMerchantServiceAccountAccessTokenProvider({
          credentialSecretName: clientConfig.credentialSecretName,
          secretResolver: (secretName) => process.env[secretName],
        })
      : async () => {
          throw new Error("Google Merchant credentials are not required in dry-run mode.");
        };

  return createGoogleMerchantApiClient({
    config: clientConfig,
    accessTokenProvider,
    logger,
  });
}
