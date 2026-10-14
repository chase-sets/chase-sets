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
import { module as marketplaceModule } from "../../../index";
import { buildMarketplaceOfferProjectionHandlers } from "../read-model/projection";
import { getOfferMatch, getPublicOffer, listOfferMatches, listSubmittedOffers } from "../read-model/queries";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Offer lifecycle DB tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Offer lifecycle visibility on Postgres", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;
  let position = 0;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["marketplace"], "offer_lifecycle_visibility");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    position = 0;
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    await pools.marketplace.query(
      `INSERT INTO marketplace_supply_items (
        item_id, account_id, catalog_catalog_item_id, product_id, storage_location_id, total_quantity
      ) VALUES ('inv_seller', 'acc_seller', 'cat_one', 'cat_one::', 'loc_fixture', 10)`,
    );
    await pools.marketplace.query(
      `INSERT INTO marketplace_listing_pages (
        listing_id, account_id, inventory_item_id, catalog_catalog_item_id, product_id,
        price_amount, price_currency_code, listing_stream_version, marketplace_sales_fee_unit_amount,
        seller_net_unit_amount, fee_quote_fingerprint, quantity_cap, status
      ) VALUES ('lst_seller', 'acc_seller', 'inv_seller', 'cat_one', 'cat_one::', 10, 'USD', 2, 0, 10, 'fixture', 10, 'active')`,
    );
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function project(type: string, streamVersion: number, data: Record<string, unknown> = {}) {
    position += 1;
    const handlers = buildMarketplaceOfferProjectionHandlers(pools.marketplace);
    await handlers[type]!(
      buildTransportEvent(
        type,
        { offerId: "off_one", buyerAccountId: "acc_buyer", at: "2026-10-14T00:00:00.000Z", ...data },
        {
          id: `evt_${position}`,
          streamId: "marketplace.offer-off_one",
          streamVersion,
          globalPosition: String(position),
          timing: {
            occurredAt: `2026-10-14T00:00:0${position}.000Z`,
            recordedAt: `2026-10-14T00:00:0${position}.000Z`,
          },
        },
      ),
    );
  }

  async function reads() {
    const db = pools.marketplace;
    return {
      matches: (await listOfferMatches(db, { sellerAccountId: "acc_seller" })).items.map((row) => row.offer_id),
      match: await getOfferMatch(db, "off_one", "acc_seller"),
      publicOffer: await getPublicOffer(db, "off_one"),
      submitted: await listSubmittedOffers(db, { buyerAccountId: "acc_buyer", status: "submitted" }),
      all: await listSubmittedOffers(db, { buyerAccountId: "acc_buyer" }),
    };
  }

  async function expectOpenAt(priceAmount: string) {
    const current = await reads();
    expect(current.matches).toEqual(["off_one"]);
    expect(current.match).toMatchObject({ offer_id: "off_one", price_amount: priceAmount });
    expect(current.publicOffer).toMatchObject({ offer_id: "off_one", status: "submitted", price_amount: priceAmount });
    expect(current.submitted.items.map((row) => row.offer_id)).toEqual(["off_one"]);
  }

  async function expectHidden(status: "paused" | "withdrawn", priceAmount: string) {
    const current = await reads();
    expect(current.matches).toEqual([]);
    expect(current.match).toBeNull();
    expect(current.publicOffer).toBeNull();
    expect(current.submitted).toMatchObject({ items: [], total: 0 });
    const filtered = await listSubmittedOffers(pools.marketplace, { buyerAccountId: "acc_buyer", status });
    expect(filtered.items).toEqual([expect.objectContaining({ offer_id: "off_one", status, price_amount: priceAmount })]);
    expect(filtered.total).toBe(1);
    expect(current.all.statusCounts).toEqual({
      submitted: 0,
      paused: status === "paused" ? 1 : 0,
      withdrawn: status === "withdrawn" ? 1 : 0,
      accepted: 0,
    });
    expect(current.all.total).toBe(1);
  }

  it("hides a paused Offer from every read, keeps a paused re-price paused, and restores it at that price", async () => {
    await project("marketplace.offer.submitted", 1, {
      catalogItemId: "cat_one",
      productId: "cat_one::",
      itemTitle: "Item",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      shippingDestinationSnapshot: { name: "Buyer", line1: "1 Main", city: "Chicago", state: "IL", postalCode: "60601", country: "US" },
      priceAmount: "5.00",
      priceCurrencyCode: "USD",
      quantityRequested: 1,
    });
    await expectOpenAt("5.00");

    await project("marketplace.offer.paused", 2);
    await expectHidden("paused", "5.00");

    await project("marketplace.offer.price-updated", 3, { priceAmount: "6.00", priceCurrencyCode: "USD" });
    await expectHidden("paused", "6.00");

    await project("marketplace.offer.resumed", 4);
    await expectOpenAt("6.00");

    // A redelivered older Pause must not overwrite the newer Resume.
    await project("marketplace.offer.paused", 2);
    await expectOpenAt("6.00");

    await project("marketplace.offer.withdrawn", 5);
    await expectHidden("withdrawn", "6.00");
  });
});
