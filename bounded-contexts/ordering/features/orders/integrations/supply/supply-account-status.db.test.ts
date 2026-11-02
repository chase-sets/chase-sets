import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase, createSubscriptionRunner } from "@chase-sets/bounded-context-runtime";
import { buildEventSubscriptionsFromManifest } from "@chase-sets/bounded-context-module";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { parseMarketplaceListingCreatedPayload, type MarketplaceListingCreatedPayload } from "@chase-sets/event-core";
import { module as orderingModule } from "../../../../index";
import orderingManifest from "../../../../context.json" with { type: "json" };
import { getOrderingSupplyCandidateByListingId, listOrderingSupplyCandidates } from "./supply-queries";
import { buildOrderingMarketplaceSupplyProjectionHandlers } from "./supply-projection";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Ordering supply DB tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Ordering supply account status on Postgres", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["ordering"], "ordering_supply_account_status");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pool = createMultiContextTestPools(urls).ordering;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ ordering: pool });
    await bootstrapContextDatabase(orderingModule, pool);
    await pool.query(`
      INSERT INTO ordering_account_pages (account_id, display_name, status) VALUES ('acc_seller', 'Seller', 'suspended');
      INSERT INTO ordering_inventory_item_inputs (item_id, seller_account_id, catalog_catalog_item_id, product_id, total_quantity, updated_at, last_stream_version)
      VALUES ('inv_one', 'acc_seller', 'cat_one', 'cat_one::', 10, now(), 1);
      INSERT INTO ordering_market_listing_inputs
        (listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, item_title, ship_from_code,
         ship_from_address, product_measure_snapshot, price_amount, price_currency_code, listing_stream_version,
         marketplace_sales_fee_unit_amount, seller_net_unit_amount, terms_resolved_at, quantity_cap, status, updated_at,
         seller_listing_availability_status)
      VALUES ('lst_one', 'acc_seller', 'inv_one', 'cat_one', 'cat_one::', 'Item', 'CHI', '{}'::jsonb, '{}'::jsonb, 100,
         'USD', 2, 0, 100, now(), 10, 'active', now(), 'available');
    `);
  });
  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ ordering: pool });
  });

  const demand = {
    productId: "cat_one::",
    itemTitle: "Item",
    itemSubtitle: null,
    selectedOptions: [],
    productSummary: null,
    quantity: 1,
    buyerAccountId: "acc_buyer",
  } as never;

  it("excludes suspended sellers from normal candidates but allowCommitted resolves them", async () => {
    expect(await listOrderingSupplyCandidates(pool, demand)).toEqual([]);
    expect(await getOrderingSupplyCandidateByListingId(pool, "lst_one")).toBeNull();
    await pool.query(`UPDATE ordering_account_pages SET status = 'active' WHERE account_id = 'acc_seller'`);
    expect((await listOrderingSupplyCandidates(pool, demand)).map((candidate) => candidate.listingId)).toEqual([
      "lst_one",
    ]);
    expect(await getOrderingSupplyCandidateByListingId(pool, "lst_one")).toMatchObject({ listingId: "lst_one" });
    await pool.query(`UPDATE ordering_account_pages SET status = 'suspended' WHERE account_id = 'acc_seller'`);
    expect(await listOrderingSupplyCandidates(pool, demand)).toEqual([]);
    expect(await getOrderingSupplyCandidateByListingId(pool, "lst_one")).toBeNull();
    expect(await getOrderingSupplyCandidateByListingId(pool, "lst_one", { allowCommitted: true })).toMatchObject({
      listingId: "lst_one",
    });
  });

  it("upgrades prior native fee constraints, retains channel-only rows and never offers them as supply", async () => {
    await pool.query(`ALTER TABLE ordering_market_listing_inputs
      ALTER COLUMN marketplace_sales_fee_unit_amount SET NOT NULL,
      ALTER COLUMN seller_net_unit_amount SET NOT NULL;
      DELETE FROM bounded_context_schema_migrations
      WHERE migration_id = '20261023_ordering_marketplace_channel_only_nullable_fees';
      UPDATE ordering_account_pages SET status = 'active' WHERE account_id = 'acc_seller'`);
    const columns = async () =>
      (
        await pool.query(
          `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'ordering_market_listing_inputs'
       AND column_name IN ('marketplace_sales_fee_unit_amount', 'seller_net_unit_amount') ORDER BY column_name`,
        )
      ).rows;
    expect(await columns()).toEqual([
      { column_name: "marketplace_sales_fee_unit_amount", is_nullable: "NO" },
      { column_name: "seller_net_unit_amount", is_nullable: "NO" },
    ]);
    await bootstrapContextDatabase(orderingModule, pool);
    expect(await columns()).toEqual([
      { column_name: "marketplace_sales_fee_unit_amount", is_nullable: "YES" },
      { column_name: "seller_net_unit_amount", is_nullable: "YES" },
    ]);
    const payload = {
      schemaVersion: 2,
      publicationScope: "channel-only",
      nativeVisibility: "disabled",
      nativeFeeState: "not-enrolled",
      listingId: "lst_channel",
      accountId: "acc_seller" as never,
      inventoryItemId: "inv_one",
      catalogItemId: "cat_one",
      productId: "cat_one::",
      itemLanguageCode: null,
      itemTitle: "Item",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      productMeasureSnapshot: null,
      gradedCard: null,
      storageLocationName: null,
      shipFromCode: "CHI",
      shipFromAddress: {
        name: "Seller",
        company: null,
        line1: "1 Main",
        line2: null,
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
        phone: null,
        email: null,
      },
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      marketplaceSalesFeeUnitAmount: null,
      sellerNetUnitAmount: null,
      shippingAllowancePercentageBps: 0,
      termsScheduleId: null,
      termsAgreementId: null,
      termsResolvedAt: null,
      feeQuoteFingerprint: null,
      feeLocks: [],
      quantityCap: 1,
      purchaseLimits: { maxUnitsPerOrder: null, maxUnitsPerDay: null, maxUnitsPerCustomerAccount: null },
      evidenceRequirements: null,
      evidence: [],
    } satisfies MarketplaceListingCreatedPayload;
    parseMarketplaceListingCreatedPayload(payload);
    const store = createPostgresEventStore({ pool });
    const streamId = `marketplace.listing-${payload.listingId}`;
    const context = {
      tenantId: "tnt_test" as never,
      audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_seller" as never },
    };
    const [subscription] = buildEventSubscriptionsFromManifest({
      contextName: "ordering",
      manifest: orderingManifest,
      handlers: {
        "marketplace.ordering-marketplace-supply-input-projection": () =>
          buildOrderingMarketplaceSupplyProjectionHandlers(pool),
      },
    });
    const runner = createSubscriptionRunner("ordering", pool, pool, subscription!);
    const project = async () => {
      while ((await runner.runOnce()).processed > 0) {
        /* Drain the registered subscription. */
      }
      expect(await runner.refreshStatus()).toMatchObject({ poisonEventCount: 0, blockedStreamCount: 0 });
    };
    const read = async () =>
      (
        await pool.query(
          `SELECT status, marketplace_sales_fee_unit_amount, seller_net_unit_amount, terms_resolved_at,
       fee_locks, shipping_allowance_percentage_bps FROM ordering_market_listing_inputs WHERE listing_id = 'lst_channel'`,
        )
      ).rows[0];
    await store.appendToStream({
      streamId,
      expectedVersion: 0,
      context,
      events: [{ eventType: "marketplace.listing.created", payload }],
    });
    await project();
    const absentFees = {
      marketplace_sales_fee_unit_amount: null,
      seller_net_unit_amount: null,
      terms_resolved_at: null,
      fee_locks: [],
      shipping_allowance_percentage_bps: 0,
    };
    expect(await read()).toEqual({ ...absentFees, status: "draft" });
    expect((await listOrderingSupplyCandidates(pool, demand)).map((candidate) => candidate.listingId)).toEqual([
      "lst_one",
    ]);
    expect(await getOrderingSupplyCandidateByListingId(pool, "lst_one")).toMatchObject({
      listingId: "lst_one",
      marketplaceSalesFeeUnitAmount: "0.00",
      sellerNetUnitAmount: "100.00",
    });
    expect(await getOrderingSupplyCandidateByListingId(pool, payload.listingId)).toBeNull();
    expect(await getOrderingSupplyCandidateByListingId(pool, payload.listingId, { allowCommitted: true })).toBeNull();
    await store.appendToStream({
      streamId,
      expectedVersion: 1,
      context,
      events: [{ eventType: "marketplace.listing.photos-added", payload: { evidence: [] } }],
    });
    await project();
    expect(await read()).toEqual({ ...absentFees, status: "draft" });
    await store.appendToStream({
      streamId,
      expectedVersion: 2,
      context,
      events: [{ eventType: "marketplace.listing.withdrawn", payload: {} }],
    });
    await project();
    expect(await read()).toEqual({ ...absentFees, status: "withdrawn" });
    expect(await getOrderingSupplyCandidateByListingId(pool, payload.listingId, { allowCommitted: true })).toBeNull();
  });
});
