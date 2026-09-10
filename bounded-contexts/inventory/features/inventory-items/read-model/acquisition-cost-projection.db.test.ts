import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { listNativeInventoryExportItems } from "./queries";

const ACQUISITION_CURRENCY_MIGRATION_ID = "20260909_inventory_acquisition_cost_currency";
const ACQUISITION_CURRENCY_BOOT_EXPANSION = `ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS acquisition_cost_currency_code text NULL;`;
const retainedInventoryItemSchemaFixture = readFileSync(
  new URL("./fixtures/inventory-items-boot-schema-6feb1454.sql", import.meta.url),
  "utf8",
);

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["inventory"] as const;

function rawSqlFixture(fixture: string): string {
  const headerEnd = fixture.indexOf("\n\n");
  if (headerEnd === -1) {
    throw new Error("Pinned Inventory SQL fixture is missing its provenance header separator.");
  }
  return fixture.slice(headerEnd + 2);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("Inventory retained acquisition-cost schema fixture provenance", () => {
  it("pins the exact reviewed merge-base table shape", () => {
    expect(sha256(rawSqlFixture(retainedInventoryItemSchemaFixture))).toBe(
      "1ce46b3003f77f61f9101c9a6f5ae518c4df86a98b6c6a2f4b4669786e719739",
    );
  });
});

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
  });

  async function insertStorageLocation(): Promise<void> {
    await pool.query(
      `INSERT INTO inventory_storage_locations (
         storage_location_id, account_id, name, ship_from_code, ship_from_address
       ) VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      ["loc_1", "acc_1", "Main", "MAIN"],
    );
  }

  async function bootstrapFreshInventory(): Promise<void> {
    await bootstrapContextDatabase(inventoryModule, pool);
    await insertStorageLocation();
  }

  async function installRetainedInventoryItem(): Promise<void> {
    await pool.query(retainedInventoryItemSchemaFixture);
    await insertStorageLocation();
    await pool.query(
      `INSERT INTO inventory_items (
         item_id, account_id, catalog_catalog_item_id, product_id, selected_options,
         storage_location_id, total_quantity, last_stream_version, acquisition_cost_amount,
         created_at, updated_at
       ) VALUES (
         'inv_retained_boot', 'acc_1', 'cat_1', 'cat_1::', '[]'::jsonb,
         'loc_1', 1, 4, 4.25, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
       )`,
    );
  }

  async function bootWithoutInventoryLedger(schemaSql = inventoryModule.schemaSql): Promise<void> {
    await bootstrapContextDatabase(
      {
        contextName: inventoryModule.contextName,
        schemaSql,
        schemaMigrations: [],
      },
      pool,
    );
  }

  async function capturePostgresError(
    action: () => Promise<unknown>,
  ): Promise<Readonly<{ code?: string; message: string }>> {
    try {
      await action();
    } catch (error) {
      if (error instanceof Error) {
        return error as Error & { code?: string };
      }
      throw error;
    }
    throw new Error("Expected PostgreSQL to reject the boot-expansion-deleted mutant.");
  }

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("persists the real producer's pair and leaves retained amount-only events without a denomination", async () => {
    await bootstrapFreshInventory();
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

    await bootstrapContextDatabase(inventoryModule, pool);
    const afterRepeatedFreshBoot = await pool.query<{
      item_id: string;
      acquisition_cost_amount: string | null;
      acquisition_cost_currency_code: string | null;
    }>(
      `SELECT item_id, acquisition_cost_amount::text, acquisition_cost_currency_code
       FROM inventory_items
       ORDER BY item_id`,
    );
    expect(afterRepeatedFreshBoot.rows).toEqual(result.rows);
  });

  it("serves retained amount-only rows before the ledger migration and keeps boot plus ledger idempotent", async () => {
    await installRetainedInventoryItem();

    await bootWithoutInventoryLedger();
    const beforeLedger = await listNativeInventoryExportItems(pool, { accountId: "acc_1" });
    expect(beforeLedger).toEqual([
      {
        catalog_item_id: "cat_1",
        storage_location_id: "loc_1",
        total_quantity: 1,
        selected_options: [],
        acquisition_cost_amount: "4.25",
        acquisition_cost_currency_code: null,
      },
    ]);
    const beforeLedgerEntry = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM bounded_context_schema_migrations
       WHERE migration_id = $1`,
      [ACQUISITION_CURRENCY_MIGRATION_ID],
    );
    expect(beforeLedgerEntry.rows).toEqual([{ count: "0" }]);

    await bootWithoutInventoryLedger();
    expect(await listNativeInventoryExportItems(pool, { accountId: "acc_1" })).toEqual(beforeLedger);

    await bootstrapContextDatabase(inventoryModule, pool);
    await bootstrapContextDatabase(inventoryModule, pool);

    const afterLedger = await listNativeInventoryExportItems(pool, { accountId: "acc_1" });
    expect(afterLedger).toEqual(beforeLedger);
    const ledgerEntry = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM bounded_context_schema_migrations
       WHERE migration_id = $1`,
      [ACQUISITION_CURRENCY_MIGRATION_ID],
    );
    expect(ledgerEntry.rows).toEqual([{ count: "1" }]);
    const constraint = await pool.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated
       FROM pg_constraint
       WHERE conrelid = 'inventory_items'::regclass
         AND conname = 'inventory_items_acquisition_cost_currency_check'`,
    );
    expect(constraint.rows).toEqual([
      { conname: "inventory_items_acquisition_cost_currency_check", convalidated: true },
    ]);
  });

  it("makes the boot-expansion-deleted mutant fail at the real pre-ledger currency read", async () => {
    await installRetainedInventoryItem();
    const mutantSchemaSql = inventoryModule.schemaSql.replace(ACQUISITION_CURRENCY_BOOT_EXPANSION, "");
    expect(mutantSchemaSql).not.toBe(inventoryModule.schemaSql);

    await bootWithoutInventoryLedger(mutantSchemaSql);
    const error = await capturePostgresError(() => listNativeInventoryExportItems(pool, { accountId: "acc_1" }));

    expect(error.code).toBe("42703");
    expect(error.message).toContain("acquisition_cost_currency_code");
  });
});
