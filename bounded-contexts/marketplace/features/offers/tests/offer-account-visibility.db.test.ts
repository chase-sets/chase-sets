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
import { buildMarketplaceAccountProjectionHandlers } from "../../listings/integrations/supply/supply-projection";
import { getOfferMatch, getPublicOffer, listOfferMatchesForSellers } from "../read-model/queries";

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
    await bootstrapContextDatabase(marketplaceModule, pool);
    await pool.query(`
      INSERT INTO marketplace_account_pages (account_id, display_name, status)
      VALUES ('acc_buyer', 'Buyer', 'active'), ('acc_seller', 'Seller', 'active');
      INSERT INTO marketplace_supply_items (item_id, account_id, catalog_catalog_item_id, product_id, total_quantity)
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
  ) {
    const handlers = buildMarketplaceAccountProjectionHandlers(pool, { onAccountStatusChanged: async () => undefined });
    await handlers[eventType]!(
      buildTransportEvent(
        eventType,
        {},
        {
          id: `evt_${version}`,
          streamId: "identity.account-acc_buyer",
          streamVersion: version,
          globalPosition: String(version),
          timing: { occurredAt: `2026-10-17T00:00:0${version}.000Z`, recordedAt: `2026-10-17T00:00:0${version}.000Z` },
        },
      ),
    );
  }

  it("hides and restores every Offer read, and stale or duplicate lifecycle events are no-ops", async () => {
    expect(await getPublicOffer(pool, "off_one")).toMatchObject({ offer_id: "off_one" });
    expect(await getOfferMatch(pool, "off_one", "acc_seller")).toMatchObject({ offer_id: "off_one" });
    expect((await listOfferMatchesForSellers(pool, "off_one", ["acc_seller"])).has("acc_seller")).toBe(true);
    await status("identity.account.suspended", 2);
    expect(await getPublicOffer(pool, "off_one")).toBeNull();
    expect(await getOfferMatch(pool, "off_one", "acc_seller")).toBeNull();
    expect((await listOfferMatchesForSellers(pool, "off_one", ["acc_seller"])).size).toBe(0);
    await status("identity.account.suspended", 2);
    await status("identity.account.reactivated", 1);
    expect(
      (
        await pool.query<{ status: string; status_stream_version: number }>(
          `SELECT status, status_stream_version FROM marketplace_account_pages WHERE account_id = 'acc_buyer'`,
        )
      ).rows[0],
    ).toEqual({ status: "suspended", status_stream_version: 2 });
    await status("identity.account.reactivated", 3);
    expect(await getPublicOffer(pool, "off_one")).toMatchObject({ offer_id: "off_one" });
    await status("identity.account.closed", 4);
    expect(await getPublicOffer(pool, "off_one")).toBeNull();
  });
});
