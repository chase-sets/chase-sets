import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
});

async function seedActiveListing(
  pool: PgTransactionalPool,
  services: ReturnType<typeof createMarketplaceServices>,
  listingId: string,
  inventoryItemId: string,
) {
  const created = await services.listings.commandHandler({
    streamId: `marketplace.listing-${listingId}`,
    command: createListingCommand(listingId, inventoryItemId),
    context,
  });
  const published = await services.listings.commandHandler({
    streamId: `marketplace.listing-${listingId}`,
    expectedVersion: created.version,
    command: publishListingCommand,
    context,
  });
  await pool.query(
    `INSERT INTO marketplace_listing_pages
      (listing_id,account_id,inventory_item_id,catalog_catalog_item_id,product_id,price_amount,
       price_currency_code,listing_stream_version,marketplace_sales_fee_unit_amount,seller_net_unit_amount,
       fee_quote_fingerprint,quantity_cap,evidence_requirements,status,updated_at)
     VALUES ($1,'acc_seller',$2,'cat_test','cat_test::','10.00','USD',$3,'1.00','9.00','fee_test',1,$4,'active',now())`,
    [listingId, inventoryItemId, published.version, JSON.stringify(evidenceRequirements)],
  );
}

async function streamVersion(pool: PgTransactionalPool, listingId: string) {
  const result = await pool.query<{ current_version: string | number }>(
    "SELECT current_version FROM event_store_streams WHERE stream_id=$1",
    [`marketplace.listing-${listingId}`],
  );
  return Number(result.rows[0]?.current_version);
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

function createListingCommand(listingId: string, inventoryItemId: string): CreateListingCommand {
  return {
    type: "CreateListing",
    listingId: listingId as never,
    accountId: "acc_seller" as never,
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
