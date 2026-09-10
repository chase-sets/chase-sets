import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import { canonicalManualClaimLeasePolicySnapshotDigest } from "../../tcgplayer-csv/domain/validation";
import type { ChannelSyncRun } from "../../tcgplayer-csv/domain/contracts";

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
  if (existingConnectionEvents.length === 0) {
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
  if (existingRunEvents.length === 0) {
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
