import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as inventoryModule } from "../../..";
import { decideInventoryItem, initialInventoryItemState } from "../domain/domain";
import { buildInventoryItemProjectionHandlers } from "./projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["inventory"] as const;

describeDb("Inventory acquisition-cost denomination projection", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "acquisition_cost_denomination");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.inventory;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pool);
    await pool.query(
      `INSERT INTO inventory_storage_locations (
         storage_location_id, account_id, name, ship_from_code, ship_from_address
       ) VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      ["loc_1", "acc_1", "Main", "MAIN"],
    );
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("persists the real producer's pair and leaves retained amount-only events without a denomination", async () => {
    const handlers = buildInventoryItemProjectionHandlers(pool);
    const [created] = decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: "inv_current" as never,
      accountId: "acc_1" as never,
      catalogItemId: "cat_1" as never,
      productId: "cat_1::" as never,
      selectedOptions: [],
      storageLocationId: "loc_1",
      totalQuantity: 2,
      acquisitionCostAmount: "6.50",
      acquisitionCostCurrencyCode: "CAD",
      acquisitionOccurrence: { kind: "unknown" },
      commandOccurredAt: "2026-09-08T00:00:00Z",
    });
    await handlers["inventory.item.created"]?.({
      ...created,
      streamId: "inventory.item-inv_current",
      streamVersion: 1,
      timing: { recordedAt: "2026-09-08T00:00:00Z" },
    } as never);
    await handlers["inventory.item.created"]?.({
      type: "inventory.item.created",
      streamId: "inventory.item-inv_retained",
      streamVersion: 1,
      data: {
        itemId: "inv_retained",
        accountId: "acc_1",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        selectedOptions: [],
        gradedCard: null,
        storageLocationId: "loc_1",
        totalQuantity: 1,
        acquisitionCostAmount: "4.25",
      },
      timing: { recordedAt: "2026-09-08T00:00:01Z" },
    } as never);

    const result = await pool.query<{
      item_id: string;
      acquisition_cost_amount: string | null;
      acquisition_cost_currency_code: string | null;
    }>(
      `SELECT item_id, acquisition_cost_amount::text, acquisition_cost_currency_code
       FROM inventory_items
       ORDER BY item_id`,
    );
    expect(result.rows).toEqual([
      {
        item_id: "inv_current",
        acquisition_cost_amount: "6.50",
        acquisition_cost_currency_code: "CAD",
      },
      {
        item_id: "inv_retained",
        acquisition_cost_amount: "4.25",
        acquisition_cost_currency_code: null,
      },
    ]);
  });
});
