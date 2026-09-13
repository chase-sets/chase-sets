import { readFileSync } from "node:fs";
import type { ChannelsServices } from "@chase-sets/channels/server";
import { describe, expect, it, vi } from "vitest";
import { createChannelsOutboundRunners } from "../src/channels-outbound-runners";

describe("Channels outbound worker wiring", () => {
  it("registers the isolated Channels runner in the existing jobs group", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).toContain('import { createChannelsOutboundRunners } from "./channels-outbound-runners";');
    expect(source).toContain("...createChannelsOutboundRunners(runtime.services, config)");
  });

  it("uses the canonical expanded Channels service and injected provider registry", () => {
    const source = readFileSync(new URL("../src/channels-outbound-runners.ts", import.meta.url), "utf8");
    expect(source).toContain('import { isChannelsServices } from "@chase-sets/channels/server"');
    expect(source).toContain("registry: channelProviderRegistry");
    expect(source).toContain('workflowName: "channels.outbound-operations"');
    expect(source).toContain("channelsOutboundOperationLaneCount");
    expect(source).not.toMatch(/services\.channels\s+as\s+\{/);
    expect(source).not.toMatch(/services\.channels\s+as\s+ChannelsServices/);
  });

  it("registers nothing when Channels service validation fails", () => {
    const config = { workerId: "worker-1", channelsOutboundOperationLaneCount: 2 };
    const outboundOnly = {
      channels: {
        outboundSync: {
          recoverExpiredClaimedOperations: async () => 0,
          processNextInlineOperation: async () => 0,
        },
      },
    };
    const connectionsOnly = { channels: { connections: { getConnection: async () => null } } };
    const missingUsedMethod = {
      channels: {
        ...validChannelsCandidate(),
        outboundSync: { recoverExpiredClaimedOperations: async () => 0 },
      },
    };

    expect(createChannelsOutboundRunners(outboundOnly, config)).toEqual([]);
    expect(createChannelsOutboundRunners(connectionsOnly, config)).toEqual([]);
    expect(createChannelsOutboundRunners(missingUsedMethod, config)).toEqual([]);
  });

  it("retains the exact configured runner set for a valid aggregate", async () => {
    const recoverExpiredClaimedOperations = vi.fn(async () => 2);
    const processNextInlineOperation = vi.fn(
      async (_input: Readonly<{ registry: unknown; claimOwnerId: string }>) => 3,
    );
    const candidate = validChannelsCandidate({ recoverExpiredClaimedOperations, processNextInlineOperation });
    const runners = createChannelsOutboundRunners(
      { channels: candidate },
      { workerId: "worker-1", channelsOutboundOperationLaneCount: 2 },
    );

    expect(runners.map((runner) => runner.name)).toEqual([
      "job:channels.outbound-operations.lane-1",
      "job:channels.outbound-operations.lane-2",
    ]);
    await expect(Promise.all(runners.map((runner) => runner.runOnce()))).resolves.toEqual([
      { processed: 5, lastGlobalPosition: "0" },
      { processed: 5, lastGlobalPosition: "0" },
    ]);
    expect(recoverExpiredClaimedOperations).toHaveBeenCalledTimes(2);
    expect(processNextInlineOperation.mock.calls.map(([input]) => input.claimOwnerId)).toEqual([
      "worker-1:job:channels.outbound-operations.lane-1",
      "worker-1:job:channels.outbound-operations.lane-2",
    ]);
  });
});

function validChannelsCandidate(
  outboundSync: Readonly<{
    recoverExpiredClaimedOperations: () => Promise<number>;
    processNextInlineOperation: (input: Readonly<{ registry: unknown; claimOwnerId: string }>) => Promise<number>;
  }> = {
    recoverExpiredClaimedOperations: async () => 0,
    processNextInlineOperation: async () => 0,
  },
) {
  return {
    connections: { getConnection: async () => null },
    connectionHealth: {
      submitObservation: vi.fn(),
      readConnectionHealth: vi.fn(),
      listOpenReasonGenerations: vi.fn(),
    },
    listingComposition: {},
    outboundSync,
    tcgplayerCsv: {},
    projectors: [],
    db: {},
  } satisfies Record<keyof ChannelsServices, unknown>;
}
