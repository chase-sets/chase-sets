import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createCheckoutServices } from "../support/runtime-support/services";
import {
  buildCheckoutIdentitySellerAccountsProjectionHandlers,
  createSellerSlug,
} from "../features/cart/integrations/identity/identity-projection";
import {
  getCheckoutSellOfferMatch,
  listCheckoutSellOfferMatches,
  loadCheckoutSellListRawReview,
  type CheckoutSellListTermsPreview,
} from "../features/sell-list/read-model/queries";
import { fixtureLine } from "../features/sell-list/api/owner-read.fixture";

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

  it.each([false, true])(
    "selected and suggested Sell List Offers follow standing before quoting (owner quote port: %s)",
    async (withQuotePort) => {
      const subscription = checkoutModule.buildSubscriptions!(createCheckoutServices(pool)).find(
        (sub) => sub.projectionName === "checkout.offer-standing-projection",
      )!;
      const apply = async (suffix: string, version: number, accountId: string) => {
        const type = `marketplace.seller-listing-availability.${suffix}`;
        expect(subscription.eventTypes).toContain(type);
        await subscription.handlers[type]!(
          identityEvent(type, `marketplace.seller-listing-availability-${accountId}`, version, { accountId }),
        );
      };
      const item = { catalog_catalog_item_id: "cat_one", product_id: "cat_one::", item_title: "Item" };
      const selected = {
        ...fixtureLine,
        ...item,
        offer_id: "off_one",
        offer_price_amount: "80.00",
        offer_stream_version: 2,
      };
      const suggested = { ...fixtureLine, ...item, line_type: "product" as const, offer_id: null, listing_id: null };
      const resolvedAt = "2026-10-17T00:00:00.000Z";
      const quote = vi.fn(
        async (): Promise<CheckoutSellListTermsPreview> => ({
          account_type: "personal",
          basis_amount: "80.00",
          marketplace_sales_fee_unit_amount: "0.00",
          seller_net_unit_amount: "80.00",
          shipping_allowance_percentage_bps: 500,
          schedule_id: null,
          agreement_id: null,
          resolved_at: resolvedAt,
          fee_quote_fingerprint: "synthetic_quote",
        }),
      );
      const fallback = vi.fn(async () => ({
        accountType: "personal" as const,
        basisAmount: "80.00",
        marketplaceSalesFeeUnitAmount: "0.00",
        sellerNetUnitAmount: "80.00",
        shippingAllowancePercentageBps: 500,
        scheduleId: null,
        agreementId: null,
        resolvedAt,
      }));
      const review = (line: typeof fixtureLine) =>
        loadCheckoutSellListRawReview(
          pool,
          {
            resolveListingTerms: fallback,
            resolvePublicStandardListingTerms: async () => {
              throw new Error("No standard comparison was requested.");
            },
          },
          {
            sellerAccountId: "acc_seller",
            lines: [line],
            ...(withQuotePort ? { offerAcceptanceTermsSource: { previewOfferAcceptanceTerms: quote } } : {}),
          },
        );
      await apply("offers-disabled", 3, "acc_no_mirror");
      await apply("offers-disabled", 3, "acc_buyer");
      await apply("offers-enabled", 2, "acc_buyer");
      expect((await pool.query("SELECT * FROM checkout_buyer_offer_standing ORDER BY account_id")).rows).toEqual([
        { account_id: "acc_buyer", away_stream_version: 3, offers_away: true },
        { account_id: "acc_no_mirror", away_stream_version: 3, offers_away: true },
      ]);
      expect(await getCheckoutSellOfferMatch(pool, "acc_seller", "off_one")).toBeNull();
      expect(
        await listCheckoutSellOfferMatches(pool, { sellerAccountId: "acc_seller", productIds: ["cat_one::"] }),
      ).toEqual([]);
      for (const listing_id of [null, "lst_one"]) {
        expect((await review({ ...selected, listing_id })).offerReviews[0]).toMatchObject({
          lineId: selected.line_id,
          status: "unavailable",
          terms: null,
        });
      }
      expect((await review(suggested)).productOfferReviews[0]).toMatchObject({ status: "unavailable", offers: [] });
      expect(quote).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();

      await apply("offers-enabled", 4, "acc_buyer");
      expect(await getCheckoutSellOfferMatch(pool, "acc_seller", "off_one")).toMatchObject({ offer_id: "off_one" });
      for (const listing_id of [null, "lst_one"]) {
        expect((await review({ ...selected, listing_id })).offerReviews[0]).toMatchObject({
          lineId: selected.line_id,
          status: "ready",
        });
      }
      expect((await review(suggested)).productOfferReviews[0]).toMatchObject({
        status: "ready",
        offers: [{ offer: { offer_id: "off_one" } }],
      });
      expect(quote).toHaveBeenCalledTimes(withQuotePort ? 2 : 0);
      expect(fallback).toHaveBeenCalledTimes(withQuotePort ? 1 : 3);
    },
  );

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
    const displayName = "Replay Buyer";
    const lifecycle = async (accountId: string, addressId: string) => {
      const stream = `identity.account-${accountId}`;
      const addressStream = `identity.shipping-address-book-${accountId}`;
      await project("identity.account.created", stream, 1, { accountId, displayName });
      expect(
        (
          await pool.query(`SELECT status, status_stream_version FROM checkout_seller_accounts WHERE account_id = $1`, [
            accountId,
          ])
        ).rows[0],
      ).toEqual({ status: "active", status_stream_version: 0 });
      await project("identity.account.suspended", stream, 2, {});
      expect(
        (
          await pool.query(`SELECT status, status_stream_version FROM checkout_seller_accounts WHERE account_id = $1`, [
            accountId,
          ])
        ).rows[0],
      ).toEqual({ status: "suspended", status_stream_version: 2 });
      await project("identity.account.profile-updated", stream, 3, { displayName });
      expect(
        (
          await pool.query(
            `SELECT status, status_stream_version, display_name FROM checkout_seller_accounts WHERE account_id = $1`,
            [accountId],
          )
        ).rows[0],
      ).toEqual({ status: "suspended", status_stream_version: 2, display_name: displayName });
      await project("identity.account.reactivated", stream, 4, {});
      expect(
        (
          await pool.query(`SELECT status, status_stream_version FROM checkout_seller_accounts WHERE account_id = $1`, [
            accountId,
          ])
        ).rows[0],
      ).toEqual({ status: "active", status_stream_version: 4 });
      await project(
        "identity.shipping-address.added",
        addressStream,
        1,
        addressData(accountId, addressId, "1 Main Street"),
      );
      await project("identity.shipping-address.updated", addressStream, 2, {
        ...addressData(accountId, addressId, "2 Main Street"),
        updatedAt: "2026-10-17T00:00:02.000Z",
      });
      expect(
        (
          await pool.query(
            `SELECT line1, last_stream_version FROM checkout_ship_from_addresses WHERE shipping_address_id = $1`,
            [addressId],
          )
        ).rows[0],
      ).toEqual({ line1: "2 Main Street", last_stream_version: 2 });
      await project("identity.account.closed", stream, 5, {});
      expect(
        (
          await pool.query(`SELECT status, status_stream_version FROM checkout_seller_accounts WHERE account_id = $1`, [
            accountId,
          ])
        ).rows[0],
      ).toEqual({ status: "closed", status_stream_version: 5 });
    };

    await lifecycle("acc_empty_replay", "addr_empty");
    const emptyTuple = (
      await pool.query(
        `SELECT status, status_stream_version, display_name, slug, last_stream_version FROM checkout_seller_accounts WHERE account_id = 'acc_empty_replay'`,
      )
    ).rows[0];

    const advancedAccount = "acc_advanced_replay";
    const advancedStream = `identity.account-${advancedAccount}`;
    const advancedAddressStream = `identity.shipping-address-book-${advancedAccount}`;
    await project("identity.account.created", advancedStream, 1, { accountId: advancedAccount, displayName });
    await project("identity.account.profile-updated", advancedStream, 3, { displayName });
    await project(
      "identity.shipping-address.added",
      advancedAddressStream,
      1,
      addressData(advancedAccount, "addr_advanced", "1 Main Street"),
    );
    await project("identity.shipping-address.updated", advancedAddressStream, 2, {
      ...addressData(advancedAccount, "addr_advanced", "2 Main Street"),
      updatedAt: "2026-10-17T00:00:02.000Z",
    });
    const advancedAddress = (
      await pool.query(
        `SELECT line1, city, last_stream_version FROM checkout_ship_from_addresses WHERE shipping_address_id = 'addr_advanced'`,
      )
    ).rows[0];
    for (const [type, streamId, version, data] of [
      ["identity.account.created", advancedStream, 1, { accountId: advancedAccount, displayName }],
      ["identity.account.suspended", advancedStream, 2, {}],
      ["identity.account.profile-updated", advancedStream, 3, { displayName }],
      ["identity.account.reactivated", advancedStream, 4, {}],
      [
        "identity.shipping-address.added",
        advancedAddressStream,
        1,
        addressData(advancedAccount, "addr_advanced", "1 Main Street"),
      ],
      [
        "identity.shipping-address.updated",
        advancedAddressStream,
        2,
        { ...addressData(advancedAccount, "addr_advanced", "2 Main Street"), updatedAt: "2026-10-17T00:00:02.000Z" },
      ],
      ["identity.account.closed", advancedStream, 5, {}],
    ] as const) {
      await project(type, streamId, version, data);
      if (type === "identity.account.suspended") {
        expect(
          (
            await pool.query(
              `SELECT status, status_stream_version FROM checkout_seller_accounts WHERE account_id = $1`,
              [advancedAccount],
            )
          ).rows[0],
        ).toEqual({ status: "suspended", status_stream_version: 2 });
      }
      if (type === "identity.shipping-address.added" || type === "identity.shipping-address.updated") {
        expect(
          (
            await pool.query(
              `SELECT line1, city, last_stream_version FROM checkout_ship_from_addresses WHERE shipping_address_id = 'addr_advanced'`,
            )
          ).rows[0],
        ).toEqual(advancedAddress);
      }
    }
    expect(
      (
        await pool.query(`SELECT status, status_stream_version FROM checkout_seller_accounts WHERE account_id = $1`, [
          advancedAccount,
        ])
      ).rows[0],
    ).toEqual({ status: "closed", status_stream_version: 5 });
    const advancedTuple = (
      await pool.query(
        `SELECT status, status_stream_version, display_name, slug, last_stream_version FROM checkout_seller_accounts WHERE account_id = $1`,
        [advancedAccount],
      )
    ).rows[0];
    expect(emptyTuple).toEqual({
      status: "closed",
      status_stream_version: 5,
      display_name: displayName,
      slug: createSellerSlug(displayName, "acc_empty_replay"),
      last_stream_version: 3,
    });
    expect(advancedTuple).toEqual({
      ...emptyTuple,
      slug: createSellerSlug(displayName, advancedAccount),
    });
  });
});
