import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { catalogScenarioItems } from "@chase-sets/catalog-seed";
import { module as marketplaceModule } from "../../index";
import { buildMarketplaceInventoryProjectionHandlers } from "../../features/listings/integrations/supply/supply-projection";
import { buildMarketplaceListingProjectionHandlers } from "../../features/listings/read-model/projection";
import { createMarketplaceListingRuntime } from "../../features/listings/api/runtime";
import { seedListingAttemptKey, withdrawStrayRepresentativeListings } from "./seed";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for seed recovery DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const catalogItemId = catalogScenarioItems.bulbasaurBaseSet;
const context: EventStoreContext = {
  tenantId: "tnt_seed" as never,
  audit: { performedByUserId: "usr_seed" as never, forAccountId: "acc_seller" as never },
};
const measure = {
  catalogItemId,
  productId: `${catalogItemId}::`,
  selectedOptions: [],
  measureVersion: "pm_seed",
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.01,
  unitWeightOunces: 0.1,
  physicalFlags: ["raw-card"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "measured",
};
const address = {
  name: "Seller",
  line1: "1 Main St",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
};

describeDb("seed Listing commands recover without duplicates", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["marketplace"], "marketplace_seed_recovery");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.marketplace.query(marketplaceModule.schemaSql);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("withdraws a stray representative Listing once across a same-boot repeat, a lagging projection and a restart", async () => {
    const f = await fixture(pools.marketplace);
    await f.activeListing("lst_repr_stray");
    await f.project();
    await withdrawStrayRepresentativeListings(f.services(), context);
    expect(await f.count("lst_repr_stray", "marketplace.listing.withdrawn")).toBe(1);
    // The projection has not caught up, so it still nominates the Listing: the authoritative stream decides.
    expect(await f.projectedStatus("lst_repr_stray")).toBe("active");
    await f.expectNoAppend(() => withdrawStrayRepresentativeListings(f.services(), context));
    await f.expectNoAppend(() => withdrawStrayRepresentativeListings(f.services(f.restart()), context));
    await f.project();
    await f.expectNoAppend(() => withdrawStrayRepresentativeListings(f.services(f.restart()), context));
    expect(await f.count("lst_repr_stray", "marketplace.listing.withdrawn")).toBe(1);
  });

  it("withdraws a retained draft stray once and replays an interrupted withdrawal's first receipt", async () => {
    const f = await fixture(pools.marketplace);
    await f.draftListing("lst_repr_draft");
    await f.project();
    const observed = (await f.events("lst_repr_draft")).length;
    // Mid-command interruption: the withdrawal committed but the seed never saw its receipt.
    const committed = await f.listings.withdrawListing(
      {
        accountId: "acc_seller",
        listingId: "lst_repr_draft",
        idempotencyKey: seedListingAttemptKey("withdraw-stray", "lst_repr_draft", observed),
      },
      context,
    );
    await f.expectNoAppend(async () =>
      expect(
        await f.restart().withdrawListing(
          {
            accountId: "acc_seller",
            listingId: "lst_repr_draft",
            idempotencyKey: seedListingAttemptKey("withdraw-stray", "lst_repr_draft", observed),
          },
          context,
        ),
      ).toMatchObject({ version: committed.version }),
    );
    await f.expectNoAppend(() => withdrawStrayRepresentativeListings(f.services(f.restart()), context));
    expect(await f.count("lst_repr_draft", "marketplace.listing.withdrawn")).toBe(1);
  });

  it("replays seeded create/publish/pause attempts from every retained state on boot-twice and restart", async () => {
    const f = await fixture(pools.marketplace);
    const listingId = "lst_seed_boot_twice";
    const create = {
      accountId: "acc_seller" as never,
      inventoryItemId: "inv_seed",
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      quantityCap: 1,
      listingIdOverride: listingId as never,
      listingPhotoUploads: [],
      idempotencyKey: seedListingAttemptKey("create", listingId),
    };
    const created = await f.listings.createListing(create, context);
    // Retained draft: a second boot or a restart re-issues the create and gets the first receipt.
    await f.expectNoAppend(async () =>
      expect(await f.restart().createListing(create, context)).toMatchObject({ listingId, version: created.version }),
    );
    const publishVersion = (await f.events(listingId)).length;
    const publish = {
      accountId: "acc_seller",
      listingId,
      feeQuoteFingerprint: created.feeQuoteFingerprint,
      idempotencyKey: seedListingAttemptKey("publish", listingId, publishVersion),
    };
    const published = await f.listings.publishListing(publish, context);
    // Partial: publish committed, the boot died before the pause; the same decision replays.
    await f.expectNoAppend(async () =>
      expect(await f.restart().publishListing(publish, context)).toMatchObject({ version: published.version }),
    );
    const pauseVersion = (await f.events(listingId)).length;
    const pause = {
      accountId: "acc_seller",
      listingId,
      idempotencyKey: seedListingAttemptKey("pause", listingId, pauseVersion),
    };
    const paused = await f.listings.pauseListing(pause, context);
    // Terminal for the seed: a day-after boot replays and appends nothing.
    await f.expectNoAppend(async () =>
      expect(await f.restart().pauseListing(pause, context)).toMatchObject({ version: paused.version }),
    );
    expect(await f.count(listingId, "marketplace.listing.created")).toBe(1);
    expect(await f.count(listingId, "marketplace.listing.published")).toBe(1);
    expect(await f.count(listingId, "marketplace.listing.paused")).toBe(1);
  });
});

async function fixture(pool: PgTransactionalPool) {
  const store = createPostgresEventStore({ pool });
  const restart = () =>
    createMarketplaceListingRuntime({
      eventStore: store,
      db: pool,
      checkpointStore: createPostgresProjectionStore({ db: pool }),
      commercialTermsResolver: {
        resolveListingTerms: async ({ amount, accountId }: { amount: string; accountId: string }) => ({
          accountId,
          accountType: "business",
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "0.50",
          sellerNetUnitAmount: "9.50",
          scheduleId: "cts_seed",
          agreementId: null,
          resolvedAt: "2026-10-28T00:00:00.000Z",
        }),
      } as never,
    });
  const listings = restart();
  const handlers = buildMarketplaceListingProjectionHandlers(pool);
  const projected = new Set<string>();
  async function project() {
    let afterGlobalPosition;
    for (;;) {
      const page = await store.readAll({ afterGlobalPosition, limit: 500 });
      for (const event of page) {
        if (handlers[event.eventType] && !projected.has(event.eventId)) {
          await handlers[event.eventType]!(toTransportEvent(event));
          projected.add(event.eventId);
        }
      }
      if (page.length < 500) break;
      afterGlobalPosition = page.at(-1)!.globalPosition;
    }
  }
  async function emit(type: string, payload: JsonObject, streamId: string) {
    const previous = await store.readStream({ streamId });
    const appended = await store.appendToStream({
      streamId,
      expectedVersion: previous.length,
      context,
      events: [{ eventType: type, payload }],
    });
    const supply = buildMarketplaceInventoryProjectionHandlers(pool, {
      onInventoryItemChanged: listings.reconcileInventoryCapacity,
    });
    await supply[type]!(toTransportEvent(appended[0]!));
    await project();
  }
  const eventCount = async () =>
    Number((await pool.query<{ count: string }>("SELECT count(*) AS count FROM event_store_events")).rows[0]!.count);
  const events = (listingId: string) => store.readStream({ streamId: `marketplace.listing-${listingId}` });
  await pool.query(
    "INSERT INTO marketplace_catalog_items (catalog_item_id, title, status, product_measure_snapshots) VALUES ($1, 'Bulbasaur', 'published', $2)",
    [catalogItemId, JSON.stringify([measure])],
  );
  await emit(
    "inventory.storage-location.created",
    {
      storageLocationId: "loc_seed",
      accountId: "acc_seller",
      name: "Main",
      shipFromCode: "CHI",
      shipFromAddress: address,
    },
    "inventory.storage-location-loc_seed",
  );
  await emit(
    "inventory.item.created",
    {
      itemId: "inv_seed",
      accountId: "acc_seller",
      catalogItemId,
      productId: `${catalogItemId}::`,
      selectedOptions: [],
      gradedCard: null,
      storageLocationId: "loc_seed",
      totalQuantity: 10,
      acquisitionCostAmount: null,
    },
    "inventory.item-inv_seed",
  );
  const draftListing = (listingId: string) =>
    listings.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_seed",
        priceAmount: "1.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: listingId as never,
      },
      context,
    );
  return {
    listings,
    restart,
    project,
    events,
    draftListing,
    services: (runtime = listings) =>
      ({ db: pool, listings: runtime }) as unknown as Parameters<typeof withdrawStrayRepresentativeListings>[0],
    activeListing: async (listingId: string) => {
      await draftListing(listingId);
      await listings.publishListing({ accountId: "acc_seller", listingId }, context);
    },
    projectedStatus: async (listingId: string) =>
      (
        await pool.query<{ status: string }>("SELECT status FROM marketplace_listing_pages WHERE listing_id=$1", [
          listingId,
        ])
      ).rows[0]?.status,
    count: async (listingId: string, eventType: string) =>
      (await events(listingId)).filter((event) => event.eventType === eventType).length,
    expectNoAppend: async (action: () => Promise<unknown>) => {
      const before = await eventCount();
      await action();
      expect(await eventCount()).toBe(before);
    },
  };
}
