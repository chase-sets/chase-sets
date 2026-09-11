import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import { createChannelListingCompositionRuntime } from "../api/runtime";
import { createChannelCompositionProfileRegistry } from "../domain/canonical";
import { buildChannelOutboundOperationReactionHandlers } from "../../outbound-sync/integrations/listing-composition";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import { buildChannelConnectionProjectionHandlers } from "../../connections/read-model/projection";
import {
  buildChannelCatalogFactsProjectionHandlers,
  buildChannelConnectionFactsProjectionHandlers,
  buildChannelInventoryFactsProjectionHandlers,
  buildChannelMarketplaceFactsProjectionHandlers,
} from "../read-model/facts-projection";
import { buildChannelListingStateProjectionHandlers } from "../read-model/state-projection";
import { syntheticProfile } from "./test-support";
import { createConnectionHarness, testContext } from "../../connections/tests/test-support";
import { deriveClaimedOperationOutcomes } from "../../tcgplayer-csv/domain/lifecycle";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("channel-listing-desired-state-production-path", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "channel_desired_state_production");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("composes the landed Marketplace amount/currency pair once and advances on currency-only change", async () => {
    const marketplace = buildChannelMarketplaceFactsProjectionHandlers(pools.channels);
    const inventory = buildChannelInventoryFactsProjectionHandlers(pools.channels);
    const catalog = buildChannelCatalogFactsProjectionHandlers(pools.channels);
    const channels = {
      ...buildChannelConnectionFactsProjectionHandlers(pools.channels),
      ...buildChannelListingStateProjectionHandlers(pools.channels),
    };
    await marketplace["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "listing-production",
          accountId: "account-production",
          inventoryItemId: "item-production",
          catalogItemId: "catalog-production",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 10,
          selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
          itemTitle: "Production path card",
          itemSubtitle: null,
          productSummary: "Landed Marketplace pair",
          gradedCard: null,
        },
        "marketplace.listing-listing-production",
        1,
      ),
    );
    await marketplace["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "marketplace.listing-listing-production", 2),
    );
    await inventory["inventory.item.created"]!(
      event(
        "inventory.item.created",
        {
          itemId: "item-production",
          accountId: "account-production",
          catalogItemId: "catalog-production",
          totalQuantity: 4,
        },
        "inventory.item-item-production",
        1,
      ),
    );
    const catalogStream = "catalog.catalog-item-catalog-production";
    await catalog["catalog.catalog-item.category-assigned"]!(
      event("catalog.catalog-item.category-assigned", { categoryId: "cards" }, catalogStream, 1),
    );
    await catalog["catalog.catalog-item.external-product-reference-linked"]!(
      event(
        "catalog.catalog-item.external-product-reference-linked",
        {
          providerKey: "synthetic-provider",
          externalKey: "sku:production",
          selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        },
        catalogStream,
        2,
      ),
    );
    await catalog["catalog.catalog-item.external-catalog-item-reference-linked"]!(
      event(
        "catalog.catalog-item.external-catalog-item-reference-linked",
        { providerKey: "synthetic-provider", externalKey: "product:production" },
        catalogStream,
        3,
      ),
    );
    await channels["channels.connection.connected"]!(
      event(
        "channels.connection.connected",
        {
          connectionId: "connection-production",
          accountId: "account-production",
          providerKey: "synthetic-provider",
          environment: "sandbox",
        },
        "channels.connection-connection-production",
        1,
      ),
    );
    await channels["channels.connection.activated"]!(
      event(
        "channels.connection.activated",
        { connectionId: "connection-production" },
        "channels.connection-connection-production",
        2,
      ),
    );
    await channels["channels.channel-publication-configuration.settings-replaced"]!(
      event(
        "channels.channel-publication-configuration.settings-replaced",
        {
          connectionId: "connection-production",
          settings: {
            titlePrefix: "",
            titleSuffix: "",
            descriptionFooter: "",
            categoryAllowlist: ["cards"],
            excludedListingIds: [],
          },
        },
        "channels.channel-publication-configuration-connection-production",
        1,
      ),
    );
    await channels["channels.channel-publication-configuration.mapping-candidate-recorded"]!(
      event(
        "channels.channel-publication-configuration.mapping-candidate-recorded",
        {
          connectionId: "connection-production",
          provenance: "compose-discovered",
          candidates: [
            candidate("category", "catalog-category:cards", "trading-cards"),
            candidate("condition", "selected-option:condition:near-mint", "near-mint"),
          ],
        },
        "channels.channel-publication-configuration-connection-production",
        2,
      ),
    );
    for (const [version, dimension, sourceKey, targetKey] of [
      [3, "category", "catalog-category:cards", "trading-cards"],
      [4, "condition", "selected-option:condition:near-mint", "near-mint"],
    ] as const) {
      await channels["channels.channel-publication-configuration.mapping-review-decided"]!(
        event(
          "channels.channel-publication-configuration.mapping-review-decided",
          {
            connectionId: "connection-production",
            dimension,
            sourceKey,
            targetKey,
            confidenceTier: "manual",
            reviewStatus: "accepted",
            evidence: { listingId: "listing-production", derivedFrom: "production-path-fixture" },
          },
          "channels.channel-publication-configuration-connection-production",
          version,
        ),
      );
    }

    const connectionProjection = buildChannelConnectionProjectionHandlers(pools.channels);
    await connectionProjection["channels.connection.connected"]!(
      event(
        "channels.connection.connected",
        {
          connectionId: "connection-production",
          accountId: "account-production",
          providerKey: "tcgplayer",
          environment: "sandbox",
          createdAt: "2026-09-09T12:00:00.000Z",
        },
        "channels.connection-connection-production",
        1,
      ),
    );
    await connectionProjection["channels.connection.activated"]!(
      event(
        "channels.connection.activated",
        {
          connectionId: "connection-production",
          credentialReference: "credential-production",
          bindings: [{ storageLocationId: "location-production", revision: 1 }],
        },
        "channels.connection-connection-production",
        2,
      ),
    );

    const services = createChannelListingCompositionRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      profiles: createChannelCompositionProfileRegistry([syntheticProfile]),
    });
    const source = { connectionId: "connection-production", listingId: "listing-production" };
    const first = await services.recordChannelListingDesiredState(source, testContext);
    expect(first).toMatchObject({ kind: "applied", streamVersion: 1 });
    await projectLinkEvents(channels);
    const pending = await pools.channels.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM channels_channel_listing_links
       WHERE connection_id='connection-production' AND listing_id='listing-production' AND publish_state='pending'`,
    );
    expect(pending.rows[0]?.count).toBe("1");

    await marketplace["marketplace.listing.price-updated"]!(
      event(
        "marketplace.listing.price-updated",
        { priceAmount: "20.00", priceCurrencyCode: "EUR" },
        "marketplace.listing-listing-production",
        3,
      ),
    );
    await expect(services.recordChannelListingDesiredState(source, testContext)).resolves.toMatchObject({
      kind: "applied",
      streamVersion: 2,
    });
    const desired = await desiredEvents();
    expect(desired).toHaveLength(2);
    expect(desired.map((row) => row.payload.draft.price)).toEqual([
      { amountMinor: 2_000, currency: "USD" },
      { amountMinor: 2_000, currency: "EUR" },
    ]);
    expect(desired[0]!.payload.desiredStateHash).not.toBe(desired[1]!.payload.desiredStateHash);

    const rootServices = channelsModule.createServices(pools.channels, {});
    const outboundReaction = buildChannelOutboundOperationReactionHandlers(rootServices.outboundSync);
    const sourceEvent = await pools.channels.query<{
      event_id: string;
      stream_id: string;
      stream_version: number;
      global_position: string;
      occurred_at: string | Date;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_id,stream_id,stream_version,global_position::text,occurred_at,payload
       FROM event_store_events
       WHERE event_type='channels.channel-listing.desired-state-changed'
       ORDER BY stream_version LIMIT 1`,
    );
    const origin = sourceEvent.rows[0]!;
    await outboundReaction["channels.channel-listing.desired-state-changed"]!(
      buildTransportEvent("channels.channel-listing.desired-state-changed", origin.payload, {
        id: origin.event_id,
        streamId: origin.stream_id,
        streamVersion: Number(origin.stream_version),
        globalPosition: origin.global_position,
        timing: {
          occurredAt: new Date(origin.occurred_at).toISOString(),
          recordedAt: new Date(origin.occurred_at).toISOString(),
        },
      }),
    );
    const queued = await pools.channels.query<{
      operation_kind: string;
      source_event_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT operation_kind,source_event_id,payload FROM channel_outbound_operations
       WHERE source_event_id=$1`,
      [origin.event_id],
    );
    expect(queued.rows).toEqual([
      expect.objectContaining({ operation_kind: "publish", source_event_id: origin.event_id }),
    ]);
    const reservation = await rootServices.outboundSync.reserveClaimedOutboundOperations({
      registry: channelProviderRegistry,
      connectionId: "connection-production",
      claimant: { claimantKind: "connector", claimantId: "producer-boundary-proof" },
      maxOperations: 1,
      leaseMs: 60_000,
    });
    expect(reservation?.operations).toHaveLength(1);
    const operation = reservation!.operations[0]!;
    const report = {
      reservationId: reservation!.reservationId,
      claimant: reservation!.claimant,
      outcomes: [
        {
          operationId: operation.operationId,
          attemptId: operation.attemptId,
          claimGeneration: operation.claimGeneration,
          desiredStateSequence: operation.desiredStateSequence,
          outcome: {
            kind: "applied",
            result: { kind: "succeeded", externalListingId: "tcgplayer:production-boundary" },
          },
        },
      ],
    } as const;
    await rootServices.outboundSync.reportClaimedOperationOutcomes(report);
    await expect(rootServices.outboundSync.reportClaimedOperationOutcomes(report)).resolves.toBeUndefined();
    await expect(
      rootServices.outboundSync.reportClaimedOperationOutcomes({
        ...report,
        outcomes: [{ ...report.outcomes[0], desiredStateSequence: 99 }],
      }),
    ).rejects.toMatchObject({ code: "reservation-membership-mismatch" });
    expect(
      await pools.channels.query(
        `SELECT event_type FROM event_store_events
         WHERE stream_id=$1 AND event_type='channels.channel-listing.publication-recorded'`,
        [origin.stream_id],
      ),
    ).toMatchObject({ rows: [{ event_type: "channels.channel-listing.publication-recorded" }] });
    await expect(
      outboundReaction["channels.channel-listing.desired-state-changed"]!(
        buildTransportEvent(
          "channels.channel-listing.desired-state-changed",
          {
            ...origin.payload,
            intent: "delist",
            delist: {
              channelListingId: origin.payload.channelListingId,
              listingRevision: origin.payload.listingRevision,
              lastPublishedQuantity: 1,
              delistReasons: ["sold-out"],
            },
          },
          {
            id: "invalid-delist-event",
            streamId: origin.stream_id,
            streamVersion: origin.stream_version,
            globalPosition: origin.global_position,
          },
        ),
      ),
    ).rejects.toThrow();
    expect(
      await pools.channels.query(
        "SELECT 1 FROM channel_outbound_operations WHERE source_event_id='invalid-delist-event'",
      ),
    ).toMatchObject({ rows: [] });

    await marketplace["marketplace.listing.price-updated"]!(
      event(
        "marketplace.listing.price-updated",
        { priceAmount: "20.00", priceCurrencyCode: "EUR" },
        "marketplace.listing-listing-production",
        3,
      ),
    );
    await expect(services.recordChannelListingDesiredState(source, testContext)).resolves.toMatchObject({
      kind: "unchanged",
      streamVersion: 2,
    });
    expect(await desiredEvents()).toHaveLength(2);

    await marketplace["marketplace.listing.price-updated"]!(
      event("marketplace.listing.price-updated", { priceAmount: "21.00" }, "marketplace.listing-listing-production", 4),
    );
    await expect(services.recordChannelListingDesiredState(source, testContext)).resolves.toMatchObject({
      kind: "applied",
      streamVersion: 3,
    });
    const final = await pools.channels.query<{ event_type: string; payload: { reasons: readonly string[] } }>(
      `SELECT event_type,payload FROM event_store_events
       WHERE stream_id LIKE 'channels.channel-listing-cl_%' ORDER BY stream_version DESC LIMIT 1`,
    );
    expect(final.rows[0]).toMatchObject({
      event_type: "channels.channel-listing.publication-blocked",
      payload: { reasons: ["missing-price"] },
    });
  });
  it("drives the canonical TCGplayer connection aggregate through both projections, reservation settlement, replay, and malformed delist", async () => {
    const connectionId = "connection-boundary";
    const accountId = "account-boundary";
    const policyAuthority = createConnectionHarness().ports.policyAuthority;
    if (!policyAuthority) throw new Error("The canonical policy authority fixture is unavailable.");
    const rootServices = channelsModule.createServices(pools.channels, {
      clock: { now: () => "2026-09-09T12:00:00.000Z" },
      policyAuthority,
      storageLocationAuthority: {
        resolve: async ({ storageLocationId }) => ({ accountId, storageLocationId, revision: 1, status: "active" }),
      },
    });
    await expect(
      rootServices.connections.connectChannel(
        { connectionId, accountId, providerKey: "tcgplayer" },
        { deploymentEnvironment: "local" },
        testContext,
      ),
    ).resolves.toMatchObject({ state: { providerKey: "tcgplayer", environment: "sandbox" } });
    await expect(
      rootServices.connections.activateChannelConnection(
        {
          accountId,
          connectionId,
          credentialReference: null,
          bindings: [{ storageLocationId: "location-boundary", revision: 1 }],
        },
        testContext,
      ),
    ).resolves.toMatchObject({ state: { status: "active" } });
    await projectConnectionEvents(connectionId);
    expect(
      await pools.channels.query(
        `SELECT connection_id,account_id,provider_key,environment,status FROM channel_connections WHERE connection_id=$1
         UNION ALL
         SELECT connection_id,account_id,provider_key,environment,status FROM channels_connection_facts WHERE connection_id=$1`,
        [connectionId],
      ),
    ).toMatchObject({
      rows: [
        {
          connection_id: connectionId,
          account_id: accountId,
          provider_key: "tcgplayer",
          environment: "sandbox",
          status: "active",
        },
        {
          connection_id: connectionId,
          account_id: accountId,
          provider_key: "tcgplayer",
          environment: "sandbox",
          status: "active",
        },
      ],
    });
    expect(
      await pools.channels.query(
        "SELECT DISTINCT tenant_id,for_account_id FROM event_store_events WHERE stream_id=$1",
        [`channels.connection-${connectionId}`],
      ),
    ).toMatchObject({ rows: [{ tenant_id: "tnt_channels", for_account_id: "acc_owner" }] });

    const marketplace = buildChannelMarketplaceFactsProjectionHandlers(pools.channels);
    const inventory = buildChannelInventoryFactsProjectionHandlers(pools.channels);
    const catalog = buildChannelCatalogFactsProjectionHandlers(pools.channels);
    const channels = {
      ...buildChannelConnectionFactsProjectionHandlers(pools.channels),
      ...buildChannelListingStateProjectionHandlers(pools.channels),
    };
    await marketplace["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "listing-boundary",
          accountId,
          inventoryItemId: "item-boundary",
          catalogItemId: "catalog-boundary",
          priceAmount: "0.27",
          priceCurrencyCode: "USD",
          quantityCap: 10,
          selectedOptions: [],
          itemTitle: "Synthetic boundary card",
          itemSubtitle: null,
          productSummary: "Synthetic boundary proof",
          gradedCard: null,
        },
        "marketplace.listing-listing-boundary",
        1,
      ),
    );
    await marketplace["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "marketplace.listing-listing-boundary", 2),
    );
    await inventory["inventory.item.created"]!(
      event(
        "inventory.item.created",
        { itemId: "item-boundary", accountId, catalogItemId: "catalog-boundary", totalQuantity: 1 },
        "inventory.item-item-boundary",
        1,
      ),
    );
    await catalog["catalog.catalog-item.category-assigned"]!(
      event(
        "catalog.catalog-item.category-assigned",
        { categoryId: "cards" },
        "catalog.catalog-item-catalog-boundary",
        1,
      ),
    );
    await catalog["catalog.catalog-item.external-catalog-item-reference-linked"]!(
      event(
        "catalog.catalog-item.external-catalog-item-reference-linked",
        { providerKey: "tcgplayer", externalKey: "product:90000801" },
        "catalog.catalog-item-catalog-boundary",
        2,
      ),
    );
    await channels["channels.channel-publication-configuration.settings-replaced"]!(
      event(
        "channels.channel-publication-configuration.settings-replaced",
        {
          connectionId,
          settings: {
            titlePrefix: "",
            titleSuffix: "",
            descriptionFooter: "",
            categoryAllowlist: ["cards"],
            excludedListingIds: [],
          },
        },
        `channels.channel-publication-configuration-${connectionId}`,
        1,
      ),
    );
    await expect(
      rootServices.listingComposition.recordChannelListingDesiredState(
        { connectionId, listingId: "listing-boundary" },
        testContext,
      ),
    ).resolves.toMatchObject({ kind: "applied", streamVersion: 1 });
    await projectLinkEvents(channels);
    const origin = await readDesiredStateOrigin("listing-boundary");
    const outboundReaction = buildChannelOutboundOperationReactionHandlers(rootServices.outboundSync);
    await outboundReaction["channels.channel-listing.desired-state-changed"]!(transport(origin));
    expect(
      await pools.channels.query(
        "SELECT operation_kind,source_event_id FROM channel_outbound_operations WHERE source_event_id=$1",
        [origin.event_id],
      ),
    ).toMatchObject({ rows: [{ operation_kind: "publish", source_event_id: origin.event_id }] });

    const stagedHeader = "TCGplayer Id,Total Quantity,Add to Quantity,TCG Marketplace Price";
    await rootServices.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId: "snapshot-boundary-basis",
      connectionId,
      surface: "staged",
      csv: `${stagedHeader}\n90000801,2,0,0.2600`,
      limits: { maxRecords: 1 },
      ingestedAt: "2026-09-09T12:01:00Z",
      capturedAt: "2026-09-09T12:01:00Z",
      capturedAtSource: "operator-declared",
    });
    const composed = await rootServices.tcgplayerCsv.composeTcgplayerSyncRun(
      {
        runId: "run-boundary",
        connectionId,
        claimant: { claimantKind: "connector", claimantId: "connector-boundary" },
        leaseMs: 60_000,
        manualClaimLeasePolicySnapshot: null,
        resolvedPolicy: { maxRowsPerBatch: 500 },
        composedAt: "2026-09-09T12:02:00Z",
      },
      testContext,
    );
    const claimed = await rootServices.tcgplayerCsv.claimRun(
      { runId: composed!.run.runId, expectedRevision: composed!.run.revision },
      testContext,
    );
    const awaiting = await rootServices.tcgplayerCsv.recordUploadAttempt(
      {
        runId: claimed.runId,
        expectedRevision: claimed.revision,
        uploadAttemptedAt: "2026-09-09T12:02:30Z",
        fileName: "boundary.csv",
      },
      testContext,
    );
    await rootServices.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId: "snapshot-boundary-proof",
      connectionId,
      surface: "staged",
      csv: `${stagedHeader}\n90000801,1,0,0.2700`,
      limits: { maxRecords: 1 },
      ingestedAt: "2026-09-09T12:03:00Z",
      capturedAt: "2026-09-09T12:03:00Z",
      capturedAtSource: "operator-declared",
    });
    const summary = {
      fileName: "boundary.csv",
      dateImportedText: "9/9/2026 12:03 PM",
      numberOfProducts: 1,
      recordedAt: "2026-09-09T12:03:30Z",
    };
    const applied = await rootServices.tcgplayerCsv.verifyRun(
      {
        runId: awaiting.runId,
        expectedRevision: awaiting.revision,
        verificationSnapshotId: "snapshot-boundary-proof",
        importSummary: summary,
      },
      testContext,
    );
    expect(applied.state).toBe("applied");
    const replay = {
      reservationId: applied.reservationId,
      claimant: applied.claimant,
      outcomes: deriveClaimedOperationOutcomes(applied),
      runSettlement: {
        runId: applied.runId,
        expectedRunRevision: awaiting.revision,
        fromState: "awaiting-verification" as const,
        toState: "applied" as const,
        verificationSnapshotId: "snapshot-boundary-proof",
        verificationSnapshotGeneration: 2,
        uploadAttemptedAt: null,
        uploadFileName: null,
        importSummary: summary,
        context: testContext,
      },
    };
    await expect(rootServices.outboundSync.reportClaimedOperationOutcomes(replay)).resolves.toBeUndefined();
    await expect(
      rootServices.outboundSync.reportClaimedOperationOutcomes({
        ...replay,
        outcomes: [{ ...replay.outcomes[0]!, desiredStateSequence: 99 }],
      }),
    ).rejects.toMatchObject({ code: "reservation-membership-mismatch" });
    await expect(
      outboundReaction["channels.channel-listing.desired-state-changed"]!(
        buildTransportEvent(
          "channels.channel-listing.desired-state-changed",
          {
            ...origin.payload,
            intent: "delist",
            delist: {
              channelListingId: origin.payload.channelListingId,
              listingRevision: origin.payload.listingRevision,
              lastPublishedQuantity: 1,
              delistReasons: ["sold-out"],
            },
          },
          { id: "invalid-boundary-delist", streamId: origin.stream_id, streamVersion: 1, globalPosition: "999" },
        ),
      ),
    ).rejects.toThrow();
    expect(
      await pools.channels.query(
        "SELECT 1 FROM channel_outbound_operations WHERE source_event_id='invalid-boundary-delist'",
      ),
    ).toMatchObject({ rows: [] });
  });

});

function candidate(dimension: string, sourceKey: string, proposedTargetKey: string) {
  return {
    dimension,
    sourceKey,
    proposedTargetKey,
    confidenceTier: "high",
    evidence: { listingId: "listing-production", derivedFrom: "production-path-fixture" },
  };
}

function event(type: string, data: Record<string, unknown>, streamId: string, streamVersion: number) {
  return buildTransportEvent(type, data, { streamId, streamVersion, globalPosition: `${streamId}:${streamVersion}` });
}

type StoredOrigin = Readonly<{
  event_id: string;
  event_type: string;
  stream_id: string;
  stream_version: number | string;
  global_position: string;
  occurred_at: string | Date;
  recorded_at: string | Date;
  payload: Record<string, unknown>;
}>;

async function projectConnectionEvents(connectionId: string): Promise<void> {
  const canonical = buildChannelConnectionProjectionHandlers(pools.channels);
  const facts = buildChannelConnectionFactsProjectionHandlers(pools.channels);
  const rows = await pools.channels.query<StoredOrigin>(
    `SELECT event_id,event_type,stream_id,stream_version,global_position::text,occurred_at,recorded_at,payload
     FROM event_store_events WHERE stream_id=$1 ORDER BY stream_version`,
    [`channels.connection-${connectionId}`],
  );
  for (const row of rows.rows) {
    const projected = transport(row);
    await canonical[row.event_type]!(projected);
    await facts[row.event_type]!(projected);
  }
}

async function readDesiredStateOrigin(listingId: string): Promise<StoredOrigin> {
  const result = await pools.channels.query<StoredOrigin>(
    `SELECT event_id,event_type,stream_id,stream_version,global_position::text,occurred_at,recorded_at,payload
     FROM event_store_events
     WHERE event_type='channels.channel-listing.desired-state-changed' AND payload->>'listingId'=$1`,
    [listingId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Desired-state origin was unavailable.");
  return row;
}

function transport(origin: StoredOrigin) {
  return buildTransportEvent(origin.event_type, origin.payload, {
    id: origin.event_id,
    streamId: origin.stream_id,
    streamVersion: Number(origin.stream_version),
    globalPosition: origin.global_position,
    timing: {
      occurredAt: new Date(origin.occurred_at).toISOString(),
      recordedAt: new Date(origin.recorded_at).toISOString(),
    },
  });
}

async function projectLinkEvents(
  handlers: ReturnType<typeof buildChannelListingStateProjectionHandlers>,
): Promise<void> {
  const rows = await pools.channels.query<{
    event_type: string;
    payload: Record<string, unknown>;
    stream_id: string;
    stream_version: number;
    global_position: string;
  }>(
    `SELECT event_type,payload,stream_id,stream_version,global_position::text
     FROM event_store_events WHERE stream_id LIKE 'channels.channel-listing-cl_%' ORDER BY stream_version`,
  );
  for (const row of rows.rows) {
    await handlers[row.event_type]!(
      buildTransportEvent(row.event_type, row.payload, {
        streamId: row.stream_id,
        streamVersion: Number(row.stream_version),
        globalPosition: row.global_position,
      }),
    );
  }
}

async function desiredEvents() {
  const rows = await pools.channels.query<{
    payload: Readonly<{
      desiredStateHash: string;
      draft: Readonly<{ price: Readonly<{ amountMinor: number; currency: string }> }>;
    }>;
  }>(
    `SELECT payload FROM event_store_events
     WHERE stream_id LIKE 'channels.channel-listing-cl_%'
       AND event_type='channels.channel-listing.desired-state-changed' ORDER BY stream_version`,
  );
  return rows.rows;
}
