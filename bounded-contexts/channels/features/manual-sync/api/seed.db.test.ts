import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  drainLocalProjectionHandlerSets,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { composeModuleSchemaSql } from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import { module as channelsModule } from "../../../index";
import { channelConnectionEventCodec } from "../../connections/domain/codec";
import { channelSyncRunEventCodec } from "../../tcgplayer-csv/domain/codec";
import { inspectManualSyncSeedState, manualSyncScenarioSeed, seedManualSyncScenario } from "./seed";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("manual-sync browser scenario seed", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "manual_sync_scenario_seed");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).channels;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ channels: pool });
    await pool.query(composeModuleSchemaSql(channelsModule));
  });
  afterAll(async () => closeMultiContextTestPools({ channels: pool }));

  it("reconciles one real claimed reservation and releases its exact member through the mounted runtime", async () => {
    expect([
      "bounded-contexts/channels/features/manual-sync/api/seed.ts#readStream#1",
      "bounded-contexts/channels/features/manual-sync/api/seed.ts#readStream#2",
    ]).toHaveLength(2);
    let engageCalls = 0;
    let recoverCalls = 0;
    const services = channelsModule.createServices(pool, {
      marketplaceChannelInboundClamp: {
        kind: "available",
        port: {
          engage: async () => {
            engageCalls += 1;
            return {
              kind: "engaged",
              requestedListingCount: 1,
              affectedListingCount: 1,
              clampedListingCount: 1,
              recoveryListingCount: 0,
            };
          },
          recover: async () => {
            recoverCalls += 1;
            return {
              kind: "released",
              examinedListingCount: 1,
              releasedListingCount: 1,
              retainedListingCount: 0,
              recoveryListingCount: 0,
            };
          },
        },
      },
    });
    const context: EventStoreContext = {
      tenantId: "tnt_seed" as never,
      audit: {
        performedByUserId: demoIdentitySeedIds.userId,
        forAccountId: demoIdentitySeedIds.accountId,
      },
    };
    await expect(inspectManualSyncSeedState(pool)).resolves.toEqual([
      expect.objectContaining({ aggregateName: "Channel Connection", kind: "absent", status: null, eventCount: 0 }),
      expect.objectContaining({ aggregateName: "Channel Sync Run", kind: "absent", status: null, eventCount: 0 }),
    ]);
    await seedManualSyncScenario(pool, services);
    await expect(inspectManualSyncSeedState(pool)).resolves.toEqual([
      expect.objectContaining({ aggregateName: "Channel Connection", kind: "active", eventCount: 2 }),
      expect.objectContaining({ aggregateName: "Channel Sync Run", kind: "absent", eventCount: 0 }),
    ]);
    await drainLocalProjectionHandlerSets("channels", pool, services.projectors);
    await seedManualSyncScenario(pool, services);
    await seedManualSyncScenario(pool, services);
    await drainLocalProjectionHandlerSets("channels", pool, services.projectors);
    await expect(inspectManualSyncSeedState(pool)).resolves.toEqual([
      {
        contextName: "channels",
        aggregateName: "Channel Connection",
        id: manualSyncScenarioSeed.connectionId,
        key: "tcgplayer-manual-recovery",
        streamId: `channels.connection-${manualSyncScenarioSeed.connectionId}`,
        kind: "active",
        status: "active",
        eventCount: 2,
      },
      {
        contextName: "channels",
        aggregateName: "Channel Sync Run",
        id: manualSyncScenarioSeed.runId,
        key: "manual-recovery",
        streamId: `channels.tcgplayer-sync-run-${manualSyncScenarioSeed.runId}`,
        kind: "active",
        status: "composed",
        eventCount: 1,
      },
    ]);
    const eventStore = createPostgresEventStore({ pool });
    const connectionEvents = await eventStore.readStream({
      streamId: `channels.connection-${manualSyncScenarioSeed.connectionId}`,
    });
    const runEvents = await eventStore.readStream({
      streamId: `channels.tcgplayer-sync-run-${manualSyncScenarioSeed.runId}`,
    });
    expect(connectionEvents).toHaveLength(2);
    expect(
      connectionEvents.map((event) =>
        channelConnectionEventCodec.decode({ eventType: event.eventType, payload: event.payload }),
      ),
    ).toEqual([
      expect.objectContaining({ type: "channels.connection.connected" }),
      {
        type: "channels.connection.activated",
        data: {
          connectionId: manualSyncScenarioSeed.connectionId,
          credentialReference: null,
          bindings: [
            {
              storageLocationId: manualSyncScenarioSeed.storageLocationId,
              revision: manualSyncScenarioSeed.storageLocationRevision,
            },
          ],
        },
      },
    ]);
    expect(runEvents).toHaveLength(1);
    const composedEvent = channelSyncRunEventCodec.decode({
      eventType: runEvents[0]!.eventType,
      payload: runEvents[0]!.payload,
    });
    expect(composedEvent).toMatchObject({
      type: "channels.tcgplayer-sync-run.composed",
      data: {
        run: {
          runId: manualSyncScenarioSeed.runId,
          state: "composed",
          membershipCompleteness: { kind: "complete", total: 1 },
        },
      },
    });
    if (composedEvent.type !== "channels.tcgplayer-sync-run.composed") {
      throw new Error("Expected the scenario's one composed run event.");
    }
    const seededRun = composedEvent.data.run;
    const seededMember = seededRun.members[0]!;
    const reservation = await pool.query<{
      operation_id: string;
      attempt_id: string;
      claim_generation: number;
      reservation_id: string;
      claimant_kind: string;
      claim_owner_id: string;
      channel_listing_id: string;
      listing_id: string;
      source_desired_state_sequence: number;
      listing_revision: number;
      payload_digest: string;
      status: string;
    }>(
      `SELECT operation_id,attempt_id,claim_generation::int,reservation_id,claimant_kind,claim_owner_id,
              channel_listing_id,listing_id,source_desired_state_sequence::int,listing_revision::int,payload_digest,status
         FROM channel_outbound_operations`,
    );
    expect(reservation.rows).toEqual([
      {
        operation_id: seededMember.operationId,
        attempt_id: seededMember.attemptId,
        claim_generation: seededMember.claimGeneration,
        reservation_id: seededRun.reservationId,
        claimant_kind: "manual",
        claim_owner_id: demoIdentitySeedIds.userId,
        channel_listing_id: seededMember.channelListingId,
        listing_id: seededMember.listingId,
        source_desired_state_sequence: seededMember.desiredStateSequence,
        listing_revision: seededMember.listingRevision,
        payload_digest: seededMember.payloadDigest,
        status: "in-flight",
      },
    ]);
    await expect(
      pool.query(
        `SELECT account_id,connection_id,run_revision::int,state,requested_listing_count,affected_listing_count
           FROM channels_manual_sync_clamp_status WHERE run_id=$1`,
        [manualSyncScenarioSeed.runId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          account_id: "acc_seed_demo_account",
          connection_id: manualSyncScenarioSeed.connectionId,
          run_revision: 0,
          state: "recovery",
          requested_listing_count: 1,
          affected_listing_count: 1,
        },
      ],
    });

    await expect(
      services.manualSync.retryClamp(
        {
          accountId: demoIdentitySeedIds.accountId,
          connectionId: manualSyncScenarioSeed.connectionId,
          runId: manualSyncScenarioSeed.runId,
          expectedRevision: 0,
        },
        context,
      ),
    ).resolves.toMatchObject({ attentionReason: "ready", actions: ["download"] });
    const download = await services.manualSync.claimAndDownload(
      {
        accountId: demoIdentitySeedIds.accountId,
        connectionId: manualSyncScenarioSeed.connectionId,
        runId: manualSyncScenarioSeed.runId,
        expectedRevision: 0,
      },
      context,
    );
    expect(download).toMatchObject({
      fileName: `tcgplayer-staged-${manualSyncScenarioSeed.runId}.csv`,
      run: { revision: 1, state: "claimed", reservationId: seededRun.reservationId },
      batch: { reservationId: seededRun.reservationId },
    });
    expect(download.batch.csv).toContain("seed-tcgplayer-manual-recovery,-1,399.99");
    await expect(
      services.manualSync.release(
        {
          accountId: demoIdentitySeedIds.accountId,
          connectionId: manualSyncScenarioSeed.connectionId,
          runId: manualSyncScenarioSeed.runId,
          expectedRevision: 1,
        },
        context,
      ),
    ).resolves.toMatchObject({ revision: 2, state: "abandoned", reservationId: seededRun.reservationId });
    expect({ engageCalls, recoverCalls }).toEqual({ engageCalls: 2, recoverCalls: 1 });

    await expect(
      pool.query(
        `SELECT status,revision::int,attempt_id,claim_generation::int,claimant_kind,claim_owner_id,reservation_id,
                terminal_reason,link_write_state
           FROM channel_outbound_operations WHERE operation_id=$1`,
        [seededMember.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          status: "pending",
          revision: 3,
          attempt_id: null,
          claim_generation: seededMember.claimGeneration,
          claimant_kind: null,
          claim_owner_id: null,
          reservation_id: null,
          terminal_reason: null,
          link_write_state: "pending",
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT reservation_id,claimant,outcomes,run_settlement
           FROM channel_outbound_reservation_settlements WHERE reservation_id=$1`,
        [seededRun.reservationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          reservation_id: seededRun.reservationId,
          claimant: seededRun.claimant,
          outcomes: [
            {
              operationId: seededMember.operationId,
              attemptId: seededMember.attemptId,
              claimGeneration: seededMember.claimGeneration,
              desiredStateSequence: seededMember.desiredStateSequence,
              outcome: { kind: "abandoned", reason: "released" },
            },
          ],
          run_settlement: {
            runId: manualSyncScenarioSeed.runId,
            expectedRunRevision: 1,
            fromState: "claimed",
            toState: "abandoned",
            verificationSnapshotId: null,
            verificationSnapshotGeneration: null,
            uploadAttemptedAt: null,
            uploadFileName: null,
            importSummary: null,
          },
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT run_revision::int,state,requested_listing_count,affected_listing_count
           FROM channels_manual_sync_clamp_status WHERE run_id=$1`,
        [manualSyncScenarioSeed.runId],
      ),
    ).resolves.toMatchObject({
      rows: [{ run_revision: 2, state: "released", requested_listing_count: 1, affected_listing_count: 1 }],
    });
    const finalRunEvents = await eventStore.readStream({
      streamId: `channels.tcgplayer-sync-run-${manualSyncScenarioSeed.runId}`,
    });
    expect(finalRunEvents.map((event) => event.eventType)).toEqual([
      "channels.tcgplayer-sync-run.composed",
      "channels.tcgplayer-sync-run.transitioned",
      "channels.tcgplayer-sync-run.transitioned",
    ]);
  });
});
