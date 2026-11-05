import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
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
        'c51a-row-fingerprint', 'add', 2, 'cat_c51a', 'cat_c51a::', '[]'::jsonb, 'loc_c51a', 2,
        '[]'::jsonb, now(), now())`,
    );
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("A1/A3 mutant new-job-on-replay and attempt-identity-dropped stay red", async () => {
    const inventory = createInventoryServices(pools.inventory);
    const attemptId = randomUUID();
    const attempt = withInventoryMutationAttempt(context, attemptId);
    const jobs = await Promise.all(
      Array.from({ length: 4 }, () =>
        inventory.importBatches.enqueueCommitBatchJob({ accountId, batchId: "imb_c51a" }, attempt),
      ),
    );
    expect(new Set(jobs.map((job) => job.jobId)).size).toBe(1);
    expect(new Set(jobs.map((job) => job.payload.commit?.inputId)).size).toBe(1);
    const beforeMismatch = await pools.inventory.query(
      `SELECT * FROM inventory_import_batch_rows
       WHERE row_id = 'imr_c51a_1'`,
    );
    await expect(
      inventory.importBatches.enqueueCommitBatchJob({ accountId, batchId: "imb_other" }, attempt),
    ).rejects.toThrow("conflicts");
    const foreignAccountId = "acc_c51a_foreign" as AccountId;
    const foreignAccountContext = withInventoryMutationAttempt(
      {
        ...context,
        audit: { ...context.audit, forAccountId: foreignAccountId },
      },
      attemptId,
    );
    await expect(
      inventory.importBatches.enqueueCommitBatchJob(
        { accountId: foreignAccountId, batchId: "imb_c51a" },
        foreignAccountContext,
      ),
    ).rejects.toThrow(/not found|not authorized/i);
    const counts = await pools.inventory.query(
      `SELECT (SELECT count(*)::integer FROM inventory_import_batch_jobs) AS jobs,
              (SELECT count(*)::integer FROM inventory_import_commit_inputs) AS inputs,
              (SELECT count(*)::integer FROM inventory_mutation_attempts) AS receipts`,
    );
    expect(counts.rows).toEqual([{ jobs: 1, inputs: 1, receipts: 1 }]);
    const afterMismatch = await pools.inventory.query(
      `SELECT * FROM inventory_import_batch_rows
       WHERE row_id = 'imr_c51a_1'`,
    );
    expect(afterMismatch.rows).toEqual(beforeMismatch.rows);
  });

  it("A2 mutant snapshot-reread stays red after the source row changes", async () => {
    const inventory = createInventoryServices(pools.inventory);
    const attempt = withInventoryMutationAttempt(context, randomUUID());
    const job = await inventory.importBatches.enqueueCommitBatchJob({ accountId, batchId: "imb_c51a" }, attempt);
    await pools.inventory.query(
      `UPDATE inventory_import_batch_rows SET quantity_delta = 99, total_quantity = 99, raw_row = '{"totalQuantity":"99"}'::jsonb
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

    const input = await pools.inventory.query<{
      tenant_id: string;
      actor_user_id: string;
      account_id: string;
      batch_id: string;
      snapshot_version: number;
      snapshot_hash: string;
      row_count: number;
      accepted_rows: Array<{ quantity_delta: number }>;
    }>(
      `SELECT tenant_id, actor_user_id, account_id, batch_id, snapshot_version, snapshot_hash, row_count, accepted_rows
       FROM inventory_import_commit_inputs`,
    );
    expect(input.rows).toHaveLength(1);
    expect(input.rows[0]).toMatchObject({
      tenant_id: context.tenantId,
      actor_user_id: context.audit.performedByUserId,
      account_id: accountId,
      batch_id: "imb_c51a",
      snapshot_version: 1,
      row_count: 1,
    });
    expect(input.rows[0]?.accepted_rows[0]?.quantity_delta).toBe(2);
    expect(input.rows[0]?.snapshot_hash).toBe(job.payload.commit?.snapshotHash);
  });

  it("replayed commit jobs overlay current committed progress", async () => {
    const inventory = createInventoryServices(pools.inventory);
    const firstAttempt = withInventoryMutationAttempt(context, randomUUID());
    const secondAttempt = withInventoryMutationAttempt(context, randomUUID());
    expect(
      (
        await pools.inventory.query(
          `SELECT item_id, account_id, catalog_catalog_item_id, product_id, selected_options, storage_location_id, total_quantity
           FROM inventory_items
           WHERE account_id = $1`,
          [accountId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pools.inventory.query(
          `SELECT count(*)::integer AS count
           FROM inventory_item_adjustment_idempotency
           WHERE idempotency_key = 'inventory-import-row:imr_c51a_1:adjustment'`,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    const projectionRuntime = {
      subscriptionRunners: resolveModuleSubscriptions([
        {
          contextName: "inventory",
          module: { ...inventoryModule, buildSubscriptions: () => [], eventSubscriptions: [], eventReactions: [] },
          services: inventory,
          pool: pools.inventory,
          projectionHandlerSets: inventoryModule.projectionHandlerSets?.(inventory) ?? [],
        },
      ]),
    };
    const first = await inventory.importBatches.enqueueCommitBatchJob({ accountId, batchId: "imb_c51a" }, firstAttempt);
    await expect(
      inventory.importBatches.enqueueCommitBatchJob({ accountId, batchId: "imb_c51a" }, secondAttempt),
    ).rejects.toThrow("Import commit is already running.");
    expect(
      (await inventory.importBatches.enqueueCommitBatchJob({ accountId, batchId: "imb_c51a" }, firstAttempt)).jobId,
    ).toBe(first.jobId);
    // Retained duplicate jobs must still replay frozen input without repeating stock writes.
    const duplicateInputId = `commit_input_${randomUUID()}`;
    const duplicateJobId = `job_${randomUUID()}`;
    await pools.inventory.query(
      `INSERT INTO inventory_import_commit_inputs
      (input_id, tenant_id, actor_user_id, account_id, batch_id, snapshot_version, snapshot_hash, row_count, accepted_rows, created_at)
      SELECT $1, tenant_id, actor_user_id, account_id, batch_id, snapshot_version, snapshot_hash, row_count, accepted_rows, now()
      FROM inventory_import_commit_inputs WHERE input_id = $2`,
      [duplicateInputId, first.payload.commit!.inputId],
    );
    await pools.inventory.query(
      `INSERT INTO inventory_import_batch_jobs
      (job_id, job_kind, status, payload, progress, event_context, created_at, updated_at)
      SELECT $1, job_kind, status, jsonb_set(payload, '{commit,inputId}', to_jsonb($2::text)), progress, event_context,
        created_at + interval '1 second', updated_at
      FROM inventory_import_batch_jobs WHERE job_id = $3`,
      [duplicateJobId, duplicateInputId, first.jobId],
    );
    const second = (await inventory.importBatches.getImportBatchJob(duplicateJobId))!;
    expect(first.jobId).not.toBe(second.jobId);
    expect(first.payload.commit?.inputId).not.toBe(second.payload.commit?.inputId);
    const frozenInputs = await pools.inventory.query<{
      input_id: string;
      accepted_rows: Array<{
        row_id: string;
        status: string;
        quantity_mode: string;
        quantity_delta: number;
        catalog_item_id: string;
        product_id: string;
        selected_options: unknown;
        storage_location_id: string;
      }>;
    }>(
      `SELECT input_id, accepted_rows
       FROM inventory_import_commit_inputs
       WHERE input_id = ANY($1::text[])
       ORDER BY input_id`,
      [[first.payload.commit?.inputId, second.payload.commit?.inputId]],
    );
    expect(frozenInputs.rows).toHaveLength(2);
    for (const input of frozenInputs.rows) {
      expect(input.accepted_rows).toHaveLength(1);
      expect(input.accepted_rows[0]).toMatchObject({
        row_id: "imr_c51a_1",
        status: "accepted",
        quantity_mode: "add",
        quantity_delta: 2,
        catalog_item_id: "cat_c51a",
        product_id: "cat_c51a::",
        selected_options: [],
        storage_location_id: "loc_c51a",
      });
    }

    expect(
      await inventory.importBatches.processNextImportBatchJob({ claimOwnerId: "c51a-replay-1", claimTtlMs: 30_000 }),
    ).toBe(1);
    await drainContextRuntime(projectionRuntime, { settleIdleCheckpoints: true });
    const preReplayItem = await pools.inventory.query(
      `SELECT item_id, account_id, catalog_catalog_item_id, product_id, selected_options, storage_location_id, total_quantity
       FROM inventory_items
       WHERE account_id = $1
       ORDER BY item_id`,
      [accountId],
    );
    expect(preReplayItem.rows).toEqual([
      {
        item_id: "inv_c51a_1",
        account_id: "acc_c51a",
        catalog_catalog_item_id: "cat_c51a",
        product_id: "cat_c51a::",
        selected_options: [],
        storage_location_id: "loc_c51a",
        total_quantity: 2,
      },
    ]);
    const preReplaySource = await pools.inventory.query(
      `SELECT row_id, status, committed_inventory_item_id, committed_at
       FROM inventory_import_batch_rows
       WHERE row_id = 'imr_c51a_1'`,
    );
    expect(preReplaySource.rows).toHaveLength(1);
    expect(preReplaySource.rows[0]).toMatchObject({
      row_id: "imr_c51a_1",
      status: "committed",
      committed_inventory_item_id: "inv_c51a_1",
    });
    expect(preReplaySource.rows[0]?.committed_at).not.toBeNull();
    const preReplayJobs = await pools.inventory.query(
      `SELECT status
       FROM inventory_import_batch_jobs
       WHERE job_id = ANY($1::text[])
       ORDER BY status, job_id`,
      [[first.jobId, second.jobId]],
    );
    expect(preReplayJobs.rows).toEqual([{ status: "completed" }, { status: "queued" }]);
    expect(
      (
        await pools.inventory.query(
          `SELECT count(*)::integer AS count
           FROM inventory_item_adjustment_idempotency
           WHERE idempotency_key = 'inventory-import-row:imr_c51a_1:adjustment'`,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      await inventory.importBatches.processNextImportBatchJob({ claimOwnerId: "c51a-replay-2", claimTtlMs: 30_000 }),
    ).toBe(1);
    await drainContextRuntime(projectionRuntime, { settleIdleCheckpoints: true });

    const finalStock = await pools.inventory.query(
      `SELECT total_quantity FROM inventory_items WHERE item_id = 'inv_c51a_1' AND account_id = $1`,
      [accountId],
    );
    const finalAdjustmentCount = (
      await pools.inventory.query(
        `SELECT count(*)::integer AS count
           FROM inventory_item_adjustment_idempotency
           WHERE idempotency_key = 'inventory-import-row:imr_c51a_1:adjustment'`,
      )
    ).rows;
    expect(finalStock.rows).toEqual([{ total_quantity: 2 }]);
    expect(finalAdjustmentCount).toEqual([{ count: 0 }]);
    expect((await inventory.importBatches.getImportBatchJob(first.jobId))?.status).toBe("completed");
    expect((await inventory.importBatches.getImportBatchJob(second.jobId))?.status).toBe("completed");
  });

  it("rejects a reused attempt from another actor without mutating source rows", async () => {
    const inventory = createInventoryServices(pools.inventory);
    const attemptId = randomUUID();
    const attempt = withInventoryMutationAttempt(context, attemptId);
    await inventory.importBatches.enqueueCommitBatchJob({ accountId, batchId: "imb_c51a" }, attempt);
    const before = await pools.inventory.query(
      `SELECT status, quantity_delta, raw_row FROM inventory_import_batch_rows WHERE row_id = 'imr_c51a_1'`,
    );
    const foreignContext = withInventoryMutationAttempt(
      {
        ...context,
        audit: { ...context.audit, performedByUserId: "usr_c51a_foreign" as never },
      },
      attemptId,
    );
    await expect(
      inventory.importBatches.enqueueCommitBatchJob({ accountId, batchId: "imb_c51a" }, foreignContext),
    ).rejects.toThrow("not authorized");
    const after = await pools.inventory.query(
      `SELECT status, quantity_delta, raw_row FROM inventory_import_batch_rows WHERE row_id = 'imr_c51a_1'`,
    );
    expect(after.rows).toEqual(before.rows);
    expect(
      await pools.inventory.query(`SELECT count(*)::integer AS count FROM inventory_import_batch_jobs`),
    ).toMatchObject({
      rows: [{ count: 1 }],
    });
  });

  it.each([
    ["row-count", `UPDATE inventory_import_commit_inputs SET row_count = row_count + 1`],
    ["hash", `UPDATE inventory_import_commit_inputs SET snapshot_hash = repeat('0', 64)`],
    ["scope", `UPDATE inventory_import_commit_inputs SET tenant_id = 'tnt_c51a_foreign'`],
  ])("worker rejects a tampered commit input (%s) before item writes", async (_name, mutation) => {
    const inventory = createInventoryServices(pools.inventory);
    const job = await inventory.importBatches.enqueueCommitBatchJob(
      { accountId, batchId: "imb_c51a" },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    await pools.inventory.query(mutation);
    const created = vi.fn();
    const adjusted = vi.fn();
    const worker = createInventoryImportBatchRuntime({
      db: pools.inventory,
      items: {
        ...inventory.items,
        createItem: created,
        adjustItem: adjusted,
      } as InventoryItemServices,
      catalogItems: inventory.catalogItems,
    });
    const before = await pools.inventory.query(
      `SELECT status, quantity_delta, raw_row FROM inventory_import_batch_rows WHERE row_id = 'imr_c51a_1'`,
    );
    expect(await worker.processNextImportBatchJob({ claimOwnerId: `c51a-guard-${_name}`, claimTtlMs: 30_000 })).toBe(1);
    expect(created).not.toHaveBeenCalled();
    expect(adjusted).not.toHaveBeenCalled();
    expect((await worker.getImportBatchJob(job.jobId))?.status).toBe("failed");
    expect((await worker.getImportBatchJob(job.jobId))?.errorMessage).toBe("import_job_failed_reconciliation_required");
    const after = await pools.inventory.query(
      `SELECT status, quantity_delta, raw_row FROM inventory_import_batch_rows WHERE row_id = 'imr_c51a_1'`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("accepts a batch with a committed row and commits only the remaining accepted row", async () => {
    await pools.inventory.query(
      `UPDATE inventory_import_batches
       SET total_count = 2, accepted_count = 2, committed_count = 1
       WHERE batch_id = 'imb_c51a'`,
    );
    await pools.inventory.query(
      `UPDATE inventory_import_batch_rows
       SET status = 'committed', committed_inventory_item_id = 'inv_existing', committed_at = now()
       WHERE row_id = 'imr_c51a_1'`,
    );
    await pools.inventory.query(
      `INSERT INTO inventory_import_batch_rows
       (row_id, batch_id, row_number, status, raw_row, row_fingerprint, quantity_mode, quantity_delta,
        catalog_item_id, product_id, selected_options, storage_location_id, total_quantity,
        validation_errors, created_at, updated_at)
       VALUES ('imr_c51a_2', 'imb_c51a', 2, 'accepted', '{"totalQuantity":"3"}'::jsonb,
        'c51a-row-fingerprint-2', 'add', 3, 'cat_c51a', 'cat_c51a::', '[]'::jsonb, 'loc_c51a', 3,
        '[]'::jsonb, now(), now())`,
    );
    const inventory = createInventoryServices(pools.inventory);
    const job = await inventory.importBatches.enqueueCommitBatchJob(
      { accountId, batchId: "imb_c51a" },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    const input = await pools.inventory.query<{ accepted_rows: Array<{ committed_at: unknown }> }>(
      `SELECT accepted_rows FROM inventory_import_commit_inputs`,
    );
    expect(input.rows[0]?.accepted_rows[0]?.committed_at).toEqual(expect.any(String));

    const created = vi.fn(async (params: Parameters<InventoryItemServices["createItem"]>[0]) => ({
      itemId: params.itemIdOverride ?? ("inv_c51a_2" as InventoryItemId),
      version: 1,
    }));
    const worker = createInventoryImportBatchRuntime({
      db: pools.inventory,
      items: { ...inventory.items, createItem: created } as InventoryItemServices,
      catalogItems: inventory.catalogItems,
    });
    await worker.processNextImportBatchJob({ claimOwnerId: "c51a-date-worker", claimTtlMs: 30_000 });
    expect(created).toHaveBeenCalledTimes(1);
    expect((await worker.getImportBatchJob(job.jobId))?.status).toBe("completed");
  });
});
