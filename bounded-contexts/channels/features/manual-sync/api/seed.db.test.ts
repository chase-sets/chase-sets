import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { composeModuleSchemaSql } from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
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

  it("writes one valid connection/run history and one durable recovery row across repeated seed passes", async () => {
    expect([
      "bounded-contexts/channels/features/manual-sync/api/seed.ts#readStream#1",
      "bounded-contexts/channels/features/manual-sync/api/seed.ts#readStream#2",
    ]).toHaveLength(2);
    await expect(inspectManualSyncSeedState(pool)).resolves.toEqual([
      expect.objectContaining({ aggregateName: "Channel Connection", kind: "absent", status: null, eventCount: 0 }),
      expect.objectContaining({ aggregateName: "Channel Sync Run", kind: "absent", status: null, eventCount: 0 }),
    ]);
    await seedManualSyncScenario(pool);
    await seedManualSyncScenario(pool);
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
    expect(
      channelSyncRunEventCodec.decode({ eventType: runEvents[0]!.eventType, payload: runEvents[0]!.payload }),
    ).toMatchObject({
      type: "channels.tcgplayer-sync-run.composed",
      data: {
        run: {
          runId: manualSyncScenarioSeed.runId,
          state: "composed",
          membershipCompleteness: { kind: "complete", total: 1 },
        },
      },
    });
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
  });
});
