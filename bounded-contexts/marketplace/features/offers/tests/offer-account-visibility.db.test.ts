import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import {
  getOfferMatch,
  getPublicOffer,
  listOfferMatches,
  listOfferMatchesForSellers,
  listSubmittedOffers,
} from "../read-model/queries";
import { buildMarketplaceOfferProjectionHandlers } from "../read-model/projection";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Offer account DB tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Offer account visibility on Postgres", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["marketplace"], "offer_account_visibility");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pool = createMultiContextTestPools(urls).marketplace;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ marketplace: pool });
    await pool.query(realtimeOutboxSchemaSql);
    await bootstrapContextDatabase(marketplaceModule, pool);
    await pool.query(`
      INSERT INTO marketplace_account_pages (account_id, display_name, status)
      VALUES ('acc_buyer', 'Buyer', 'active'), ('acc_seller', 'Seller', 'active');
      INSERT INTO marketplace_supply_items
        (item_id, account_id, catalog_catalog_item_id, product_id, storage_location_id, total_quantity)
      VALUES ('inv_one', 'acc_seller', 'cat_one', 'cat_one::', 'loc_one', 10);
      INSERT INTO marketplace_listing_pages (
        listing_id, account_id, inventory_item_id, catalog_catalog_item_id, product_id,
        item_title, price_amount, price_currency_code, listing_stream_version,
        marketplace_sales_fee_unit_amount, seller_net_unit_amount, fee_quote_fingerprint,
        quantity_cap, terms_resolved_at, status, product_measure_snapshot
      ) VALUES ('lst_one', 'acc_seller', 'inv_one', 'cat_one', 'cat_one::', 'Item', 100, 'USD', 2,
        0, 100, 'fixture', 10, now(), 'active', '{}'::jsonb);
      INSERT INTO marketplace_offer_pages (
        offer_id, buyer_account_id, catalog_catalog_item_id, product_id, item_title,
        price_amount, price_currency_code, last_stream_version, quantity_requested, status
      ) VALUES ('off_one', 'acc_buyer', 'cat_one', 'cat_one::', 'Item', 80, 'USD', 1, 1, 'submitted');
    `);
  });
  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ marketplace: pool });
  });

  async function status(
    eventType: "identity.account.suspended" | "identity.account.reactivated" | "identity.account.closed",
    version: number,
    globalPosition = String(version),
  ) {
    const services = createMarketplaceServices(pool);
    const subscription = marketplaceModule.buildSubscriptions!(services).find(
      (candidate) => candidate.projectionName === "marketplace-identity-account-projection",
    );
    expect(subscription).toBeDefined();
    expect(subscription!.sourceContextName).toBe("identity");
    await subscription!.handlers[eventType]!(
      buildTransportEvent(
        eventType,
        {},
        {
          id: `evt_${version}`,
          streamId: "identity.account-acc_buyer",
          streamVersion: version,
          globalPosition,
          timing: { occurredAt: `2026-10-17T00:00:0${version}.000Z`, recordedAt: `2026-10-17T00:00:0${version}.000Z` },
        },
      ),
    );
  }

  async function patchRows() {
    const result = await pool.query<{ source_global_position: string; patch_key: string; payload_json: string }>(
      `SELECT source_global_position::text, patch_key, payload_json
       FROM realtime_projection_outbox
       WHERE projection_name = 'marketplace-offer-projection'
       ORDER BY outbox_id ASC`,
    );
    return result.rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as { topics: string[]; changes: unknown[] };
      return {
        sourceGlobalPosition: row.source_global_position,
        patchKey: row.patch_key,
        topics: payload.topics,
        changes: payload.changes,
      };
    });
  }

  it("fences stale and duplicate Offers standing on public reads, seller Match patches and the buyer badge", async () => {
    const subscription = marketplaceModule.buildSubscriptions!(createMarketplaceServices(pool)).find(
      (candidate) => candidate.subscriptionName === "marketplace.self-listing-projection",
    )!;
    const date = "2030-01-01T00:00:00.000Z";
    const data = {
      accountId: "acc_buyer",
      reasonCategory: "travel",
      availableAgainOn: null,
      availableAgainAt: null,
      disabledAt: date,
    };
    const apply = async (
      suffix: string,
      version: number,
      payload: typeof data | { accountId: string; enabledAt: string },
    ) => {
      const type = `marketplace.seller-listing-availability.${suffix}`;
      await subscription.handlers[type]!(
        buildTransportEvent(type, payload, {
          streamId: "marketplace.seller-listing-availability-acc_buyer",
          streamVersion: version,
          globalPosition: String(version),
        }),
      );
    };
    await apply("disabled", 1, data);
    expect(await getPublicOffer(pool, "off_one")).toMatchObject({ offer_id: "off_one" });
    await apply("enabled", 2, { accountId: data.accountId, enabledAt: date });
    await apply("offers-disabled", 3, data);
    expect(await getPublicOffer(pool, "off_one")).toBeNull();
    expect((await listOfferMatches(pool, { sellerAccountId: "acc_seller" })).items).toEqual([]);
    expect((await listSubmittedOffers(pool, { buyerAccountId: "acc_buyer" })).items[0]).toMatchObject({
      status: "submitted",
      offers_away: true,
    });
    expect((await patchRows()).flatMap((row) => row.changes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "remove", entity: "marketplace.offerMatch", id: "off_one" }),
        expect.objectContaining({
          op: "upsert",
          entity: "marketplace.offer",
          value: expect.objectContaining({ offers_away: true }),
        }),
      ]),
    );
    const awayPatches = await patchRows();
    await apply("offers-enabled", 2, { accountId: data.accountId, enabledAt: date });
    await apply("offers-disabled", 3, data);
    expect(await getPublicOffer(pool, "off_one")).toBeNull();
    expect(await getOfferMatch(pool, "off_one", "acc_seller")).toBeNull();
    expect((await listSubmittedOffers(pool, { buyerAccountId: "acc_buyer" })).items[0]?.offers_away).toBe(true);
    expect(await patchRows()).toEqual(awayPatches);

    await apply("offers-enabled", 4, { accountId: data.accountId, enabledAt: date });
    expect(await getPublicOffer(pool, "off_one")).toMatchObject({ offer_id: "off_one" });
    expect((await listSubmittedOffers(pool, { buyerAccountId: "acc_buyer" })).items[0]?.offers_away).toBe(false);
    expect(await getOfferMatch(pool, "off_one", "acc_seller")).toMatchObject({ offer_id: "off_one" });
    const resumedPatches = await patchRows();
    expect(resumedPatches.slice(awayPatches.length).flatMap((row) => row.changes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "upsert", entity: "marketplace.offerMatch", id: "off_one" }),
        expect.objectContaining({
          op: "upsert",
          entity: "marketplace.offer",
          value: expect.objectContaining({ offers_away: false }),
        }),
      ]),
    );
    await apply("offers-disabled", 3, data);
    await apply("offers-enabled", 4, { accountId: data.accountId, enabledAt: date });
    expect(await getPublicOffer(pool, "off_one")).toMatchObject({ offer_id: "off_one" });
    expect((await listSubmittedOffers(pool, { buyerAccountId: "acc_buyer" })).items[0]?.offers_away).toBe(false);
    expect(await patchRows()).toEqual(resumedPatches);
  });

  it("hides and restores every Offer read, and stale or duplicate lifecycle events are no-ops", async () => {
    expect(await getPublicOffer(pool, "off_one")).toMatchObject({ offer_id: "off_one" });
    expect(await getOfferMatch(pool, "off_one", "acc_seller")).toMatchObject({ offer_id: "off_one" });
    expect((await listOfferMatchesForSellers(pool, "off_one", ["acc_seller"])).has("acc_seller")).toBe(true);
    await status("identity.account.suspended", 2);
    expect(await getPublicOffer(pool, "off_one")).toBeNull();
    expect(await getOfferMatch(pool, "off_one", "acc_seller")).toBeNull();
    expect((await listOfferMatchesForSellers(pool, "off_one", ["acc_seller"])).size).toBe(0);
    expect(await patchRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceGlobalPosition: "2",
          patchKey: "offer-match:off_one:acc_seller",
          changes: [expect.objectContaining({ op: "remove", entity: "marketplace.offerMatch", id: "off_one" })],
        }),
      ]),
    );
    const suspendedPatchCount = (await patchRows()).length;
    await status("identity.account.suspended", 2);
    await status("identity.account.reactivated", 1);
    expect(
      (
        await pool.query<{ status: string; status_stream_version: number }>(
          `SELECT status, status_stream_version FROM marketplace_account_pages WHERE account_id = 'acc_buyer'`,
        )
      ).rows[0],
    ).toEqual({ status: "suspended", status_stream_version: 2 });
    expect((await patchRows()).length).toBe(suspendedPatchCount);
    await status("identity.account.reactivated", 3);
    expect(await getPublicOffer(pool, "off_one")).toMatchObject({ offer_id: "off_one" });
    expect(await getOfferMatch(pool, "off_one", "acc_seller")).toMatchObject({ offer_id: "off_one" });
    expect((await listOfferMatchesForSellers(pool, "off_one", ["acc_seller"])).size).toBe(1);
    expect(await patchRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceGlobalPosition: "3",
          patchKey: "offer-match:off_one:acc_seller",
          changes: [expect.objectContaining({ op: "upsert", entity: "marketplace.offerMatch", id: "off_one" })],
        }),
      ]),
    );
    await status("identity.account.closed", 4);
    expect(await getPublicOffer(pool, "off_one")).toBeNull();
    expect(await getOfferMatch(pool, "off_one", "acc_seller")).toBeNull();
    expect((await listOfferMatchesForSellers(pool, "off_one", ["acc_seller"])).size).toBe(0);
    await status("identity.account.suspended", 1, "11");
    await status("identity.account.closed", 3, "30");
    expect(
      (
        await pool.query<{ status: string; status_stream_version: number }>(
          `SELECT status, status_stream_version FROM marketplace_account_pages WHERE account_id = 'acc_buyer'`,
        )
      ).rows[0],
    ).toEqual({ status: "closed", status_stream_version: 4 });
    expect((await patchRows()).some((row) => row.sourceGlobalPosition === "11")).toBe(false);
    expect((await patchRows()).some((row) => row.sourceGlobalPosition === "30")).toBe(false);
  });

  async function seedInventoryOnlySeller() {
    await pool.query(`
      INSERT INTO marketplace_account_pages (account_id, display_name, status) VALUES ('acc_stock', 'Stock', 'active');
      INSERT INTO marketplace_supply_items
        (item_id, account_id, catalog_catalog_item_id, product_id, storage_location_id, total_quantity)
      VALUES ('inv_stock', 'acc_stock', 'cat_one', 'cat_one::', 'loc_stock', 2);
    `);
  }

  it("sends an inventory-only seller an upsert for a new Offer and a removal when the buyer goes Away for Offers", async () => {
    await seedInventoryOnlySeller();
    await buildMarketplaceOfferProjectionHandlers(pool)["marketplace.offer.submitted"]!(
      buildTransportEvent(
        "marketplace.offer.submitted",
        {
          offerId: "off_two",
          buyerAccountId: "acc_buyer",
          catalogItemId: "cat_one",
          productId: "cat_one::",
          itemTitle: "Item",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          shippingDestinationSnapshot: {},
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityRequested: 1,
        },
        { id: "evt_off_two", streamId: "marketplace.offer-off_two", streamVersion: 1, globalPosition: "5" },
      ),
    );
    expect(await patchRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          patchKey: "offer-match:off_two:acc_stock",
          topics: ["account:acc_stock:offer-matches"],
          changes: [
            expect.objectContaining({
              op: "upsert",
              entity: "marketplace.offerMatch",
              id: "off_two",
              value: expect.objectContaining({ fill_source: "inventory", inventory_item_id: "inv_stock" }),
            }),
          ],
        }),
        expect.objectContaining({ patchKey: "offer:off_two", topics: ["account:acc_buyer:offers"] }),
      ]),
    );
    const offersTopicEntities = (await patchRows())
      .filter((row) => row.topics.some((topic) => topic.endsWith(":offers")))
      .flatMap((row) => row.changes.map((change) => (change as { entity: string }).entity));
    expect(offersTopicEntities).not.toContain("marketplace.offerMatch");

    const subscription = marketplaceModule.buildSubscriptions!(createMarketplaceServices(pool)).find(
      (candidate) => candidate.subscriptionName === "marketplace.self-listing-projection",
    )!;
    const before = (await patchRows()).length;
    await subscription.handlers["marketplace.seller-listing-availability.offers-disabled"]!(
      buildTransportEvent(
        "marketplace.seller-listing-availability.offers-disabled",
        {
          accountId: "acc_buyer",
          reasonCategory: "travel",
          availableAgainOn: null,
          availableAgainAt: null,
          disabledAt: "2030-01-01T00:00:00.000Z",
        },
        { streamId: "marketplace.seller-listing-availability-acc_buyer", streamVersion: 1, globalPosition: "6" },
      ),
    );
    expect((await patchRows()).slice(before)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          patchKey: "offer-match-away:off_two:acc_stock",
          changes: [expect.objectContaining({ op: "remove", entity: "marketplace.offerMatch", id: "off_two" })],
        }),
      ]),
    );
    expect(await getOfferMatch(pool, "off_two", "acc_stock")).toBeNull();
    expect((await listOfferMatches(pool, { sellerAccountId: "acc_stock" })).items).toEqual([]);
    expect((await listOfferMatchesForSellers(pool, "off_two", ["acc_stock"])).size).toBe(0);
  });

  it("hides inventory Matches while the buyer is suspended", async () => {
    await seedInventoryOnlySeller();
    expect(await getOfferMatch(pool, "off_one", "acc_stock")).toMatchObject({
      fill_source: "inventory",
      inventory_item_id: "inv_stock",
    });
    await status("identity.account.suspended", 2);
    expect(await getOfferMatch(pool, "off_one", "acc_stock")).toBeNull();
    expect((await listOfferMatches(pool, { sellerAccountId: "acc_stock" })).items).toEqual([]);
    expect((await listOfferMatchesForSellers(pool, "off_one", ["acc_stock"])).size).toBe(0);
    expect(await patchRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          patchKey: "offer-match:off_one:acc_stock",
          changes: [expect.objectContaining({ op: "remove", entity: "marketplace.offerMatch", id: "off_one" })],
        }),
      ]),
    );
  });
});
