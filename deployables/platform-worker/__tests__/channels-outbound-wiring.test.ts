import { readFileSync } from "node:fs";
import { isChannelsServices, OutboundSyncError, type ChannelsServices } from "@chase-sets/channels/server";
import {
  readConnectorLivenessAuthority,
  readConnectorLivenessAuthorityInTransaction,
  listConnectorLivenessCandidates,
} from "@chase-sets/channels/server";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { createWorkerRunnerLoop } from "@chase-sets/platform-runtime/worker";
import { describe, expect, it, vi } from "vitest";
import {
  createChannelsOutboundRunners,
  createPlatformWorkerMarketplaceChannelInboundClampBinding,
} from "../src/channels-outbound-runners";

describe("Channels outbound worker wiring", () => {
  it("can call the published liveness readers through the real server entrypoint", async () => {
    const db: PgQueryable = { query: vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [] }) };
    const input = { connectionId: "connection_never_paired" };
    expect(await readConnectorLivenessAuthority(db, input)).toBeNull();
    expect(await readConnectorLivenessAuthorityInTransaction(db, input)).toBeNull();
    expect(await listConnectorLivenessCandidates(db, { dueAt: "2026-10-07T12:00:00Z", limit: 100 })).toEqual({
      candidates: [],
      nextCursor: null,
    });
  });
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
    const candidate = validChannelsCandidate();
    expect(isChannelsServices(candidate)).toBe(true);
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
        ...candidate,
        outboundSync: { recoverExpiredClaimedOperations: async () => 0 },
      },
    };
    const missingOrderPullProducer = {
      channels: {
        ...candidate,
        outboundSync: {
          recoverExpiredClaimedOperations: async () => 0,
          processNextInlineOperation: async () => 0,
        },
      },
    };

    expect(createChannelsOutboundRunners(outboundOnly, config)).toEqual([]);
    expect(createChannelsOutboundRunners(connectionsOnly, config)).toEqual([]);
    expect(createChannelsOutboundRunners(missingUsedMethod, config)).toEqual([]);
    expect(createChannelsOutboundRunners(missingOrderPullProducer, config)).toEqual([]);
  });

  it.each(["connectionHealth", "manualSync"] as const)(
    "requires the integrated %s service before running",
    (member) => {
      const candidate = validChannelsCandidate();
      const config = { workerId: "worker-1", channelsOutboundOperationLaneCount: 2 };
      expect(createChannelsOutboundRunners({ channels: candidate }, config)).toHaveLength(2);
      const missing = Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== member));
      expect(createChannelsOutboundRunners({ channels: missing }, config)).toEqual([]);
    },
  );

  it("retains the exact configured runner set for a valid aggregate", async () => {
    const recoverExpiredClaimedOperations = vi.fn(async () => 2);
    const processNextInlineOperation = vi.fn(
      async (_input: Readonly<{ registry: unknown; claimOwnerId: string }>) => 3,
    );
    const scheduleDueOrderPulls = vi.fn(async (_input: Readonly<{ registry: unknown }>) => 1);
    const candidate = validChannelsCandidate({
      recoverExpiredClaimedOperations,
      processNextInlineOperation,
      scheduleDueOrderPulls,
    });
    const runners = createChannelsOutboundRunners(
      { channels: candidate },
      { workerId: "worker-1", channelsOutboundOperationLaneCount: 2 },
    );

    expect(runners.map((runner) => runner.name)).toEqual([
      "job:channels.outbound-operations.lane-1",
      "job:channels.outbound-operations.lane-2",
    ]);
    await expect(Promise.all(runners.map((runner) => runner.runOnce()))).resolves.toEqual([
      { processed: 6, lastGlobalPosition: "0" },
      { processed: 6, lastGlobalPosition: "0" },
    ]);
    expect(recoverExpiredClaimedOperations).toHaveBeenCalledTimes(2);
    // The background tick, never the claim endpoint, calls the bounded order-pull due runner.
    expect(scheduleDueOrderPulls).toHaveBeenCalledTimes(2);
    expect(processNextInlineOperation.mock.calls.map(([input]) => input.claimOwnerId)).toEqual([
      "worker-1:job:channels.outbound-operations.lane-1",
      "worker-1:job:channels.outbound-operations.lane-2",
    ]);
  });

  it("reports a scheduler failure through the real worker failure path without stalling listing work", async () => {
    const failure = new OutboundSyncError(
      "order-pull-schedule-unavailable",
      "The order-pull authority could not be resolved.",
    );
    const processNextInlineOperation = vi.fn(async () => 1);
    const scheduleDueOrderPulls = vi.fn(async (): Promise<number> => {
      throw failure;
    });
    const [runner] = createChannelsOutboundRunners(
      {
        channels: validChannelsCandidate({
          recoverExpiredClaimedOperations: async () => 0,
          processNextInlineOperation,
          scheduleDueOrderPulls,
        }),
      },
      { workerId: "worker-1", channelsOutboundOperationLaneCount: 1 },
    );
    const statuses: Parameters<PlatformControlPlane["recordRunnerStatus"]>[0][] = [];
    const granted: Partial<PlatformControlPlane> = {
      acquireLease: async (input) => ({
        leaseName: input.leaseName,
        ownerId: input.ownerId,
        fencingToken: "1",
        expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
      }),
      renewLease: async () => true,
      releaseLease: async () => undefined,
      recordRunnerStatus: async (input) => {
        statuses.push(input);
      },
    };
    // Any other control-plane call is outside this runner's path and fails the test loudly.
    const controlPlane = new Proxy(granted, {
      get: (target, key) =>
        Reflect.get(target, key) ??
        (async () => {
          throw new Error(`Unexpected synthetic control-plane call ${String(key)}.`);
        }),
    }) as PlatformControlPlane;
    const runnerFailed = vi.fn();
    const onError = vi.fn();
    const loop = createWorkerRunnerLoop({
      workerId: "worker-1",
      controlPlane,
      runners: [runner!],
      maxConcurrentRunners: 1,
      leaseTtlMs: 60_000,
      leaseRenewIntervalMs: 60_000,
      pollIntervalMs: 5,
      failureBackoffBaseMs: 0,
      observer: { runnerFailed },
      onError,
    });
    loop.start();
    try {
      await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    } finally {
      await loop.stop();
    }
    expect(onError).toHaveBeenCalledWith(failure, expect.objectContaining({ name: runner!.name }));
    expect(runnerFailed).toHaveBeenCalledWith(expect.objectContaining({ runnerName: runner!.name, error: failure }));
    expect(statuses).toContainEqual(
      expect.objectContaining({
        runnerName: runner!.name,
        state: "error",
        lastError: "The order-pull authority could not be resolved.",
      }),
    );
    // The same pass still processed listing work before the failure was reported.
    expect(processNextInlineOperation.mock.calls.length).toBeGreaterThanOrEqual(
      scheduleDueOrderPulls.mock.calls.length,
    );
  });

  it("mounts the real Marketplace-owned inbound clamp capability for Channels", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const bindingSource = readFileSync(new URL("../src/channels-outbound-runners.ts", import.meta.url), "utf8");
    expect(source).toContain("createPlatformWorkerMarketplaceChannelInboundClampBinding(");
    expect(bindingSource).toContain("createMarketplaceChannelInboundClampCapability(");
    expect(source).toContain("Boolean(pools.marketplace)");
    expect(source).toContain("runtime?.services.marketplace as MarketplaceServices | undefined");
    expect(source).toContain("marketplaceChannelInboundClamp,");
    expect(source).not.toContain("services.channelInboundClamp.engage(input, context)");
    expect(source).not.toContain("services.channelInboundClamp.recover(input, context)");
    expect(source).not.toContain("listingIds.slice(0, 500)");
  });

  it("executes engage and recover through the actual worker-host Channels-facing binding", async () => {
    const engage = vi.fn(async () => ({
      kind: "engaged" as const,
      requestedListingCount: 1,
      affectedListingCount: 1,
      clampedListingCount: 1,
      recoveryListingCount: 0,
    }));
    const recover = vi.fn(async () => ({
      kind: "released" as const,
      examinedListingCount: 1,
      releasedListingCount: 1,
      retainedListingCount: 0,
      recoveryListingCount: 0,
    }));
    const capability = createPlatformWorkerMarketplaceChannelInboundClampBinding(true, () => ({
      channelInboundClamp: { engage, recover },
    }));
    if (capability.kind !== "available") throw new Error("Expected worker-host Marketplace clamp binding.");
    const input = {
      accountId: "account-synthetic-worker-host",
      connectionId: "connection-synthetic-worker-host",
      runId: "run-synthetic-worker-host",
      listingIds: ["listing-synthetic-worker-host"],
    };
    const context = {
      tenantId: "tenant-synthetic-worker-host",
      audit: { performedByUserId: "user-synthetic-worker-host", forAccountId: input.accountId },
    } as never;

    await expect(capability.port.engage(input, context)).resolves.toMatchObject({ kind: "engaged" });
    await expect(capability.port.recover(input, context)).resolves.toMatchObject({ kind: "released" });
    expect(engage).toHaveBeenCalledWith(input, context);
    expect(recover).toHaveBeenCalledWith(input, context);
  });
});

function validChannelsCandidate(
  outboundSync: Readonly<{
    recoverExpiredClaimedOperations: () => Promise<number>;
    processNextInlineOperation: (input: Readonly<{ registry: unknown; claimOwnerId: string }>) => Promise<number>;
    scheduleDueOrderPulls: (input: Readonly<{ registry: unknown }>) => Promise<number>;
  }> = {
    recoverExpiredClaimedOperations: async () => 0,
    processNextInlineOperation: async () => 0,
    scheduleDueOrderPulls: async () => 0,
  },
) {
  return {
    connections: { getConnection: async () => null },
    credentials: { create: vi.fn(), replace: vi.fn(), rewrap: vi.fn(), resolve: vi.fn() },
    connectionHealth: {
      submitObservation: vi.fn(),
      readConnectionHealth: vi.fn(),
      listOpenReasonGenerations: vi.fn(),
    },
    connectionAttention: { listOpenAttention: vi.fn(), resolveAttention: vi.fn() },
    listingComposition: {},
    outboundSync,
    reconciliation: {
      reconcileDueConnections: async () => [],
      deliverHealthObservations: vi.fn(),
      readChannelDriftDetail: vi.fn(),
      readChannelDriftDecision: vi.fn(),
      acceptChannelDrift: vi.fn(),
      repushChannelListing: vi.fn(),
    },
    tcgplayerCsv: {},
    tcgplayerOrders: { interpretConnection: vi.fn(), interpretDueConnections: vi.fn() },
    fulfillmentObservations: { interpretConnection: vi.fn(), interpretDueConnections: vi.fn() },
    manualSync: {},
    connectorFeed: {
      readAuthority: vi.fn(),
      withAuthority: vi.fn(),
      claim: vi.fn(),
      report: vi.fn(),
      ingest: vi.fn(),
      readAdmittedConnectorInboundEvents: vi.fn(),
      readConnectorLivenessAuthority: vi.fn<ChannelsServices["connectorFeed"]["readConnectorLivenessAuthority"]>(),
      readConnectorLivenessAuthorityInTransaction:
        vi.fn<ChannelsServices["connectorFeed"]["readConnectorLivenessAuthorityInTransaction"]>(),
      listConnectorLivenessCandidates: vi.fn<ChannelsServices["connectorFeed"]["listConnectorLivenessCandidates"]>(),
    },
    projectors: [],
    db: {},
  } satisfies Record<keyof ChannelsServices, unknown>;
}
