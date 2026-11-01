import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
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
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { JsonObject } from "@chase-sets/primitives/json";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceListingRuntime } from "../api/runtime";
import {
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingEvent,
} from "../domain/domain";
import { buildMarketplaceInventoryProjectionHandlers } from "../integrations/supply/supply-projection";
import { buildMarketplaceListingProjectionHandlers } from "../read-model/projection";
import { createListingActionAttentionSourceFromReadModel } from "../read-model/seller-attention-source";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["marketplace"] as const;
const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
};
const measure = {
  catalogItemId: "cat_test",
  productId: "cat_test::",
  selectedOptions: [],
  measureVersion: "pm_test",
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

describeDb("inventory capacity recovery through stored events and projections", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "marketplace_inventory_capacity_recovery",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.marketplace.query(marketplaceModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it.each(["released", "expired"] as const)(
    "restores a held quantity-one Listing on hold %s, with replay and day-after no-ops",
    async (terminal) => {
      const f = await fixture(pools.marketplace, 1);
      await f.create("lst_one", 1);
      const original = await f.listings.loadListingState("lst_one");
      await f.hold("hold_one", 1);
      expect(await f.listings.loadListingState("lst_one")).toMatchObject({
        status: "paused",
        pauseReason: "inventory-capacity",
      });
      expect(await f.row("lst_one")).toMatchObject({ status: "paused", pause_reason: "inventory-capacity" });
      expect(
        await createListingActionAttentionSourceFromReadModel(pools.marketplace).load({
          accountId: "acc_seller",
          now: new Date().toISOString(),
        }),
      ).toHaveLength(0);
      const pause = (await f.events("lst_one")).find((e) => e.eventType === "marketplace.listing.paused");
      expect(pause?.performedByUserId).toBe("usr_marketplace_system");
      const shortageCount = await f.count();
      await f.reconcile();
      expect(await f.count()).toBe(shortageCount);
      await f.release("hold_one", terminal);
      expect(await f.listings.loadListingState("lst_one")).toMatchObject({
        status: "active",
        pauseReason: null,
        inventoryCapacityRecoveryBlock: null,
        feeLocks: original.feeLocks,
        priceAmount: original.priceAmount,
        quantityCap: 1,
      });
      await f.replay();
      expect(await f.row("lst_one")).toMatchObject({
        status: "active",
        pause_reason: null,
        inventory_capacity_recovery_block: null,
      });
      const replayed = (await f.events("lst_one")).reduce(
        (state, event) =>
          evolveMarketplaceListing(state, {
            type: event.eventType,
            data: event.payload,
          } as MarketplaceListingEvent),
        initialMarketplaceListingState,
      );
      expect(replayed).toEqual(await f.listings.loadListingState("lst_one"));
      const recoveredCount = await f.count();
      await Promise.all([f.reconcile(), f.reconcile()]);
      expect(await f.count()).toBe(recoveredCount);
    },
  );

  it("retains one durable actionable evidence condition across reads/restart, then clears it on recovery or seller pause", async () => {
    const f = await fixture(pools.marketplace, 1);
    await f.create("lst_blocked", 1);
    await f.hold("hold_blocked", 1);
    await pools.marketplace.query(
      "UPDATE marketplace_listing_pages SET product_measure_snapshot = NULL WHERE listing_id = 'lst_blocked'",
    );
    const restart = f.restart({
      evaluate: async () => {
        throw new Error("policy unavailable");
      },
    });
    await f.release("hold_blocked", "released", restart);
    const source = () =>
      createListingActionAttentionSourceFromReadModel(pools.marketplace).load({
        accountId: "acc_seller",
        now: new Date().toISOString(),
      });
    expect(await source()).toMatchObject([
      {
        entity: "listing",
        summary: { params: { action: "inventory-capacity:publication-unavailable" } },
        deepLink: { href: "/account/listings/lst_blocked" },
      },
    ]);
    const blockedCount = await f.count();
    await restart.reconcileInventoryCapacity("inv_shared");
    await f.project();
    expect(await f.count()).toBe(blockedCount);
    expect(await source()).toHaveLength(1);
    await f.replay();
    expect(await source()).toHaveLength(1);
    await f.restart().reconcileInventoryCapacity("inv_shared");
    await f.project();
    expect(await source()).toHaveLength(0);
    await f.hold("hold_again", 1);
    await f.release("hold_again", "released", restart);
    await restart.pauseListing({ accountId: "acc_seller", listingId: "lst_blocked" }, context);
    await f.project();
    expect(await f.row("lst_blocked")).toMatchObject({
      pause_reason: "seller",
      inventory_capacity_recovery_block: null,
    });
    await f.reconcile();
    expect((await f.listings.loadListingState("lst_blocked")).status).toBe("paused");
  });

  it("allocates fitting candidates deterministically after active commitments despite stale projections and concurrent callbacks", async () => {
    const f = await fixture(pools.marketplace, 6);
    await f.create("lst_a_large", 3);
    await f.create("lst_b_small", 1);
    await f.create("lst_z_active", 2);
    await f.hold("hold_shared", 4);
    // Reconciler state must not depend on the display projection, including a stale active row.
    await pools.marketplace.query("UPDATE marketplace_listing_pages SET status = 'active'");
    await f.adjust(4);
    await Promise.all([
      f.listings.reconcileInventoryCapacity("inv_shared"),
      f.restart().reconcileInventoryCapacity("inv_shared"),
    ]);
    const states = await Promise.all(
      ["lst_a_large", "lst_b_small", "lst_z_active"].map((id) => f.listings.loadListingState(id)),
    );
    expect(states.filter((s) => s.status === "active").reduce((sum, s) => sum + s.quantityCap, 0)).toBeLessThanOrEqual(
      0,
    );
    await f.release("hold_shared", "released");
    const recovered = await Promise.all(
      ["lst_a_large", "lst_b_small", "lst_z_active"].map((id) => f.listings.loadListingState(id)),
    );
    expect(recovered.map((s) => s.status)).toEqual(["active", "active", "paused"]);
    expect(recovered.filter((s) => s.status === "active").reduce((sum, s) => sum + s.quantityCap, 0)).toBe(4);
    expect((await f.events("lst_a_large")).filter((e) => e.eventType === "marketplace.listing.published")).toHaveLength(
      2,
    );
    const settled = await f.count();
    await f.reconcile();
    expect(await f.count()).toBe(settled);
  });

  it.each(["pause", "withdraw"] as const)(
    "honors a seller %s immediately before the protected recovery append",
    async (action) => {
      const f = await fixture(pools.marketplace, 1);
      await f.create("lst_race", 1);
      await f.hold("hold_race", 1);
      const inner = f.store;
      let raced = false;
      const racingStore: EventStore = {
        ...inner,
        appendToStreams: async (inputs) => {
          if (!raced && inputs.some((i) => i.events.some((e) => e.eventType === "marketplace.listing.published"))) {
            raced = true;
            if (action === "pause")
              await f.listings.pauseListing({ accountId: "acc_seller", listingId: "lst_race" }, context);
            else await f.listings.withdrawListing({ accountId: "acc_seller", listingId: "lst_race" }, context);
          }
          return inner.appendToStreams!(inputs);
        },
      };
      await f.release("hold_race", "released", f.restart(undefined, racingStore));
      expect(raced).toBe(true);
      expect(await f.listings.loadListingState("lst_race")).toMatchObject({
        status: action === "pause" ? "paused" : "withdrawn",
        inventoryCapacityRecoveryBlock: null,
      });
      expect((await f.events("lst_race")).filter((e) => e.eventType === "marketplace.listing.published")).toHaveLength(
        1,
      );
    },
  );

  it("recovers from existing item-created/adjusted availability callbacks without publishing from attention reads", async () => {
    const f = await fixture(pools.marketplace, 1);
    await f.create("lst_adjust", 1);
    await f.adjust(0);
    expect((await f.listings.loadListingState("lst_adjust")).pauseReason).toBe("inventory-capacity");
    await f.adjust(1);
    expect((await f.listings.loadListingState("lst_adjust")).status).toBe("active");
    const count = await f.count();
    await createListingActionAttentionSourceFromReadModel(pools.marketplace).load({
      accountId: "acc_seller",
      now: new Date().toISOString(),
    });
    expect(await f.count()).toBe(count);
  });

  it("upgrades existing Listing rows without inventing historical capacity provenance", async () => {
    const f = await fixture(pools.marketplace, 1);
    await f.create("lst_legacy", 1);
    await f.listings.pauseListing({ accountId: "acc_seller", listingId: "lst_legacy" }, context);
    await f.project();
    await pools.marketplace.query(
      "ALTER TABLE marketplace_listing_pages DROP COLUMN pause_reason, DROP COLUMN inventory_capacity_recovery_block",
    );
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    expect(await f.row("lst_legacy")).toMatchObject({
      status: "paused",
      pause_reason: null,
      inventory_capacity_recovery_block: null,
    });
    await f.reconcile();
    expect((await f.listings.loadListingState("lst_legacy")).pauseReason).toBe("seller");
  });
});

async function fixture(pool: PgTransactionalPool, total: number) {
  const store = createPostgresEventStore({ pool });
  const restart = (
    listingEvidencePolicyEvaluator?: Parameters<
      typeof createMarketplaceListingRuntime
    >[0]["listingEvidencePolicyEvaluator"],
    eventStore: EventStore = store,
  ) =>
    createMarketplaceListingRuntime({
      eventStore,
      db: pool,
      checkpointStore: createPostgresProjectionStore({ db: pool }),
      listingEvidencePolicyEvaluator,
      commercialTermsResolver: {
        resolveListingTerms: async ({ amount, accountId }: { amount: string; accountId: string }) => ({
          accountId,
          accountType: "business",
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "0.50",
          sellerNetUnitAmount: "9.50",
          scheduleId: "cts_test",
          agreementId: null,
          resolvedAt: "2026-10-28T00:00:00.000Z",
        }),
      } as never,
    });
  const listings = restart();
  const handlers = buildMarketplaceListingProjectionHandlers(pool);
  let projected = new Set<string>();
  async function events(listingId: string) {
    return store.readStream({ streamId: `marketplace.listing-${listingId}` });
  }
  async function project() {
    let afterGlobalPosition;
    for (;;) {
      const page = await store.readAll({ afterGlobalPosition, limit: 500 });
      for (const e of page) {
        if (handlers[e.eventType] && !projected.has(e.eventId)) {
          await handlers[e.eventType]!(toTransportEvent(e));
          projected.add(e.eventId);
        }
      }
      if (page.length < 500) break;
      afterGlobalPosition = page.at(-1)!.globalPosition;
    }
  }
  async function emit(type: string, payload: JsonObject, streamId: string, runtime = listings) {
    const previous = await store.readStream({ streamId });
    const appended = await store.appendToStream({
      streamId,
      expectedVersion: previous.length,
      context,
      events: [{ eventType: type, payload }],
    });
    const supply = buildMarketplaceInventoryProjectionHandlers(pool, {
      onInventoryItemChanged: runtime.reconcileInventoryCapacity,
    });
    await supply[type]!(toTransportEvent(appended[0]!));
    await project();
  }
  await pool.query(
    "INSERT INTO marketplace_catalog_items (catalog_item_id, title, status, product_measure_snapshots) VALUES ('cat_test', 'Test Card', 'published', $1)",
    [JSON.stringify([measure])],
  );
  await emit(
    "inventory.storage-location.created",
    {
      storageLocationId: "loc_test",
      accountId: "acc_seller",
      name: "Main",
      shipFromCode: "CHI",
      shipFromAddress: address,
    },
    "inventory.storage-location-loc_test",
  );
  await emit(
    "inventory.item.created",
    {
      itemId: "inv_shared",
      accountId: "acc_seller",
      catalogItemId: "cat_test",
      productId: "cat_test::",
      selectedOptions: [],
      gradedCard: null,
      storageLocationId: "loc_test",
      totalQuantity: total,
      acquisitionCostAmount: null,
    },
    "inventory.item-inv_shared",
  );
  return {
    listings,
    store,
    restart,
    events,
    project,
    count: async () =>
      Number(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*) AS count FROM event_store_events WHERE event_type LIKE 'marketplace.%'",
          )
        ).rows[0]!.count,
      ),
    row: async (id: string) =>
      (
        await pool.query(
          "SELECT status, pause_reason, inventory_capacity_recovery_block FROM marketplace_listing_pages WHERE listing_id=$1",
          [id],
        )
      ).rows[0],
    create: async (id: string, quantityCap: number) => {
      await listings.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_shared",
          priceAmount: "10.00",
          priceCurrencyCode: "USD",
          quantityCap,
          listingIdOverride: id as never,
        },
        context,
      );
      await listings.publishListing({ accountId: "acc_seller", listingId: id }, context);
      await project();
    },
    hold: (id: string, quantity: number) =>
      emit(
        "inventory.hold.placed",
        {
          holdId: id,
          itemId: "inv_shared",
          accountId: "acc_seller",
          quantity,
          reason: "Ordering commitment",
          notes: null,
          purpose: "order",
          sourceRef: null,
          expiresAt: null,
        },
        `inventory.hold-${id}`,
      ),
    release: (id: string, terminal: "released" | "expired", runtime = listings) =>
      emit(
        `inventory.hold.${terminal}`,
        {
          holdId: id,
          releasedAt: new Date().toISOString(),
          expiredAt: new Date().toISOString(),
          releaseReason: "checkout-expired",
        },
        `inventory.hold-${id}`,
        runtime,
      ),
    adjust: async (totalQuantity: number) => {
      const current = await pool.query<{ total_quantity: number }>(
        "SELECT total_quantity FROM marketplace_supply_items WHERE item_id='inv_shared'",
      );
      await emit(
        "inventory.item.adjusted",
        { itemId: "inv_shared", quantityDelta: totalQuantity - current.rows[0]!.total_quantity },
        "inventory.item-inv_shared",
      );
    },
    reconcile: async () => {
      await listings.reconcileInventoryCapacity("inv_shared");
      await project();
    },
    replay: async () => {
      await pool.query("TRUNCATE marketplace_listing_pages");
      projected = new Set();
      await project();
    },
  };
}
