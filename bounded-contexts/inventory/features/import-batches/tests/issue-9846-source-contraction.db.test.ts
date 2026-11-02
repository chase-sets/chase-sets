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
import {
  INVENTORY_IMPORT_LEGACY_VALUE_MARKER,
  loadInventoryImportSnapshotPage,
  prepareInventoryImportSnapshot,
} from "../api/safe-snapshot";
import {
  INVENTORY_IMPORT_SOURCE_CONTRACTION,
  contractionLedgerRows,
  enterSourceFloor,
  rawSourceColumns,
  recordingPool,
} from "./source-floor-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for the import source contraction DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_9846_synthetic" as AccountId;
const authority: EventStoreContext = {
  tenantId: "tnt_9846_synthetic",
  audit: { performedByUserId: "usr_9846_synthetic", forAccountId: accountId },
};
const params = {
  accountId,
  csvText: "catalogItemId,storageLocationId,totalQuantity\ncat_9846_synthetic,loc_9846_synthetic,2",
};
const claim = { claimOwnerId: "9846-worker-synthetic", claimTtlMs: 30_000 };
const unsafeRawRow = {
  catalogItemId: "cat_9846_synthetic",
  totalQuantity: "1",
  rowNote: "see https://synthetic.invalid/listing",
  sellerSku: "token=synthetic-secret-9846",
};
const unsafeResult = {
  batch: {
    batch_id: "imb_9846_post_floor",
    source_filename: "https://synthetic.invalid/private-upload.csv",
    rows: [{ row_id: "imr_9846_post_floor", raw_row: unsafeRawRow }],
  },
};
// A floor-era TCGplayer row is already in the safe snapshot shape; its rowNote is derived by the adapter.
const safeTcgplayerRawRow = prepareInventoryImportSnapshot({
  accountId,
  sourceKey: "tcgplayer-csv",
  csvText:
    "TCGplayer Id,Product Line,Set Name,Product Name,Title,Number,Rarity,Condition,TCG Market Price,TCG Direct Low,TCG Low Price With Shipping,TCG Low Price,Total Quantity,Add to Quantity,TCG Marketplace Price,Photo URL\n" +
    "9846,Pokemon,Base,Pikachu,,58,Common,Near Mint,1.00,,,,3,0,1.50,",
}).rows[0].rawRow;
// The floor release's ledger: every migration except the contraction.
const floorModule = {
  ...inventoryModule,
  schemaMigrations: inventoryModule.schemaMigrations?.filter(
    ({ migrationId }) => migrationId !== INVENTORY_IMPORT_SOURCE_CONTRACTION,
  ),
};

describeDb("issue-9846-source-contraction", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "inventory_9846_contraction");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.inventory;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    // An upgraded database that has never run the contraction.
    await bootstrapContextDatabase(floorModule, pool);
    await pool.query(
      "INSERT INTO inventory_catalog_items (catalog_item_id, status) VALUES ('cat_9846_synthetic', 'active')",
    );
    await pool.query(
      `INSERT INTO inventory_storage_locations (storage_location_id, account_id, name, ship_from_code)
      VALUES ('loc_9846_synthetic', $1, 'Synthetic shelf', 'MAIN')`,
      [accountId],
    );
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function seedPostFloorHistory() {
    await pool.query(
      `INSERT INTO inventory_import_batches
       (batch_id, account_id, status, total_count, accepted_count, source_filename, created_at, updated_at)
       VALUES ('imb_9846_post_floor', $1, 'uploaded', 1, 1, 'https://synthetic.invalid/private-upload.csv', now(), now())`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_rows (row_id, batch_id, row_number, status, raw_row, created_at, updated_at)
       VALUES ('imr_9846_post_floor', 'imb_9846_post_floor', 2, 'accepted', $1::jsonb, now(), now())`,
      [JSON.stringify(unsafeRawRow)],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_jobs (job_id, job_kind, status, payload, progress, result, created_at, updated_at)
       VALUES ('job_9846_post_floor', 'create', 'completed', $1::jsonb, '{"phase":"completed","total":1}'::jsonb, $2::jsonb, now(), now())`,
      [JSON.stringify({ accountId, batchId: "imb_9846_post_floor", create: {} }), JSON.stringify(unsafeResult)],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_job_events (job_id, sequence, event_name, snapshot, created_at)
       VALUES ('job_9846_post_floor', 1, 'completed', $1::jsonb, now())`,
      [JSON.stringify({ jobId: "job_9846_post_floor", status: "completed", result: unsafeResult })],
    );
  }

  async function urlBearingColumns() {
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name LIKE 'inventory\\_import\\_%'
         AND data_type IN ('text', 'jsonb')
       ORDER BY table_name, column_name`,
    );
    const leaked: string[] = [];
    for (const { table_name, column_name } of columns.rows) {
      const hit = await pool.query(
        `SELECT 1 FROM "${table_name}" WHERE "${column_name}"::text LIKE '%https://%' LIMIT 1`,
      );
      if (hit.rows.length) leaked.push(`${table_name}.${column_name}`);
    }
    return leaked.sort();
  }

  async function importColumns() {
    const result = await pool.query(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
              character_maximum_length, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name LIKE 'inventory\\_import\\_%'
       ORDER BY table_name, column_name`,
    );
    return result.rows;
  }

  async function retainedXmins() {
    const result = await pool.query<{ record: string; xmin: string }>(
      `SELECT 'row:' || row_id AS record, xmin::text AS xmin FROM inventory_import_batch_rows
       UNION ALL SELECT 'job:' || job_id, xmin::text FROM inventory_import_batch_jobs
       UNION ALL SELECT 'event:' || job_id || ':' || sequence, xmin::text FROM inventory_import_batch_job_events
       UNION ALL SELECT 'input:' || input_id, xmin::text FROM inventory_import_batch_job_inputs
       ORDER BY record`,
    );
    return result.rows;
  }

  async function rewindToLegacyCreate(jobId: string, inputId: string, csvText: string) {
    await pool.query("DELETE FROM inventory_import_snapshot_rows WHERE input_id = $1", [inputId]);
    await pool.query(
      `UPDATE inventory_import_batch_job_inputs SET snapshot_version = NULL, snapshot_hash = NULL, row_count = NULL,
         adapter_version = NULL, csv_text = $2, source_filename = 'legacy-synthetic.csv' WHERE input_id = $1`,
      [inputId, csvText],
    );
    await pool.query(
      `UPDATE inventory_import_batch_jobs SET job_kind = 'create',
         payload = jsonb_set(payload, '{create}', (payload->'create') - 'snapshotVersion' - 'snapshotHash' - 'rowCount')
       WHERE job_id = $1`,
      [jobId],
    );
    await pool.query("UPDATE inventory_import_batch_work_units SET unit_kind = 'create' WHERE job_id = $1", [jobId]);
  }

  it("re-sanitizes retained history before the drop", async () => {
    await enterSourceFloor(pool);
    await seedPostFloorHistory();
    expect(await urlBearingColumns()).toEqual([
      "inventory_import_batch_job_events.snapshot",
      "inventory_import_batch_jobs.result",
      "inventory_import_batch_rows.raw_row",
      "inventory_import_batches.source_filename",
    ]);

    const statements: string[] = [];
    await bootstrapContextDatabase(inventoryModule, recordingPool(pool, statements));

    const rawRow = await pool.query<{ raw_row: Record<string, unknown> }>(
      "SELECT raw_row FROM inventory_import_batch_rows WHERE row_id = 'imr_9846_post_floor'",
    );
    expect(rawRow.rows[0].raw_row).toMatchObject({
      catalogItemId: "cat_9846_synthetic",
      totalQuantity: "1",
      rowNote: INVENTORY_IMPORT_LEGACY_VALUE_MARKER,
      sellerSku: INVENTORY_IMPORT_LEGACY_VALUE_MARKER,
      legacyMigrationWarnings: expect.arrayContaining([
        {
          recordType: "batch-row",
          recordId: "imr_9846_post_floor",
          field: "raw_row.rowNote",
          reason: "unsafe-retained-text",
        },
        {
          recordType: "batch-row",
          recordId: "imr_9846_post_floor",
          field: "raw_row.sellerSku",
          reason: "unsafe-retained-text",
        },
      ]),
    });
    const job = await pool.query<{ result: Record<string, unknown> }>(
      "SELECT result FROM inventory_import_batch_jobs WHERE job_id = 'job_9846_post_floor'",
    );
    expect(job.rows[0].result).toMatchObject({
      batch: { source_filename: null },
      legacyMigrationWarnings: expect.arrayContaining([
        expect.objectContaining({ recordType: "job-result", field: "result.batch.rows[0].raw_row.rowNote" }),
        expect.objectContaining({ recordType: "job-result", field: "result.batch.rows[0].raw_row.sellerSku" }),
      ]),
    });
    const event = await pool.query<{ snapshot: Record<string, unknown> }>(
      "SELECT snapshot FROM inventory_import_batch_job_events WHERE job_id = 'job_9846_post_floor' AND sequence = 1",
    );
    expect(event.rows[0].snapshot).toMatchObject({
      legacyMigrationWarnings: expect.arrayContaining([
        expect.objectContaining({ recordType: "job-event", recordId: "job_9846_post_floor:1" }),
      ]),
    });
    for (const retained of [rawRow.rows[0].raw_row, job.rows[0].result, event.rows[0].snapshot]) {
      expect(JSON.stringify(retained)).not.toMatch(/https:\/\/|synthetic-secret/);
    }

    const firstDrop = statements.findIndex((sql) =>
      /\bDROP\s+COLUMN\s+IF\s+EXISTS\s+(?:csv_text|parsed_rows|source_filename)\b/i.test(sql),
    );
    const sanitizers = [
      /UPDATE inventory_import_batch_rows SET raw_row/,
      /UPDATE inventory_import_batch_jobs SET result/,
      /UPDATE inventory_import_batch_job_events SET snapshot/,
    ].map((pattern) => statements.reduce((last, sql, index) => (pattern.test(sql) ? index : last), -1));
    expect(firstDrop).toBeGreaterThan(-1);
    for (const index of sanitizers) {
      expect(index).toBeGreaterThan(-1);
      expect(index).toBeLessThan(firstDrop);
    }
    expect(await rawSourceColumns(pool)).toEqual([]);
    expect(await contractionLedgerRows(pool)).toHaveLength(1);
    expect(await urlBearingColumns()).toEqual([]);
  });

  it("leaves already-safe retained history untouched", async () => {
    await enterSourceFloor(pool);
    await pool.query(
      `INSERT INTO inventory_import_batches (batch_id, account_id, status, source_key, total_count, created_at, updated_at)
       VALUES ('imb_9846_safe', $1, 'uploaded', 'tcgplayer-csv', 1, now(), now())`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_rows (row_id, batch_id, row_number, status, raw_row, created_at, updated_at)
       VALUES ('imr_9846_safe', 'imb_9846_safe', 2, 'accepted', $1::jsonb, now(), now())`,
      [JSON.stringify(safeTcgplayerRawRow)],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_jobs (job_id, job_kind, status, payload, progress, result, created_at, updated_at)
       VALUES ('job_9846_safe', 'create-snapshot-v1', 'completed', '{}'::jsonb, '{}'::jsonb, $1::jsonb, now(), now()),
              ('job_9846_queued', 'create-snapshot-v1', 'queued', '{}'::jsonb, '{}'::jsonb, NULL, now(), now())`,
      [JSON.stringify({ source_key: "tcgplayer-csv", raw_row: safeTcgplayerRawRow })],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_job_events (job_id, sequence, event_name, snapshot, created_at)
       VALUES ('job_9846_safe', 1, 'completed', $1::jsonb, now())`,
      [JSON.stringify({ jobId: "job_9846_safe", status: "completed" })],
    );
    // A floor-era acceptance: its input is already a snapshot and its job is already fenced.
    await createInventoryServices(pool).importBatches.enqueueCreateBatchJob(
      params,
      withInventoryMutationAttempt(authority, randomUUID()),
    );
    const before = await retainedXmins();
    expect(before.filter(({ record }) => record.startsWith("input:"))).toHaveLength(1);

    await bootstrapContextDatabase(inventoryModule, pool);

    expect(await contractionLedgerRows(pool)).toHaveLength(1);
    expect(await retainedXmins()).toEqual(before);
    expect(
      (await pool.query("SELECT raw_row FROM inventory_import_batch_rows WHERE row_id = 'imr_9846_safe'")).rows,
    ).toEqual([{ raw_row: safeTcgplayerRawRow }]);
    expect(
      (
        await pool.query(
          "SELECT result IS NULL AS unset FROM inventory_import_batch_jobs WHERE job_id = 'job_9846_queued'",
        )
      ).rows,
    ).toEqual([{ unset: true }]);
  });

  it("converts post-floor legacy sources", async () => {
    await enterSourceFloor(pool);
    const inventory = createInventoryServices(pool);
    const valid = await inventory.importBatches.enqueueCreateBatchJob(
      params,
      withInventoryMutationAttempt(authority, randomUUID()),
    );
    const validInputId = valid.payload.create!.inputId;
    await rewindToLegacyCreate(valid.jobId, validInputId, params.csvText);
    await pool.query(
      `INSERT INTO inventory_import_batch_job_inputs (input_id, account_id, csv_text, source_filename, created_at)
       VALUES ('input_9846_poison', $1, $2, 'legacy-poison.csv', now())`,
      [accountId, "catalogItemId,totalQuantity\n" + "x".repeat(1_025)],
    );
    await pool.query(
      `INSERT INTO inventory_import_batches (batch_id, account_id, status, total_count, created_at, updated_at)
       VALUES ('imb_9846_poison', $1, 'uploaded', 1, now(), now())`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_jobs (job_id, job_kind, status, payload, progress, created_at, updated_at)
       VALUES ('job_9846_poison', 'create', 'queued', $1::jsonb, '{"phase":"queued","total":1}'::jsonb, now(), now())`,
      [JSON.stringify({ accountId, batchId: "imb_9846_poison", create: { inputId: "input_9846_poison" } })],
    );
    expect(
      (
        await pool.query(
          "SELECT job_kind, count(*)::integer AS jobs FROM inventory_import_batch_jobs WHERE status = 'queued' GROUP BY job_kind",
        )
      ).rows,
    ).toEqual([{ job_kind: "create", jobs: 2 }]);

    await bootstrapContextDatabase(inventoryModule, pool);

    const original = prepareInventoryImportSnapshot(params);
    expect(
      (
        await pool.query(
          "SELECT job_kind, payload->'create' AS create FROM inventory_import_batch_jobs WHERE job_id = $1",
          [valid.jobId],
        )
      ).rows,
    ).toEqual([
      {
        job_kind: "create-snapshot-v1",
        create: {
          inputId: validInputId,
          batchId: valid.payload.batchId,
          snapshotVersion: 1,
          snapshotHash: original.header.hash,
          rowCount: 1,
        },
      },
    ]);
    expect(
      (
        await pool.query("SELECT DISTINCT unit_kind FROM inventory_import_batch_work_units WHERE job_id = $1", [
          valid.jobId,
        ])
      ).rows,
    ).toEqual([{ unit_kind: "create-snapshot-v1" }]);
    expect((await loadInventoryImportSnapshotPage(pool, validInputId, accountId)).rows).toEqual(original.rows);
    expect(
      (
        await pool.query(
          "SELECT status, error_message FROM inventory_import_batch_jobs WHERE job_id = 'job_9846_poison'",
        )
      ).rows,
    ).toEqual([{ status: "failed", error_message: "import_job_failed_reconciliation_required" }]);
    expect((await inventory.importBatches.getBatch("imb_9846_poison", accountId))?.status).toBe("failed-safe");
    expect(await contractionLedgerRows(pool)).toHaveLength(1);
    expect(await rawSourceColumns(pool)).toEqual([]);

    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    expect((await inventory.importBatches.getImportBatchJob(valid.jobId))?.status).toBe("completed");
  });

  it("contracts once per database", async () => {
    await enterSourceFloor(pool);
    await seedPostFloorHistory();
    await bootstrapContextDatabase(inventoryModule, pool);
    const contracted = await retainedXmins();
    expect(contracted).toHaveLength(3);

    const statements: string[] = [];
    await bootstrapContextDatabase(inventoryModule, recordingPool(pool, statements));
    await bootstrapContextDatabase(inventoryModule, recordingPool(pool, statements));

    expect(statements.length).toBeGreaterThan(0);
    expect(await retainedXmins()).toEqual(contracted);
    expect(
      statements.filter((sql) => /\bLOCK\s+TABLE\s+inventory_import_|inventory-import-source-cutover/i.test(sql)),
    ).toEqual([]);
    expect(await rawSourceColumns(pool)).toEqual([]);
    expect(await contractionLedgerRows(pool)).toHaveLength(1);
  });

  it("fresh and upgraded schemas converge", async () => {
    await enterSourceFloor(pool);
    await seedPostFloorHistory();
    await bootstrapContextDatabase(inventoryModule, pool);
    const upgraded = await importColumns();

    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pool);
    const fresh = await importColumns();

    expect(upgraded).toEqual(fresh);
    expect(await rawSourceColumns(pool)).toEqual([]);
    expect(await contractionLedgerRows(pool)).toHaveLength(1);
  });

  it("lazy failure after drop fails closed", async () => {
    await enterSourceFloor(pool);
    await bootstrapContextDatabase(inventoryModule, pool);
    expect(await rawSourceColumns(pool)).toEqual([]);
    // A base rollback below the floor is unsupported once the columns are gone.
    await expect(
      pool.query(
        `INSERT INTO inventory_import_batch_job_inputs (input_id, account_id, csv_text, created_at)
         VALUES ('input_9846_base', $1, 'catalogItemId\ncat', now())`,
        [accountId],
      ),
    ).rejects.toMatchObject({ code: "42703" });
    // A legacy input that never reached a snapshot and has no recoverable rows.
    await pool.query(
      `INSERT INTO inventory_import_batch_job_inputs (input_id, account_id, created_at) VALUES ('input_9846_lazy', $1, now())`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO inventory_import_batches (batch_id, account_id, status, total_count, created_at, updated_at)
       VALUES ('imb_9846_lazy', $1, 'uploaded', 1, now(), now())`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_jobs
       (job_id, job_kind, status, payload, progress, event_context, created_at, updated_at)
       VALUES ('job_9846_lazy', 'create', 'queued', $1::jsonb, '{"phase":"queued","total":1}'::jsonb, $2::jsonb, now(), now())`,
      [
        JSON.stringify({ accountId, batchId: "imb_9846_lazy", create: { inputId: "input_9846_lazy" } }),
        JSON.stringify(authority),
      ],
    );

    const statements: string[] = [];
    const worker = createInventoryServices(recordingPool(pool, statements));
    expect(await worker.importBatches.processNextImportBatchJob(claim)).toBe(1);
    expect(await worker.importBatches.processNextImportBatchJob(claim)).toBe(0);

    expect(statements.some((sql) => sql.includes("SELECT to_jsonb(input) AS legacy"))).toBe(true);
    expect(
      (await pool.query("SELECT status, error_message FROM inventory_import_batch_jobs WHERE job_id = 'job_9846_lazy'"))
        .rows,
    ).toEqual([{ status: "failed", error_message: "import_job_failed_reconciliation_required" }]);
    expect(statements.filter((sql) => /\b(?:csv_text|parsed_rows|source_filename)\b/.test(sql))).toEqual([]);
    expect(
      statements.filter((sql) =>
        /\bLOCK\s+TABLE\b|inventory-import-source-cutover|information_schema|_source_contracted|UPDATE inventory_import_batch_rows SET raw_row|UPDATE inventory_import_batch_jobs SET result|UPDATE inventory_import_batch_job_events SET snapshot/i.test(
          sql,
        ),
      ),
    ).toEqual([]);
  });
});
