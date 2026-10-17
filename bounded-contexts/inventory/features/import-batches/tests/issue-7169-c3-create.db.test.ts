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
import { type PgQueryFunction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresDurableJobStore } from "@chase-sets/platform-runtime/durable-job-store";
import { createPostgresDurableJobWorkUnitStore } from "@chase-sets/platform-runtime/durable-job-work-units";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { module as inventoryModule } from "../../../index";
import { createInventoryServices } from "../../../support/runtime-support/services";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import { createInventoryImportBatchRuntime } from "../api/runtime";
import { loadInventoryImportSnapshotPage, stageInventoryImportSnapshot } from "../api/safe-snapshot";
import { prepareInventoryImportSnapshot } from "../api/safe-snapshot";
import { contractInventoryImportSources, migrateInventoryImportSource } from "../api/source-migration";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for C3 import recovery DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_c3_synthetic" as AccountId;
const authority: EventStoreContext = {
  tenantId: "tnt_c3_synthetic",
  audit: { performedByUserId: "usr_c3_synthetic", forAccountId: accountId },
};
const params = {
  accountId,
  csvText: "catalogItemId,storageLocationId,totalQuantity\ncat_c3_synthetic,loc_c3_synthetic,2",
};
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
    await pools.inventory.query(
      "INSERT INTO inventory_catalog_items (catalog_item_id, status) VALUES ('cat_c3_synthetic', 'active')",
    );
    await pools.inventory.query(
      `INSERT INTO inventory_storage_locations (storage_location_id, account_id, name, ship_from_code)
      VALUES ('loc_c3_synthetic', $1, 'Synthetic shelf', 'MAIN')`,
      [accountId],
    );
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  const services = () => createInventoryServices(pools.inventory);

  it.each(["csv", "parsed", "normalized"])(
    "issue-7169-c3-safe-rollout: lossless %s legacy source conversion is replay-safe",
    async (kind) => {
      await pools.inventory.query(`ALTER TABLE inventory_import_batch_job_inputs ADD COLUMN csv_text text,
      ADD COLUMN parsed_rows jsonb, ADD COLUMN source_filename text`);
      const original = prepareInventoryImportSnapshot(params);
      const inputId = `input_legacy_${kind}_synthetic`;
      if (kind !== "normalized")
        await pools.inventory.query(
          `INSERT INTO inventory_import_batch_job_inputs
      (input_id, account_id, csv_text, parsed_rows, source_filename, created_at) VALUES ($1, $2, $3, $4::jsonb, 'private-synthetic.csv', now())`,
          [
            inputId,
            accountId,
            kind === "csv" ? params.csvText : null,
            kind === "parsed"
              ? JSON.stringify([
                  {
                    rowNumber: 2,
                    values: {
                      catalogItemId: "cat_c3_synthetic",
                      storageLocationId: "loc_c3_synthetic",
                      totalQuantity: "2",
                    },
                  },
                ])
              : null,
          ],
        );
      const fallback = { inputId, normalizedRows: original.rows };
      expect(await migrateInventoryImportSource(pools.inventory, inputId, accountId, fallback)).toEqual(
        original.header,
      );
      expect(await migrateInventoryImportSource(pools.inventory, inputId, accountId, fallback)).toEqual(
        original.header,
      );
      expect((await loadInventoryImportSnapshotPage(pools.inventory, inputId, accountId)).rows).toEqual(original.rows);
      const retained = await pools.inventory.query(
        `SELECT csv_text, parsed_rows, source_filename, snapshot_version
      FROM inventory_import_batch_job_inputs WHERE input_id = $1`,
        [inputId],
      );
      expect(retained.rows).toEqual([
        { csv_text: null, parsed_rows: null, source_filename: null, snapshot_version: 1 },
      ]);
    },
  );

  it("issue-7169-c3-safe-rollout: interrupted conversion preserves old work, then contracts after compatible readers", async () => {
    await pools.inventory.query(`ALTER TABLE inventory_import_batch_job_inputs ADD COLUMN csv_text text,
      ADD COLUMN parsed_rows jsonb, ADD COLUMN source_filename text`);
    await pools.inventory.query("ALTER TABLE inventory_import_batches ADD COLUMN source_filename text");
    const inventory = services();
    const job = await inventory.importBatches.enqueueCreateBatchJob(
      params,
      withInventoryMutationAttempt(authority, randomUUID()),
    );
    await pools.inventory.query(`DELETE FROM inventory_import_snapshot_rows WHERE input_id = $1`, [
      job.payload.create!.inputId,
    ]);
    await pools.inventory.query(
      `UPDATE inventory_import_batch_job_inputs SET snapshot_version = NULL,
      snapshot_hash = NULL, csv_text = $2, source_filename = 'private-synthetic.csv' WHERE input_id = $1`,
      [job.payload.create!.inputId, params.csvText],
    );
    let killed = false;
    const interrupted: PgTransactionalPool = {
      query: ((sql: string, values?: readonly unknown[]) => pools.inventory.query(sql, values)) as PgQueryFunction,
      connect: async () => {
        const client = await pools.inventory.connect();
        return {
          release: (error) => client.release(error),
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(sql, values);
            if (!killed && sql.includes("INSERT INTO inventory_import_snapshot_rows")) {
              killed = true;
              throw new Error("synthetic-conversion-kill");
            }
            return result;
          },
        };
      },
    };
    await expect(contractInventoryImportSources(interrupted)).rejects.toThrow("synthetic-conversion-kill");
    expect(
      (await pools.inventory.query("SELECT csv_text, snapshot_version FROM inventory_import_batch_job_inputs")).rows,
    ).toEqual([{ csv_text: params.csvText, snapshot_version: null }]);
    expect((await pools.inventory.query("SELECT row_number FROM inventory_import_snapshot_rows")).rows).toEqual([]);
    await contractInventoryImportSources(pools.inventory);
    await contractInventoryImportSources(pools.inventory);
    const columns = await pools.inventory.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name IN ('inventory_import_batch_job_inputs', 'inventory_import_batches')
        AND column_name IN ('csv_text', 'parsed_rows', 'source_filename')`);
    expect(columns.rows).toHaveLength(4);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    expect(
      (
        await pools.inventory.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'inventory_import_batch_job_inputs' AND column_name = 'csv_text'`)
      ).rows,
    ).toHaveLength(1);
    expect(
      (await loadInventoryImportSnapshotPage(pools.inventory, job.payload.create!.inputId, accountId)).rows,
    ).toHaveLength(1);
    await inventory.importBatches.processNextImportBatchJob(claim);
    expect((await inventory.importBatches.getImportBatchJob(job.jobId))?.status).toBe("completed");
  });

  it("issue-7169-c3-safe-rollout: base workers ignore fenced jobs before and after legacy conversion", async () => {
    const inventory = services();
    const job = await inventory.importBatches.enqueueCreateBatchJob(
      params,
      withInventoryMutationAttempt(authority, randomUUID()),
    );
    const baseJobStore = createPostgresDurableJobStore<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(pools.inventory, { jobsTable: "inventory_import_batch_jobs", eventsTable: "inventory_import_batch_job_events" });
    const baseUnitStore = createPostgresDurableJobWorkUnitStore<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
      { rowNumber: number },
      Record<string, unknown>
    >(
      pools.inventory,
      {
        jobsTable: "inventory_import_batch_jobs",
        eventsTable: "inventory_import_batch_job_events",
        workUnitsTable: "inventory_import_batch_work_units",
      },
      { workflowName: "inventory.import-batch" },
    );
    expect(
      (await pools.inventory.query("SELECT job_kind FROM inventory_import_batch_jobs WHERE job_id = $1", [job.jobId]))
        .rows,
    ).toEqual([{ job_kind: "create-snapshot-v1" }]);
    expect(
      (
        await baseUnitStore.claimNext({
          claimOwnerId: "base-old",
          claimTtlMs: 30_000,
          workflowMaxActiveClaims: 1,
          jobMaxActiveClaims: 1,
          jobKinds: ["create"],
        })
      ).claim,
    ).toBeNull();
    expect(
      await baseJobStore.claimNext({ claimOwnerId: "base-old", claimTtlMs: 30_000, jobKinds: ["create"] }),
    ).toBeNull();

    await pools.inventory.query(
      "ALTER TABLE inventory_import_batch_job_inputs ADD COLUMN csv_text text, ADD COLUMN parsed_rows jsonb, ADD COLUMN source_filename text",
    );
    await pools.inventory.query("DELETE FROM inventory_import_snapshot_rows WHERE input_id = $1", [
      job.payload.create!.inputId,
    ]);
    await pools.inventory.query(
      `UPDATE inventory_import_batch_job_inputs SET snapshot_version = NULL, snapshot_hash = NULL, csv_text = $2, source_filename = 'legacy.csv' WHERE input_id = $1`,
      [job.payload.create!.inputId, params.csvText],
    );
    await pools.inventory.query("UPDATE inventory_import_batch_jobs SET job_kind = 'create' WHERE job_id = $1", [
      job.jobId,
    ]);
    await pools.inventory.query("UPDATE inventory_import_batch_work_units SET unit_kind = 'create' WHERE job_id = $1", [
      job.jobId,
    ]);
    await contractInventoryImportSources(pools.inventory);
    expect(
      (await pools.inventory.query("SELECT job_kind FROM inventory_import_batch_jobs WHERE job_id = $1", [job.jobId]))
        .rows,
    ).toEqual([{ job_kind: "create-snapshot-v1" }]);
    expect(
      (
        await baseUnitStore.claimNext({
          claimOwnerId: "base-old-2",
          claimTtlMs: 30_000,
          workflowMaxActiveClaims: 1,
          jobMaxActiveClaims: 1,
          jobKinds: ["create"],
        })
      ).claim,
    ).toBeNull();
    expect(
      await baseJobStore.claimNext({ claimOwnerId: "base-old-2", claimTtlMs: 30_000, jobKinds: ["create"] }),
    ).toBeNull();
    expect(
      (
        await pools.inventory.query(
          "SELECT csv_text, snapshot_version FROM inventory_import_batch_job_inputs WHERE input_id = $1",
          [job.payload.create!.inputId],
        )
      ).rows,
    ).toEqual([{ csv_text: null, snapshot_version: 1 }]);
  });

  it("issue-7169-c3-safe-rollout: isolates poison retained records and continues valid work", async () => {
    await pools.inventory.query(
      `ALTER TABLE inventory_import_batch_job_inputs ADD COLUMN csv_text text, ADD COLUMN parsed_rows jsonb, ADD COLUMN source_filename text`,
    );
    const inventory = services();
    const valid = await inventory.importBatches.enqueueCreateBatchJob(
      params,
      withInventoryMutationAttempt(authority, randomUUID()),
    );
    await pools.inventory.query("DELETE FROM inventory_import_snapshot_rows WHERE input_id = $1", [
      valid.payload.create!.inputId,
    ]);
    await pools.inventory.query(
      `UPDATE inventory_import_batch_job_inputs SET snapshot_version = NULL, snapshot_hash = NULL, csv_text = $2 WHERE input_id = $1`,
      [valid.payload.create!.inputId, params.csvText],
    );
    await pools.inventory.query(
      `INSERT INTO inventory_import_batches (batch_id, account_id, status, total_count, accepted_count, created_at, updated_at, source_key)
       VALUES ('imb_poison_synthetic', $1, 'uploaded', 1, 1, now(), now(), 'native-csv')`,
      [accountId],
    );
    await pools.inventory.query(
      `INSERT INTO inventory_import_batch_rows (row_id, batch_id, row_number, status, raw_row, created_at, updated_at)
       VALUES ('imr_poison_synthetic', 'imb_poison_synthetic', 1, 'accepted', $1::jsonb, now(), now())`,
      [JSON.stringify({ rowNote: "restocked, see https://synthetic.invalid/listing" })],
    );
    await pools.inventory.query(
      `INSERT INTO inventory_import_batch_job_inputs (input_id, account_id, csv_text, source_filename, created_at)
       VALUES ('input_poison_synthetic', $1, $2, 'legacy.csv', now())`,
      [accountId, "catalogItemId,totalQuantity\n" + "x".repeat(1_025)],
    );
    await contractInventoryImportSources(pools.inventory);
    const poisonedInput = await pools.inventory.query(
      "SELECT csv_text, parsed_rows, source_filename FROM inventory_import_batch_job_inputs WHERE input_id = 'input_poison_synthetic'",
    );
    expect(poisonedInput.rows).toEqual([{ csv_text: null, parsed_rows: null, source_filename: null }]);
    const retained = await pools.inventory.query<{ raw_row: Record<string, unknown> }>(
      "SELECT raw_row FROM inventory_import_batch_rows WHERE row_id = 'imr_poison_synthetic'",
    );
    expect(JSON.stringify(retained.rows[0].raw_row)).not.toContain("https://synthetic.invalid");
    expect(JSON.stringify(retained.rows[0].raw_row)).toContain("legacy import value redacted");
    await inventory.importBatches.processNextImportBatchJob(claim);
    expect((await inventory.importBatches.getImportBatchJob(valid.jobId))?.status).toBe("completed");
  });

  it("issue-7169-c3-create-row-recovery: reads all 10k source rows in bounded pages and reaches a decisive row beyond the first page", async () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      rowNumber: index + 1,
      values: { catalogItemId: "cat_c3_synthetic", totalQuantity: "1", sellerSku: `SKU-${index}` },
    }));
    const snapshot = prepareInventoryImportSnapshot({ accountId, sourceKey: "saved-list", parsedRows: rows });
    await stageInventoryImportSnapshot(pools.inventory, "input_10k_synthetic", snapshot);
    let after = 0;
    let read = 0;
    let pages = 0;
    for (;;) {
      const page = await loadInventoryImportSnapshotPage(pools.inventory, "input_10k_synthetic", accountId, after);
      expect(page.rows.length).toBeLessThanOrEqual(100);
      if (!page.rows.length) break;
      read += page.rows.length;
      pages++;
      after = page.rows[page.rows.length - 1].rowNumber;
    }
    expect({ read, pages, after }).toEqual({ read: 10_000, pages: 100, after: 10_000 });
    expect(
      (await loadInventoryImportSnapshotPage(pools.inventory, "input_10k_synthetic", accountId, 0, 10_000)).rows[0]
        .values.sellerSku,
    ).toBe("SKU-9999");
    await expect(
      loadInventoryImportSnapshotPage(pools.inventory, "input_10k_synthetic", "acc_c3_other", 0, 10_000),
    ).rejects.toThrow();
    await pools.inventory.query(
      `INSERT INTO inventory_import_batches
      (batch_id, account_id, status, total_count, accepted_count, created_at, updated_at)
      VALUES ('imb_paged_synthetic', $1, 'uploaded', 10000, 10000, now(), now())`,
      [accountId],
    );
    await pools.inventory.query(`INSERT INTO inventory_import_batch_rows
      (row_id, batch_id, row_number, status, seller_sku, created_at, updated_at)
      SELECT 'imr_paged_synthetic_' || number, 'imb_paged_synthetic', number, 'accepted', 'SKU-' || number, now(), now()
      FROM generate_series(1, 10000) AS number`);
    const first = await services().importBatches.getBatch("imb_paged_synthetic", accountId);
    expect(first).toMatchObject({ total_count: 10_000, status: "ready-to-commit" });
    expect(first?.rows).toHaveLength(100);
    const last = await services().importBatches.getBatch("imb_paged_synthetic", accountId, {
      limit: 100,
      offset: 9_900,
    });
    expect(last?.rows).toHaveLength(100);
    expect(last?.rows[99].seller_sku).toBe("SKU-10000");
    expect(await services().importBatches.getBatch("imb_paged_synthetic", "acc_c3_other")).toBeNull();
  });

  it("issue-7169-c3-create-row-recovery: shutdown relinquishes a claim without losing the accepted source or writing a row", async () => {
    const inventory = services();
    const job = await inventory.importBatches.enqueueCreateBatchJob(
      params,
      withInventoryMutationAttempt(authority, randomUUID()),
    );
    const controller = new AbortController();
    const worker = createInventoryImportBatchRuntime({
      db: pools.inventory,
      items: inventory.items,
      catalogItems: {
        ...inventory.catalogItems,
        getCatalogItem: async (...args) => {
          const result = await inventory.catalogItems.getCatalogItem(...args);
          controller.abort();
          return result;
        },
      },
    });
    expect(await worker.processNextImportBatchJob({ ...claim, signal: controller.signal })).toBe(0);
    expect((await pools.inventory.query("SELECT row_id FROM inventory_import_batch_rows")).rows).toEqual([]);
    expect(
      (await pools.inventory.query("SELECT state, claim_owner_id FROM inventory_import_batch_work_units")).rows,
    ).toEqual([{ state: "queued", claim_owner_id: null }]);
    expect((await inventory.importBatches.getImportBatchJob(job.jobId))?.status).toBe("queued");
    expect((await pools.inventory.query("SELECT input_id FROM inventory_import_batch_job_inputs")).rows).toHaveLength(
      1,
    );
    await inventory.importBatches.processNextImportBatchJob(claim);
    expect((await inventory.importBatches.getImportBatchJob(job.jobId))?.status).toBe("completed");
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(0);
  });

  it("issue-7169-c3-upload-recovery: expiry retains active sources, receipts and diagnostics, then audits exact identity deletion", async () => {
    const inventory = services();
    const id = randomUUID();
    const context = withInventoryMutationAttempt(authority, id);
    const job = await inventory.importBatches.enqueueCreateBatchJob(params, context);
    await pools.inventory.query("UPDATE inventory_import_batch_job_inputs SET created_at = now() - interval '2 days'");
    expect((await inventory.importBatches.pruneImportBatchJobRetention()).stagedInputs).toBe(0);
    expect((await pools.inventory.query("SELECT input_id FROM inventory_import_batch_job_inputs")).rows).toHaveLength(
      1,
    );
    await inventory.importBatches.processNextImportBatchJob(claim);
    expect((await inventory.importBatches.pruneImportBatchJobRetention()).stagedInputs).toBe(1);
    expect((await inventory.importBatches.getBatch(job.payload.batchId!, accountId))?.status).toBe("expired");
    expect((await pools.inventory.query("SELECT row_id FROM inventory_import_batch_rows")).rows).toHaveLength(1);
    expect(
      (await pools.inventory.query("SELECT input_id, snapshot_hash FROM inventory_import_source_cleanup")).rows,
    ).toEqual([{ input_id: job.payload.create!.inputId, snapshot_hash: job.payload.create!.snapshotHash }]);
    expect((await inventory.mutations.read(id, context))?.result).toEqual(job);
    expect(await inventory.importBatches.enqueueCreateBatchJob(params, context)).toEqual(job);
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(0);
    expect((await inventory.importBatches.pruneImportBatchJobRetention()).stagedInputs).toBe(0);
  });

  it("container-only-complete: poisoned terminal units without row outcomes fail closed", async () => {
    const inventory = services();
    const job = await inventory.importBatches.enqueueCreateBatchJob(
      params,
      withInventoryMutationAttempt(authority, randomUUID()),
    );
    await pools.inventory.query(
      `UPDATE inventory_import_batch_work_units SET state = 'completed',
      result = '{"rowId":"missing-synthetic","status":"accepted"}'::jsonb WHERE job_id = $1`,
      [job.jobId],
    );
    await inventory.importBatches.processNextImportBatchJob(claim);
    expect((await inventory.importBatches.getImportBatchJob(job.jobId))?.status).toBe("failed");
    expect((await pools.inventory.query("SELECT row_id FROM inventory_import_batch_rows")).rows).toEqual([]);
  });

  it("issue-7169-ac4-safe-import-create: concurrency, replay and response loss return one immutable private acceptance", async () => {
    const inventory = services();
    const id = randomUUID();
    const context = withInventoryMutationAttempt(authority, id);
    const jobs = await Promise.all(
      Array.from({ length: 8 }, () => inventory.importBatches.enqueueCreateBatchJob(params, context)),
    );
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
    await expect(
      inventory.importBatches.enqueueCreateBatchJob(
        { ...params, csvText: params.csvText.replace(",2", ",3") },
        context,
      ),
    ).rejects.toThrow("conflicts");
    const stranger = withInventoryMutationAttempt(
      { ...authority, audit: { ...authority.audit, performedByUserId: "usr_c3_other" } },
      id,
    );
    expect(await inventory.mutations.read(id, stranger)).toBeNull();
    await expect(inventory.importBatches.enqueueCreateBatchJob(params, stranger)).rejects.toThrow("not authorized");
    await expect(
      loadInventoryImportSnapshotPage(pools.inventory, initial.payload.create!.inputId, "acc_c3_other"),
    ).rejects.toThrow("snapshot is invalid");
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
    const job = await inventory.importBatches.enqueueCreateBatchJob(
      params,
      withInventoryMutationAttempt(authority, randomUUID()),
    );
    let killed = false;
    const pool: PgTransactionalPool = {
      ...pools.inventory,
      query: ((sql: string, values?: readonly unknown[]) => pools.inventory.query(sql, values)) as PgQueryFunction,
      connect: async () => {
        const client = await pools.inventory.connect();
        return {
          release: (error) => client.release(error),
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(sql, values);
            if (!killed && sql.includes("INSERT INTO inventory_import_batch_rows")) {
              killed = true;
              throw new Error("password=synthetic-must-not-be-retained");
            }
            return result;
          },
        };
      },
    };
    const worker = createInventoryImportBatchRuntime({
      db: pool,
      items: inventory.items,
      catalogItems: inventory.catalogItems,
    });
    expect(await worker.processNextImportBatchJob(claim)).toBe(1);
    expect(killed).toBe(true);
    expect((await pools.inventory.query("SELECT row_id FROM inventory_import_batch_rows")).rows).toEqual([]);
    expect(
      (await pools.inventory.query("SELECT state, error_message FROM inventory_import_batch_work_units")).rows,
    ).toEqual([{ state: "failed", error_message: "import_validation_failed_reconciliation_required" }]);
    expect((await worker.getImportBatchJob(job.jobId))?.status).toBe("failed");
    const retained = await pools.inventory.query<{ snapshot: string }>(
      "SELECT snapshot::text FROM inventory_import_batch_job_events",
    );
    expect(JSON.stringify(retained.rows)).not.toContain("synthetic-must-not-be-retained");
    expect((await pools.inventory.query("SELECT input_id FROM inventory_import_batch_job_inputs")).rows).toHaveLength(
      1,
    );
  });

  it("stale-create-claim cannot overwrite the current validation fact or first terminal", async () => {
    const inventory = services();
    const job = await inventory.importBatches.enqueueCreateBatchJob(
      params,
      withInventoryMutationAttempt(authority, randomUUID()),
    );
    let entered!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const old = createInventoryImportBatchRuntime({
      db: pools.inventory,
      items: inventory.items,
      catalogItems: {
        ...inventory.catalogItems,
        getCatalogItem: async (...args) => {
          entered();
          await gate;
          const item = await inventory.catalogItems.getCatalogItem(...args);
          return item ? { ...item, status: "draft" } : null;
        },
      },
    });
    const stale = old.processNextImportBatchJob({ ...claim, claimOwnerId: "c3-old-synthetic" });
    const observed = stale.then(
      () => null,
      (error: unknown) => error,
    );
    await waiting;
    await pools.inventory.query(
      "UPDATE inventory_import_batch_work_units SET claimed_until = now() - interval '1 second' WHERE job_id = $1",
      [job.jobId],
    );
    try {
      await inventory.importBatches.processNextImportBatchJob({ ...claim, claimOwnerId: "c3-current-synthetic" });
    } finally {
      resume();
    }
    expect(await observed).toBeInstanceOf(Error);
    const detail = await inventory.importBatches.getBatch(job.payload.batchId!, accountId);
    expect(detail?.rows).toHaveLength(1);
    expect(detail?.rows[0]).toMatchObject({ status: "accepted", product_id: "cat_c3_synthetic::" });
    expect((await inventory.importBatches.getImportBatchJob(job.jobId))?.status).toBe("completed");
  });
});
