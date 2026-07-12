import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as inventoryModule } from "../../..";
import { resolveAccountSellerSkusToInventoryItems } from "../read-model/account-sku-mappings";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["inventory"] as const;

describeDb("inventory batch seller-SKU -> item resolution (#4328 reuse of m71)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "inventory_sku_resolve");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.inventory.query(inventoryModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function seed(pool: PgTransactionalPool) {
    await pool.query(
      `INSERT INTO inventory_storage_locations (storage_location_id, account_id, name, ship_from_code)
       VALUES ('loc_1', 'acc_seller', 'Main', 'MAIN')`,
    );
    await pool.query(
      `INSERT INTO inventory_items (item_id, account_id, catalog_catalog_item_id, product_id, selected_options, storage_location_id, total_quantity)
       VALUES
         ('inv_mapped', 'acc_seller', 'cat_1', 'cat_1::', '[]'::jsonb, 'loc_1', 5),
         ('inv_other_account', 'acc_other', 'cat_2', 'cat_2::', '[]'::jsonb, 'loc_1', 5)`,
    );
    await pool.query(
      `INSERT INTO inventory_import_account_sku_mappings
         (mapping_id, account_id, seller_sku, normalized_seller_sku, catalog_item_id, selected_options, created_at, updated_at)
       VALUES
         ('map_1', 'acc_seller', 'SKU-MAPPED', 'sku-mapped', 'cat_1', '[]'::jsonb, now(), now()),
         ('map_2', 'acc_seller', 'SKU-AMBIGUOUS', 'sku-ambiguous', 'cat_1', '[]'::jsonb, now(), now()),
         ('map_3', 'acc_seller', 'SKU-AMBIGUOUS', 'sku-ambiguous', 'cat_2', '[]'::jsonb, now(), now()),
         ('map_4', 'acc_seller', 'SKU-NO-ITEM', 'sku-no-item', 'cat_3', '[]'::jsonb, now(), now())`,
    );
  }

  it("resolves mapped, missing, ambiguous, and unmapped-item seller SKUs in one batch", async () => {
    const pool = pools.inventory;
    await seed(pool);

    const resolutions = await resolveAccountSellerSkusToInventoryItems(pool, {
      accountId: "acc_seller",
      sellerSkus: ["SKU-MAPPED", "sku-mapped", "SKU-AMBIGUOUS", "SKU-NO-ITEM", "SKU-UNKNOWN", ""],
    });

    expect(resolutions).toEqual([
      {
        sellerSku: "SKU-MAPPED",
        status: "mapped",
        inventoryItemId: "inv_mapped",
        catalogItemId: "cat_1",
        productId: "cat_1::",
      },
      // Case-insensitive: same normalized SKU resolves the same way.
      {
        sellerSku: "sku-mapped",
        status: "mapped",
        inventoryItemId: "inv_mapped",
        catalogItemId: "cat_1",
        productId: "cat_1::",
      },
      { sellerSku: "SKU-AMBIGUOUS", status: "ambiguous", mappingCount: 2 },
      { sellerSku: "SKU-NO-ITEM", status: "unmapped-item", catalogItemId: "cat_3" },
      { sellerSku: "SKU-UNKNOWN", status: "missing" },
      { sellerSku: "", status: "missing" },
    ]);
  });

  it("never resolves an item belonging to a different account", async () => {
    const pool = pools.inventory;
    await seed(pool);
    await pool.query(
      `INSERT INTO inventory_import_account_sku_mappings
         (mapping_id, account_id, seller_sku, normalized_seller_sku, catalog_item_id, selected_options, created_at, updated_at)
       VALUES ('map_cross', 'acc_seller', 'SKU-CROSS', 'sku-cross', 'cat_2', '[]'::jsonb, now(), now())`,
    );

    const resolutions = await resolveAccountSellerSkusToInventoryItems(pool, {
      accountId: "acc_seller",
      sellerSkus: ["SKU-CROSS"],
    });

    // cat_2's only inventory item (inv_other_account) belongs to a different account, so it must not resolve.
    expect(resolutions).toEqual([{ sellerSku: "SKU-CROSS", status: "unmapped-item", catalogItemId: "cat_2" }]);
  });
});
