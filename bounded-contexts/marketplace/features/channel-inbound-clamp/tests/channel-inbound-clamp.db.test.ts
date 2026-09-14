import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import type { CreateListingCommand, PublishListingCommand } from "../../listings/domain/domain";
import { createMarketplaceChannelInboundClampRuntime } from "../api/runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["marketplace"] as const;
const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_seller" as never },
};

describeDb("manual-sync-dark-inbound-clamp and recovery", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "marketplace_channel_inbound_clamp",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.marketplace.query(marketplaceModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("expands one genuine requested Listing Item to every active account Listing and restores only unchanged ownership", async () => {
    const services = createMarketplaceServices(pools.marketplace);
    await seedActiveListing(pools.marketplace, services, "lst_requested", "itm_shared");
    await seedActiveListing(pools.marketplace, services, "lst_sibling", "itm_shared");
    const clamp = createMarketplaceChannelInboundClampRuntime(pools.marketplace, {
      commandHandler: services.listings.commandHandler,
      loadListingState: services.listings.loadListingState,
      publishListing: async ({ accountId, listingId }, eventContext) => {
        const current = await streamVersion(pools.marketplace, listingId);
        const result = await services.listings.commandHandler({
          streamId: `marketplace.listing-${listingId}`,
          expectedVersion: current,
          command: publishListingCommand,
          context: eventContext,
        });
        expect(result.state.accountId).toBe(accountId);
        return { listingId, version: result.version };
      },
    });
    const input = {
      accountId: "acc_seller",
      connectionId: "connection-tcg",
      runId: "run-one",
      listingIds: ["lst_requested"],
    } as const;
    await expect(clamp.engage(input, context)).resolves.toEqual({
      kind: "engaged",
      requestedListingCount: 1,
      affectedListingCount: 2,
      clampedListingCount: 2,
      recoveryListingCount: 0,
    });
    expect((await services.listings.loadListingState("lst_requested")).status).toBe("paused");
    expect((await services.listings.loadListingState("lst_sibling")).status).toBe("paused");
    const pausedVersions = await Promise.all([
      streamVersion(pools.marketplace, "lst_requested"),
      streamVersion(pools.marketplace, "lst_sibling"),
    ]);
    await expect(clamp.engage(input, context)).resolves.toEqual({
      kind: "engaged",
      requestedListingCount: 1,
      affectedListingCount: 2,
      clampedListingCount: 2,
      recoveryListingCount: 0,
    });
    await expect(
      Promise.all([streamVersion(pools.marketplace, "lst_requested"), streamVersion(pools.marketplace, "lst_sibling")]),
    ).resolves.toEqual(pausedVersions);

    await expect(clamp.recover(input, context)).resolves.toEqual({
      kind: "released",
      examinedListingCount: 2,
      releasedListingCount: 2,
      retainedListingCount: 0,
      recoveryListingCount: 0,
    });
    expect((await services.listings.loadListingState("lst_requested")).status).toBe("active");
    expect((await services.listings.loadListingState("lst_sibling")).status).toBe("active");
  });

  it("retains a newer seller pause as recovery and repeated recovery is inert", async () => {
    const services = createMarketplaceServices(pools.marketplace);
    await seedActiveListing(pools.marketplace, services, "lst_requested", "itm_one");
    const clamp = services.channelInboundClamp;
    const input = {
      accountId: "acc_seller",
      connectionId: "connection-tcg",
      runId: "run-seller-intent",
      listingIds: ["lst_requested"],
    } as const;
    await clamp.engage(input, context);
    await services.listings.commandHandler({
      streamId: "marketplace.listing-lst_requested",
      expectedVersion: await streamVersion(pools.marketplace, "lst_requested"),
      command: { type: "PauseListing", reason: "seller" },
      context,
    });
    const first = await clamp.recover(input, context);
    expect(first).toMatchObject({ kind: "recovery", recoveryListingCount: 1, releasedListingCount: 0 });
    expect(await services.listings.loadListingState("lst_requested")).toMatchObject({
      status: "paused",
      pauseReason: "seller",
    });
    await expect(clamp.recover(input, context)).resolves.toMatchObject({
      examinedListingCount: 0,
      releasedListingCount: 0,
    });
  });

  it("records every dark-inbound owner at one paused version and releases only after the final owner", async () => {
    const services = createMarketplaceServices(pools.marketplace);
    await seedActiveListing(pools.marketplace, services, "lst_shared_owner", "itm_shared_owner");
    const clamp = services.channelInboundClamp;
    const ownerA = {
      accountId: "acc_seller",
      connectionId: "connection-synthetic-a",
      runId: "run-synthetic-a",
      listingIds: ["lst_shared_owner"],
    } as const;
    const ownerB = {
      accountId: "acc_seller",
      connectionId: "connection-synthetic-b",
      runId: "run-synthetic-b",
      listingIds: ["lst_shared_owner"],
    } as const;

    const beforePauseVersion = await streamVersion(pools.marketplace, "lst_shared_owner");
    await expect(clamp.engage(ownerA, context)).resolves.toEqual({
      kind: "engaged",
      requestedListingCount: 1,
      affectedListingCount: 1,
      clampedListingCount: 1,
      recoveryListingCount: 0,
    });
    const pausedVersion = await streamVersion(pools.marketplace, "lst_shared_owner");
    expect(pausedVersion).toBe(beforePauseVersion + 1);

    await expect(clamp.engage(ownerB, context)).resolves.toEqual({
      kind: "engaged",
      requestedListingCount: 1,
      affectedListingCount: 1,
      clampedListingCount: 1,
      recoveryListingCount: 0,
    });
    expect(await streamVersion(pools.marketplace, "lst_shared_owner")).toBe(pausedVersion);
    await expect(readOwners(pools.marketplace, "lst_shared_owner")).resolves.toEqual([
      {
        connection_id: ownerA.connectionId,
        run_id: ownerA.runId,
        state: "engaged",
        observed_stream_version: beforePauseVersion,
        paused_stream_version: pausedVersion,
      },
      {
        connection_id: ownerB.connectionId,
        run_id: ownerB.runId,
        state: "engaged",
        observed_stream_version: beforePauseVersion,
        paused_stream_version: pausedVersion,
      },
    ]);

    await expect(clamp.recover(ownerA, context)).resolves.toEqual({
      kind: "released",
      examinedListingCount: 1,
      releasedListingCount: 1,
      retainedListingCount: 1,
      recoveryListingCount: 0,
    });
    expect(await streamVersion(pools.marketplace, "lst_shared_owner")).toBe(pausedVersion);
    expect(await services.listings.loadListingState("lst_shared_owner")).toMatchObject({
      status: "paused",
      pauseReason: "channel-inbound-dark",
    });

    await expect(clamp.recover(ownerB, context)).resolves.toEqual({
      kind: "released",
      examinedListingCount: 1,
      releasedListingCount: 1,
      retainedListingCount: 0,
      recoveryListingCount: 0,
    });
    expect(await streamVersion(pools.marketplace, "lst_shared_owner")).toBe(pausedVersion + 2);
    expect((await services.listings.loadListingState("lst_shared_owner")).status).toBe("active");
    await expect(listingEventTypes(pools.marketplace, "lst_shared_owner")).resolves.toEqual([
      "marketplace.listing.created",
      "marketplace.listing.published",
      "marketplace.listing.paused",
      "marketplace.listing.evidence-requirements-refreshed",
      "marketplace.listing.published",
    ]);
  });

  it("keeps the final owner in recovery when the production publication adapter fails", async () => {
    const services = createMarketplaceServices(pools.marketplace);
    await seedActiveListing(pools.marketplace, services, "lst_publication_failure", "itm_publication_failure");
    const publishListing = vi.fn(async () => {
      throw new Error("synthetic publication failure");
    });
    const clamp = createMarketplaceChannelInboundClampRuntime(pools.marketplace, {
      commandHandler: services.listings.commandHandler,
      loadListingState: services.listings.loadListingState,
      publishListing,
    });
    const input = {
      accountId: "acc_seller",
      connectionId: "connection-publication-failure",
      runId: "run-publication-failure",
      listingIds: ["lst_publication_failure"],
    } as const;

    await expect(clamp.engage(input, context)).resolves.toMatchObject({ kind: "engaged", clampedListingCount: 1 });
    await expect(clamp.recover(input, context)).resolves.toEqual({
      kind: "recovery",
      examinedListingCount: 1,
      releasedListingCount: 0,
      retainedListingCount: 0,
      recoveryListingCount: 1,
    });
    expect(publishListing).toHaveBeenCalledOnce();
    expect(await services.listings.loadListingState("lst_publication_failure")).toMatchObject({
      status: "paused",
      pauseReason: "channel-inbound-dark",
    });
    await expect(
      pools.marketplace.query(
        `SELECT state,paused_stream_version FROM marketplace_channel_inbound_clamps
          WHERE connection_id=$1 AND run_id=$2 AND listing_id=$3`,
        [input.connectionId, input.runId, input.listingIds[0]],
      ),
    ).resolves.toMatchObject({ rows: [{ state: "recovery", paused_stream_version: null }] });
  });

  it("refuses duplicate and foreign requested membership without pausing either account", async () => {
    const services = createMarketplaceServices(pools.marketplace);
    await seedActiveListing(pools.marketplace, services, "lst_owned", "itm_owned");
    await seedActiveListing(pools.marketplace, services, "lst_foreign", "itm_foreign", "acc_foreign");
    const ownedVersion = await streamVersion(pools.marketplace, "lst_owned");
    const foreignVersion = await streamVersion(pools.marketplace, "lst_foreign");

    await expect(
      services.channelInboundClamp.engage(
        {
          accountId: "acc_seller",
          connectionId: "connection-synthetic",
          runId: "run-duplicate",
          listingIds: ["lst_owned", "lst_owned"],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      services.channelInboundClamp.engage(
        {
          accountId: "acc_seller",
          connectionId: "connection-synthetic",
          runId: "run-foreign",
          listingIds: ["lst_foreign"],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "listing-membership-incomplete" });
    expect(await streamVersion(pools.marketplace, "lst_owned")).toBe(ownedVersion);
    expect(await streamVersion(pools.marketplace, "lst_foreign")).toBe(foreignVersion);
    await expect(pools.marketplace.query("SELECT 1 FROM marketplace_channel_inbound_clamps")).resolves.toMatchObject({
      rows: [],
    });
  });

  it("pages 251 already-clamped shared-Item Listings and acquires complete current ownership without repausing", async () => {
    await pools.marketplace.query(
      `INSERT INTO event_store_streams (stream_id,current_version,updated_at)
       SELECT 'marketplace.listing-listing-' || lpad(value::text,4,'0'),2,now()
         FROM generate_series(0,250) AS value`,
    );
    await pools.marketplace.query(
      `INSERT INTO marketplace_listing_pages
       (listing_id,account_id,inventory_item_id,catalog_catalog_item_id,product_id,price_amount,
        price_currency_code,listing_stream_version,marketplace_sales_fee_unit_amount,seller_net_unit_amount,
        fee_quote_fingerprint,quantity_cap,evidence_requirements,status,updated_at)
       SELECT 'listing-' || lpad(value::text,4,'0'),'acc_seller','itm_paged','cat_test','cat_test::',
              '10.00','USD',2,'1.00','9.00','fee_test',1,$1,'paused',now()
         FROM generate_series(0,250) AS value`,
      [JSON.stringify(evidenceRequirements)],
    );
    await pools.marketplace.query(
      `INSERT INTO marketplace_channel_inbound_clamps
       (account_id,connection_id,run_id,listing_id,inventory_item_id,state,observed_stream_version,
        paused_stream_version,observed_updated_at,created_at,updated_at)
       SELECT 'acc_seller','connection-synthetic-a','run-synthetic-a',
              'listing-' || lpad(value::text,4,'0'),'itm_paged','engaged',1,2,now(),now(),now()
         FROM generate_series(0,250) AS value`,
    );
    const commandHandler = vi.fn();
    const clamp = createMarketplaceChannelInboundClampRuntime(pools.marketplace, {
      commandHandler: commandHandler as never,
      loadListingState: async (listingId) =>
        ({
          listingId,
          accountId: "acc_seller",
          status: "paused",
          pauseReason: "channel-inbound-dark",
        }) as never,
      publishListing: vi.fn(),
    });
    const input = {
      accountId: "acc_seller",
      connectionId: "connection-synthetic-b",
      runId: "run-synthetic-b",
      listingIds: ["listing-0000"],
    } as const;

    await expect(clamp.engage(input, context)).resolves.toEqual({
      kind: "engaged",
      requestedListingCount: 1,
      affectedListingCount: 251,
      clampedListingCount: 251,
      recoveryListingCount: 0,
    });
    expect(commandHandler).not.toHaveBeenCalled();
    await expect(
      pools.marketplace.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM marketplace_channel_inbound_clamps
          WHERE connection_id=$1 AND run_id=$2 AND state='engaged' AND paused_stream_version=2`,
        [input.connectionId, input.runId],
      ),
    ).resolves.toMatchObject({ rows: [{ total: "251" }] });
  });

  it("keeps a partial safe write clamped and retryable when another Listing cannot pause", async () => {
    const services = createMarketplaceServices(pools.marketplace);
    await seedActiveListing(pools.marketplace, services, "lst_partial_a", "itm_partial");
    await seedActiveListing(pools.marketplace, services, "lst_partial_b", "itm_partial");
    const commandHandler = vi.fn(async (command: Parameters<typeof services.listings.commandHandler>[0]) => {
      if (command.streamId.endsWith("lst_partial_b")) throw new Error("synthetic concurrent seller write");
      return services.listings.commandHandler(command);
    });
    const clamp = createMarketplaceChannelInboundClampRuntime(pools.marketplace, {
      commandHandler,
      loadListingState: services.listings.loadListingState,
      publishListing: services.listings.publishListing,
    });
    const input = {
      accountId: "acc_seller",
      connectionId: "connection-partial",
      runId: "run-partial",
      listingIds: ["lst_partial_a"],
    } as const;

    await expect(clamp.engage(input, context)).resolves.toEqual({
      kind: "recovery",
      requestedListingCount: 1,
      affectedListingCount: 2,
      clampedListingCount: 1,
      recoveryListingCount: 1,
    });
    expect(await services.listings.loadListingState("lst_partial_a")).toMatchObject({
      status: "paused",
      pauseReason: "channel-inbound-dark",
    });
    expect((await services.listings.loadListingState("lst_partial_b")).status).toBe("active");
    await expect(
      pools.marketplace.query(
        `SELECT listing_id,state FROM marketplace_channel_inbound_clamps
          WHERE connection_id=$1 AND run_id=$2 ORDER BY listing_id`,
        [input.connectionId, input.runId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { listing_id: "lst_partial_a", state: "engaged" },
        { listing_id: "lst_partial_b", state: "recovery" },
      ],
    });
  });
});

async function readOwners(pool: PgTransactionalPool, listingId: string) {
  const result = await pool.query<{
    connection_id: string;
    run_id: string;
    state: string;
    observed_stream_version: string | number;
    paused_stream_version: string | number | null;
  }>(
    `SELECT connection_id,run_id,state,observed_stream_version,paused_stream_version
       FROM marketplace_channel_inbound_clamps
      WHERE listing_id=$1
      ORDER BY connection_id,run_id`,
    [listingId],
  );
  return result.rows.map((row) => ({
    ...row,
    observed_stream_version: Number(row.observed_stream_version),
    paused_stream_version: row.paused_stream_version === null ? null : Number(row.paused_stream_version),
  }));
}

async function seedActiveListing(
  pool: PgTransactionalPool,
  services: ReturnType<typeof createMarketplaceServices>,
  listingId: string,
  inventoryItemId: string,
  accountId = "acc_seller",
) {
  const storageLocationId = `loc_channel_clamp_fixture_${accountId}`;
  await pool.query(
    `INSERT INTO marketplace_supply_locations
      (storage_location_id,account_id,name,ship_from_code,ship_from_address,is_archived,updated_at)
     VALUES ($1,$2,'Channel clamp fixture','CHI','{}'::jsonb,false,now())
     ON CONFLICT (storage_location_id) DO NOTHING`,
    [storageLocationId, accountId],
  );
  await pool.query(
    `INSERT INTO marketplace_supply_items
      (item_id,account_id,catalog_catalog_item_id,product_id,selected_options,graded_card,storage_location_id,
       total_quantity,acquisition_cost_amount,last_stream_version,updated_at)
     VALUES ($1,$2,'cat_test','cat_test::','[]'::jsonb,NULL,$3,100,NULL,1,now())
     ON CONFLICT (item_id) DO NOTHING`,
    [inventoryItemId, accountId, storageLocationId],
  );
  const created = await services.listings.commandHandler({
    streamId: `marketplace.listing-${listingId}`,
    command: createListingCommand(listingId, inventoryItemId, accountId),
    context: contextFor(accountId),
  });
  const published = await services.listings.commandHandler({
    streamId: `marketplace.listing-${listingId}`,
    expectedVersion: created.version,
    command: publishListingCommand,
    context: contextFor(accountId),
  });
  await pool.query(
    `INSERT INTO marketplace_listing_pages
      (listing_id,account_id,inventory_item_id,catalog_catalog_item_id,product_id,price_amount,
       price_currency_code,listing_stream_version,marketplace_sales_fee_unit_amount,seller_net_unit_amount,
       fee_quote_fingerprint,quantity_cap,evidence_requirements,status,updated_at)
     VALUES ($1,$2,$3,'cat_test','cat_test::','10.00','USD',$4,'1.00','9.00','fee_test',1,$5,'active',now())`,
    [listingId, accountId, inventoryItemId, published.version, JSON.stringify(evidenceRequirements)],
  );
}

async function streamVersion(pool: PgTransactionalPool, listingId: string) {
  const result = await pool.query<{ current_version: string | number }>(
    "SELECT current_version FROM event_store_streams WHERE stream_id=$1",
    [`marketplace.listing-${listingId}`],
  );
  return Number(result.rows[0]?.current_version);
}

async function listingEventTypes(pool: PgTransactionalPool, listingId: string) {
  const result = await pool.query<{ event_type: string }>(
    "SELECT event_type FROM event_store_events WHERE stream_id=$1 ORDER BY stream_version",
    [`marketplace.listing-${listingId}`],
  );
  return result.rows.map((row) => row.event_type);
}

const evidenceRequirements = {
  policyId: null,
  policyVersion: null,
  policyHash: "sha256:policy",
  evaluatedAt: "2026-09-10T12:00:00.000Z",
  requirementHash: "sha256:requirements",
  matchedRuleIds: [],
  explanationCodes: [],
  requirements: { minimumPhotoCount: 0, requiredSlots: [], sellerTrustRequirements: [], buyerAcknowledgment: "none" },
} as const;

const publishListingCommand = {
  type: "PublishListing",
  readiness: {
    ready: true,
    requirementHash: evidenceRequirements.requirementHash,
    unmetCodes: [],
    coverage: { complete: true, unmetCodes: [], slots: [], activePhotoCount: 0, minimumPhotoCount: 0 },
  },
} satisfies PublishListingCommand;

function createListingCommand(
  listingId: string,
  inventoryItemId: string,
  accountId = "acc_seller",
): CreateListingCommand {
  return {
    type: "CreateListing",
    listingId: listingId as never,
    accountId: accountId as never,
    inventoryItemId,
    catalogItemId: "cat_test",
    productId: "cat_test::" as never,
    itemLanguageCode: "en",
    itemTitle: "Test Card",
    itemSubtitle: null,
    selectedOptions: [],
    productSummary: null,
    productMeasureSnapshot: {
      catalogItemId: "cat_test",
      productId: "cat_test::",
      selectedOptions: [],
      measureVersion: "pm_test_v1",
      unitLengthInches: 3.5,
      unitWidthInches: 2.5,
      unitHeightInches: 0.01,
      unitWeightOunces: 0.1,
      physicalFlags: ["raw-card"],
      stackBehavior: "stackable-thickness",
      source: "profile",
      confidence: "measured",
    },
    storageLocationName: "Main",
    shipFromCode: "CHI",
    shipFromAddress: {
      name: "Seller",
      company: null,
      line1: "1 Main St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
    },
    priceAmount: "10.00",
    priceCurrencyCode: "USD",
    feeLock: {
      unitCount: 1,
      terms: {
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: "25.00",
        shippingAllowancePercentageBps: 500,
        termsScheduleId: "cts_standard",
        termsAgreementId: null,
        termsResolvedAt: "2026-09-10T12:00:00.000Z",
      },
      marketplaceSalesFeeUnitAmount: "1.00",
      sellerNetUnitAmount: "9.00",
      feeQuoteFingerprint: "fee_test",
    },
    quantityCap: 1,
    evidenceRequirements,
  };
}

function contextFor(accountId: string): EventStoreContext {
  return {
    tenantId: context.tenantId,
    audit: { performedByUserId: context.audit.performedByUserId, forAccountId: accountId as never },
  };
}
