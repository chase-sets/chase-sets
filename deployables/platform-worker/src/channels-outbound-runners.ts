import { channelProviderRegistry } from "@chase-sets/channels";
import type { ChannelsServices } from "@chase-sets/channels/server";
import { createDurableJobLaneRunners, type WorkerRunner } from "@chase-sets/platform-runtime/worker";

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
      const processed = await candidate.outboundSync.processNextInlineOperation({
        registry: channelProviderRegistry,
        claimOwnerId: `${input.workerId}:${lane.laneName}`,
      });
      return { processed: recovered + processed, lastGlobalPosition: "0" as never };
    },
  });
}

function isChannelsServices(value: unknown): value is ChannelsServices {
  if (typeof value !== "object" || value === null) return false;
  const outboundSync = Reflect.get(value, "outboundSync");
  return (
    typeof outboundSync === "object" &&
    outboundSync !== null &&
    typeof Reflect.get(outboundSync, "recoverExpiredClaimedOperations") === "function" &&
    typeof Reflect.get(outboundSync, "processNextInlineOperation") === "function"
  );
}
