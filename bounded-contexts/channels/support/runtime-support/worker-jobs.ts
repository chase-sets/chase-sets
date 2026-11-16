import type { WorkerRunner } from "@chase-sets/bounded-context-module";
import { createDurableJobLaneRunners } from "@chase-sets/platform-runtime/worker-jobs";
import { createScheduledJobRunner, type WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";
import type { ChannelsServices } from "./services";
import { isChannelsServices } from "./services";
import { createEbayReceiptExpiryRunner } from "../../features/ebay-account-deletion/api/expiry-runner";
import { createEbayAccountDeletionConsumerRunner } from "../../features/ebay-account-deletion/api/consumer-runner";
import { channelProviderRegistry } from "../../features/publication-port/api/registry";
import type { ChannelProviderRegistry } from "../../features/publication-port/domain/contracts";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { ebayCredentialMaintenancePolicy } from "../../features/ebay-connection/domain/credential-maintenance";

export function createChannelsEbayCredentialRefreshRunners({
  services,
  controlPlane,
}: Pick<WorkerJobInput<Readonly<{}>>, "services" | "controlPlane">): readonly WorkerRunner[] {
  const channels = services.channels;
  if (!isChannelsServices(channels) || !channels.ebayConnection?.enabled) return [];
  const maintenance = channels.ebayConnection.credentialRefresh;
  return [
    createScheduledJobRunner(
      "channels.ebay-credential-refresh",
      ebayCredentialMaintenancePolicy.defaultValue.sweepSeconds * 1000,
      controlPlane,
      () => maintenance.sweep(),
    ),
  ];
}

type CreateChannelsEbayAccountDeletionReceiptExpiryRunnersConfig = Readonly<{}>;
export function createChannelsEbayAccountDeletionConsumerRunners({
  services,
  controlPlane,
  logger,
}: Pick<WorkerJobInput<Readonly<{}>>, "services" | "controlPlane" | "logger">): readonly WorkerRunner[] {
  const channels = services.channels;
  return isChannelsServices(channels)
    ? [createEbayAccountDeletionConsumerRunner(channels.ebayAccountDeletionConsumer, logger, controlPlane)]
    : [];
}

export function createChannelsEbayAccountDeletionReceiptExpiryRunners({
  services,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateChannelsEbayAccountDeletionReceiptExpiryRunnersConfig>,
  "services" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const channels = services.channels;
  const runners: WorkerRunner[] = [];
  if (isChannelsServices(channels)) {
    runners.push(createEbayReceiptExpiryRunner(channels.ebayReceiptExpiry, logger, undefined, controlPlane));
  }
  return runners;
}

type CreateChannelsConnectorLivenessSweepRunnersConfig = Readonly<{
  channelsConnectorLivenessSweepIntervalMs: number | null;
}>;
export function createChannelsConnectorLivenessSweepRunners({
  services,
  config: input,
  controlPlane,
}: Pick<
  WorkerJobInput<CreateChannelsConnectorLivenessSweepRunnersConfig>,
  "services" | "config" | "controlPlane"
>): readonly WorkerRunner[] {
  const channels = services.channels;
  const runners: WorkerRunner[] = [];
  if (input.channelsConnectorLivenessSweepIntervalMs && isChannelsServices(channels)) {
    runners.push(
      createScheduledJobRunner(
        "channels.connector-liveness-sweep",
        input.channelsConnectorLivenessSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await channels.connectionHealth.sweepConnectorLiveness({
            now: new Date().toISOString(),
            limit: 100,
          });
          return result.accepted;
        },
      ),
    );
  }
  return runners;
}

type CreateChannelsOutboundRunnersConfig = Readonly<{ channelsOutboundOperationLaneCount: number; workerId: string }>;
export function createChannelsOutboundRunners({
  services,
  config: input,
}: Pick<WorkerJobInput<CreateChannelsOutboundRunnersConfig>, "services" | "config">): readonly WorkerRunner[] {
  const candidate = services.channels;
  if (!isChannelsServices(candidate)) return [];

  return createDurableJobLaneRunners({
    workflowName: "channels.outbound-operations",
    laneCount: input.channelsOutboundOperationLaneCount,
    runLane: async (lane) => {
      const recovered = await candidate.outboundSync.recoverExpiredClaimedOperations();
      const scheduling = await candidate.outboundSync.scheduleDueOrderPulls({ registry: channelProviderRegistry }).then(
        (scheduled) => ({ kind: "scheduled" as const, scheduled }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      const liveExports = await candidate.outboundSync
        .scheduleDueLiveExports({ registry: channelProviderRegistry })
        .then(
          (scheduled) => ({ kind: "scheduled" as const, scheduled }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
      const processed = await candidate.outboundSync.processNextInlineOperation({
        registry: channelProviderRegistry,
        claimOwnerId: `${input.workerId}:${lane.laneName}`,
      });
      // A scheduler failure never stalls this pass's listing work, then fails the pass so the worker's
      // existing failure observer, runner status and backoff report it.
      if (scheduling.kind === "failed") throw scheduling.error;
      if (liveExports.kind === "failed") throw liveExports.error;
      return {
        processed: recovered + scheduling.scheduled + liveExports.scheduled + processed,
        lastGlobalPosition: "0" as never,
      };
    },
  });
}

export function createChannelsReconciliationRunners(
  input: Readonly<{
    services: ChannelsServices;
    controlPlane: PlatformControlPlane;
    registry?: ChannelProviderRegistry;
  }>,
): readonly WorkerRunner[] {
  return [
    createScheduledJobRunner("channels-drift-reconciliation", 60_000, input.controlPlane, async () => {
      await input.services.reconciliation.deliverHealthObservations(
        input.services.connectionHealth,
        accountScopedWorkerContext,
      );
      const results = await input.services.reconciliation.reconcileDueConnections(
        {
          registry: input.registry ?? channelProviderRegistry,
          sourceAttempt: 1,
          readConnectionHealth: input.services.connectionHealth.readConnectionHealth,
          limit: 100,
        },
        accountScopedWorkerContext,
      );
      await input.services.reconciliation.deliverHealthObservations(
        input.services.connectionHealth,
        accountScopedWorkerContext,
      );
      return results.length;
    }),
    createScheduledJobRunner("channels-tcgplayer-orders", 60_000, input.controlPlane, async () =>
      input.services.tcgplayerOrders.interpretDueConnections(),
    ),
    createScheduledJobRunner("channels-live-export-snapshots", 60_000, input.controlPlane, async () =>
      input.services.liveExportSnapshots.consumeDueConnections(),
    ),
    createScheduledJobRunner("channels-order-fulfillment-observations", 60_000, input.controlPlane, async () =>
      input.services.fulfillmentObservations.interpretDueConnections(),
    ),
  ];
}
export function accountScopedWorkerContext(accountId: string): EventStoreContext {
  return {
    tenantId: "tnt_channels_worker" as never,
    audit: {
      performedByUserId: "usr_channels_worker" as never,
      forAccountId: accountId as never,
    },
  };
}
type CreateChannelsScheduledReconciliationRunnersConfig = Readonly<{}>;
export function createChannelsScheduledReconciliationRunners({
  services,
  controlPlane,
}: Pick<
  WorkerJobInput<CreateChannelsScheduledReconciliationRunnersConfig>,
  "services" | "controlPlane"
>): readonly WorkerRunner[] {
  const channels = services.channels;
  return isChannelsServices(channels) ? createChannelsReconciliationRunners({ services: channels, controlPlane }) : [];
}
