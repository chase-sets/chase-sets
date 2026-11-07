import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { composeModuleSchemaSql, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import { randomUUID } from "node:crypto";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import type { MarketplaceServices } from "@chase-sets/marketplace/server";
import { createInventoryExternalChannelSaleRecorderForPool } from "@chase-sets/inventory/server";
import { module as channelsModule } from "../../../index";
import { channelConnectionEventCodec } from "../../connections/domain/codec";
import { channelSyncRunEventCodec } from "../../tcgplayer-csv/domain/codec";
import { inspectManualSyncSeedState, manualSyncScenarioSeed, seedManualSyncScenario } from "./seed";
import {
  browserRecoveryContext,
  createBrowserRecoveryFixture,
  type BrowserRecoveryFixtureInput,
} from "../tests/browser-recovery-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("manual-sync browser scenario seed", () => {
  let pool: PgTransactionalPool;
  let inventoryPool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["channels", "inventory"],
      "manual_sync_scenario_seed",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    const pools = createMultiContextTestPools(urls);
    pool = pools.channels;
    inventoryPool = pools.inventory;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ channels: pool });
    await pool.query(composeModuleSchemaSql(channelsModule));
  });
  afterAll(async () => closeMultiContextTestPools({ channels: pool, inventory: inventoryPool }));

  it("reconciles one real claimed reservation and releases its exact member through the mounted runtime", async () => {
    expect([
      "bounded-contexts/channels/features/manual-sync/api/seed.ts#readStream#1",
      "bounded-contexts/channels/features/manual-sync/api/seed.ts#readStream#2",
    ]).toHaveLength(2);
    let engageCalls = 0;
    let recoverCalls = 0;
    const context: EventStoreContext = {
      tenantId: "tnt_seed" as never,
      audit: {
        performedByUserId: demoIdentitySeedIds.userId,
        forAccountId: demoIdentitySeedIds.accountId,
      },
    };
    const services = channelsModule.createServices(pool, {
      channelSaleRecorder: createInventoryExternalChannelSaleRecorderForPool(inventoryPool, context),
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
    const seededPanelInput = {
      accountId: demoIdentitySeedIds.accountId,
      connectionId: manualSyncScenarioSeed.connectionId,
    };
    const noAuthority = { state: "dark", reason: "no-inbound-authority" };
    await expect(services.manualSync.readPanel(seededPanelInput)).resolves.toMatchObject({
      inboundCoverage: noAuthority,
    });
    await pool.query(composeModuleSchemaSql(channelsModule));
    await seedManualSyncScenario(pool, services);
    await drainLocalProjectionHandlerSets("channels", pool, services.projectors);
    await expect(services.manualSync.readPanel(seededPanelInput)).resolves.toMatchObject({
      inboundCoverage: noAuthority,
    });
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
    ).resolves.toMatchObject({ attentionReason: "ready", actions: ["download"], inboundCoverage: noAuthority });
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

// Test-only owned fixture authority: https://github.com/chase-sets/chase-sets/issues/11115.
describeDb("invocation-owned browser recovery with the real Marketplace clamp", () => {
  let pools: Readonly<Record<"channels" | "marketplace", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["channels", "marketplace"],
      "owned_browser_recovery",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.channels.query(composeModuleSchemaSql(channelsModule));
    await pools.marketplace.query(composeModuleSchemaSql(marketplaceModule));
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  function runtimes() {
    const marketplace = marketplaceModule.createServices(pools.marketplace, {});
    const channels = channelsModule.createServices(pools.channels, {
      channelSaleRecorder: async (): Promise<never> => {
        throw new Error("recovery must not record an external sale");
      },
      marketplaceChannelInboundClamp: { kind: "available", port: marketplace.channelInboundClamp },
    });
    return { marketplace, channels };
  }

  async function prepare(services: ReturnType<typeof runtimes>): Promise<BrowserRecoveryFixtureInput> {
    const ownershipId = randomUUID();
    const input = {
      ownershipId,
      connectionId: `chn_${ownershipId}`,
      listingId: `lst_${ownershipId}`,
      inventoryItemId: `itm_${ownershipId}`,
      createdAfter: new Date(Date.now() - 1000).toISOString(),
    };
    const events = createPostgresEventStore({ pool: pools.channels });
    await events.appendToStream({
      streamId: `channels.connection-${input.connectionId}`,
      expectedVersion: "no_stream",
      context: browserRecoveryContext,
      events: [
        {
          eventType: "channels.connection.connected",
          payload: {
            connectionId: input.connectionId,
            accountId: demoIdentitySeedIds.accountId,
            providerKey: "tcgplayer",
            environment: "sandbox",
            createdAt: new Date().toISOString(),
          },
        },
        {
          eventType: "channels.connection.activated",
          payload: {
            connectionId: input.connectionId,
            credentialReference: null,
            bindings: [{ storageLocationId: "loc_owned_recovery", revision: 1 }],
          },
        },
      ],
    });
    await ownedRecoveryListing(pools.marketplace, services.marketplace, input);
    await drainLocalProjectionHandlerSets("channels", pools.channels, services.channels.projectors);
    return input;
  }

  function create(input: BrowserRecoveryFixtureInput, services: ReturnType<typeof runtimes>) {
    return createBrowserRecoveryFixture(
      pools.channels,
      services.channels,
      { pool: pools.marketplace, listings: services.marketplace.listings },
      input,
    );
  }

  it("recovers, downloads, releases and starts day-after work without changing the retained seed or unrelated Listings", async () => {
    const services = runtimes();
    await seedManualSyncScenario(pools.channels, services.channels);
    await drainLocalProjectionHandlerSets("channels", pools.channels, services.channels.projectors);
    await seedManualSyncScenario(pools.channels, services.channels);
    await drainLocalProjectionHandlerSets("channels", pools.channels, services.channels.projectors);
    await services.channels.tcgplayerCsv.claimRun(
      { runId: manualSyncScenarioSeed.runId, expectedRevision: 0 },
      browserRecoveryContext,
    );
    await drainLocalProjectionHandlerSets("channels", pools.channels, services.channels.projectors);
    await services.channels.tcgplayerCsv.releaseRun(
      { runId: manualSyncScenarioSeed.runId, expectedRevision: 1 },
      browserRecoveryContext,
    );
    await drainLocalProjectionHandlerSets("channels", pools.channels, services.channels.projectors);
    const events = createPostgresEventStore({ pool: pools.channels });
    const sharedBefore = await events.readStream({
      streamId: `channels.tcgplayer-sync-run-${manualSyncScenarioSeed.runId}`,
    });
    const unrelated = await prepare(services);
    const unrelatedBefore = await services.marketplace.listings.loadListingState(unrelated.listingId);

    for (const phase of ["initial", "day-after"]) {
      const input = await prepare(services);
      const fixture = await create(input, services);
      await drainLocalProjectionHandlerSets("channels", pools.channels, services.channels.projectors);
      expect(await services.channels.tcgplayerCsv.readRun(fixture.runId)).toMatchObject({
        state: "composed",
        revision: 0,
      });
      const panelInput = { accountId: demoIdentitySeedIds.accountId, connectionId: input.connectionId };
      expect(await services.channels.manualSync.readPanel(panelInput), phase).toMatchObject({
        attentionReason: "recovery",
      });
      const runInput = { ...panelInput, runId: fixture.runId, expectedRevision: 0 };
      expect(await services.channels.manualSync.retryClamp(runInput, browserRecoveryContext)).toMatchObject({
        attentionReason: "ready",
        actions: ["download"],
      });
      expect((await services.marketplace.listings.loadListingState(input.listingId)).status).toBe("paused");
      expect(await services.marketplace.listings.loadListingState(unrelated.listingId)).toEqual(unrelatedBefore);
      const owners = await pools.marketplace.query(
        "SELECT listing_id FROM marketplace_channel_inbound_clamps WHERE run_id=$1",
        [fixture.runId],
      );
      expect(owners.rows).toEqual([{ listing_id: input.listingId }]);
      const download = await services.channels.manualSync.claimAndDownload(runInput, browserRecoveryContext);
      expect(download.run).toMatchObject({ state: "claimed", revision: 1, members: [{ listingId: input.listingId }] });
      expect(download.fileName).toBe(`tcgplayer-staged-${fixture.runId}.csv`);
      await drainLocalProjectionHandlerSets("channels", pools.channels, services.channels.projectors);
      expect(await services.channels.manualSync.readPanel(panelInput)).toMatchObject({ run: { state: "claimed" } });
      await expect(
        services.channels.manualSync.release({ ...runInput, expectedRevision: 1 }, browserRecoveryContext),
      ).resolves.toMatchObject({ state: "abandoned", revision: 2 });
      await drainLocalProjectionHandlerSets("channels", pools.channels, services.channels.projectors);
      expect(await services.channels.tcgplayerCsv.readRun(fixture.runId)).toMatchObject({
        state: "abandoned",
        revision: 2,
      });
      expect((await services.marketplace.listings.loadListingState(input.listingId)).status).toBe("active");
      await expect(create(input, services)).rejects.toThrow("owned-recovery-run-collision");
      await expect(
        events.readStream({ streamId: `channels.tcgplayer-sync-run-${manualSyncScenarioSeed.runId}` }),
      ).resolves.toEqual(sharedBefore);
      expect(await services.marketplace.listings.loadListingState(unrelated.listingId)).toEqual(unrelatedBefore);
    }
  });

  it("refuses an interrupted existing run and an authoritative sibling absent from the read model before authoring work", async () => {
    const services = runtimes();
    const input = await prepare(services);
    const events = createPostgresEventStore({ pool: pools.marketplace });
    await events.appendToStream({
      streamId: `marketplace.inventory-listing-capacity-${input.inventoryItemId}`,
      expectedVersion: 1,
      context: browserRecoveryContext,
      events: [
        {
          eventType: "marketplace.inventory-listings.registered",
          payload: { inventoryItemId: input.inventoryItemId, listingIds: ["lst_unprojected_sibling"] },
        },
      ],
    });
    await expect(create(input, services)).rejects.toThrow("owned-recovery-listing-collision");
    expect(
      (
        await pools.channels.query("SELECT 1 FROM channel_outbound_operations WHERE connection_id=$1", [
          input.connectionId,
        ])
      ).rows,
    ).toEqual([]);
    const partial = await prepare(services);
    const channelEvents = createPostgresEventStore({ pool: pools.channels });
    const streamId = `channels.tcgplayer-sync-run-run-browser-recovery-${partial.ownershipId}`;
    await channelEvents.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context: browserRecoveryContext,
      events: [{ eventType: "test.interrupted-owned-recovery", payload: { ownershipId: partial.ownershipId } }],
    });
    const before = await channelEvents.readStream({ streamId });
    await expect(create(partial, services)).rejects.toThrow("owned-recovery-run-collision");
    expect(await channelEvents.readStream({ streamId })).toEqual(before);
    expect(
      (
        await pools.channels.query("SELECT 1 FROM channel_outbound_operations WHERE connection_id=$1", [
          partial.connectionId,
        ])
      ).rows,
    ).toEqual([]);
  });

  it("makes omitted recovery initialization observably different instead of accepting an arbitrary existing panel", async () => {
    const services = runtimes();
    const input = await prepare(services);
    await drainLocalProjectionHandlerSets("channels", pools.channels, services.channels.projectors);
    const panel = { accountId: demoIdentitySeedIds.accountId, connectionId: input.connectionId };
    expect(await services.channels.manualSync.readPanel(panel)).not.toMatchObject({ attentionReason: "recovery" });
    await create(input, services);
    await drainLocalProjectionHandlerSets("channels", pools.channels, services.channels.projectors);
    expect(await services.channels.manualSync.readPanel(panel)).toMatchObject({ attentionReason: "recovery" });
  });
});

async function ownedRecoveryListing(
  pool: PgTransactionalPool,
  services: MarketplaceServices,
  input: BrowserRecoveryFixtureInput,
) {
  const accountId = demoIdentitySeedIds.accountId;
  await pool.query(
    `INSERT INTO marketplace_supply_locations
    (storage_location_id,account_id,name,ship_from_code,ship_from_address,is_archived,updated_at)
    VALUES ('loc_owned_recovery',$1,'Owned recovery','CHI','{}'::jsonb,false,now()) ON CONFLICT DO NOTHING`,
    [accountId],
  );
  await pool.query(
    `INSERT INTO marketplace_supply_items
    (item_id,account_id,catalog_catalog_item_id,product_id,selected_options,graded_card,storage_location_id,total_quantity,acquisition_cost_amount,last_stream_version,updated_at)
    VALUES ($1,$2,'cat_owned_recovery','cat_owned_recovery::','[]'::jsonb,NULL,'loc_owned_recovery',2,NULL,1,now())`,
    [input.inventoryItemId, accountId],
  );
  const evidenceRequirements = {
    policyId: null,
    policyVersion: null,
    policyHash: "sha256:owned-policy",
    evaluatedAt: new Date().toISOString(),
    requirementHash: "sha256:owned-requirements",
    matchedRuleIds: [],
    explanationCodes: [],
    requirements: { minimumPhotoCount: 0, requiredSlots: [], sellerTrustRequirements: [], buyerAcknowledgment: "none" },
  } as const;
  const command: Parameters<MarketplaceServices["listings"]["commandHandler"]>[0]["command"] = {
    type: "CreateListing",
    listingId: input.listingId as never,
    accountId,
    inventoryItemId: input.inventoryItemId,
    catalogItemId: "cat_owned_recovery",
    productId: "cat_owned_recovery::" as never,
    itemLanguageCode: "en",
    itemTitle: "Owned recovery",
    itemSubtitle: null,
    selectedOptions: [],
    productSummary: null,
    productMeasureSnapshot: {
      catalogItemId: "cat_owned_recovery",
      productId: "cat_owned_recovery::",
      selectedOptions: [],
      measureVersion: "owned-v1",
      unitLengthInches: 3.5,
      unitWidthInches: 2.5,
      unitHeightInches: 0.01,
      unitWeightOunces: 0.1,
      physicalFlags: ["raw-card"],
      stackBehavior: "stackable-thickness",
      source: "profile",
      confidence: "measured",
    },
    storageLocationName: "Owned recovery",
    shipFromCode: "CHI",
    shipFromAddress: {
      name: "Synthetic seller",
      company: null,
      line1: "1 Test St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
    },
    priceAmount: "5.00",
    priceCurrencyCode: "USD",
    quantityCap: 1,
    evidenceRequirements,
    feeLock: {
      unitCount: 1,
      terms: {
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: "25.00",
        shippingAllowancePercentageBps: 500,
        termsScheduleId: "cts_standard",
        termsAgreementId: null,
        termsResolvedAt: new Date().toISOString(),
      },
      marketplaceSalesFeeUnitAmount: "0.25",
      sellerNetUnitAmount: "4.75",
      feeQuoteFingerprint: "fee_owned",
    },
  };
  const created = await services.listings.commandHandler({
    streamId: `marketplace.listing-${input.listingId}`,
    command,
    context: browserRecoveryContext,
  });
  const published = await services.listings.commandHandler({
    streamId: `marketplace.listing-${input.listingId}`,
    expectedVersion: created.version,
    command: {
      type: "PublishListing",
      readiness: {
        ready: true,
        requirementHash: evidenceRequirements.requirementHash,
        unmetCodes: [],
        coverage: { complete: true, unmetCodes: [], slots: [], activePhotoCount: 0, minimumPhotoCount: 0 },
      },
    },
    context: browserRecoveryContext,
  });
  await pool.query(
    `INSERT INTO marketplace_listing_pages
    (listing_id,account_id,inventory_item_id,catalog_catalog_item_id,product_id,price_amount,price_currency_code,listing_stream_version,marketplace_sales_fee_unit_amount,seller_net_unit_amount,fee_quote_fingerprint,quantity_cap,evidence_requirements,status,updated_at)
    VALUES ($1,$2,$3,'cat_owned_recovery','cat_owned_recovery::','5.00','USD',$4,'0.25','4.75','fee_owned',1,$5,'active',now())`,
    [input.listingId, accountId, input.inventoryItemId, published.version, JSON.stringify(evidenceRequirements)],
  );
  await createPostgresEventStore({ pool }).appendToStream({
    streamId: `marketplace.inventory-listing-capacity-${input.inventoryItemId}`,
    expectedVersion: "no_stream",
    context: browserRecoveryContext,
    events: [
      {
        eventType: "marketplace.inventory-listing-capacity.committed",
        payload: { inventoryItemId: input.inventoryItemId, listingId: input.listingId, quantityCap: 1 },
      },
    ],
  });
}
