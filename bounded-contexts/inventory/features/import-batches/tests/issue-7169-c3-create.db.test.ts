import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { closeMultiContextTestPools, createMultiContextTestDatabaseUrls, createMultiContextTestPools,
  ensureMultiContextTestDatabases, resetMultiContextTestSchemas } from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { module as inventoryModule } from "../../../index";
import { createInventoryServices } from "../../../support/runtime-support/services";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import { createInventoryImportBatchRuntime } from "../api/runtime";
import { loadInventoryImportSnapshotPage } from "../api/safe-snapshot";
import { prepareInventoryImportSnapshot } from "../api/safe-snapshot";
import { migrateInventoryImportSource } from "../api/source-migration";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for C3 import recovery DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_c3_synthetic" as AccountId;
const authority: EventStoreContext = { tenantId: "tnt_c3_synthetic",
  audit: { performedByUserId: "usr_c3_synthetic", forAccountId: accountId } };
const params = { accountId, csvText: "catalogItemId,storageLocationId,totalQuantity\ncat_c3_synthetic,loc_c3_synthetic,2" };
const claim = { claimOwnerId: "c3-worker-synthetic", claimTtlMs: 30_000 };

describeDb("issue-7169-c3-create-row-recovery", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "inventory_c3_recovery");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await pools.inventory.query("INSERT INTO inventory_catalog_items (catalog_item_id, status) VALUES ('cat_c3_synthetic', 'active')");
    await pools.inventory.query(`INSERT INTO inventory_storage_locations (storage_location_id, account_id, name, ship_from_code)
      VALUES ('loc_c3_synthetic', $1, 'Synthetic shelf', 'MAIN')`, [accountId]);
  });
  afterAll(async () => { if (pools) await closeMultiContextTestPools(pools); });
  const services = () => createInventoryServices(pools.inventory);

  it.each(["csv", "parsed", "normalized"])("issue-7169-c3-safe-rollout: lossless %s legacy source conversion is replay-safe", async (kind) => {
    const original = prepareInventoryImportSnapshot(params);
    const inputId = `input_legacy_${kind}_synthetic`;
    if (kind !== "normalized") await pools.inventory.query(`INSERT INTO inventory_import_batch_job_inputs
      (input_id, account_id, csv_text, parsed_rows, source_filename, created_at) VALUES ($1, $2, $3, $4::jsonb, 'private-synthetic.csv', now())`,
    [inputId, accountId, kind === "csv" ? params.csvText : null, kind === "parsed" ? JSON.stringify([
      { rowNumber: 2, values: { catalogItemId: "cat_c3_synthetic", storageLocationId: "loc_c3_synthetic", totalQuantity: "2" } },
    ]) : null]);
    const fallback = { inputId, normalizedRows: original.rows };
    expect(await migrateInventoryImportSource(pools.inventory, inputId, accountId, fallback)).toEqual(original.header);
    expect(await migrateInventoryImportSource(pools.inventory, inputId, accountId, fallback)).toEqual(original.header);
    expect((await loadInventoryImportSnapshotPage(pools.inventory, inputId, accountId)).rows).toEqual(original.rows);
    const retained = await pools.inventory.query(`SELECT csv_text, parsed_rows, source_filename, snapshot_version
      FROM inventory_import_batch_job_inputs WHERE input_id = $1`, [inputId]);
    expect(retained.rows).toEqual([{ csv_text: null, parsed_rows: null, source_filename: null, snapshot_version: 1 }]);
  });

  it("issue-7169-c3-upload-recovery: expiry retains active sources, receipts and diagnostics, then audits exact identity deletion", async () => {
    const inventory = services();
    const id = randomUUID();
    const context = withInventoryMutationAttempt(authority, id);
    const job = await inventory.importBatches.enqueueCreateBatchJob(params, context);
    await pools.inventory.query("UPDATE inventory_import_batch_job_inputs SET created_at = now() - interval '2 days'");
    expect((await inventory.importBatches.pruneImportBatchJobRetention()).stagedInputs).toBe(0);
    expect((await pools.inventory.query("SELECT input_id FROM inventory_import_batch_job_inputs")).rows).toHaveLength(1);
    await inventory.importBatches.processNextImportBatchJob(claim);
    expect((await inventory.importBatches.pruneImportBatchJobRetention()).stagedInputs).toBe(1);
    expect((await inventory.importBatches.getBatch(job.payload.batchId!, accountId))?.status).toBe("expired");
    expect((await pools.inventory.query("SELECT row_id FROM inventory_import_batch_rows")).rows).toHaveLength(1);
    expect((await pools.inventory.query("SELECT input_id, snapshot_hash FROM inventory_import_source_cleanup")).rows)
      .toEqual([{ input_id: job.payload.create!.inputId, snapshot_hash: job.payload.create!.snapshotHash }]);
    expect((await inventory.mutations.read(id, context))?.result).toEqual(job);
    expect(await inventory.importBatches.enqueueCreateBatchJob(params, context)).toEqual(job);
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(0);
    expect((await inventory.importBatches.pruneImportBatchJobRetention()).stagedInputs).toBe(0);
  });

  it("container-only-complete: poisoned terminal units without row outcomes fail closed", async () => {
    const inventory = services();
    const job = await inventory.importBatches.enqueueCreateBatchJob(params, withInventoryMutationAttempt(authority, randomUUID()));
    await pools.inventory.query(`UPDATE inventory_import_batch_work_units SET state = 'completed',
      result = '{"rowId":"missing-synthetic","status":"accepted"}'::jsonb WHERE job_id = $1`, [job.jobId]);
    await inventory.importBatches.processNextImportBatchJob(claim);
    expect((await inventory.importBatches.getImportBatchJob(job.jobId))?.status).toBe("failed");
    expect((await pools.inventory.query("SELECT row_id FROM inventory_import_batch_rows")).rows).toEqual([]);
  });

  it("issue-7169-ac4-safe-import-create: concurrency, replay and response loss return one immutable private acceptance", async () => {
    const inventory = services();
    const id = randomUUID();
    const context = withInventoryMutationAttempt(authority, id);
    const jobs = await Promise.all(Array.from({ length: 8 }, () => inventory.importBatches.enqueueCreateBatchJob(params, context)));
    expect(new Set(jobs.map((job) => job.jobId)).size).toBe(1);
    const initial = jobs[0];
    const counts = await pools.inventory.query(`SELECT
      (SELECT count(*)::integer FROM inventory_import_batch_jobs) AS jobs,
      (SELECT count(*)::integer FROM inventory_import_batch_job_inputs) AS inputs,
      (SELECT count(*)::integer FROM inventory_import_snapshot_rows) AS sources,
      (SELECT count(*)::integer FROM inventory_import_batch_work_units) AS units,
      (SELECT count(*)::integer FROM inventory_mutation_attempts) AS receipts,
      (SELECT count(*)::integer FROM event_store_events) AS stock_facts`);
    expect(counts.rows).toEqual([{ jobs: 1, inputs: 1, sources: 1, units: 1, receipts: 1, stock_facts: 0 }]);
    const formatted = { ...params, csvText: params.csvText.replaceAll("\n", "\r\n") + "\r\n" };
    expect(await inventory.importBatches.enqueueCreateBatchJob(formatted, context)).toEqual(initial);
    await expect(inventory.importBatches.enqueueCreateBatchJob({ ...params, csvText: params.csvText.replace(",2", ",3") }, context)).rejects.toThrow("conflicts");
    const stranger = withInventoryMutationAttempt({ ...authority, audit: { ...authority.audit, performedByUserId: "usr_c3_other" } }, id);
    expect(await inventory.mutations.read(id, stranger)).toBeNull();
    await expect(inventory.importBatches.enqueueCreateBatchJob(params, stranger)).rejects.toThrow("not authorized");
    await expect(loadInventoryImportSnapshotPage(pools.inventory, initial.payload.create!.inputId, "acc_c3_other")).rejects.toThrow("snapshot is invalid");
    await inventory.importBatches.processNextImportBatchJob(claim);
    const completed = await inventory.importBatches.getImportBatchJob(initial.jobId);
    expect(completed?.status).toBe("completed");
    const detail = await inventory.importBatches.getBatch(initial.payload.batchId!, accountId);
    expect(detail).toMatchObject({ total_count: 1, accepted_count: 1, rejected_count: 0 });
    expect(detail?.rows[0].status).toBe("accepted");
    expect(await inventory.importBatches.enqueueCreateBatchJob(params, context)).toEqual(initial);
    expect((await inventory.mutations.read(id, context))?.result).toEqual(initial);
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(0);
  });

  it("rolls back the validation fact with its fenced outcome and records a bounded real failure", async () => {
    const inventory = services();
    const job = await inventory.importBatches.enqueueCreateBatchJob(params, withInventoryMutationAttempt(authority, randomUUID()));
    let killed = false;
    const pool: PgTransactionalPool = { ...pools.inventory,
      query: (sql, values) => pools.inventory.query(sql, values),
      connect: async () => {
        const client = await pools.inventory.connect();
        return { release: (error) => client.release(error), query: async <Row>(sql: string, values?: readonly unknown[]) => {
          const result = await client.query<Row>(sql, values);
          if (!killed && sql.includes("INSERT INTO inventory_import_batch_rows")) {
            killed = true;
            throw new Error("password=synthetic-must-not-be-retained");
          }
          return result;
        } };
      } };
    const worker = createInventoryImportBatchRuntime({ db: pool, items: inventory.items, catalogItems: inventory.catalogItems });
    expect(await worker.processNextImportBatchJob(claim)).toBe(1);
    expect(killed).toBe(true);
    expect((await pools.inventory.query("SELECT row_id FROM inventory_import_batch_rows")).rows).toEqual([]);
    expect((await pools.inventory.query("SELECT state, error_message FROM inventory_import_batch_work_units")).rows)
      .toEqual([{ state: "failed", error_message: "import_validation_failed_reconciliation_required" }]);
    expect((await worker.getImportBatchJob(job.jobId))?.status).toBe("failed");
    const retained = await pools.inventory.query<{ snapshot: string }>("SELECT snapshot::text FROM inventory_import_batch_job_events");
    expect(JSON.stringify(retained.rows)).not.toContain("synthetic-must-not-be-retained");
    expect((await pools.inventory.query("SELECT input_id FROM inventory_import_batch_job_inputs")).rows).toHaveLength(1);
  });

  it("stale-create-claim cannot overwrite the current validation fact or first terminal", async () => {
    const inventory = services();
    const job = await inventory.importBatches.enqueueCreateBatchJob(params, withInventoryMutationAttempt(authority, randomUUID()));
    let entered!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const old = createInventoryImportBatchRuntime({ db: pools.inventory, items: inventory.items,
      catalogItems: { ...inventory.catalogItems, getCatalogItem: async (...args) => {
        entered(); await gate;
        const item = await inventory.catalogItems.getCatalogItem(...args);
        return item ? { ...item, status: "draft" } : null;
      } } });
    const stale = old.processNextImportBatchJob({ ...claim, claimOwnerId: "c3-old-synthetic" });
    const observed = stale.then(() => null, (error: unknown) => error);
    await waiting;
    await pools.inventory.query("UPDATE inventory_import_batch_work_units SET claimed_until = now() - interval '1 second' WHERE job_id = $1", [job.jobId]);
    try {
      await inventory.importBatches.processNextImportBatchJob({ ...claim, claimOwnerId: "c3-current-synthetic" });
    } finally { resume(); }
    expect(await observed).toBeInstanceOf(Error);
    const detail = await inventory.importBatches.getBatch(job.payload.batchId!, accountId);
    expect(detail?.rows).toHaveLength(1);
    expect(detail?.rows[0]).toMatchObject({ status: "accepted", product_id: "cat_c3_synthetic::" });
    expect((await inventory.importBatches.getImportBatchJob(job.jobId))?.status).toBe("completed");
  });
});
