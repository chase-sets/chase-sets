import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";
import type { TcgplayerCsvServices } from "../../tcgplayer-csv/api/runtime";
import type { ChannelSyncRun } from "../../tcgplayer-csv/domain/contracts";
import { createManualSyncRuntime } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tenant" as never,
  audit: { performedByUserId: "seller" as never, forAccountId: "account-owner" as never },
};

describe("manual-sync runtime binding", () => {
  it("refuses a missing connection before policy resolution or producer composition", async () => {
    const tcgplayerCsv = producer();
    const resolvePolicy = vi.fn();
    const runtime = createManualSyncRuntime({
      db: db() as never,
      connections: connections(null),
      tcgplayerCsv,
      policies: { resolvePolicy },
      marketplaceClamp: { kind: "not-mounted" },
    });
    await expect(
      runtime.compose({ accountId: "account-owner", connectionId: "missing" }, context),
    ).rejects.toMatchObject({
      code: "connection-not-found",
    });
    expect(resolvePolicy).not.toHaveBeenCalled();
    expect(tcgplayerCsv.composeTcgplayerSyncRun).not.toHaveBeenCalled();
  });

  it("resolves both policies once at one instant and passes the frozen lease tuple to the actual producer API", async () => {
    const tcgplayerCsv = producer();
    const resolvePolicy = vi.fn(
      async (definition: Readonly<{ policyKey: string }>, params: Readonly<{ at: string }>) => ({
        policyKey: definition.policyKey,
        value:
          definition.policyKey === "channels.tcgplayer-manual-claim-lease"
            ? { leaseMs: 60_000 }
            : { maxRowsPerBatch: 500 },
        source: "fallback" as const,
        documentId: null,
        effectiveFrom: null,
        effectiveUntil: null,
        resolvedAt: params.at,
      }),
    );
    const runtime = createManualSyncRuntime({
      db: db() as never,
      connections: connections(activeConnection()),
      tcgplayerCsv,
      policies: { resolvePolicy: resolvePolicy as never },
      marketplaceClamp: { kind: "not-mounted" },
      now: () => "2026-09-10T12:00:00.000Z",
    });
    await expect(
      runtime.compose({ accountId: "account-owner", connectionId: "connection-tcg" }, context),
    ).rejects.toMatchObject({
      code: "invalid-action",
    });
    expect(resolvePolicy).toHaveBeenCalledTimes(2);
    expect(resolvePolicy.mock.calls.map((call) => call[1])).toEqual([
      { at: "2026-09-10T12:00:00.000Z" },
      { at: "2026-09-10T12:00:00.000Z" },
    ]);
    expect(tcgplayerCsv.composeTcgplayerSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseMs: 60_000,
        resolvedPolicy: { maxRowsPerBatch: 500 },
        manualClaimLeasePolicySnapshot: expect.objectContaining({
          source: "fallback",
          value: { leaseMs: 60_000 },
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
      context,
    );
  });

  it("uses genuine unique run listingIds without a captured-cap read before claim", async () => {
    const composed = run();
    const tcgplayerCsv = producer(composed);
    const engage = vi.fn(async () => ({
      kind: "engaged" as const,
      requestedListingCount: 1,
      affectedListingCount: 2,
      clampedListingCount: 2,
      recoveryListingCount: 0,
    }));
    const runtime = createManualSyncRuntime({
      db: db() as never,
      connections: connections(activeConnection()),
      tcgplayerCsv,
      policies: { resolvePolicy: vi.fn() },
      marketplaceClamp: { kind: "available", port: { engage, recover: vi.fn() } },
    });
    const result = await runtime.claimAndDownload(
      { accountId: "account-owner", connectionId: composed.connectionId, runId: composed.runId, expectedRevision: 1 },
      context,
    );
    expect(engage).toHaveBeenCalledWith(
      {
        accountId: "account-owner",
        connectionId: composed.connectionId,
        runId: composed.runId,
        listingIds: ["listing-1"],
      },
      context,
    );
    expect(result.batch.rows).toHaveLength(1);
    expect(tcgplayerCsv.claimRun).toHaveBeenCalledWith({ runId: composed.runId, expectedRevision: 1 }, context);
  });

  it("settles a pre-submission producer release before revision-fenced clamp recovery", async () => {
    const claimed = { ...run(), state: "claimed" as const, revision: 2 };
    const tcgplayerCsv = producer(claimed);
    const releaseRun = vi.fn(async (): Promise<ChannelSyncRun> => ({ ...claimed, state: "composed", revision: 3 }));
    tcgplayerCsv.releaseRun = releaseRun;
    const recover = vi.fn(async () => ({
      kind: "released" as const,
      examinedListingCount: 2,
      releasedListingCount: 2,
      retainedListingCount: 0,
      recoveryListingCount: 0,
    }));
    const runtime = createManualSyncRuntime({
      db: db() as never,
      connections: connections(activeConnection()),
      tcgplayerCsv,
      policies: { resolvePolicy: vi.fn() },
      marketplaceClamp: { kind: "available", port: { engage: vi.fn(), recover } },
    });
    const released = await runtime.release(
      { accountId: "account-owner", connectionId: claimed.connectionId, runId: claimed.runId, expectedRevision: 2 },
      context,
    );
    expect(releaseRun).toHaveBeenCalledBefore(recover);
    expect(recover).toHaveBeenCalledWith(
      {
        accountId: "account-owner",
        connectionId: claimed.connectionId,
        runId: claimed.runId,
        listingIds: ["listing-1"],
      },
      context,
    );
    expect(released).toMatchObject({ state: "composed", revision: 3 });
  });
});

function activeConnection() {
  return {
    connectionId: "connection-tcg",
    providerKey: "tcgplayer",
    environment: "production" as const,
    status: "active" as const,
    createdAt: "2026-09-10T11:00:00.000Z",
  };
}

function connections(connection: ReturnType<typeof activeConnection> | null): ChannelConnectionServices {
  const unavailable = async (): Promise<never> => Promise.reject(new Error("not reached"));
  return {
    connectChannel: unavailable,
    activateChannelConnection: unavailable,
    pauseChannelConnection: unavailable,
    resumeChannelConnection: unavailable,
    disconnectChannelConnection: unavailable,
    getConnection: vi.fn(async () => connection),
    listConnections: unavailable,
    projectors: [],
  };
}

function producer(read: ChannelSyncRun | null = null): TcgplayerCsvServices {
  const notReached = vi.fn(async (): Promise<never> => {
    throw new Error("not reached");
  });
  return {
    ingestTcgplayerExportSnapshot: notReached,
    composeTcgplayerSyncRun: vi.fn(async () => null),
    claimRun: vi.fn(async (): Promise<ChannelSyncRun> => ({ ...read!, state: "claimed", revision: 2 })),
    releaseRun: notReached,
    recordUploadAttempt: notReached,
    recordValidationCancellation: notReached,
    verifyRun: notReached,
    supersedeRun: notReached,
    observeNewerBasis: notReached,
    settleReservationLeaseExpiry: notReached,
    readLatestSnapshotRows: notReached,
    readRun: vi.fn(async () => read),
    projectors: [],
  };
}

function db() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT csv_header"))
        return { rows: [{ csv_header: ["TCGplayer Id", "Add to Quantity", "TCG Marketplace Price"] }] };
      return { rows: [], rowCount: 1 };
    }),
  };
}

function run(): ChannelSyncRun {
  return {
    runId: "run-genuine",
    revision: 1,
    sequence: 1,
    connectionId: "connection-tcg",
    providerKey: "tcgplayer",
    reservationId: "reservation-1",
    claimant: { claimantKind: "manual", claimantId: "seller" },
    leaseExpiresAt: "2026-09-10T12:30:00Z",
    manualClaimLeasePolicySnapshot: null,
    state: "composed",
    basisSnapshotId: "snapshot-1",
    basisSnapshotGeneration: 1,
    verificationSnapshotId: null,
    verificationSnapshotGeneration: null,
    uploadAttemptedAt: null,
    uploadFileName: null,
    importSummary: null,
    createdAt: "2026-09-10T12:00:00Z",
    updatedAt: "2026-09-10T12:00:00Z",
    membershipCompleteness: { kind: "complete", total: 1 },
    members: [
      {
        operationId: "operation-1",
        attemptId: "attempt-1",
        claimGeneration: 1,
        reservationId: "reservation-1",
        channelListingId: "channel-listing-1",
        listingId: "listing-1",
        desiredStateSequence: 1,
        listingRevision: 1,
        payloadDigest: "a".repeat(64),
        ordinal: 0,
        memberKind: "composed",
        externalKey: "product:1",
        conditionText: "Near Mint",
        basisSnapshotId: "snapshot-1",
        basisSnapshotGeneration: 1,
        basisTotalQuantity: 2,
        basisPriceAmountMinor: 100,
        targetQuantity: 1,
        targetPriceAmountMinor: 125,
        csvRow: { "TCGplayer Id": "1", "Add to Quantity": "-1", "TCG Marketplace Price": "1.25" },
        refusalReason: null,
        mappingDimension: null,
        mappingSourceKey: null,
      },
    ],
  };
}
