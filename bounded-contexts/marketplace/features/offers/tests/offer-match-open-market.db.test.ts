import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as marketplaceModule } from "../../../index";
import {
  getOfferMatch,
  getOfferMatchForListing,
  listOfferMatches,
  listOfferMatchesForSellers,
} from "../read-model/queries";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Offer Match DB tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("open-market Offer Matches on Postgres", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["marketplace"], "offer_match_open_market");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    await pools.marketplace.query(
      `INSERT INTO marketplace_account_pages (account_id, display_name, status)
       VALUES ('acc_buyer', 'Buyer', 'active'),
              ('acc_seller_a', 'Seller A', 'active'),
              ('acc_seller_b', 'Seller B', 'active'),
              ('acc_seller_c', 'Seller C', 'active')`,
    );
    for (const [seller, amount] of [
      ["acc_seller_a", "10.00"],
      ["acc_seller_b", "14.00"],
      ["acc_seller_c", "20.00"],
    ]) {
      await seedListing(seller!, `lst_${seller}`, amount!);
    }
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function seedListing(seller: string, listingId: string, amount: string) {
    const itemId = `inv_${listingId}`;
    await pools.marketplace.query(
      `INSERT INTO marketplace_supply_items (
        item_id, account_id, catalog_catalog_item_id, product_id, storage_location_id, total_quantity
      ) VALUES ($1, $2, 'cat_one', 'cat_one::', 'loc_fixture', 10)`,
      [itemId, seller],
    );
    await pools.marketplace.query(
      `INSERT INTO marketplace_listing_pages (
        listing_id, account_id, inventory_item_id, catalog_catalog_item_id, product_id,
        price_amount, price_currency_code, listing_stream_version, marketplace_sales_fee_unit_amount,
        seller_net_unit_amount, fee_quote_fingerprint, quantity_cap, status
      ) VALUES ($1, $2, $3, 'cat_one', 'cat_one::', $4, 'USD', 2, 0, $4, 'fixture', 10, 'active')`,
      [listingId, seller, itemId, amount],
    );
  }
  async function seedOffer(offerId: string, amount = "1.00", { productId = "cat_one::", quantity = 1 } = {}) {
    await pools.marketplace.query(
      `INSERT INTO marketplace_offer_pages (
        offer_id, buyer_account_id, catalog_catalog_item_id, product_id, item_title,
        price_amount, price_currency_code, last_stream_version, quantity_requested, status
      ) VALUES ($1, 'acc_buyer', 'cat_one', $3, 'Item', $2, 'USD', 1, $4, 'submitted')`,
      [offerId, amount, productId, quantity],
    );
  }
  async function seedInventory(seller: string, itemId: string, quantity: number, productId = "cat_one::") {
    await pools.marketplace.query(
      `INSERT INTO marketplace_supply_items (
        item_id, account_id, catalog_catalog_item_id, product_id, storage_location_id, total_quantity
      ) VALUES ($1, $2, 'cat_one', $3, 'loc_fixture', $4)`,
      [itemId, seller, productId, quantity],
    );
  }
  async function seedHold(seller: string, itemId: string, quantity: number) {
    await pools.marketplace.query(
      `INSERT INTO marketplace_supply_holds (hold_id, account_id, item_id, quantity, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [`hold_${itemId}_${quantity}`, seller, itemId, quantity],
    );
  }
  const listingOnlyKeys = [
    "listing_id",
    "listing_price_amount",
    "listing_price_currency_code",
    "listing_stream_version",
    "listing_quantity_cap",
    "listing_visible_quantity",
    "offer_price_gap_amount",
    "offer_to_listing_price_bps",
    "seller_available_quantity",
    "seller_listing_availability_status",
  ];
  async function expectVisibleEverywhere(offerId: string, seller: string, listingId: string) {
    const db = pools.marketplace;
    const list = await listOfferMatches(db, { sellerAccountId: seller, canFulfill: true });
    expect(list.items.map((row) => row.offer_id)).toContain(offerId);
    expect(await getOfferMatch(db, offerId, seller)).toMatchObject({
      offer_id: offerId,
      fill_source: "listing",
      can_fulfill: true,
    });
    expect(await getOfferMatchForListing(db, offerId, seller, listingId)).toMatchObject({ offer_id: offerId });
    expect((await listOfferMatchesForSellers(db, offerId, [seller])).get(seller)).toMatchObject({
      offer_id: offerId,
      fill_source: "listing",
    });
  }

  it("shows a $1 Offer to sellers asking $10, $14 and $20", async () => {
    await seedOffer("off_one");
    for (const seller of ["acc_seller_a", "acc_seller_b", "acc_seller_c"]) {
      await expectVisibleEverywhere("off_one", seller, `lst_${seller}`);
    }
  });

  it("ignores historical buyer mutes and future cooldowns in all four Match reads", async () => {
    await seedOffer("off_one");
    await pools.marketplace.query(
      `INSERT INTO marketplace_offer_seller_controls (
        seller_account_id, buyer_account_id, listing_id, product_id, muted_at,
        lowball_decline_count, last_lowball_declined_amount, last_lowball_declined_currency_code, lowball_cooldown_until
      ) VALUES ('acc_seller_a', 'acc_buyer', 'lst_acc_seller_a', 'cat_one::', now(), 2, 2, 'USD', now() + interval '7 days')`,
    );
    await expectVisibleEverywhere("off_one", "acc_seller_a", "lst_acc_seller_a");
  });

  it("retains currency, active Listing and available supply gates", async () => {
    const db = pools.marketplace;
    await seedOffer("off_one");
    await db.query(
      "UPDATE marketplace_listing_pages SET price_currency_code = 'EUR' WHERE account_id = 'acc_seller_a'",
    );
    // The EUR Listing no longer qualifies, so the Listing's in-stock item matches from inventory instead.
    expect(
      (await listOfferMatches(db, { sellerAccountId: "acc_seller_a" })).items.map((row) => row.fill_source),
    ).toEqual(["inventory"]);
    expect(await getOfferMatch(db, "off_one", "acc_seller_a")).toMatchObject({ fill_source: "inventory" });
    expect(await getOfferMatchForListing(db, "off_one", "acc_seller_a", "lst_acc_seller_a")).toBeNull();
    expect((await listOfferMatchesForSellers(db, "off_one", ["acc_seller_a"])).get("acc_seller_a")).toMatchObject({
      fill_source: "inventory",
    });
    await db.query(
      "UPDATE marketplace_listing_pages SET price_currency_code = 'USD', status = 'paused' WHERE account_id = 'acc_seller_a'",
    );
    expect(await getOfferMatch(db, "off_one", "acc_seller_a")).toMatchObject({ fill_source: "inventory" });
    expect(await getOfferMatchForListing(db, "off_one", "acc_seller_a", "lst_acc_seller_a")).toBeNull();
    await db.query("UPDATE marketplace_listing_pages SET status = 'active' WHERE account_id = 'acc_seller_a'");
    await db.query("UPDATE marketplace_supply_items SET total_quantity = 0 WHERE account_id = 'acc_seller_a'");
    expect((await listOfferMatches(db, { sellerAccountId: "acc_seller_a", canFulfill: true })).items).toEqual([]);
    expect(await getOfferMatch(db, "off_one", "acc_seller_a")).toMatchObject({
      fill_source: "listing",
      can_fulfill: false,
    });
  });

  it("keeps declined Offers hidden across Listings and a best-Listing switch, but not from another seller", async () => {
    const db = pools.marketplace;
    await seedListing("acc_seller_a", "lst_alternative", "12.00");
    for (const [id, amount] of [
      ["off_first", "3.00"],
      ["off_second", "2.00"],
      ["off_third", "1.50"],
      ["off_fourth", "1.00"],
    ]) {
      await seedOffer(id!, amount);
    }
    expect(await getOfferMatch(db, "off_first", "acc_seller_a")).toMatchObject({ listing_id: "lst_acc_seller_a" });
    for (const offerId of ["off_first", "off_second"]) {
      await db.query(
        `INSERT INTO marketplace_offer_seller_declines (
          seller_account_id, buyer_account_id, listing_id, product_id, offer_id,
          offer_price_amount, offer_price_currency_code, listing_price_amount, listing_price_currency_code, declined_at
        ) VALUES ('acc_seller_a', 'acc_buyer', 'lst_acc_seller_a', 'cat_one::', $1, 2, 'USD', 10, 'USD', now())`,
        [offerId],
      );
    }
    for (const switchBest of [false, true]) {
      if (switchBest)
        await db.query("UPDATE marketplace_listing_pages SET price_amount = 8 WHERE listing_id = 'lst_alternative'");
      const list = await listOfferMatches(db, { sellerAccountId: "acc_seller_a" });
      expect(list.total).toBe(2);
      expect(list.items.map((row) => row.offer_id).sort()).toEqual(["off_fourth", "off_third"]);
      expect(await getOfferMatch(db, "off_fourth", "acc_seller_a")).toMatchObject({
        listing_id: switchBest ? "lst_alternative" : "lst_acc_seller_a",
      });
      for (const offerId of ["off_first", "off_second"]) {
        expect(await getOfferMatch(db, offerId, "acc_seller_a")).toBeNull();
        for (const listing of ["lst_acc_seller_a", "lst_alternative"]) {
          expect(await getOfferMatchForListing(db, offerId, "acc_seller_a", listing)).toBeNull();
        }
        const batch = await listOfferMatchesForSellers(db, offerId, ["acc_seller_a", "acc_seller_b"]);
        expect(batch.has("acc_seller_a")).toBe(false);
        expect(batch.get("acc_seller_b")).toMatchObject({ offer_id: offerId });
        await expectVisibleEverywhere(offerId, "acc_seller_b", "lst_acc_seller_b");
      }
      await expectVisibleEverywhere("off_fourth", "acc_seller_a", "lst_alternative");
    }
  });

  it("shows an inventory-only seller the Offer from the item with the most available stock, and a seller with neither nothing", async () => {
    const db = pools.marketplace;
    await seedInventory("acc_seller_d", "inv_d_b", 2);
    await seedInventory("acc_seller_d", "inv_d_a", 2);
    await seedInventory("acc_seller_d", "inv_d_c", 1);
    await seedOffer("off_one", "4.00");

    const list = await listOfferMatches(db, { sellerAccountId: "acc_seller_d" });
    expect(list.total).toBe(1);
    expect(list.items).toEqual([
      expect.objectContaining({
        offer_id: "off_one",
        fill_source: "inventory",
        can_fulfill: false,
        inventory_item_id: "inv_d_a",
        inventory_available_quantity: 2,
        buyer_display_name: "Buyer",
      }),
    ]);
    for (const key of listingOnlyKeys) expect(list.items[0]).not.toHaveProperty(key);
    expect(await getOfferMatch(db, "off_one", "acc_seller_d")).toMatchObject({ inventory_item_id: "inv_d_a" });
    expect((await listOfferMatchesForSellers(db, "off_one", ["acc_seller_d"])).get("acc_seller_d")).toMatchObject({
      fill_source: "inventory",
      inventory_item_id: "inv_d_a",
    });
    expect((await listOfferMatches(db, { sellerAccountId: "acc_seller_d", canFulfill: true })).items).toEqual([]);

    await seedHold("acc_seller_d", "inv_d_a", 1);
    expect(await getOfferMatch(db, "off_one", "acc_seller_d")).toMatchObject({
      inventory_item_id: "inv_d_b",
      inventory_available_quantity: 2,
    });

    await seedHold("acc_seller_d", "inv_d_b", 2);
    await db.query("UPDATE marketplace_supply_items SET total_quantity = 1 WHERE item_id IN ('inv_d_a', 'inv_d_c')");
    await seedHold("acc_seller_d", "inv_d_c", 1);
    expect(await getOfferMatch(db, "off_one", "acc_seller_d")).toBeNull();

    expect((await listOfferMatches(db, { sellerAccountId: "acc_seller_none" })).items).toEqual([]);
    expect(await getOfferMatch(db, "off_one", "acc_seller_none")).toBeNull();
    expect((await listOfferMatchesForSellers(db, "off_one", ["acc_seller_none"])).size).toBe(0);
  });

  it("never shows a seller their own Offer from a Listing or inventory", async () => {
    const db = pools.marketplace;
    await seedListing("acc_buyer", "lst_acc_buyer", "9.00");
    await seedInventory("acc_buyer", "inv_buyer_extra", 5);
    await seedOffer("off_one");

    expect((await listOfferMatches(db, { sellerAccountId: "acc_buyer" })).items).toEqual([]);
    expect(await getOfferMatch(db, "off_one", "acc_buyer")).toBeNull();
    const batch = await listOfferMatchesForSellers(db, "off_one", ["acc_buyer", "acc_seller_a"]);
    expect(batch.has("acc_buyer")).toBe(false);
    expect(batch.get("acc_seller_a")).toMatchObject({ fill_source: "listing" });
  });

  it("prefers the Listing when a seller also holds inventory and lists inventory Matches after Listing Matches", async () => {
    const db = pools.marketplace;
    await seedInventory("acc_seller_a", "inv_a_extra", 50);
    await seedInventory("acc_seller_a", "inv_a_two", 2, "cat_two::");
    await seedOffer("off_listing", "2.00");
    await seedOffer("off_short_high", "9.00", { productId: "cat_two::", quantity: 3 });
    await seedOffer("off_cover_low", "3.00", { productId: "cat_two::", quantity: 1 });
    await seedOffer("off_cover_high", "6.00", { productId: "cat_two::", quantity: 2 });

    const list = await listOfferMatches(db, { sellerAccountId: "acc_seller_a" });
    expect(list.items.map((row) => [row.offer_id, row.fill_source])).toEqual([
      ["off_listing", "listing"],
      ["off_cover_high", "inventory"],
      ["off_cover_low", "inventory"],
      ["off_short_high", "inventory"],
    ]);
    expect(list.items[0]).toMatchObject({ listing_id: "lst_acc_seller_a", can_fulfill: true });
    expect(list.items[0]).not.toHaveProperty("inventory_item_id");
    expect(list.items[0]).not.toHaveProperty("inventory_available_quantity");
    expect(list.items[3]).toMatchObject({ inventory_item_id: "inv_a_two", inventory_available_quantity: 2 });
    expect(
      (await listOfferMatches(db, { sellerAccountId: "acc_seller_a", canFulfill: true })).items.map(
        (row) => row.offer_id,
      ),
    ).toEqual(["off_listing"]);
    expect((await listOfferMatches(db, { sellerAccountId: "acc_seller_b" })).items.map((row) => row.offer_id)).toEqual([
      "off_listing",
    ]);
  });
});
