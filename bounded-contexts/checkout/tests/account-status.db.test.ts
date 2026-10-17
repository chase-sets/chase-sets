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

  function identityEvent(type: string, streamId: string, streamVersion: number, data: Record<string, unknown>) {
    return buildTransportEvent(type, data, {
      id: `evt_${streamId}_${streamVersion}`,
      streamId,
      streamVersion,
      globalPosition: `${streamVersion}`,
      timing: {
        occurredAt: `2026-10-17T00:00:0${Math.min(streamVersion, 9)}.000Z`,
        recordedAt: `2026-10-17T00:00:0${Math.min(streamVersion, 9)}.000Z`,
      },
    });
  }

  function addressData(accountId: string, shippingAddressId: string, line1: string) {
    return {
      accountId,
      shippingAddressId,
      label: "Home",
      address: {
        name: "Buyer",
        company: null,
        line1,
        line2: null,
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        phone: null,
        email: null,
      },
      isDefault: true,
      addedAt: "2026-10-17T00:00:01.000Z",
      updatedAt: "2026-10-17T00:00:01.000Z",
    };
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

  it("replays lifecycle and shipping addresses from empty and over advanced rows", async () => {
    const handlers = buildCheckoutIdentitySellerAccountsProjectionHandlers(pool);
    const project = async (type: string, streamId: string, version: number, data: Record<string, unknown>) => {
      await handlers[type]!(identityEvent(type, streamId, version, data));
    };
    const emptyAccount = "acc_empty_replay";
    const emptyStream = `identity.account-${emptyAccount}`;
    await project("identity.account.created", emptyStream, 1, { accountId: emptyAccount, displayName: "Empty Buyer" });
    await project(
      "identity.shipping-address.added",
      `identity.shipping-address-book-${emptyAccount}`,
      1,
      addressData(emptyAccount, "addr_empty", "1 Main Street"),
    );
    await project("identity.account.suspended", emptyStream, 3, {});
    await project("identity.account.profile-updated", emptyStream, 4, { displayName: "Renamed Empty Buyer" });
    await project("identity.account.reactivated", emptyStream, 5, {});
    await project("identity.account.closed", emptyStream, 6, {});
    expect(
      (
        await pool.query<{
          status: string;
          status_stream_version: number;
          display_name: string;
          last_stream_version: number;
        }>(
          `SELECT status, status_stream_version, display_name, last_stream_version
           FROM checkout_seller_accounts WHERE account_id = $1`,
          [emptyAccount],
        )
      ).rows[0],
    ).toMatchObject({
      status: "closed",
      status_stream_version: 6,
      display_name: "Renamed Empty Buyer",
      last_stream_version: 4,
    });
    const emptyAddress = await pool.query(
      `SELECT line1, last_stream_version FROM checkout_ship_from_addresses WHERE shipping_address_id = 'addr_empty'`,
    );
    expect(emptyAddress.rows[0]).toEqual({ line1: "1 Main Street", last_stream_version: 1 });

    const advancedAccount = "acc_advanced_replay";
    const advancedStream = `identity.account-${advancedAccount}`;
    await project("identity.account.created", advancedStream, 1, {
      accountId: advancedAccount,
      displayName: "Advanced Buyer",
    });
    await project("identity.account.profile-updated", advancedStream, 10, { displayName: "Latest Buyer" });
    await project(
      "identity.shipping-address.added",
      `identity.shipping-address-book-${advancedAccount}`,
      10,
      addressData(advancedAccount, "addr_advanced", "99 Current Street"),
    );
    const beforeReplay = (
      await pool.query(
        `SELECT line1, city, last_stream_version FROM checkout_ship_from_addresses WHERE shipping_address_id = 'addr_advanced'`,
      )
    ).rows[0];
    for (const [version, line1] of [
      [1, "1 Replay Street"],
      [2, "2 Replay Street"],
    ] as const) {
      await project("identity.shipping-address.updated", `identity.shipping-address-book-${advancedAccount}`, version, {
        ...addressData(advancedAccount, "addr_advanced", line1),
        updatedAt: `2026-10-17T00:00:0${version}.000Z`,
      });
      expect(
        (
          await pool.query(
            `SELECT line1, city, last_stream_version FROM checkout_ship_from_addresses WHERE shipping_address_id = 'addr_advanced'`,
          )
        ).rows[0],
      ).toEqual(beforeReplay);
    }
    await project("identity.account.suspended", advancedStream, 3, {});
    expect(
      (
        await pool.query(`SELECT status, status_stream_version FROM checkout_seller_accounts WHERE account_id = $1`, [
          advancedAccount,
        ])
      ).rows[0],
    ).toEqual({
      status: "suspended",
      status_stream_version: 3,
    });
    await project("identity.account.reactivated", advancedStream, 5, {});
    await project("identity.account.closed", advancedStream, 6, {});
    expect(
      (
        await pool.query(
          `SELECT status, status_stream_version, display_name, last_stream_version FROM checkout_seller_accounts WHERE account_id = $1`,
          [advancedAccount],
        )
      ).rows[0],
    ).toEqual({ status: "closed", status_stream_version: 6, display_name: "Latest Buyer", last_stream_version: 10 });
    expect(
      (
        await pool.query(
          `SELECT line1, city, last_stream_version FROM checkout_ship_from_addresses WHERE shipping_address_id = 'addr_advanced'`,
        )
      ).rows[0],
    ).toEqual(beforeReplay);
  });
});
