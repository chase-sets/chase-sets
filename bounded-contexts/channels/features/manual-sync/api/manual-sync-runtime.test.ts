import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";
import type { TcgplayerCsvServices } from "../../tcgplayer-csv/api/runtime";
import type { ChannelSyncRun, ChannelSyncRunMember } from "../../tcgplayer-csv/domain/contracts";
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
    expect(resolvePolicy).toHaveBeenCalledBefore(tcgplayerCsv.composeTcgplayerSyncRun as never);
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

  it("refuses foreign and duplicate run membership before clamp or producer claim", async () => {
    const genuine = run();
    const duplicate = { ...genuine, members: [genuine.members[0]!, genuine.members[0]!] };
    const tcgplayerCsv = producer(duplicate);
    const engage = vi.fn();
    const runtime = createManualSyncRuntime({
      db: db() as never,
      connections: connections(activeConnection()),
      tcgplayerCsv,
      policies: { resolvePolicy: vi.fn() },
      marketplaceClamp: { kind: "available", port: { engage, recover: vi.fn() } },
    });
    await expect(
      runtime.claimAndDownload(
        { accountId: "account-owner", connectionId: genuine.connectionId, runId: genuine.runId, expectedRevision: 1 },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid-action" });
    expect(engage).not.toHaveBeenCalled();
    expect(tcgplayerCsv.claimRun).not.toHaveBeenCalled();

    tcgplayerCsv.readRun = vi.fn(async () => ({ ...genuine, connectionId: "connection-foreign" }));
    await expect(
      runtime.claimAndDownload(
        { accountId: "account-owner", connectionId: genuine.connectionId, runId: genuine.runId, expectedRevision: 1 },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid-action" });
    expect(engage).not.toHaveBeenCalled();
  });

  it("uses all 501 genuine run members after a later batch-cap revision lowers the producer cap to 500", async () => {
    const first = run();
    const template = first.members[0];
    if (!template || template.memberKind !== "composed") throw new Error("Expected a composed member fixture.");
    const members: ChannelSyncRunMember[] = Array.from({ length: 501 }, (_, index) => ({
      ...template,
      operationId: `operation-${index}`,
      attemptId: `attempt-${index}`,
      channelListingId: `channel-listing-${index}`,
      listingId: `listing-${index}`,
      externalKey: `product:${index}`,
      csvRow: {
        "TCGplayer Id": String(index),
        "Add to Quantity": "-1",
        "TCG Marketplace Price": "1.25",
      },
      ordinal: index,
    }));
    const composed: ChannelSyncRun = {
      ...first,
      membershipCompleteness: { kind: "complete" as const, total: members.length },
      members,
    };
    const tcgplayerCsv = producer(composed);
    const engage = vi.fn(async (_input: Readonly<{ listingIds: readonly string[] }>, _context: EventStoreContext) => ({
      kind: "engaged" as const,
      requestedListingCount: members.length,
      affectedListingCount: members.length,
      clampedListingCount: members.length,
      recoveryListingCount: 0,
    }));
    const resolvePolicy = vi.fn(async () => ({ value: { maxRowsPerBatch: 500 } }));
    const runtime = createManualSyncRuntime({
      db: db() as never,
      connections: connections(activeConnection()),
      tcgplayerCsv,
      policies: { resolvePolicy: resolvePolicy as never },
      marketplaceClamp: { kind: "available", port: { engage, recover: vi.fn() } },
    });

    await expect(
      runtime.claimAndDownload(
        { accountId: "account-owner", connectionId: composed.connectionId, runId: composed.runId, expectedRevision: 1 },
        context,
      ),
    ).resolves.toMatchObject({ batch: { rows: expect.any(Array) } });
    expect(engage.mock.calls[0]?.[0].listingIds).toHaveLength(501);
    expect(resolvePolicy).not.toHaveBeenCalled();
  });

  it("refuses UTF-8 and logical-record bounds before the imported producer writes", async () => {
    const tcgplayerCsv = producer();
    const runtime = createManualSyncRuntime({
      db: db() as never,
      connections: connections(activeConnection()),
      tcgplayerCsv,
      policies: { resolvePolicy: vi.fn() },
      marketplaceClamp: { kind: "not-mounted" },
    });
    const input = {
      accountId: "account-owner",
      connectionId: "connection-tcg",
      surface: "staged" as const,
      fileName: "staged.csv",
      capturedAt: "2026-09-10T12:00:00.000Z",
      capturedAtSource: "ingest" as const,
    };
    await expect(runtime.ingest({ ...input, bytes: Uint8Array.of(0xff) })).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(
      runtime.ingest({ ...input, bytes: new TextEncoder().encode(`id\n${"1\n".repeat(100_001)}`) }),
    ).rejects.toMatchObject({ code: "export-record-limit-exceeded" });
    expect(tcgplayerCsv.ingestTcgplayerExportSnapshot).not.toHaveBeenCalled();
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

  it("keeps recovery explicit until retry establishes complete ownership, then restores composed download", async () => {
    const composed = run();
    const tcgplayerCsv = producer(composed);
    const database = statefulPanelDb(composed.runId);
    const engage = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "recovery",
        requestedListingCount: 1,
        affectedListingCount: 2,
        clampedListingCount: 1,
        recoveryListingCount: 1,
      })
      .mockResolvedValueOnce({
        kind: "engaged",
        requestedListingCount: 1,
        affectedListingCount: 2,
        clampedListingCount: 2,
        recoveryListingCount: 0,
      });
    const runtime = createManualSyncRuntime({
      db: database as never,
      connections: connections(activeConnection()),
      tcgplayerCsv,
      policies: { resolvePolicy: vi.fn() },
      marketplaceClamp: { kind: "available", port: { engage, recover: vi.fn() } },
      now: () => "2026-09-10T12:00:00.000Z",
    });
    const input = {
      accountId: "account-owner",
      connectionId: composed.connectionId,
      runId: composed.runId,
      expectedRevision: composed.revision,
    } as const;

    await expect(runtime.retryClamp(input, context)).rejects.toMatchObject({ code: "inbound-clamp-recovery" });
    await expect(runtime.readPanel(input)).resolves.toMatchObject({
      attentionReason: "recovery",
      actions: ["retry-clamp"],
    });

    await expect(runtime.retryClamp(input, context)).resolves.toMatchObject({
      attentionReason: "ready",
      actions: ["download"],
    });
    expect(engage).toHaveBeenCalledTimes(2);
    expect(tcgplayerCsv.claimRun).not.toHaveBeenCalled();
  });

  it("passes the exact Summary receipt and snapshot fence to the producer-owned application proof", async () => {
    const awaiting = {
      ...run(),
      state: "awaiting-verification" as const,
      revision: 3,
      uploadAttemptedAt: "2026-09-10T12:10:00.000Z",
      uploadFileName: "staged-import.csv",
    };
    const tcgplayerCsv = producer(awaiting);
    const verifyRun = vi.fn(
      async (): Promise<ChannelSyncRun> => ({
        ...awaiting,
        state: "applied",
        revision: 4,
      }),
    );
    tcgplayerCsv.verifyRun = verifyRun;
    const runtime = createManualSyncRuntime({
      db: db() as never,
      connections: connections(activeConnection()),
      tcgplayerCsv,
      policies: { resolvePolicy: vi.fn() },
      marketplaceClamp: { kind: "not-mounted" },
    });
    const importSummary = {
      fileName: "staged-import.csv",
      dateImportedText: "09/10/2026 7:12 AM CDT",
      numberOfProducts: 1,
      recordedAt: "2026-09-10T12:12:00.000Z",
    };

    await expect(
      runtime.verify(
        {
          accountId: "account-owner",
          connectionId: awaiting.connectionId,
          runId: awaiting.runId,
          expectedRevision: awaiting.revision,
          verificationSnapshotId: "snapshot-newer-staged",
          importSummary,
        },
        context,
      ),
    ).resolves.toMatchObject({ state: "applied", revision: 4 });
    expect(verifyRun).toHaveBeenCalledWith(
      {
        runId: awaiting.runId,
        expectedRevision: awaiting.revision,
        verificationSnapshotId: "snapshot-newer-staged",
        importSummary,
      },
      context,
    );
  });

  it("keeps every stale composed, claimed, and awaiting action zero-write", async () => {
    const composed = run();
    const tcgplayerCsv = producer(composed);
    const engage = vi.fn();
    const recover = vi.fn();
    const runtime = createManualSyncRuntime({
      db: db() as never,
      connections: connections(activeConnection()),
      tcgplayerCsv,
      policies: { resolvePolicy: vi.fn() },
      marketplaceClamp: { kind: "available", port: { engage, recover } },
    });
    const fence = {
      accountId: "account-owner",
      connectionId: composed.connectionId,
      runId: composed.runId,
      expectedRevision: composed.revision + 1,
    };
    await expect(runtime.claimAndDownload(fence, context)).rejects.toMatchObject({ code: "invalid-action" });
    await expect(runtime.retryClamp(fence, context)).rejects.toMatchObject({ code: "invalid-action" });

    tcgplayerCsv.readRun = vi.fn(async () => ({ ...composed, state: "claimed" as const, revision: 2 }));
    const claimedFence = { ...fence, expectedRevision: 3 };
    await expect(runtime.release(claimedFence, context)).rejects.toMatchObject({ code: "invalid-action" });
    await expect(runtime.recordValidationCancellation(claimedFence, context)).rejects.toMatchObject({
      code: "invalid-action",
    });
    await expect(
      runtime.recordUploadAttempt(
        {
          ...claimedFence,
          uploadAttemptedAt: "2026-09-10T12:10:00.000Z",
          fileName: "staged.csv",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid-action" });

    tcgplayerCsv.readRun = vi.fn(async () => ({
      ...composed,
      state: "awaiting-verification" as const,
      revision: 3,
    }));
    await expect(
      runtime.verify(
        {
          ...fence,
          expectedRevision: 4,
          verificationSnapshotId: "snapshot-newer-staged",
          importSummary: {
            fileName: "staged.csv",
            dateImportedText: "09/10/2026",
            numberOfProducts: 1,
            recordedAt: "2026-09-10T12:12:00.000Z",
          },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid-action" });

    expect(engage).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(tcgplayerCsv.claimRun).not.toHaveBeenCalled();
    expect(tcgplayerCsv.releaseRun).not.toHaveBeenCalled();
    expect(tcgplayerCsv.recordValidationCancellation).not.toHaveBeenCalled();
    expect(tcgplayerCsv.recordUploadAttempt).not.toHaveBeenCalled();
    expect(tcgplayerCsv.verifyRun).not.toHaveBeenCalled();
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

function statefulPanelDb(runId: string) {
  let clampState: string | null = null;
  return {
    query: vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.includes("SELECT run_id FROM channel_sync_runs")) return { rows: [{ run_id: runId }] };
      if (sql.includes("SELECT state FROM channels_manual_sync_clamp_status")) {
        return { rows: clampState ? [{ state: clampState }] : [] };
      }
      if (sql.includes("INSERT INTO channels_manual_sync_clamp_status")) {
        clampState = String(parameters?.[4]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT csv_header")) {
        return { rows: [{ csv_header: ["TCGplayer Id", "Add to Quantity", "TCG Marketplace Price"] }] };
      }
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
