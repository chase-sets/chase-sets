import { channelProviderRegistry } from "@chase-sets/channels";
import { isChannelsServices } from "@chase-sets/channels/server";
import {
  createMarketplaceChannelInboundClampCapability,
  type MarketplaceChannelInboundClampCapability,
  type MarketplaceChannelInboundClampPort,
} from "@chase-sets/marketplace/server";
import { createDurableJobLaneRunners, type WorkerRunner } from "@chase-sets/platform-runtime/worker";

export function createPlatformWorkerMarketplaceChannelInboundClampBinding(
  mounted: boolean,
  getServices: () => Readonly<{ channelInboundClamp: MarketplaceChannelInboundClampPort }> | undefined,
): MarketplaceChannelInboundClampCapability {
  return createMarketplaceChannelInboundClampCapability(mounted, getServices);
}

export function createChannelsOutboundRunners(
  services: Readonly<Record<string, unknown>>,
  input: Readonly<{
    workerId: string;
    channelsOutboundOperationLaneCount: number;
  }>,
): readonly WorkerRunner[] {
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
