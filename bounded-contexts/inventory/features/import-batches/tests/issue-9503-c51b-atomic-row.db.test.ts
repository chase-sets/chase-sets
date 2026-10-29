import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
  resolveModuleSubscriptions,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, InventoryItemId } from "@chase-sets/primitives/typed-ids";
import { module as inventoryModule } from "../../../index";
import { createInventoryServices } from "../../../support/runtime-support/services";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import { createInventoryImportBatchRuntime, indexInventoryImportCommitRows } from "../api/runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
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
      `INSERT INTO inventory_storage_locations
         (storage_location_id, account_id, name, ship_from_code, ship_from_address)
       VALUES ('loc_c51b_synthetic', $1, 'Synthetic shelf', 'MAIN', $2::jsonb)`,
      [
        accountId,
        JSON.stringify({
          name: "Synthetic seller",
          line1: "1 Main St",
          line2: null,
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
          phone: null,
          email: null,
        }),
      ],
    );
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function drainInventory(inventory: ReturnType<typeof createInventoryServices>) {
    await drainContextRuntime(
      {
        subscriptionRunners: resolveModuleSubscriptions([
          {
            contextName: "inventory",
            module: { ...inventoryModule, buildSubscriptions: () => [], eventSubscriptions: [], eventReactions: [] },
            services: inventory,
            pool: pools.inventory,
            projectionHandlerSets: inventoryModule.projectionHandlerSets?.(inventory) ?? [],
          },
        ]),
      },
      { settleIdleCheckpoints: true },
    );
  }

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
    await drainInventory(inventory);
    const commitJob = await inventory.importBatches.enqueueCommitBatchJob(
      { accountId, batchId: createJob.payload.batchId! },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    await drainInventory(inventory);
    return { inventory, commitJob, batchId: createJob.payload.batchId! };
  }

  async function setupAcceptedCommitJob(rowCount = 1, pool = pools.inventory) {
    const inventory = createInventoryServices(pool);
    const createJob = await inventory.importBatches.enqueueCreateBatchJob(
      {
        accountId,
        parsedRows: Array.from({ length: rowCount }, (_, index) => ({
          rowNumber: index + 1,
          values: {
            catalogItemId: "cat_c51b_synthetic",
            storageLocationId: "loc_c51b_synthetic",
            totalQuantity: String(index === 0 ? 2 : 1),
            listingPriceAmount: "5.00",
            listingPriceCurrencyCode: "USD",
            listingQuantityCap: "2",
          },
        })),
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    for (let index = 0; index < rowCount; index += 1) {
      expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    }
    await drainInventory(inventory);
    const batchId = createJob.payload.batchId!;
    const commitJob = await inventory.importBatches.enqueueCommitBatchJob(
      { accountId, batchId },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    return { inventory, commitJob, batchId };
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

  it("F1 recovered existing-item add adjusts once without the legacy idempotency key", async () => {
    const { inventory, commitJob, batchId } = await setupAcceptedCommitJob();
    await inventory.items.createItem(
      {
        accountId,
        catalogItemId: "cat_c51b_synthetic",
        selectedOptions: [],
        storageLocationId: "loc_c51b_synthetic",
        totalQuantity: 5,
        itemIdOverride: "inv_c51b_existing" as InventoryItemId,
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    await drainInventory(inventory);
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    const item = await pools.inventory.query<{ total_quantity: number }>(
      "SELECT total_quantity FROM inventory_items WHERE item_id = 'inv_c51b_existing'",
    );
    expect(item.rows).toEqual([{ total_quantity: 7 }]);
    expect(
      (
        await pools.inventory.query(
          `SELECT count(*)::integer AS count FROM inventory_mutation_attempts
         WHERE family = 'item-adjust' AND target_id = 'inv_c51b_existing'`,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await pools.inventory.query(
          `SELECT count(*)::integer AS count FROM inventory_item_adjustment_idempotency
         WHERE idempotency_key LIKE 'inventory-import-row:%:adjustment'`,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect((await inventory.importBatches.getImportBatchJob(commitJob.jobId))?.status).toBe("completed");
    expect((await inventory.importBatches.getBatch(batchId, accountId))?.committed_count).toBe(1);
  });

  it("F3 item append failure rolls back the row unit and committed counter", async () => {
    const { inventory, commitJob, batchId } = await setupAcceptedCommitJob();
    const rowItems = {
      ...inventory.items,
      createItem: async (params: Parameters<typeof inventory.items.createItem>[0], itemContext: typeof context) => {
        await inventory.items.createItem(params, itemContext);
        throw new Error("synthetic item append barrier");
      },
    };
    const worker = createInventoryImportBatchRuntime({
      db: pools.inventory,
      items: inventory.items,
      rowItems,
      catalogItems: inventory.catalogItems,
      executeMutation: inventory.mutations.execute,
    });
    expect(await worker.processNextImportBatchJob(claim)).toBe(1);
    expect((await worker.getImportBatchJob(commitJob.jobId))?.status).toBe("failed");
    expect(
      (
        await pools.inventory.query("SELECT count(*)::integer AS count FROM inventory_items WHERE account_id = $1", [
          accountId,
        ])
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await pools.inventory.query(
          "SELECT status, committed_count FROM inventory_import_batches WHERE batch_id = $1",
          [batchId],
        )
      ).rows,
    ).toEqual([{ status: "uploaded", committed_count: 0 }]);
    expect(
      (await pools.inventory.query("SELECT status FROM inventory_import_batch_rows WHERE batch_id = $1", [batchId]))
        .rows,
    ).toEqual([{ status: "accepted" }]);
  });

  it("F3 outbox/row transition failure rolls back item, outbox, row and counter together", async () => {
    const { inventory, commitJob, batchId } = await setupAcceptedCommitJob();
    const faultingDb = {
      query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        if (sql.includes("UPDATE inventory_import_batch_rows") && sql.includes("SET status = 'committed'")) {
          throw new Error("synthetic row transition barrier");
        }
        return pools.inventory.query<Row>(sql, values);
      },
      connect: (...args: Parameters<typeof pools.inventory.connect>) => pools.inventory.connect(...args),
    };
    const worker = createInventoryImportBatchRuntime({
      db: faultingDb,
      items: inventory.items,
      rowItems: inventory.items,
      catalogItems: inventory.catalogItems,
      executeMutation: inventory.mutations.execute,
    });
    expect(await worker.processNextImportBatchJob(claim)).toBe(1);
    expect((await worker.getImportBatchJob(commitJob.jobId))?.status).toBe("failed");
    expect(
      (
        await pools.inventory.query("SELECT count(*)::integer AS count FROM inventory_items WHERE account_id = $1", [
          accountId,
        ])
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (await pools.inventory.query("SELECT count(*)::integer AS count FROM inventory_import_draft_listing_outbox"))
        .rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await pools.inventory.query(
          "SELECT status, committed_count FROM inventory_import_batches WHERE batch_id = $1",
          [batchId],
        )
      ).rows,
    ).toEqual([{ status: "uploaded", committed_count: 0 }]);
  });

  it("F6 loads frozen input once and avoids full-batch reads before the final unit", async () => {
    const counts = { frozenInputSelects: 0, fullBatchRowSelects: 0 };
    const countedPool = {
      query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        if (sql.includes("FROM inventory_import_commit_inputs")) counts.frozenInputSelects += 1;
        if (sql.includes("FROM inventory_import_batch_rows") && values?.some((value) => Number(value) === 10_000)) {
          counts.fullBatchRowSelects += 1;
        }
        return pools.inventory.query<Row>(sql, values);
      },
      connect: (...args: Parameters<typeof pools.inventory.connect>) => pools.inventory.connect(...args),
    } as unknown as PgTransactionalPool;
    const { inventory, commitJob } = await setupAcceptedCommitJob(3, countedPool);
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(3);
    expect(counts.frozenInputSelects).toBe(1);
    expect(counts.fullBatchRowSelects).toBe(1);
    expect((await inventory.importBatches.getImportBatchJob(commitJob.jobId))?.status).toBe("completed");
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

  it("B2 lease expiry interleaving commits one row and one set of effects", async () => {
    const { inventory, commitJob, batchId } = await setupAcceptedCommitJob();
    let itemAppended!: () => void;
    const appended = new Promise<void>((resolve) => {
      itemAppended = resolve;
    });
    let releaseA!: () => void;
    const resumeA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const rowItems = {
      ...inventory.items,
      createItem: async (params: Parameters<typeof inventory.items.createItem>[0], itemContext: typeof context) => {
        const result = await inventory.items.createItem(params, itemContext);
        itemAppended();
        await resumeA;
        return result;
      },
    };
    const workerA = createInventoryImportBatchRuntime({
      db: pools.inventory,
      items: inventory.items,
      rowItems,
      catalogItems: inventory.catalogItems,
      executeMutation: inventory.mutations.execute,
    });
    const first = workerA.processNextImportBatchJob({ claimOwnerId: "c51b-worker-a", claimTtlMs: 10 });
    await appended;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = inventory.importBatches.processNextImportBatchJob({ claimOwnerId: "c51b-worker-b", claimTtlMs: 10 });
    releaseA();
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    await drainInventory(inventory);
    expect(
      (await pools.inventory.query("SELECT status FROM inventory_import_batch_rows WHERE batch_id = $1", [batchId]))
        .rows,
    ).toEqual([{ status: "committed" }]);
    expect(
      (
        await pools.inventory.query(
          `SELECT
             (SELECT count(*)::integer FROM inventory_items WHERE account_id = $1) AS items,
             (SELECT count(*)::integer FROM inventory_import_draft_listing_outbox WHERE import_batch_id = $2) AS outbox,
             (SELECT committed_count FROM inventory_import_batches WHERE batch_id = $2) AS committed_count`,
          [accountId, batchId],
        )
      ).rows,
    ).toEqual([{ items: 1, outbox: 1, committed_count: 1 }]);
    expect((await inventory.importBatches.getImportBatchJob(commitJob.jobId))?.status).toBe("completed");
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

  it("F6 CPU probe indexes 10,000 committed rows within the one millisecond-per-row budget", () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      row_id: `imr_c51b_probe_${index}`,
    })) as Array<{ row_id: string }>;
    const start = process.hrtime.bigint();
    const indexed = indexInventoryImportCommitRows(rows as never);
    for (const row of rows) expect(indexed.get(row.row_id)).toBe(row);
    const totalMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    console.log(
      `F6 CPU probe rows=10000 totalMs=${totalMs.toFixed(3)} msPerCommittedRow=${(totalMs / rows.length).toFixed(6)} environment=${process.platform}/${process.arch} ${process.version}`,
    );
    expect(totalMs).toBeLessThanOrEqual(10_000);
  });
});
