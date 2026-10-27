import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { AccountId, InventoryItemId } from "@chase-sets/primitives/typed-ids";
import { module as inventoryModule } from "../../../index";
import { createInventoryServices } from "../../../support/runtime-support/services";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import { createInventoryImportBatchRuntime } from "../api/runtime";
import type { InventoryItemServices } from "../../inventory-items/api/runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_c51a" as AccountId;
const context: EventStoreContext = {
  tenantId: "tnt_c51a" as never,
  audit: { performedByUserId: "usr_c51a" as never, forAccountId: accountId },
};

describeDb("issue-9503-c51a frozen commit input", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "inventory_c51a_frozen_input");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await pools.inventory.query(
      `INSERT INTO inventory_catalog_items (catalog_item_id, status) VALUES ('cat_c51a', 'active')`,
    );
    await pools.inventory.query(
      `INSERT INTO inventory_storage_locations (storage_location_id, account_id, name, ship_from_code)
       VALUES ('loc_c51a', $1, 'C51A shelf', 'MAIN')`,
      [accountId],
    );
    await pools.inventory.query(
      `INSERT INTO inventory_import_batches
       (batch_id, account_id, status, source_key, quantity_mode, total_count, accepted_count, created_at, updated_at)
       VALUES ('imb_c51a', $1, 'uploaded', 'native-csv', 'add', 1, 1, now(), now())`,
      [accountId],
    );
    await pools.inventory.query(
      `INSERT INTO inventory_import_batch_rows
       (row_id, batch_id, row_number, status, raw_row, row_fingerprint, quantity_mode, quantity_delta,
        catalog_item_id, product_id, selected_options, storage_location_id, total_quantity,
        validation_errors, created_at, updated_at)
       VALUES ('imr_c51a_1', 'imb_c51a', 1, 'accepted', '{"totalQuantity":"2"}'::jsonb,
        'c51a-row-fingerprint', 'add', 2, 'cat_c51a', 'prod_c51a', '[]'::jsonb, 'loc_c51a', 2,
        '[]'::jsonb, now(), now())`,
    );
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("A1/A3 mutant new-job-on-replay and attempt-identity-dropped stay red", async () => {
    const inventory = createInventoryServices(pools.inventory);
    const attempt = withInventoryMutationAttempt(context, randomUUID());
    const jobs = await Promise.all(
      Array.from({ length: 4 }, () =>
        inventory.importBatches.enqueueCommitBatchJob({ accountId, batchId: "imb_c51a" }, attempt),
      ),
    );
    expect(new Set(jobs.map((job) => job.jobId)).size).toBe(1);
    expect(new Set(jobs.map((job) => job.payload.commit?.inputId)).size).toBe(1);
    await expect(
      inventory.importBatches.enqueueCommitBatchJob({ accountId, batchId: "imb_other" }, attempt),
    ).rejects.toThrow("conflicts");
    const counts = await pools.inventory.query(
      `SELECT (SELECT count(*)::integer FROM inventory_import_batch_jobs) AS jobs,
              (SELECT count(*)::integer FROM inventory_import_commit_inputs) AS inputs,
              (SELECT count(*)::integer FROM inventory_mutation_attempts) AS receipts`,
    );
    expect(counts.rows).toEqual([{ jobs: 1, inputs: 1, receipts: 1 }]);
  });

  it("A2 mutant snapshot-reread stays red after the source row changes", async () => {
    const inventory = createInventoryServices(pools.inventory);
    const attempt = withInventoryMutationAttempt(context, randomUUID());
    const job = await inventory.importBatches.enqueueCommitBatchJob({ accountId, batchId: "imb_c51a" }, attempt);
    await pools.inventory.query(
      `UPDATE inventory_import_batch_rows SET total_quantity = 99, raw_row = '{"totalQuantity":"99"}'::jsonb
       WHERE row_id = 'imr_c51a_1'`,
    );
    const created: Array<{ totalQuantity: number; itemIdOverride?: InventoryItemId }> = [];
    const items = {
      ...inventory.items,
      createItem: vi.fn(async (params: Parameters<InventoryItemServices["createItem"]>[0]) => {
        created.push(params);
        return { itemId: params.itemIdOverride ?? ("inv_c51a" as InventoryItemId), version: 1 };
      }),
      adjustItem: vi.fn(async (params: Parameters<InventoryItemServices["adjustItem"]>[0]) => ({
        itemId: params.itemId,
        version: 1,
      })),
    } as InventoryItemServices;
    const worker = createInventoryImportBatchRuntime({
      db: pools.inventory,
      items,
      catalogItems: inventory.catalogItems,
    });
    await worker.processNextImportBatchJob({ claimOwnerId: "c51a-worker", claimTtlMs: 30_000 });
    expect(created[0]?.totalQuantity).toBe(2);
    expect((await worker.getImportBatchJob(job.jobId))?.status).toBe("completed");
  });
});
