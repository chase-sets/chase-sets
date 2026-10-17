import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as inventoryModule } from "../../../index";
import { createInventoryServices } from "../../../support/runtime-support/services";
import { createInventoryImportBatchRuntime, type InventoryImportBatchJobProgress } from "./runtime";
import {
  PRODUCT_RESOLUTION_JOB_ID,
  PRODUCT_RESOLUTION_UNIT_ID,
  readProductResolutionReceipt,
  productResolutionRollout,
} from "./product-resolution-maintenance";
import {
  createImportResolutionAttentionSourceFromReadModel,
  importResolutionRowPredicateSql,
} from "../read-model/seller-attention-source";
import { unresolvedResolutionRowIds } from "../ui/resolution-flow";
import { inventoryImportSourceProfiles } from "../domain/import-source-profiles";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Import Product maintenance DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const claim = { claimOwnerId: "import-product-maintenance-db", claimTtlMs: 30_000 };
const accountId = "acc_import_review" as AccountId;
const context: EventStoreContext = {
  tenantId: "tnt_import_review" as never,
  audit: { performedByUserId: "usr_import_review" as never, forAccountId: accountId },
};

describeDb("Import Product durable maintenance AC-04 through AC-09", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["inventory"],
      "inventory_import_product_resolution",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await pools.inventory.query(`INSERT INTO inventory_catalog_items (catalog_item_id, status)
      VALUES ('cat_active', 'active'), ('cat_inactive', 'draft')`);
    await pools.inventory.query(
      `INSERT INTO inventory_storage_locations (storage_location_id, account_id, name, ship_from_code)
      VALUES ('loc_import', $1, 'Import shelf', 'MAIN')`,
      [accountId],
    );
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function runtime(
    db: PgQueryable = pools.inventory,
    rollout?: { normalizationEnabled: boolean; stockProgressionEnabled: boolean },
  ) {
    const services = createInventoryServices(pools.inventory);
    return createInventoryImportBatchRuntime({
      db,
      catalogItems: services.catalogItems,
      items: services.items,
      importProductRollout: rollout,
    });
  }
  async function seedRows(count: number, sourceKey = "tcgplayer-csv", batchId = "batch_legacy") {
    await pools.inventory.query(
      `INSERT INTO inventory_import_batches (batch_id, account_id, status, source_key, created_at, updated_at)
      VALUES ($1, $2, 'uploaded', $3, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
      [batchId, accountId, sourceKey],
    );
    await pools.inventory.query(
      `INSERT INTO inventory_import_batch_rows
      (row_id, batch_id, row_number, status, raw_row, external_reference, row_fingerprint, catalog_item_id, product_id,
       selected_options, storage_location_id, total_quantity, quantity_delta, seller_sku, row_note, validation_errors, created_at, updated_at)
      SELECT $1 || ':' || lpad(value::text, 4, '0'), $1, value, 'rejected',
        '{"original":"source evidence","Catalog item was not found.":"not an error"}'::jsonb,
        '{"providerKey":"tcgplayer","externalKey":"product:source"}'::jsonb, 'unchanged fingerprint',
        'cat_inactive', 'cat_inactive::', '[]'::jsonb, 'loc_import', 2, 2, 'original-sku', 'original note',
        '["quantity stays first","Catalog item was not found.","Seller SKU ''keep'' is not mapped for this account.","Selected options stale.","External product reference is not mapped to a Chase Sets catalog item.","listing stays last"]'::jsonb,
        '2020-01-01T00:00:00Z'::timestamptz + value * interval '1 microsecond', '2020-01-01T00:00:00Z'
      FROM generate_series(1, $2::integer) AS value`,
      [batchId, count],
    );
  }
  function interceptedPool(
    before: (sql: string, values: readonly unknown[]) => Promise<void>,
    after?: (sql: string, values: readonly unknown[]) => void,
  ): PgTransactionalPool {
    return {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        await before(sql, values);
        const result = await pools.inventory.query<Row>(sql, values);
        after?.(sql, values);
        return result;
      },
      connect: async () => {
        const client = await pools.inventory.connect();
        return {
          release: (error?: unknown) => client.release(error),
          query: async <Row>(sql: string, values: readonly unknown[] = []) => {
            await before(sql, values);
            const result = await client.query<Row>(sql, values);
            after?.(sql, values);
            return result;
          },
        };
      },
    };
  }
  async function job() {
    return (await runtime().getImportBatchJob(PRODUCT_RESOLUTION_JOB_ID))!;
  }

  it("AC-04 bootstraps a valid keyset scan index through an idempotent migration", async () => {
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    const indexes = await pools.inventory.query<{ valid: boolean; definition: string }>(
      `SELECT indisvalid AS valid, pg_get_indexdef(indexrelid) AS definition
       FROM pg_index
       WHERE indexrelid = 'inventory_import_batch_rows_product_resolution_scan_idx'::regclass`,
    );
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]?.valid).toBe(true);
    expect(indexes.rows[0]?.definition).toContain("(created_at, row_id)");
    expect(indexes.rows[0]?.definition).toContain("(status = 'rejected'::text) AND (committed_at IS NULL)");
  });

  it("AC-04 persists inclusive microsecond high-water and 250-row checkpoints across restart; replay writes nothing", async () => {
    await seedRows(301);
    const abort = new AbortController();
    let checkpointed = false;
    const db = interceptedPool(
      async () => undefined,
      (sql, values) => {
        if (sql.includes("SET progress = $2::jsonb") && JSON.parse(String(values[1])).maintenance?.scannedCount === 250)
          checkpointed = true;
        if (sql === "COMMIT" && checkpointed) abort.abort();
      },
    );
    const first = runtime(db);
    await first.enqueueProductResolutionMaintenanceJob();
    await expect(
      first.processNextImportProductResolutionMaintenanceJob({ ...claim, signal: abort.signal }),
    ).resolves.toBe(0);
    const retained = (await job()).progress.maintenance!;
    expect(retained).toMatchObject({
      scannedCount: 250,
      normalizedCount: 250,
      normalizedProviderCount: 250,
      finalCursor: { rowId: "batch_legacy:0250" },
      highWatermark: { rowId: "batch_legacy:0301" },
    });
    await pools.inventory.query(`INSERT INTO inventory_import_batch_rows
      (row_id, batch_id, row_number, status, product_id, created_at, updated_at)
      VALUES ('after-watermark', 'batch_legacy', 302, 'rejected', 'later-product', now(), now())`);
    await runtime().processNextImportProductResolutionMaintenanceJob(claim);
    const complete = await job();
    const receipt = readProductResolutionReceipt(complete.result?.maintenanceReceipt);
    expect(complete.status).toBe("completed");
    expect(receipt).toMatchObject({
      complete: true,
      scannedCount: 301,
      normalizedCount: 301,
      normalizedProviderCount: 301,
      finalCursor: receipt.highWatermark,
      jobId: PRODUCT_RESOLUTION_JOB_ID,
      unitId: PRODUCT_RESOLUTION_UNIT_ID,
    });
    const before = await pools.inventory.query(
      "SELECT snapshot::text FROM inventory_import_batch_job_events ORDER BY sequence",
    );
    const replay = await runtime().enqueueProductResolutionMaintenanceJob();
    expect(replay.result?.maintenanceReceipt).toEqual(receipt);
    expect(await runtime().processNextImportProductResolutionMaintenanceJob(claim)).toBe(0);
    expect(
      (await pools.inventory.query("SELECT snapshot::text FROM inventory_import_batch_job_events ORDER BY sequence"))
        .rows,
    ).toEqual(before.rows);
    expect(
      (
        await pools.inventory.query(
          "SELECT product_id FROM inventory_import_batch_rows WHERE row_id = 'after-watermark'",
        )
      ).rows,
    ).toEqual([{ product_id: "later-product" }]);
  });

  it("AC-04 canonical claims refuse version-suffixed sibling jobs and units", async () => {
    await seedRows(1);
    await runtime().enqueueProductResolutionMaintenanceJob();
    await pools.inventory.query(
      `INSERT INTO inventory_import_batch_jobs
      SELECT (jsonb_populate_record(NULL::inventory_import_batch_jobs,
        to_jsonb(job) || jsonb_build_object('job_id', 'sibling-v2'))).*
      FROM inventory_import_batch_jobs AS job WHERE job_id = $1`,
      [PRODUCT_RESOLUTION_JOB_ID],
    );
    await pools.inventory.query(
      `INSERT INTO inventory_import_batch_work_units
      SELECT (jsonb_populate_record(NULL::inventory_import_batch_work_units,
        to_jsonb(unit) || jsonb_build_object('job_id', 'sibling-v2'))).*
      FROM inventory_import_batch_work_units AS unit WHERE job_id = $1`,
      [PRODUCT_RESOLUTION_JOB_ID],
    );
    await pools.inventory.query(
      `INSERT INTO inventory_import_batch_work_units
      SELECT (jsonb_populate_record(NULL::inventory_import_batch_work_units,
        to_jsonb(unit) || jsonb_build_object('unit_id', 'sibling-unit-v2'))).*
      FROM inventory_import_batch_work_units AS unit WHERE job_id = $1`,
      [PRODUCT_RESOLUTION_JOB_ID],
    );
    await runtime().processNextImportProductResolutionMaintenanceJob(claim);
    expect((await job()).result?.maintenanceReceipt?.unitId).toBe(PRODUCT_RESOLUTION_UNIT_ID);
    expect(await runtime().processNextImportProductResolutionMaintenanceJob(claim)).toBe(0);
    const siblings = await pools.inventory.query<{ state: string }>(
      `SELECT state FROM inventory_import_batch_work_units
      WHERE job_id <> $1 OR unit_id <> $2`,
      [PRODUCT_RESOLUTION_JOB_ID, PRODUCT_RESOLUTION_UNIT_ID],
    );
    expect(siblings.rows).toEqual([{ state: "queued" }, { state: "queued" }]);
  });

  it("AC-04 one claimant excludes a concurrent processor", async () => {
    await seedRows(1);
    let announce!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const db = interceptedPool(async (sql) => {
      if (!held && sql.includes("JOIN inventory_import_batches AS batch") && sql.includes("LIMIT $5")) {
        held = true;
        announce();
        await resumed;
      }
    });
    await runtime().enqueueProductResolutionMaintenanceJob();
    const processing = runtime(db).processNextImportProductResolutionMaintenanceJob(claim);
    try {
      await entered;
      expect(
        await runtime().processNextImportProductResolutionMaintenanceJob({ ...claim, claimOwnerId: "second-owner" }),
      ).toBe(0);
    } finally {
      release();
    }
    expect(await processing).toBe(1);
    expect((await job()).result?.maintenanceReceipt?.scannedCount).toBe(1);
  });

  it("AC-04 three-attempt poison retains cursor/counts; only higher-version same-ID fenced reactivation resumes; retention preserves audit", async () => {
    await seedRows(251);
    await pools.inventory.query(
      "UPDATE inventory_import_batch_rows SET selected_options = '{}'::jsonb WHERE row_id = 'batch_legacy:0251'",
    );
    await runtime().enqueueProductResolutionMaintenanceJob();
    for (let attempt = 0; attempt < 3; attempt += 1)
      await runtime().processNextImportProductResolutionMaintenanceJob(claim);
    const failed = await job();
    expect(failed.status).toBe("failed");
    expect(failed.result).toBeNull();
    expect(failed.progress.maintenance).toMatchObject({
      scannedCount: 250,
      normalizedCount: 250,
      finalCursor: { rowId: "batch_legacy:0250" },
      poison: { rowId: "batch_legacy:0251", attempts: 3, errorClass: "row-state" },
    });
    await expect(
      runtime().enqueueProductResolutionMaintenanceJob({ reactivateFailed: true, validatorVersion: 1 }),
    ).rejects.toThrow("higher-validatorVersion");
    await expect(runtime().enqueueProductResolutionMaintenanceJob({ validatorVersion: 2 })).rejects.toThrow(
      "higher-validatorVersion",
    );
    await runtime().pruneImportBatchJobRetention({ completedBefore: "2099-01-01T00:00:00Z" });
    expect((await job()).progress).toEqual(failed.progress);
    await pools.inventory.query(
      "UPDATE inventory_import_batch_rows SET selected_options = '[]'::jsonb, updated_at = now() WHERE row_id = 'batch_legacy:0251'",
    );
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        runtime().enqueueProductResolutionMaintenanceJob({ reactivateFailed: true, validatorVersion: 2 }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const reactivated = await job();
    expect(reactivated.jobId).toBe(failed.jobId);
    expect(reactivated.progress.maintenance).toMatchObject({
      validatorVersion: 2,
      scannedCount: 250,
      finalCursor: failed.progress.maintenance?.finalCursor,
    });
    await runtime().processNextImportProductResolutionMaintenanceJob(claim);
    expect((await job()).result?.maintenanceReceipt).toMatchObject({
      validatorVersion: 2,
      scannedCount: 251,
      normalizedCount: 251,
    });
    await runtime().pruneImportBatchJobRetention({ completedBefore: "2099-01-01T00:00:00Z" });
    expect(
      (await pools.inventory.query("SELECT job_id, unit_id, state FROM inventory_import_batch_work_units")).rows,
    ).toEqual([{ job_id: PRODUCT_RESOLUTION_JOB_ID, unit_id: PRODUCT_RESOLUTION_UNIT_ID, state: "completed" }]);
    const poison = await pools.inventory.query(
      "SELECT sequence FROM inventory_import_batch_job_events WHERE snapshot #>> '{progress,maintenance,poison,attempts}' = '3'",
    );
    expect(poison.rows.length).toBeGreaterThan(0);
    expect(
      (await pools.inventory.query("SELECT count(*)::integer AS count FROM inventory_import_batch_jobs")).rows,
    ).toEqual([{ count: 1 }]);
  });

  it("AC-05 changes only Product fields and exact Product errors, preserving source/non-Product error bytes and order", async () => {
    await seedRows(1);
    const snapshot = () =>
      pools.inventory.query<{ unchanged: string; errors: readonly string[] }>(
        `SELECT (to_jsonb(row) - ARRAY['product_id', 'resolution_status', 'validation_errors', 'updated_at'])::text AS unchanged,
        validation_errors AS errors FROM inventory_import_batch_rows AS row`,
      );
    const before = (await snapshot()).rows[0]!;
    await runtime().enqueueProductResolutionMaintenanceJob();
    await runtime().processNextImportProductResolutionMaintenanceJob(claim);
    const after = (await snapshot()).rows[0]!;
    expect(after.unchanged).toBe(before.unchanged);
    expect(after.errors).toEqual([
      "quantity stays first",
      "Catalog item must be active.",
      "Seller SKU 'keep' is not mapped for this account.",
      "External product reference is not mapped to a Chase Sets catalog item.",
      "listing stays last",
    ]);
    expect((await job()).result?.maintenanceReceipt?.complete).toBe(true);
  });

  it("AC-05 page failure rolls back Product writes and cursor atomically, then resumes", async () => {
    await seedRows(2);
    let fail = true;
    const db = interceptedPool(async (sql, values) => {
      if (
        fail &&
        sql.startsWith("UPDATE inventory_import_batch_rows SET product_id") &&
        values[3] === "batch_legacy:0002"
      ) {
        fail = false;
        throw new Error("synthetic page write failure");
      }
    });
    const services = runtime(db);
    await services.enqueueProductResolutionMaintenanceJob();
    await services.processNextImportProductResolutionMaintenanceJob(claim);
    expect((await job()).progress.maintenance).toMatchObject({
      scannedCount: 0,
      normalizedCount: 0,
      finalCursor: null,
    });
    expect((await pools.inventory.query("SELECT DISTINCT product_id FROM inventory_import_batch_rows")).rows).toEqual([
      { product_id: "cat_inactive::" },
    ]);
    await services.processNextImportProductResolutionMaintenanceJob(claim);
    expect((await job()).result?.maintenanceReceipt).toMatchObject({ scannedCount: 2, normalizedCount: 2 });
  });

  it.each(["accept", "commit", "still-rejected"])(
    "AC-05 guarded lost-update %s is honored and revalidated before convergence",
    async (change) => {
      await seedRows(1);
      let changed = false;
      const db = interceptedPool(async (sql) => {
        if (!changed && sql.startsWith("UPDATE inventory_import_batch_rows SET product_id")) {
          changed = true;
          await pools.inventory.query(
            `UPDATE inventory_import_batch_rows SET updated_at = clock_timestamp(), row_note = 'concurrent evidence',
          status = $1, committed_at = CASE WHEN $1 = 'committed' THEN now() ELSE NULL END WHERE row_id = 'batch_legacy:0001'`,
            [change === "accept" ? "accepted" : change === "commit" ? "committed" : "rejected"],
          );
        }
      });
      await runtime(db).enqueueProductResolutionMaintenanceJob();
      await runtime(db).processNextImportProductResolutionMaintenanceJob(claim);
      expect((await job()).result?.maintenanceReceipt).toMatchObject({
        skippedConcurrentCount: 1,
        normalizedCount: change === "still-rejected" ? 1 : 0,
        complete: true,
      });
      expect((await pools.inventory.query("SELECT row_note FROM inventory_import_batch_rows")).rows).toEqual([
        { row_note: "concurrent evidence" },
      ]);
    },
  );

  it("AC-05 final guarded convergence refuses a receipt when an earlier row changes after its checkpoint", async () => {
    await seedRows(1);
    let checkpoint: InventoryImportBatchJobProgress | undefined;
    let changed = false;
    const db = interceptedPool(
      async (sql) => {
        if (sql.includes("WITH terminal_unit") && !changed) {
          changed = true;
          await pools.inventory.query(
            "UPDATE inventory_import_batch_rows SET product_id = 'changed-again', resolution_status = 'native', updated_at = now() WHERE row_id = 'batch_legacy:0001'",
          );
        }
      },
      (sql, values) => {
        if (sql.includes("SET progress = $2::jsonb")) checkpoint = JSON.parse(String(values[1]));
      },
    );
    await runtime(db).enqueueProductResolutionMaintenanceJob();
    await runtime(db).processNextImportProductResolutionMaintenanceJob(claim);
    expect(checkpoint?.maintenance?.poison?.errorClass).toBe("convergence");
    expect((await job()).result).toBeNull();
    expect((await job()).status).not.toBe("completed");
    await runtime().processNextImportProductResolutionMaintenanceJob(claim);
    expect((await job()).result?.maintenanceReceipt?.complete).toBe(true);
  });

  it.each(["before-provider", "partial-provider", "receipt"])(
    "AC-06 rollback %s retains widened review and disables normalization/stock only",
    async (phase) => {
      await seedRows(
        phase === "partial-provider" ? 251 : 1,
        phase === "before-provider" ? "native-csv" : "tcgplayer-csv",
      );
      await runtime().enqueueProductResolutionMaintenanceJob();
      if (phase === "before-provider")
        await pools.inventory.query("UPDATE inventory_import_batch_rows SET product_id = NULL WHERE row_number = 1");
      if (phase === "partial-provider")
        await pools.inventory.query(
          "UPDATE inventory_import_batch_rows SET selected_options = '{}'::jsonb WHERE row_id = 'batch_legacy:0251'",
        );
      if (phase !== "before-provider") await runtime().processNextImportProductResolutionMaintenanceJob(claim);
      const before = await job();
      const rollback = runtime(pools.inventory, { normalizationEnabled: false, stockProgressionEnabled: false });
      expect(await rollback.processNextImportProductResolutionMaintenanceJob(claim)).toBe(0);
      expect((await job()).progress).toEqual(before.progress);
      const policy = productResolutionRollout(
        { normalizationEnabled: false, stockProgressionEnabled: false },
        before.progress.maintenance ?? null,
        before.result?.maintenanceReceipt ?? null,
      );
      expect(policy).toEqual({
        widenedReviewEligibility: true,
        normalizationEnabled: false,
        stockProgressionEnabled: false,
      });
      await expect(rollback.commitBatch({ batchId: "batch_legacy", accountId }, context)).rejects.toThrow(
        "stock progression is disabled",
      );
      const detail = (await rollback.getBatch("batch_legacy", accountId))!;
      expect(unresolvedResolutionRowIds(detail).length).toBeGreaterThan(0);
      const items = await createImportResolutionAttentionSourceFromReadModel(pools.inventory).load({
        accountId,
        now: new Date().toISOString(),
      });
      expect(items.length).toBeGreaterThan(0);
    },
  );

  it("AC-07 actual SQL IDs equal drawer IDs across sources; old-native-only and valid-Product rejection controls diverge", async () => {
    for (const { sourceKey } of inventoryImportSourceProfiles) {
      await seedRows(5, sourceKey, sourceKey);
      await pools.inventory.query(
        `UPDATE inventory_import_batch_rows SET product_id = CASE WHEN row_number >= 2 THEN 'valid-product' ELSE NULL END,
        resolution_status = CASE WHEN row_number = 1 THEN 'native' WHEN row_number = 2 THEN 'unresolved' ELSE 'resolved' END,
        status = CASE WHEN row_number = 4 THEN 'accepted' WHEN row_number = 5 THEN 'committed' ELSE 'rejected' END WHERE batch_id = $1`,
        [sourceKey],
      );
      const batch = (await runtime().getBatch(sourceKey, accountId))!;
      const ids = await pools.inventory.query<{ row_id: string }>(
        `SELECT row.row_id FROM inventory_import_batch_rows AS row
        JOIN inventory_import_batches AS batch ON batch.batch_id = row.batch_id
        WHERE batch.account_id = $1 AND batch.batch_id = $2 AND ${importResolutionRowPredicateSql} ORDER BY row.row_number`,
        [accountId, sourceKey],
      );
      expect(ids.rows.map((row) => row.row_id)).toEqual(unresolvedResolutionRowIds(batch));
      expect(ids.rows).toHaveLength(sourceKey === "saved-list" ? 3 : 2);
      expect(ids.rows.some((row) => row.row_id.endsWith(":0003"))).toBe(sourceKey === "saved-list");
    }
    const attention = await createImportResolutionAttentionSourceFromReadModel(pools.inventory).load({
      accountId,
      now: new Date().toISOString(),
    });
    expect(attention).toHaveLength(7);
    expect(
      attention.every((item) => item.summary.params.count === (item.id === "inventory-resolution:saved-list" ? 3 : 2)),
    ).toBe(true);
  });

  it("AC-09 durable and synchronous create plus manual resolve use the same Product validator in real storage", async () => {
    const services = runtime();
    const params = {
      accountId,
      sourceKey: "native-csv" as const,
      defaultStorageLocationId: "loc_import",
      parsedRows: [{ rowNumber: 1, values: { catalogItemId: "cat_inactive", totalQuantity: "2" } }],
    };
    const synchronous = await services.createBatch(params, context);
    const queued = await services.enqueueCreateBatchJob(params, context);
    await services.processNextImportBatchJob(claim);
    const durable = (await services.getImportBatchJob(queued.jobId))!.result!.batch!;
    for (const batch of [synchronous, durable]) {
      expect(batch.rows[0]).toMatchObject({ product_id: null, resolution_status: "unresolved", status: "rejected" });
      const resolved = await services.resolveRow(
        {
          accountId,
          batchId: batch.batch_id,
          rowId: batch.rows[0]!.row_id,
          catalogItemId: "cat_active",
          selectedOptions: [],
          storageLocationId: "loc_import",
        },
        context,
      );
      expect(resolved.rows[0]).toMatchObject({
        product_id: "cat_active::",
        resolution_status: "resolved",
        status: "accepted",
      });
    }
  });

  it("AC-04 scan index is ledgered and boot-idempotent", async () => {
    await pools.inventory.query("DROP INDEX inventory_import_batch_rows_product_resolution_scan_idx");
    await pools.inventory.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20261006_inventory_import_product_resolution_scan'",
    );
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    expect(
      (
        await pools.inventory.query(
          "SELECT count(*)::integer AS count FROM bounded_context_schema_migrations WHERE migration_id = '20261006_inventory_import_product_resolution_scan'",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await pools.inventory.query(
          "SELECT to_regclass('inventory_import_batch_rows_product_resolution_scan_idx') AS index",
        )
      ).rows[0]?.index,
    ).toBeTruthy();
  });
});
