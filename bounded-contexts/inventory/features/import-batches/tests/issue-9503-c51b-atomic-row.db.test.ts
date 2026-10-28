import { randomUUID } from "node:crypto";
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
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { module as inventoryModule } from "../../../index";
import { createInventoryServices } from "../../../support/runtime-support/services";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for C5.1b DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_c51b_synthetic" as AccountId;
const context: EventStoreContext = {
  tenantId: "tnt_c51b_synthetic",
  audit: { performedByUserId: "usr_c51b_synthetic", forAccountId: accountId },
};
const claim = { claimOwnerId: "c51b-worker-synthetic", claimTtlMs: 30_000 };

describeDb("issue-9503-c51b atomic frozen import row", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "inventory_c51b_atomic_row");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await pools.inventory.query(
      "INSERT INTO inventory_catalog_items (catalog_item_id, status) VALUES ('cat_c51b_synthetic', 'active')",
    );
    await pools.inventory.query(
      `INSERT INTO inventory_storage_locations (storage_location_id, account_id, name, ship_from_code)
       VALUES ('loc_c51b_synthetic', $1, 'Synthetic shelf', 'MAIN')`,
      [accountId],
    );
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function setupCommittedJob() {
    const inventory = createInventoryServices(pools.inventory);
    const requestContext = withInventoryMutationAttempt(context, randomUUID());
    const createJob = await inventory.importBatches.enqueueCreateBatchJob(
      {
        accountId,
        parsedRows: [
          {
            rowNumber: 1,
            values: {
              catalogItemId: "cat_c51b_synthetic",
              storageLocationId: "loc_c51b_synthetic",
              totalQuantity: "2",
              listingPriceAmount: "5.00",
              listingPriceCurrencyCode: "USD",
              listingQuantityCap: "2",
            },
          },
        ],
      },
      requestContext,
    );
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    const commitJob = await inventory.importBatches.enqueueCommitBatchJob(
      { accountId, batchId: createJob.payload.batchId! },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    return { inventory, commitJob, batchId: createJob.payload.batchId! };
  }

  it("B1 split-transaction: item, outbox, row outcome and counters commit as one row unit", async () => {
    const { commitJob, batchId } = await setupCommittedJob();
    const row = await pools.inventory.query<{ status: string; committed_inventory_item_id: string | null }>(
      "SELECT status, committed_inventory_item_id FROM inventory_import_batch_rows WHERE batch_id = $1",
      [batchId],
    );
    expect(row.rows).toEqual([{ status: "committed", committed_inventory_item_id: expect.any(String) }]);
    expect((await pools.inventory.query("SELECT state FROM inventory_import_draft_listing_outbox")).rows).toHaveLength(
      1,
    );
    expect(
      (
        await pools.inventory.query("SELECT committed_count FROM inventory_import_batches WHERE batch_id = $1", [
          batchId,
        ])
      ).rows,
    ).toEqual([{ committed_count: 1 }]);
    expect(
      (
        await pools.inventory.query("SELECT status FROM inventory_import_batch_jobs WHERE job_id = $1", [
          commitJob.jobId,
        ])
      ).rows,
    ).toEqual([{ status: "completed" }]);
  });

  it("B2 generation-guard-removed: a live replacement claim refuses the stale row", async () => {
    const { inventory, commitJob, batchId } = await setupCommittedJob();
    const rowId = (
      await pools.inventory.query<{ row_id: string }>(
        "SELECT row_id FROM inventory_import_batch_rows WHERE batch_id = $1",
        [batchId],
      )
    ).rows[0]!.row_id;
    await pools.inventory.query(
      `UPDATE inventory_import_batch_rows SET status = 'accepted', committed_inventory_item_id = NULL,
       committed_listing_id = NULL, committed_at = NULL, commit_claim_token = 'replacement',
       commit_claimed_until = clock_timestamp() + interval '5 minutes' WHERE row_id = $1`,
      [rowId],
    );
    await pools.inventory.query("UPDATE inventory_import_batch_jobs SET status = 'queued' WHERE job_id = $1", [
      commitJob.jobId,
    ]);
    await pools.inventory.query(
      "UPDATE inventory_import_batch_work_units SET state = 'queued', result = NULL WHERE job_id = $1",
      [commitJob.jobId],
    );
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    expect(
      (await pools.inventory.query("SELECT status FROM inventory_import_batch_rows WHERE row_id = $1", [rowId])).rows,
    ).toEqual([{ status: "accepted" }]);
  });

  it("B4 retry/abort: terminal replay returns the retained result without duplicating effects", async () => {
    const { inventory, commitJob, batchId } = await setupCommittedJob();
    const before = await pools.inventory.query(
      `SELECT
         (SELECT count(*) FROM event_store_events) AS events,
         (SELECT count(*) FROM inventory_import_draft_listing_outbox) AS outbox`,
    );
    await pools.inventory.query("UPDATE inventory_import_batch_jobs SET status = 'queued' WHERE job_id = $1", [
      commitJob.jobId,
    ]);
    await pools.inventory.query(
      "UPDATE inventory_import_batch_work_units SET state = 'queued', result = NULL WHERE job_id = $1",
      [commitJob.jobId],
    );
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    const after = await pools.inventory.query(
      `SELECT
         (SELECT count(*) FROM event_store_events) AS events,
         (SELECT count(*) FROM inventory_import_draft_listing_outbox) AS outbox`,
    );
    expect(after.rows).toEqual(before.rows);
    expect((await inventory.importBatches.getBatch(batchId, accountId))?.committed_count).toBe(1);
  });
});
