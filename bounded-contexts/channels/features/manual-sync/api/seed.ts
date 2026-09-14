import type { BcSeedAggregateStateReport } from "@chase-sets/bounded-context-module";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import {
  createPostgresEventStore,
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import { inventorySeedIds } from "@chase-sets/inventory/seed-support/ids";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import { canonicalManualClaimLeasePolicySnapshotDigest } from "../../tcgplayer-csv/domain/validation";
import type { ChannelSyncRun } from "../../tcgplayer-csv/domain/contracts";
import { channelSyncRunEventCodec } from "../../tcgplayer-csv/domain/codec";
import { channelConnectionEventCodec } from "../../connections/domain/codec";
import { evolveChannelConnection, initialChannelConnectionState } from "../../connections/domain/domain";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";
import type { ClaimedOperationReservation, OutboundSyncServices } from "../../outbound-sync/domain/contracts";
import { channelProviderRegistry } from "../../publication-port/api/registry";

export const manualSyncScenarioSeed = Object.freeze({
  connectionId: "connection-seed-tcgplayer-manual",
  runId: "run-seed-tcgplayer-manual-recovery",
  channelListingId: "channel-listing-synthetic-seed-tcgplayer-manual-recovery",
  listingId: marketplaceReservedSeedIds.listings.charizardBaseSetNearMint,
  storageLocationId: inventorySeedIds.storageLocations.northShelf,
  storageLocationRevision: 1,
});

type ManualSyncScenarioSeedServices = Readonly<{
  connections: Pick<ChannelConnectionServices, "getConnection">;
  outboundSync: Pick<OutboundSyncServices, "enqueueDesiredState" | "reserveClaimedOutboundOperationsInTransaction">;
}>;

export async function seedManualSyncScenario(
  pool: PgTransactionalPool,
  services?: ManualSyncScenarioSeedServices,
): Promise<void> {
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
          payload: {
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
      ],
    });
  }

  const runStreamId = `channels.tcgplayer-sync-run-${manualSyncScenarioSeed.runId}`;
  // @stream-read-contract bounded-contexts/channels/features/manual-sync/api/seed.db.test.ts
  const existingRunEvents = await eventStore.readStream({ streamId: runStreamId, limit: 1 });
  const hasExistingRun = existingRunEvents.length > 0;
  if (hasExistingRun || !hasExistingConnection || !services) return;

  const connection = await services.connections.getConnection({
    accountId: demoIdentitySeedIds.accountId,
    connectionId: manualSyncScenarioSeed.connectionId,
  });
  if (
    connection?.providerKey !== "tcgplayer" ||
    connection.environment !== "sandbox" ||
    connection.status !== "active"
  ) {
    return;
  }

  const connectionEvents = await readCompleteStream(eventStore, { streamId: connectionStreamId });
  const sourceEvent = connectionEvents.find((event) => event.eventType === "channels.connection.activated");
  if (!sourceEvent) throw new Error("The manual sync scenario connection activation event is unavailable.");

  await services.outboundSync.enqueueDesiredState({
    connectionId: manualSyncScenarioSeed.connectionId,
    channelListingId: manualSyncScenarioSeed.channelListingId,
    listingId: manualSyncScenarioSeed.listingId,
    operationKind: "publish",
    listingRevision: 1,
    desiredStateSequence: sourceEvent.streamVersion,
    desiredStateHash: "7".repeat(64),
    payload: {
      kind: "draft",
      draft: {
        channelListingId: manualSyncScenarioSeed.channelListingId,
        listingRevision: 1,
        title: "Synthetic manual sync recovery seed",
        description: "Synthetic desired state for the browser-only manual sync recovery scenario.",
        categoryKey: "synthetic-manual-sync-recovery",
        conditionKey: "Near Mint",
        price: { amountMinor: 39_999, currency: "USD" },
        quantity: 1,
        attributes: [],
      },
    },
    envelope: {
      sourceEventId: sourceEvent.eventId,
      sourceStreamId: sourceEvent.streamId,
      sourceStreamVersion: sourceEvent.streamVersion,
      sourceGlobalPosition: sourceEvent.globalPosition,
      sourceOccurredAt: sourceEvent.occurredAt,
    },
  });

  await withPgTransaction(pool, async (db: PgQueryable) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`manual-sync-seed:${runStreamId}`]);
    const currentRun = await db.query("SELECT 1 FROM event_store_events WHERE stream_id=$1 LIMIT 1", [runStreamId]);
    if (currentRun.rows.length > 0) return;
    const reservation = await services.outboundSync.reserveClaimedOutboundOperationsInTransaction(
      {
        registry: channelProviderRegistry,
        connectionId: manualSyncScenarioSeed.connectionId,
        claimant: { claimantKind: "manual", claimantId: demoIdentitySeedIds.userId },
        maxOperations: 1,
        leaseMs: 1_800_000,
      },
      db,
    );
    if (!reservation || reservation.operations.length !== 1) {
      throw new Error(
        "The manual sync scenario desired state did not produce one claimed TCGplayer reservation member.",
      );
    }
    const run = scenarioRun(reservation);
    await eventStore.appendToStreamInTransaction(db, {
      streamId: runStreamId,
      wakeSourceContextName: "channels",
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
    await db.query(
      `INSERT INTO channels_manual_sync_clamp_status
       (run_id,connection_id,account_id,run_revision,state,requested_listing_count,affected_listing_count,updated_at)
       VALUES ($1,$2,$3,0,'recovery',1,1,now())
       ON CONFLICT (run_id) DO NOTHING`,
      [manualSyncScenarioSeed.runId, manualSyncScenarioSeed.connectionId, demoIdentitySeedIds.accountId],
    );
  });
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
    connection.status === "active" &&
    connection.bindings.length === 1 &&
    connection.bindings[0]?.storageLocationId === manualSyncScenarioSeed.storageLocationId &&
    connection.bindings[0]?.revision === manualSyncScenarioSeed.storageLocationRevision;

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

function scenarioRun(reservation: ClaimedOperationReservation): ChannelSyncRun {
  const operation = reservation.operations[0]!;
  const leaseMs = Date.parse(reservation.leaseExpiresAt) - Date.parse(reservation.reservedAt);
  const tuple = {
    policyKey: "channels.tcgplayer-manual-claim-lease" as const,
    value: { leaseMs },
    source: "fallback" as const,
    documentId: null,
    effectiveFrom: null,
    effectiveUntil: null,
    resolvedAt: reservation.reservedAt,
  };
  return {
    runId: manualSyncScenarioSeed.runId,
    revision: 0,
    sequence: 1,
    connectionId: manualSyncScenarioSeed.connectionId,
    providerKey: "tcgplayer",
    reservationId: reservation.reservationId,
    claimant: reservation.claimant,
    leaseExpiresAt: reservation.leaseExpiresAt,
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
    createdAt: reservation.reservedAt,
    updatedAt: reservation.reservedAt,
    membershipCompleteness: { kind: "complete", total: 1 },
    members: [
      {
        operationId: operation.operationId,
        attemptId: operation.attemptId,
        claimGeneration: operation.claimGeneration,
        reservationId: reservation.reservationId,
        channelListingId: operation.channelListingId,
        listingId: operation.listingId,
        desiredStateSequence: operation.desiredStateSequence,
        listingRevision: operation.listingRevision,
        payloadDigest: operation.payloadDigest,
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
