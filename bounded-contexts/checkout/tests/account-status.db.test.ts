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
import { module as checkoutModule } from "../index";
import { buildCheckoutIdentitySellerAccountsProjectionHandlers } from "../features/cart/integrations/identity/identity-projection";
import { getCheckoutSellOfferMatch, listCheckoutSellOfferMatches } from "../features/sell-list/read-model/queries";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Checkout account DB tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Checkout account status visibility on Postgres", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["checkout"], "checkout_account_status");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pool = createMultiContextTestPools(urls).checkout;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ checkout: pool });
    await bootstrapContextDatabase(checkoutModule, pool);
    await pool.query(`
      INSERT INTO checkout_seller_accounts (account_id, display_name, slug, status, status_stream_version)
      VALUES ('acc_buyer', 'Buyer', 'buyer', 'active', 1), ('acc_seller', 'Seller', 'seller', 'active', 1);
      INSERT INTO checkout_marketplace_seller_options
        (listing_id, seller_account_id, product_id, catalog_catalog_item_id, price_amount, price_currency_code,
         listing_stream_version, listing_quantity_cap, product_measure_snapshot, status, updated_at,
         supply_total_quantity, active_held_quantity, inventory_item_id)
      VALUES ('lst_one', 'acc_seller', 'cat_one::', 'cat_one', 100, 'USD', 2, 10, '{}'::jsonb, 'active', now(), 10, 0, 'inv_one');
      INSERT INTO checkout_sell_offer_pages
        (offer_id, buyer_account_id, catalog_catalog_item_id, product_id, item_title, price_amount,
         price_currency_code, quantity_requested, status, last_stream_version)
      VALUES ('off_one', 'acc_buyer', 'cat_one', 'cat_one::', 'Item', 80, 'USD', 1, 'submitted', 2);
    `);
  });
  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ checkout: pool });
  });

  async function status(
    eventType: "identity.account.suspended" | "identity.account.reactivated" | "identity.account.closed",
    version: number,
  ) {
    const handlers = buildCheckoutIdentitySellerAccountsProjectionHandlers(pool);
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

  async function profile(version: number) {
    const handlers = buildCheckoutIdentitySellerAccountsProjectionHandlers(pool);
    await handlers["identity.account.profile-updated"]!(
      buildTransportEvent(
        "identity.account.profile-updated",
        { displayName: "Renamed Buyer" },
        {
          id: `profile_${version}`,
          streamId: "identity.account-acc_buyer",
          streamVersion: version,
          globalPosition: String(version),
          timing: { occurredAt: `2026-10-17T00:00:0${version}.000Z`, recordedAt: `2026-10-17T00:00:0${version}.000Z` },
        },
      ),
    );
  }

  it("replays profile history without regressing status and hides/restores Offer matches", async () => {
    expect(await getCheckoutSellOfferMatch(pool, "acc_seller", "off_one")).toMatchObject({ offer_id: "off_one" });
    expect(
      await listCheckoutSellOfferMatches(pool, { sellerAccountId: "acc_seller", productIds: ["cat_one::"] }),
    ).toHaveLength(1);
    await status("identity.account.suspended", 2);
    expect(await getCheckoutSellOfferMatch(pool, "acc_seller", "off_one")).toBeNull();
    expect(
      await listCheckoutSellOfferMatches(pool, { sellerAccountId: "acc_seller", productIds: ["cat_one::"] }),
    ).toHaveLength(0);
    await profile(3);
    expect(
      (
        await pool.query<{ display_name: string; status: string }>(
          `SELECT display_name, status FROM checkout_seller_accounts WHERE account_id = 'acc_buyer'`,
        )
      ).rows[0],
    ).toEqual({ display_name: "Renamed Buyer", status: "suspended" });
    await status("identity.account.reactivated", 1);
    expect(
      (
        await pool.query<{ status: string; status_stream_version: number }>(
          `SELECT status, status_stream_version FROM checkout_seller_accounts WHERE account_id = 'acc_buyer'`,
        )
      ).rows[0],
    ).toEqual({ status: "suspended", status_stream_version: 2 });
    await status("identity.account.reactivated", 4);
    expect(await getCheckoutSellOfferMatch(pool, "acc_seller", "off_one")).toMatchObject({ offer_id: "off_one" });
    await status("identity.account.closed", 5);
    expect(await getCheckoutSellOfferMatch(pool, "acc_seller", "off_one")).toBeNull();
  });
});
