import type { BcSeedAggregateStateReport } from "@chase-sets/bounded-context-module";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import { canonicalManualClaimLeasePolicySnapshotDigest } from "../../tcgplayer-csv/domain/validation";
import type { ChannelSyncRun } from "../../tcgplayer-csv/domain/contracts";
import { channelSyncRunEventCodec } from "../../tcgplayer-csv/domain/codec";
import { channelConnectionEventCodec } from "../../connections/domain/codec";
import { evolveChannelConnection, initialChannelConnectionState } from "../../connections/domain/domain";

export const manualSyncScenarioSeed = Object.freeze({
  connectionId: "connection-seed-tcgplayer-manual",
  runId: "run-seed-tcgplayer-manual-recovery",
  reservationId: "reservation-seed-tcgplayer-manual-recovery",
  listingId: marketplaceReservedSeedIds.listings.charizardBaseSetNearMint,
});

export async function seedManualSyncScenario(pool: PgTransactionalPool): Promise<void> {
  const eventStore = createPostgresEventStore({ pool });
  const context: EventStoreContext = {
    tenantId: "tnt_seed" as never,
    audit: {
      performedByUserId: demoIdentitySeedIds.userId,
      forAccountId: demoIdentitySeedIds.accountId,
    },
  };
  const connectionStreamId = `channels.connection-${manualSyncScenarioSeed.connectionId}`;
  // @stream-read-contract bounded-contexts/channels/features/manual-sync/api/seed.db.test.ts
  const existingConnectionEvents = await eventStore.readStream({ streamId: connectionStreamId, limit: 1 });
  const hasExistingConnection = existingConnectionEvents.length > 0;
  if (!hasExistingConnection) {
    await eventStore.appendToStream({
      streamId: connectionStreamId,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "channels.connection.connected",
          payload: {
            connectionId: manualSyncScenarioSeed.connectionId,
            accountId: demoIdentitySeedIds.accountId,
            providerKey: "tcgplayer",
            environment: "sandbox",
            createdAt: "2026-09-10T12:00:00.000Z",
          },
        },
        {
          eventType: "channels.connection.activated",
          payload: { connectionId: manualSyncScenarioSeed.connectionId, credentialReference: null, bindings: [] },
        },
      ],
    });
  }

  const runStreamId = `channels.tcgplayer-sync-run-${manualSyncScenarioSeed.runId}`;
  // @stream-read-contract bounded-contexts/channels/features/manual-sync/api/seed.db.test.ts
  const existingRunEvents = await eventStore.readStream({ streamId: runStreamId, limit: 1 });
  const hasExistingRun = existingRunEvents.length > 0;
  if (!hasExistingRun) {
    const createdAt = new Date().toISOString();
    const run = scenarioRun(createdAt);
    await eventStore.appendToStream({
      streamId: runStreamId,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "channels.tcgplayer-sync-run.composed",
          payload: {
            run,
            csvHeader: ["TCGplayer Id", "Add to Quantity", "TCG Marketplace Price"],
          },
        },
      ],
    });
  }

  await pool.query(
    `INSERT INTO channels_manual_sync_clamp_status
     (run_id,connection_id,account_id,run_revision,state,requested_listing_count,affected_listing_count,updated_at)
     VALUES ($1,$2,$3,0,'recovery',1,1,now())
     ON CONFLICT (run_id) DO NOTHING`,
    [manualSyncScenarioSeed.runId, manualSyncScenarioSeed.connectionId, demoIdentitySeedIds.accountId],
  );
}

export async function inspectManualSyncSeedState(
  pool: PgTransactionalPool,
): Promise<readonly BcSeedAggregateStateReport[]> {
  const eventStore = createPostgresEventStore({ pool });
  const connectionStreamId = `channels.connection-${manualSyncScenarioSeed.connectionId}`;
  const connectionEvents = await readCompleteStream(eventStore, { streamId: connectionStreamId });
  const connection = connectionEvents
    .map((event) => channelConnectionEventCodec.decode({ eventType: event.eventType, payload: event.payload }))
    .reduce(evolveChannelConnection, initialChannelConnectionState);
  const connectionComplete =
    connection.connectionId === manualSyncScenarioSeed.connectionId &&
    connection.accountId === demoIdentitySeedIds.accountId &&
    connection.providerKey === "tcgplayer" &&
    connection.status === "active";

  const runStreamId = `channels.tcgplayer-sync-run-${manualSyncScenarioSeed.runId}`;
  const runEvents = await readCompleteStream(eventStore, { streamId: runStreamId });
  const decodedRunEvents = runEvents.map((event) =>
    channelSyncRunEventCodec.decode({ eventType: event.eventType, payload: event.payload }),
  );
  const composed = decodedRunEvents.find((event) => event.type === "channels.tcgplayer-sync-run.composed");
  const runStatus = decodedRunEvents.reduce<string | null>((status, event) => {
    if (event.type === "channels.tcgplayer-sync-run.composed") return event.data.run.state;
    return event.data.toState;
  }, null);
  const runComplete =
    composed?.type === "channels.tcgplayer-sync-run.composed" &&
    composed.data.run.runId === manualSyncScenarioSeed.runId &&
    composed.data.run.connectionId === manualSyncScenarioSeed.connectionId &&
    composed.data.run.claimant.claimantKind === "manual" &&
    composed.data.run.state === "composed" &&
    composed.data.run.membershipCompleteness.kind === "complete" &&
    composed.data.run.membershipCompleteness.total === 1 &&
    composed.data.run.members[0]?.listingId === manualSyncScenarioSeed.listingId &&
    decodedRunEvents.length === 1;

  return [
    {
      contextName: "channels",
      aggregateName: "Channel Connection",
      id: manualSyncScenarioSeed.connectionId,
      key: "tcgplayer-manual-recovery",
      streamId: connectionStreamId,
      kind: connectionEvents.length === 0 ? "absent" : connectionComplete ? "active" : "draft",
      status: connection.status,
      eventCount: connectionEvents.length,
    },
    {
      contextName: "channels",
      aggregateName: "Channel Sync Run",
      id: manualSyncScenarioSeed.runId,
      key: "manual-recovery",
      streamId: runStreamId,
      kind: runEvents.length === 0 ? "absent" : runComplete ? "active" : "draft",
      status: runStatus,
      eventCount: runEvents.length,
    },
  ];
}

function scenarioRun(createdAt: string): ChannelSyncRun {
  const leaseMs = 1_800_000;
  const tuple = {
    policyKey: "channels.tcgplayer-manual-claim-lease" as const,
    value: { leaseMs },
    source: "fallback" as const,
    documentId: null,
    effectiveFrom: null,
    effectiveUntil: null,
    resolvedAt: createdAt,
  };
  return {
    runId: manualSyncScenarioSeed.runId,
    revision: 0,
    sequence: 1,
    connectionId: manualSyncScenarioSeed.connectionId,
    providerKey: "tcgplayer",
    reservationId: manualSyncScenarioSeed.reservationId,
    claimant: { claimantKind: "manual", claimantId: demoIdentitySeedIds.userId },
    leaseExpiresAt: new Date(Date.parse(createdAt) + leaseMs).toISOString(),
    manualClaimLeasePolicySnapshot: {
      ...tuple,
      digest: canonicalManualClaimLeasePolicySnapshotDigest(tuple),
    },
    state: "composed",
    basisSnapshotId: "snapshot-seed-tcgplayer-staged",
    basisSnapshotGeneration: 1,
    verificationSnapshotId: null,
    verificationSnapshotGeneration: null,
    uploadAttemptedAt: null,
    uploadFileName: null,
    importSummary: null,
    createdAt,
    updatedAt: createdAt,
    membershipCompleteness: { kind: "complete", total: 1 },
    members: [
      {
        operationId: "operation-seed-tcgplayer-manual-recovery",
        attemptId: "attempt-seed-tcgplayer-manual-recovery",
        claimGeneration: 1,
        reservationId: manualSyncScenarioSeed.reservationId,
        channelListingId: "channel-listing-seed-tcgplayer-manual-recovery",
        listingId: manualSyncScenarioSeed.listingId,
        desiredStateSequence: 1,
        listingRevision: 1,
        payloadDigest: "b".repeat(64),
        ordinal: 0,
        memberKind: "composed",
        externalKey: "product:seed-tcgplayer-manual-recovery",
        conditionText: "Near Mint",
        basisSnapshotId: "snapshot-seed-tcgplayer-staged",
        basisSnapshotGeneration: 1,
        basisTotalQuantity: 2,
        basisPriceAmountMinor: 39_999,
        targetQuantity: 1,
        targetPriceAmountMinor: 39_999,
        csvRow: {
          "TCGplayer Id": "seed-tcgplayer-manual-recovery",
          "Add to Quantity": "-1",
          "TCG Marketplace Price": "399.99",
        },
        refusalReason: null,
        mappingDimension: null,
        mappingSourceKey: null,
      },
    ],
  };
}
