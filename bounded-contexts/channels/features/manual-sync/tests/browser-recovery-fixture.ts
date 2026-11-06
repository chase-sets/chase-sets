import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPostgresEventStore, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import type { ChannelsServices } from "../../../support/runtime-support/services";
import { channelConnectionEventCodec } from "../../connections/domain/codec";
import { evolveChannelConnection, initialChannelConnectionState } from "../../connections/domain/domain";
import type { ClaimedOperationReservation } from "../../outbound-sync/domain/contracts";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import type { ChannelSyncRun } from "../../tcgplayer-csv/domain/contracts";
import { canonicalManualClaimLeasePolicySnapshotDigest } from "../../tcgplayer-csv/domain/validation";
import { manualSyncScenarioSeed } from "../api/seed";

export type BrowserRecoveryFixtureInput = Readonly<{
  ownershipId: string;
  connectionId: string;
  listingId: string;
  createdAfter: string;
}>;

export function assertBrowserRecoveryFixtureInput(input: BrowserRecoveryFixtureInput): void {
  if (
    !/^[a-f0-9-]{36}$/.test(input.ownershipId) ||
    !/^chn_[a-zA-Z0-9_-]+$/.test(input.connectionId) ||
    !/^lst_[a-zA-Z0-9_-]+$/.test(input.listingId) ||
    !Number.isFinite(Date.parse(input.createdAfter)) ||
    input.connectionId === manualSyncScenarioSeed.connectionId ||
    input.listingId === manualSyncScenarioSeed.listingId
  ) throw new Error("owned-recovery-input-required");
}

export const browserRecoveryContext: EventStoreContext = {
  tenantId: "tnt_seed" as never,
  audit: { performedByUserId: demoIdentitySeedIds.userId, forAccountId: demoIdentitySeedIds.accountId },
};

// Native connection activation and Listing creation are prerequisites, never fixture privileges.
export async function createBrowserRecoveryFixture(
  pool: PgTransactionalPool,
  services: Pick<ChannelsServices, "outboundSync">,
  input: BrowserRecoveryFixtureInput,
): Promise<Readonly<{ connectionId: string; runId: string; listingId: string }>> {
  assertBrowserRecoveryFixtureInput(input);
  const eventStore = createPostgresEventStore({ pool });
  const connectionEvents = await readCompleteStream(eventStore, {
    streamId: `channels.connection-${input.connectionId}`,
  });
  const connection = connectionEvents.map((event) =>
    channelConnectionEventCodec.decode({ eventType: event.eventType, payload: event.payload }),
  ).reduce(evolveChannelConnection, initialChannelConnectionState);
  if (
    connectionEvents.length !== 2 ||
    connection.connectionId !== input.connectionId ||
    connection.accountId !== demoIdentitySeedIds.accountId ||
    connection.providerKey !== "tcgplayer" || connection.environment !== "sandbox" ||
    connection.status !== "active" || connection.credentialReference !== null ||
    connection.bindings.length !== 1 || !connection.createdAt ||
    Date.parse(connection.createdAt) < Date.parse(input.createdAfter)
  ) throw new Error("owned-recovery-connection-required");
  const source = connectionEvents[1]!;
  const runId = `run-browser-recovery-${input.ownershipId}`;
  const channelListingId = `channel-listing-browser-recovery-${input.ownershipId}`;
  const runStreamId = `channels.tcgplayer-sync-run-${runId}`;
  const existing = await readCompleteStream(eventStore, { streamId: runStreamId });
  if (existing.length > 0) throw new Error("owned-recovery-run-collision");

  await services.outboundSync.enqueueDesiredState({
    connectionId: input.connectionId, channelListingId, listingId: input.listingId,
    operationKind: "publish", listingRevision: 1,
    desiredStateSequence: source.streamVersion, desiredStateHash: "7".repeat(64),
    payload: { kind: "draft", draft: {
      channelListingId, listingRevision: 1, title: "Synthetic owned recovery Listing",
      description: "Local browser recovery fixture", categoryKey: "synthetic-browser-recovery",
      conditionKey: "Near Mint", price: { amountMinor: 500, currency: "USD" }, quantity: 1, attributes: [],
    } },
    envelope: {
      sourceEventId: source.eventId, sourceStreamId: source.streamId,
      sourceStreamVersion: source.streamVersion, sourceGlobalPosition: source.globalPosition,
      sourceOccurredAt: source.occurredAt,
    },
  });

  await withPgTransaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runStreamId]);
    const current = await db.query("SELECT 1 FROM event_store_events WHERE stream_id=$1 LIMIT 1", [runStreamId]);
    if (current.rows.length !== 0) throw new Error("owned-recovery-run-collision");
    const reservation = await services.outboundSync.reserveClaimedOutboundOperationsInTransaction({
      registry: channelProviderRegistry, connectionId: input.connectionId,
      claimant: { claimantKind: "manual", claimantId: demoIdentitySeedIds.userId },
      maxOperations: 1, leaseMs: 1_800_000,
    }, db);
    if (
      !reservation || reservation.operations.length !== 1 ||
      reservation.operations[0]?.listingId !== input.listingId ||
      reservation.operations[0]?.channelListingId !== channelListingId
    ) throw new Error("owned-recovery-member-required");
    const run = recoveryRun(input, runId, reservation);
    await eventStore.appendToStreamInTransaction(db, {
      streamId: runStreamId, wakeSourceContextName: "channels", expectedVersion: "no_stream",
      context: browserRecoveryContext,
      events: [{ eventType: "channels.tcgplayer-sync-run.composed", payload: {
        run, csvHeader: ["TCGplayer Id", "Add to Quantity", "TCG Marketplace Price"],
      } }],
    });
    await db.query(
      `INSERT INTO channels_manual_sync_clamp_status
       (run_id,connection_id,account_id,run_revision,state,requested_listing_count,affected_listing_count,updated_at)
       VALUES ($1,$2,$3,0,'recovery',1,1,now())`,
      [runId, input.connectionId, demoIdentitySeedIds.accountId],
    );
  });
  return { connectionId: input.connectionId, runId, listingId: input.listingId };
}

function recoveryRun(input: BrowserRecoveryFixtureInput, runId: string, reservation: ClaimedOperationReservation): ChannelSyncRun {
  const operation = reservation.operations[0]!;
  const tuple = {
    policyKey: "channels.tcgplayer-manual-claim-lease" as const,
    value: { leaseMs: Date.parse(reservation.leaseExpiresAt) - Date.parse(reservation.reservedAt) },
    source: "fallback" as const, documentId: null, effectiveFrom: null, effectiveUntil: null,
    resolvedAt: reservation.reservedAt,
  };
  const basisSnapshotId = `snapshot-browser-recovery-${input.ownershipId}`;
  return {
    runId, revision: 0, sequence: 1, connectionId: input.connectionId, providerKey: "tcgplayer",
    reservationId: reservation.reservationId, claimant: reservation.claimant,
    leaseExpiresAt: reservation.leaseExpiresAt,
    manualClaimLeasePolicySnapshot: { ...tuple, digest: canonicalManualClaimLeasePolicySnapshotDigest(tuple) },
    state: "composed", basisSnapshotId, basisSnapshotGeneration: 1,
    verificationSnapshotId: null, verificationSnapshotGeneration: null,
    uploadAttemptedAt: null, uploadFileName: null, importSummary: null,
    createdAt: reservation.reservedAt, updatedAt: reservation.reservedAt,
    membershipCompleteness: { kind: "complete", total: 1 },
    members: [{
      operationId: operation.operationId, attemptId: operation.attemptId, claimGeneration: operation.claimGeneration,
      reservationId: reservation.reservationId, channelListingId: operation.channelListingId,
      listingId: operation.listingId, desiredStateSequence: operation.desiredStateSequence,
      listingRevision: operation.listingRevision, payloadDigest: operation.payloadDigest,
      ordinal: 0, memberKind: "composed", externalKey: `product:${input.ownershipId}`, conditionText: "Near Mint",
      basisSnapshotId, basisSnapshotGeneration: 1, basisTotalQuantity: 2, basisPriceAmountMinor: 500,
      targetQuantity: 1, targetPriceAmountMinor: 500,
      csvRow: { "TCGplayer Id": input.ownershipId, "Add to Quantity": "-1", "TCG Marketplace Price": "5.00" },
      refusalReason: null, mappingDimension: null, mappingSourceKey: null,
    }],
  };
}
