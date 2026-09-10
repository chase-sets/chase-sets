import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  composeModuleSchemaSql,
  rebuildProjectionGroup,
  resolveModuleProjectionGroups,
} from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import { projectChannelSyncRunComposed } from "../../tcgplayer-csv/read-model/projection";
import type { ChannelSyncRun } from "../../tcgplayer-csv/domain/contracts";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("manual-sync command ownership survives the actual TCGplayer CSV projection rebuild", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "manual_sync_projection_rebuild");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).channels;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ channels: pool });
    await pool.query(composeModuleSchemaSql(channelsModule));
  });
  afterAll(async () => closeMultiContextTestPools({ channels: pool }));

  it("preserves the recovery row and its account/revision/count fences while a projected run resets and replays", async () => {
    const run = composedRun();
    await projectChannelSyncRunComposed(pool, { run, csvHeader: Object.keys(run.members[0]!.csvRow!) }, 1);
    await pool.query(
      `INSERT INTO channels_manual_sync_clamp_status
       (run_id,connection_id,account_id,run_revision,state,requested_listing_count,affected_listing_count,updated_at)
       VALUES ($1,$2,$3,7,'recovery',1,2,'2026-09-10T12:05:00.000Z')`,
      [run.runId, run.connectionId, "account-command-owner"],
    );

    let projectedRunWasAbsentBeforeReplay = false;
    let recoveryRowWasPresentBeforeReplay = false;
    const group = actualProjectionGroup("tcgplayer-csv-projection", async () => {
      projectedRunWasAbsentBeforeReplay =
        (await pool.query("SELECT 1 FROM channel_sync_runs WHERE run_id=$1", [run.runId])).rows.length === 0;
      recoveryRowWasPresentBeforeReplay =
        (await pool.query("SELECT 1 FROM channels_manual_sync_clamp_status WHERE run_id=$1", [run.runId])).rows
          .length === 1;
      await projectChannelSyncRunComposed(pool, { run, csvHeader: Object.keys(run.members[0]!.csvRow!) }, 1);
    });
    await rebuildProjectionGroup(group);

    expect(projectedRunWasAbsentBeforeReplay).toBe(true);
    expect(recoveryRowWasPresentBeforeReplay).toBe(true);
    await expect(pool.query("SELECT state FROM channel_sync_runs WHERE run_id=$1", [run.runId])).resolves.toMatchObject(
      {
        rows: [{ state: "composed" }],
      },
    );
    await expect(
      pool.query(
        `SELECT account_id,run_revision::int,state,requested_listing_count,affected_listing_count
           FROM channels_manual_sync_clamp_status WHERE run_id=$1`,
        [run.runId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          account_id: "account-command-owner",
          run_revision: 7,
          state: "recovery",
          requested_listing_count: 1,
          affected_listing_count: 2,
        },
      ],
    });
  });

  it("refuses a reset declaration that omits the projection-owned snapshot-row FK child", async () => {
    const declared = channelsModule.projectionGroups?.find(
      (group) => group.projectionName === "tcgplayer-csv-projection",
    );
    if (!declared) throw new Error("Missing actual Channels TCGplayer CSV projection group.");
    const mutant = {
      ...declared,
      ownedTables: declared.ownedTables.filter((tableName) => tableName !== "channel_inventory_snapshot_rows"),
    };
    const module = { ...channelsModule, buildProjectionGroups: undefined, projectionGroups: [mutant] };
    const [group] = resolveModuleProjectionGroups(
      [{ contextName: "channels", module, services: {}, pool, projectionHandlerSets: [] }] as never,
      [] as never,
    );

    await expect(group!.reset()).rejects.toThrow(/foreign key constraint|referenced in a foreign key/i);
  });

  it("makes the survivor guard fail when the durable command table is restored to projection ownership", async () => {
    const run = composedRun();
    await projectChannelSyncRunComposed(pool, { run, csvHeader: Object.keys(run.members[0]!.csvRow!) }, 1);
    await pool.query(
      `INSERT INTO channels_manual_sync_clamp_status
       (run_id,connection_id,account_id,run_revision,state,requested_listing_count,affected_listing_count,updated_at)
       VALUES ($1,$2,$3,7,'recovery',1,2,'2026-09-10T12:05:00.000Z')`,
      [run.runId, run.connectionId, "account-command-owner"],
    );
    const declared = channelsModule.projectionGroups?.find(
      (group) => group.projectionName === "tcgplayer-csv-projection",
    );
    if (!declared) throw new Error("Missing actual Channels TCGplayer CSV projection group.");
    const group = actualProjectionGroup(
      declared.projectionName,
      async () => projectChannelSyncRunComposed(pool, { run, csvHeader: Object.keys(run.members[0]!.csvRow!) }, 1),
      [...declared.ownedTables, "channels_manual_sync_clamp_status"],
    );
    await rebuildProjectionGroup(group);
    await expect(
      pool.query("SELECT 1 FROM channels_manual_sync_clamp_status WHERE run_id=$1", [run.runId]),
    ).resolves.toMatchObject({ rows: [] });
  });

  function actualProjectionGroup(projectionName: string, replay: () => Promise<void>, ownedTables?: readonly string[]) {
    const declared = channelsModule.projectionGroups?.find((group) => group.projectionName === projectionName);
    if (!declared) throw new Error(`Missing actual Channels projection group ${projectionName}.`);
    const module = {
      ...channelsModule,
      buildProjectionGroups: undefined,
      projectionGroups: [{ ...declared, ownedTables: ownedTables ?? declared.ownedTables }],
    };
    let replayed = false;
    const status = {
      checkpointKey: "channels-test-rebuild",
      subscriptionName: "channels-test-rebuild",
      projectionName,
      sourceContextName: "channels",
      targetContextName: "channels",
      subscriptionVersion: 1,
      initialized: true,
      recoveryRequired: false,
      lastGlobalPosition: "0",
      sourceHeadGlobalPosition: "0",
      outstandingEventCount: "0",
      processedEvents: 0,
      state: "caught-up",
      lastError: null,
      blockedStreamCount: 0,
      poisonEventCount: 0,
      updatedAt: "2026-09-10T12:00:00.000Z",
    } as const;
    const runner = {
      ...status,
      order: 1,
      runOnce: vi.fn(async () => {
        if (replayed) return { processed: 0, blockedStreams: 0, poisonEvents: 0 };
        replayed = true;
        await replay();
        return { processed: 1, blockedStreams: 0, poisonEvents: 0 };
      }),
      getStatus: () => status,
      refreshStatus: async () => status,
      reset: vi.fn(async () => {
        replayed = false;
      }),
      retryBlockedStream: vi.fn(),
    };
    return resolveModuleProjectionGroups(
      [
        {
          contextName: "channels",
          module,
          services: {},
          pool,
          projectionHandlerSets: [],
        },
      ] as never,
      [runner] as never,
    )[0]!;
  }
});

function composedRun(): ChannelSyncRun {
  return {
    runId: "run-projection-rebuild",
    revision: 0,
    sequence: 1,
    connectionId: "connection-projection-rebuild",
    providerKey: "tcgplayer",
    reservationId: "reservation-projection-rebuild",
    claimant: { claimantKind: "manual", claimantId: "user-command-owner" },
    leaseExpiresAt: "2026-09-10T12:30:00.000Z",
    manualClaimLeasePolicySnapshot: {
      policyKey: "channels.tcgplayer-manual-claim-lease",
      value: { leaseMs: 1_800_000 },
      source: "fallback",
      documentId: null,
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: "2026-09-10T12:00:00.000Z",
      digest: "a".repeat(64),
    },
    state: "composed",
    basisSnapshotId: "snapshot-projection-rebuild",
    basisSnapshotGeneration: 1,
    verificationSnapshotId: null,
    verificationSnapshotGeneration: null,
    uploadAttemptedAt: null,
    uploadFileName: null,
    importSummary: null,
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    membershipCompleteness: { kind: "complete", total: 1 },
    members: [
      {
        operationId: "operation-projection-rebuild",
        attemptId: "attempt-projection-rebuild",
        claimGeneration: 1,
        reservationId: "reservation-projection-rebuild",
        channelListingId: "channel-listing-projection-rebuild",
        listingId: "listing-projection-rebuild",
        desiredStateSequence: 1,
        listingRevision: 1,
        payloadDigest: "b".repeat(64),
        ordinal: 0,
        memberKind: "composed",
        externalKey: "product:projection-rebuild",
        conditionText: "Near Mint",
        basisSnapshotId: "snapshot-projection-rebuild",
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
