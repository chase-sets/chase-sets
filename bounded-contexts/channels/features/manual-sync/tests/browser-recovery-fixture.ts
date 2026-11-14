import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPostgresEventStore, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { runInProjectionDbContext } from "@chase-sets/bounded-context-runtime";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import type { MarketplaceListingServices } from "@chase-sets/marketplace/server";
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
  inventoryItemId: string;
  createdAfter: string;
}>;

export function assertBrowserRecoveryFixtureInput(input: unknown): asserts input is BrowserRecoveryFixtureInput {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "connectionId,createdAfter,inventoryItemId,listingId,ownershipId"
  )
    throw new Error("owned-recovery-input-required");
  const value = input as Record<string, unknown>;
  if (
    typeof value.ownershipId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.ownershipId) ||
    !["connectionId", "listingId", "inventoryItemId"].every(
      (key, index) =>
        typeof value[key] === "string" &&
        (value[key] as string).length <= 160 &&
        new RegExp(`^${["chn", "lst", "itm"][index]}_[a-zA-Z0-9_-]+$`).test(value[key] as string),
    ) ||
    typeof value.createdAfter !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAfter) ||
    !Number.isFinite(Date.parse(value.createdAfter)) ||
    new Date(value.createdAfter).toISOString() !== value.createdAfter ||
    value.connectionId === manualSyncScenarioSeed.connectionId ||
    value.listingId === manualSyncScenarioSeed.listingId
  )
    throw new Error("owned-recovery-input-required");
}

export const browserRecoveryContext: EventStoreContext = {
  tenantId: "tnt_seed" as never,
  audit: { performedByUserId: demoIdentitySeedIds.userId, forAccountId: demoIdentitySeedIds.accountId },
};

// Native connection activation and Listing creation are prerequisites, never fixture privileges.
export async function createBrowserRecoveryFixture(
  pool: PgTransactionalPool,
  services: Pick<ChannelsServices, "outboundSync">,
  marketplace: Readonly<{
    pool: PgTransactionalPool;
    listings: Pick<MarketplaceListingServices, "loadListingState">;
  }>,
  input: BrowserRecoveryFixtureInput,
): Promise<Readonly<{ connectionId: string; runId: string; listingId: string }>> {
  assertBrowserRecoveryFixtureInput(input);
  const marketplaceEvents = createPostgresEventStore({ pool: marketplace.pool });
  const listingEvents = await readCompleteStream(marketplaceEvents, {
    streamId: `marketplace.listing-${input.listingId}`,
  });
  const listing = await marketplace.listings.loadListingState(input.listingId);
  const created = listingEvents[0];
  if (
    created?.eventType !== "marketplace.listing.created" ||
    created.payload.accountId !== demoIdentitySeedIds.accountId ||
    created.payload.inventoryItemId !== input.inventoryItemId ||
    Date.parse(created.occurredAt) < Date.parse(input.createdAfter) ||
    listing.listingId !== input.listingId ||
    listing.accountId !== demoIdentitySeedIds.accountId ||
    listing.inventoryItemId !== input.inventoryItemId ||
    listing.status !== "active"
  )
    throw new Error("owned-recovery-listing-required");
  // A new run is not ownership: refuse sibling Listings sharing the clamp's Inventory Item scope.
  const capacity = await readCompleteStream(marketplaceEvents, {
    streamId: `marketplace.inventory-listing-capacity-${input.inventoryItemId}`,
    maxEvents: 100,
  });
  const registered = new Set<string>();
  for (const event of capacity) {
    if (event.payload.inventoryItemId !== input.inventoryItemId) throw new Error("owned-recovery-listing-collision");
    if (
      event.eventType === "marketplace.inventory-listings.registered" &&
      Array.isArray(event.payload.listingIds) &&
      event.payload.listingIds.every((id) => typeof id === "string")
    ) {
      for (const id of event.payload.listingIds) registered.add(id);
    } else if (
      event.eventType === "marketplace.inventory-listing-capacity.committed" &&
      typeof event.payload.listingId === "string"
    )
      registered.add(event.payload.listingId);
    else throw new Error("owned-recovery-listing-collision");
  }
  if (registered.size !== 1 || !registered.has(input.listingId)) throw new Error("owned-recovery-listing-collision");
  const eventStore = createPostgresEventStore({ pool });
  const connectionEvents = await readCompleteStream(eventStore, {
    streamId: `channels.connection-${input.connectionId}`,
  });
  const connection = connectionEvents
    .map((event) => channelConnectionEventCodec.decode({ eventType: event.eventType, payload: event.payload }))
    .reduce(evolveChannelConnection, initialChannelConnectionState);
  if (
    connectionEvents.length !== 2 ||
    connection.connectionId !== input.connectionId ||
    connection.accountId !== demoIdentitySeedIds.accountId ||
    connection.providerKey !== "tcgplayer" ||
    connection.environment !== "sandbox" ||
    connection.status !== "active" ||
    connection.credentialReference !== null ||
    connection.bindings.length !== 1 ||
    !connection.createdAt ||
    Date.parse(connection.createdAt) < Date.parse(input.createdAfter)
  )
    throw new Error("owned-recovery-connection-required");
  const source = connectionEvents[1]!;
  const runId = `run-browser-recovery-${input.ownershipId}`;
  const channelListingId = `channel-listing-browser-recovery-${input.ownershipId}`;
  const runStreamId = `channels.tcgplayer-sync-run-${runId}`;
  const existing = await readCompleteStream(eventStore, { streamId: runStreamId });
  if (existing.length > 0) throw new Error("owned-recovery-run-collision");

  await services.outboundSync.enqueueDesiredState({
    connectionId: input.connectionId,
    channelListingId,
    listingId: input.listingId,
    operationKind: "publish",
    listingRevision: 1,
    desiredStateSequence: source.streamVersion,
    desiredStateHash: "7".repeat(64),
    payload: {
      kind: "draft",
      draft: {
        channelListingId,
        listingRevision: 1,
        title: "synthetic-owned-recovery-listing",
        description: "",
        categoryKey: "synthetic-browser-recovery",
        conditionKey: "Near Mint",
        price: { amountMinor: 500, currency: "USD" },
        quantity: 1,
        attributes: [],
      },
    },
    envelope: {
      sourceEventId: source.eventId,
      sourceStreamId: source.streamId,
      sourceStreamVersion: source.streamVersion,
      sourceGlobalPosition: source.globalPosition,
      sourceOccurredAt: source.occurredAt,
    },
  });

  await withPgTransaction(pool, (db) =>
    runInProjectionDbContext(db, async () => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runStreamId]);
      const current = await db.query("SELECT 1 FROM event_store_events WHERE stream_id=$1 LIMIT 1", [runStreamId]);
      if (current.rows.length !== 0) throw new Error("owned-recovery-run-collision");
      const reservation = await services.outboundSync.reserveClaimedOutboundOperationsInTransaction(
        {
          registry: channelProviderRegistry,
          connectionId: input.connectionId,
          claimant: { claimantKind: "manual", claimantId: demoIdentitySeedIds.userId },
          maxOperations: 1,
          leaseMs: 1_800_000,
        },
        db,
      );
      if (
        !reservation ||
        reservation.operations.length !== 1 ||
        reservation.operations[0]?.listingId !== input.listingId ||
        reservation.operations[0]?.channelListingId !== channelListingId
      )
        throw new Error("owned-recovery-member-required");
      const run = recoveryRun(input, runId, reservation);
      await eventStore.appendToStreamInTransaction(db, {
        streamId: runStreamId,
        wakeSourceContextName: "channels",
        expectedVersion: "no_stream",
        context: browserRecoveryContext,
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
       VALUES ($1,$2,$3,0,'recovery',1,1,now())`,
        [runId, input.connectionId, demoIdentitySeedIds.accountId],
      );
    }),
  );
  return { connectionId: input.connectionId, runId, listingId: input.listingId };
}

function recoveryRun(
  input: BrowserRecoveryFixtureInput,
  runId: string,
  reservation: ClaimedOperationReservation,
): ChannelSyncRun {
  const operation = reservation.operations[0]!;
  const tuple = {
    policyKey: "channels.tcgplayer-manual-claim-lease" as const,
    value: { leaseMs: Date.parse(reservation.leaseExpiresAt) - Date.parse(reservation.reservedAt) },
    source: "fallback" as const,
    documentId: null,
    effectiveFrom: null,
    effectiveUntil: null,
    resolvedAt: reservation.reservedAt,
  };
  const basisSnapshotId = `snapshot-browser-recovery-${input.ownershipId}`;
  return {
    runId,
    revision: 0,
    sequence: 1,
    connectionId: input.connectionId,
    providerKey: "tcgplayer",
    reservationId: reservation.reservationId,
    claimant: reservation.claimant,
    leaseExpiresAt: reservation.leaseExpiresAt,
    manualClaimLeasePolicySnapshot: { ...tuple, digest: canonicalManualClaimLeasePolicySnapshotDigest(tuple) },
    state: "composed",
    basisSnapshotId,
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
        externalKey: `product:${input.ownershipId}`,
        conditionText: "Near Mint",
        basisSnapshotId,
        basisSnapshotGeneration: 1,
        basisTotalQuantity: 2,
        basisPriceAmountMinor: 500,
        targetQuantity: 1,
        targetPriceAmountMinor: 500,
        csvRow: { "TCGplayer Id": input.ownershipId, "Add to Quantity": "-1", "TCG Marketplace Price": "5.00" },
        refusalReason: null,
        mappingDimension: null,
        mappingSourceKey: null,
      },
    ],
  };
}
