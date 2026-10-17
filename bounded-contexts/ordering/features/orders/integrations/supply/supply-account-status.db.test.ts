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
import { module as orderingModule } from "../../../../index";
import { getOrderingSupplyCandidateByListingId, listOrderingSupplyCandidates } from "./supply-queries";

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
    expect(await getOrderingSupplyCandidateByListingId(pool, "lst_one", { allowCommitted: true })).toMatchObject({
      listingId: "lst_one",
    });
  });
});
