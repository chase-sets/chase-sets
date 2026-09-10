import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  composeModuleSchemaSql,
  rebuildProjectionGroup,
  resolveModuleProjectionGroups,
} from "@chase-sets/bounded-context-runtime";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as marketplaceModule } from "../../../index";
import { buildMarketplaceListingProjectionHandlers } from "../../listings/read-model/projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("channel-inbound-clamp command ownership survives the actual Marketplace Listing rebuild", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["marketplace"],
      "channel_inbound_clamp_projection_rebuild",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).marketplace;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ marketplace: pool });
    await pool.query(composeModuleSchemaSql(marketplaceModule));
  });
  afterAll(async () => closeMultiContextTestPools({ marketplace: pool }));

  it("preserves engaged account/version ownership while the Listing row resets and replays its clamp reason", async () => {
    const project = buildMarketplaceListingProjectionHandlers(pool);
    const events = listingEvents();
    for (const event of events) await project[event.type]?.(event);
    await pool.query(
      `INSERT INTO marketplace_channel_inbound_clamps
       (account_id,connection_id,run_id,listing_id,inventory_item_id,state,observed_stream_version,
        paused_stream_version,observed_updated_at,created_at,updated_at)
       VALUES ('account-command-owner','connection-command-owner','run-command-owner','listing-rebuild',
               'inventory-rebuild','engaged',2,3,'2026-09-10T12:01:00.000Z',now(),now())`,
    );

    let projectedListingWasAbsentBeforeReplay = false;
    let engagedRowWasPresentBeforeReplay = false;
    const group = actualProjectionGroup("marketplace-listing-projection", async () => {
      projectedListingWasAbsentBeforeReplay =
        (await pool.query("SELECT 1 FROM marketplace_listing_pages WHERE listing_id='listing-rebuild'")).rows.length ===
        0;
      engagedRowWasPresentBeforeReplay =
        (await pool.query("SELECT 1 FROM marketplace_channel_inbound_clamps WHERE run_id='run-command-owner'")).rows
          .length === 1;
      for (const event of events) await project[event.type]?.(event);
    });
    await rebuildProjectionGroup(group);

    expect(projectedListingWasAbsentBeforeReplay).toBe(true);
    expect(engagedRowWasPresentBeforeReplay).toBe(true);
    await expect(
      pool.query(
        "SELECT status,listing_stream_version FROM marketplace_listing_pages WHERE listing_id='listing-rebuild'",
      ),
    ).resolves.toMatchObject({ rows: [{ status: "paused", listing_stream_version: 1 }] });
    await expect(
      pool.query(
        `SELECT account_id,state,observed_stream_version::int,paused_stream_version::int
           FROM marketplace_channel_inbound_clamps WHERE run_id='run-command-owner'`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          account_id: "account-command-owner",
          state: "engaged",
          observed_stream_version: 2,
          paused_stream_version: 3,
        },
      ],
    });
    expect(events.at(-1)?.data).toEqual({ reason: "channel-inbound-dark" });
  });

  it("makes the survivor guard fail when the durable command table is restored to projection ownership", async () => {
    const project = buildMarketplaceListingProjectionHandlers(pool);
    const events = listingEvents();
    for (const event of events) await project[event.type]?.(event);
    await pool.query(
      `INSERT INTO marketplace_channel_inbound_clamps
       (account_id,connection_id,run_id,listing_id,inventory_item_id,state,observed_stream_version,
        paused_stream_version,observed_updated_at,created_at,updated_at)
       VALUES ('account-command-owner','connection-command-owner','run-command-owner','listing-rebuild',
               'inventory-rebuild','engaged',2,3,'2026-09-10T12:01:00.000Z',now(),now())`,
    );
    const declared = marketplaceModule.projectionGroups?.find(
      (group) => group.projectionName === "marketplace-listing-projection",
    );
    if (!declared) throw new Error("Missing actual Marketplace Listing projection group.");
    const group = actualProjectionGroup(
      declared.projectionName,
      async () => {
        for (const event of events) await project[event.type]?.(event);
      },
      [...declared.ownedTables, "marketplace_channel_inbound_clamps"],
    );
    await rebuildProjectionGroup(group);
    await expect(
      pool.query("SELECT 1 FROM marketplace_channel_inbound_clamps WHERE run_id='run-command-owner'"),
    ).resolves.toMatchObject({ rows: [] });
  });

  function actualProjectionGroup(projectionName: string, replay: () => Promise<void>, ownedTables?: readonly string[]) {
    const declared = marketplaceModule.projectionGroups?.find((group) => group.projectionName === projectionName);
    if (!declared) throw new Error(`Missing actual Marketplace projection group ${projectionName}.`);
    const module = {
      ...marketplaceModule,
      buildProjectionGroups: undefined,
      projectionGroups: [{ ...declared, ownedTables: ownedTables ?? declared.ownedTables }],
    };
    const runners = ["catalog", "marketplace"].map((sourceContextName, index) => {
      let replayed = false;
      const status = {
        checkpointKey: `marketplace-test-rebuild-${sourceContextName}`,
        subscriptionName: `marketplace-test-rebuild-${sourceContextName}`,
        projectionName,
        sourceContextName,
        targetContextName: "marketplace",
        subscriptionVersion: 1,
        initialized: true,
        recoveryRequired: false,
        lastGlobalPosition: "0",
        sourceHeadGlobalPosition: "0",
        outstandingEventCount: "0",
        processedEvents: 0,
        state: "caught-up",
        lastError: null,
        blockedStreamCount: 0,
        poisonEventCount: 0,
        updatedAt: "2026-09-10T12:00:00.000Z",
      } as const;
      return {
        ...status,
        order: index + 1,
        runOnce: vi.fn(async () => {
          if (sourceContextName !== "marketplace" || replayed) {
            return { processed: 0, blockedStreams: 0, poisonEvents: 0 };
          }
          replayed = true;
          await replay();
          return { processed: 1, blockedStreams: 0, poisonEvents: 0 };
        }),
        getStatus: () => status,
        refreshStatus: async () => status,
        reset: vi.fn(async () => {
          replayed = false;
        }),
        retryBlockedStream: vi.fn(),
      };
    });
    return resolveModuleProjectionGroups(
      [
        { contextName: "catalog", mountRole: "source-only", module, services: {}, pool, projectionHandlerSets: [] },
        { contextName: "marketplace", module, services: {}, pool, projectionHandlerSets: [] },
      ] as never,
      runners as never,
    )[0]!;
  }
});

function listingEvents() {
  const timing = { occurredAt: "2026-09-10T12:00:00.000Z", recordedAt: "2026-09-10T12:00:00.000Z" };
  const options = {
    id: "event-listing-created",
    streamId: "marketplace.listing-listing-rebuild",
    streamVersion: 1,
    tenantId: "tenant-rebuild",
    audit: { performedByUserId: "user-rebuild", forAccountId: "account-command-owner" },
    timing,
  } as const;
  return [
    buildTransportEvent(
      "marketplace.listing.created",
      {
        listingId: "listing-rebuild",
        accountId: "account-command-owner",
        inventoryItemId: "inventory-rebuild",
        catalogItemId: "catalog-rebuild",
        productId: "catalog-rebuild::",
        itemTitle: "Projection Rebuild Card",
        itemSubtitle: null,
        itemLanguageCode: "en",
        selectedOptions: [],
        productSummary: null,
        productMeasureSnapshot: null,
        gradedCard: null,
        storageLocationName: "Main",
        shipFromCode: "CHI",
        shipFromAddress: {},
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        marketplaceSalesFeeUnitAmount: "1.00",
        sellerNetUnitAmount: "9.00",
        shippingAllowancePercentageBps: 500,
        termsScheduleId: "terms-rebuild",
        termsAgreementId: null,
        termsResolvedAt: "2026-09-10T12:00:00.000Z",
        feeQuoteFingerprint: "fee-rebuild",
        feeLocks: [],
        quantityCap: 1,
        purchaseLimits: {
          maxUnitsPerOrder: null,
          maxUnitsPerDay: null,
          maxUnitsPerCustomerAccount: null,
        },
        evidenceRequirements: null,
        evidence: [],
      },
      options,
    ),
    buildTransportEvent(
      "marketplace.listing.published",
      {},
      { ...options, id: "event-listing-published", streamVersion: 2 },
    ),
    buildTransportEvent(
      "marketplace.listing.paused",
      { reason: "channel-inbound-dark" },
      { ...options, id: "event-listing-paused", streamVersion: 3 },
    ),
  ];
}
