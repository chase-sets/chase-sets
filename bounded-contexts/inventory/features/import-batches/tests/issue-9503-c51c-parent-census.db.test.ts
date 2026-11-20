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
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as inventoryModule } from "../../../index";
import { createInventoryServices } from "../../../support/runtime-support/services";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import { createInventoryImportBatchRuntime } from "../api/runtime";
import {
  censusImportCommitParent,
  type InventoryImportCommitCensusRow,
  type InventoryImportCommitParentCensus,
} from "../read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for C5.1c census DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_c51c_synthetic" as AccountId;
const context: EventStoreContext = {
  tenantId: "tnt_c51c_synthetic" as never,
  audit: { performedByUserId: "usr_c51c_synthetic" as never, forAccountId: accountId },
};
const claim = { claimOwnerId: "c51c-worker-synthetic", claimTtlMs: 30_000 };
const laterPageRowId = "imr_c51c_150";

// Same proxy shape as issue-9503-c51b-atomic-row.db.test.ts countQueries, extended to observe each
// result so the trace shows when the census runs relative to the pending-unit gate.
function countQueries<T extends object>(target: T, count: (sql: string, rows: readonly unknown[]) => void): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (key === "query") {
        return (...args: unknown[]) => {
          const result = method.apply(object, args);
          const sql = args[0];
          if (typeof sql !== "string") return result;
          return Promise.resolve(result).then((settled) => {
            count(sql, (settled as { rows: readonly unknown[] }).rows);
            return settled;
          });
        };
      }
      if (key === "connect") {
        return async (...args: unknown[]) => countQueries((await method.apply(object, args)) as object, count);
      }
      return method.bind(object);
    },
  });
}

describeDb("issue-9503-c51c parent outcome census", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "inventory_c51c_parent_census");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).inventory;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ inventory: pool });
    await bootstrapContextDatabase(inventoryModule, pool);
    // One catalog item per production row so every committed row owns exactly one item.
    await pool.query(
      `INSERT INTO inventory_catalog_items (catalog_item_id, status)
       VALUES ('cat_c51c_1', 'active'), ('cat_c51c_2', 'active'), ('cat_c51c_3', 'active')`,
    );
    await pool.query(
      `INSERT INTO inventory_storage_locations
         (storage_location_id, account_id, name, ship_from_code, ship_from_address)
       VALUES ('loc_c51c_synthetic', $1, 'Synthetic shelf', 'MAIN', $2::jsonb)`,
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
    if (pool) await closeMultiContextTestPools({ inventory: pool });
  });

  /**
   * Direct censusImportCommitParent fixture only. It writes rows, units and a job container but no
   * commit input (the census never reads one), and it is never handed to processNextImportBatchJob.
   */
  async function seed(
    input: Readonly<{
      rowCount?: number;
      state?: "queued" | "completed";
      withUnits?: boolean;
      sourceKey?: "native-csv" | "saved-list";
    }>,
  ) {
    const rowCount = input.rowCount ?? 1;
    const state = input.state ?? "completed";
    const batchId = "imb_c51c_synthetic";
    const inputId = "commit_input_c51c_synthetic";
    const jobId = "job_c51c_synthetic";
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      row_id: `imr_c51c_${index + 1}`,
      batch_id: batchId,
      row_number: index + 1,
      status: "accepted",
      raw_row: {},
      selected_options: [],
      validation_errors: [],
    }));
    await pool.query(
      `INSERT INTO inventory_import_batches
       (batch_id, account_id, status, source_key, total_count, accepted_count, created_at, updated_at)
       VALUES ($1, $2, 'uploaded', $4, $3, $3, now(), now())`,
      [batchId, accountId, rowCount, input.sourceKey ?? "native-csv"],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_rows
       (row_id, batch_id, row_number, status, raw_row, selected_options, validation_errors,
        commit_generation, committed_at, created_at, updated_at)
       SELECT row.row_id, row.batch_id, row.row_number, $2, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
              CASE WHEN $2 = 'committed' THEN 1 ELSE 0 END,
              CASE WHEN $2 = 'committed' THEN now() ELSE NULL END, now(), now()
       FROM jsonb_to_recordset($1::jsonb) AS row(row_id text, batch_id text, row_number integer)`,
      [JSON.stringify(rows), state === "completed" ? "committed" : "accepted"],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_jobs
       (job_id, job_kind, status, payload, progress, event_context, created_at, updated_at)
       VALUES ($1, 'commit', 'queued', $2::jsonb, $3::jsonb, $4::jsonb, now(), now())`,
      [
        jobId,
        JSON.stringify({ accountId, batchId, commit: { inputId } }),
        JSON.stringify({ phase: "processing", completed: 0, total: rowCount, currentRowId: null, message: null }),
        JSON.stringify(context),
      ],
    );
    if (input.withUnits !== false) {
      await pool.query(
        `INSERT INTO inventory_import_batch_work_units
         (job_id, unit_id, unit_kind, state, payload, result, attempt_count, created_at, updated_at, completed_at)
         SELECT $1, row.row_id, 'commit-row-v1', $2,
                jsonb_build_object('rowNumber', row.row_number),
                CASE WHEN $2 = 'completed' THEN jsonb_build_object('rowId', row.row_id, 'status', 'committed') ELSE NULL END,
                CASE WHEN $2 = 'completed' THEN 1 ELSE 0 END,
                now(), now(), CASE WHEN $2 = 'completed' THEN now() ELSE NULL END
         FROM jsonb_to_recordset($3::jsonb) AS row(row_id text, row_number integer)`,
        [jobId, state, JSON.stringify(rows)],
      );
    }
    // Built exactly as the worker builds census rows (api/runtime.ts processNextCommitBatchWorkUnit).
    const acceptedRows: InventoryImportCommitCensusRow[] = rows.map(({ row_id, batch_id, row_number, status }) => ({
      row_id,
      batch_id,
      row_number,
      status,
    }));
    return { jobId, inputId, batchId, acceptedRows };
  }

  async function drainInventory(inventory: ReturnType<typeof createInventoryServices>) {
    await drainContextRuntime(
      {
        subscriptionRunners: resolveModuleSubscriptions([
          {
            contextName: "inventory",
            module: { ...inventoryModule, buildSubscriptions: () => [], eventSubscriptions: [], eventReactions: [] },
            services: inventory,
            pool,
            projectionHandlerSets: inventoryModule.projectionHandlerSets?.(inventory) ?? [],
          },
        ]),
      },
      { settleIdleCheckpoints: true },
    );
  }

  // Production entrypoints only (issue-9503-c51b-atomic-row.db.test.ts setupAcceptedCommitJob pattern):
  // enqueueCreateBatchJob -> processNextImportBatchJob -> drain, with one distinct catalog item per row.
  async function createAcceptedBatch(rowCount: number, db: PgTransactionalPool = pool) {
    const inventory = createInventoryServices(db);
    const createJob = await inventory.importBatches.enqueueCreateBatchJob(
      {
        accountId,
        parsedRows: Array.from({ length: rowCount }, (_, index) => {
          const quantity = String(index === 0 ? 2 : 1);
          return {
            rowNumber: index + 1,
            values: {
              catalogItemId: `cat_c51c_${index + 1}`,
              storageLocationId: "loc_c51c_synthetic",
              totalQuantity: quantity,
              listingPriceAmount: "5.00",
              listingPriceCurrencyCode: "USD",
              listingQuantityCap: quantity,
            },
          };
        }),
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    for (let index = 0; index < rowCount; index += 1) {
      expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    }
    await drainInventory(inventory);
    return { inventory, batchId: createJob.payload.batchId! };
  }

  async function setupAcceptedCommitJob(rowCount = 1, db: PgTransactionalPool = pool) {
    const { inventory, batchId } = await createAcceptedBatch(rowCount, db);
    const commitJob = await inventory.importBatches.enqueueCommitBatchJob(
      { accountId, batchId },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    return { inventory, commitJob, batchId };
  }

  async function setupCommittedJob() {
    const setup = await setupAcceptedCommitJob(1);
    expect(await setup.inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    await drainInventory(setup.inventory);
    return setup;
  }

  // Retained unit-less duplicate job copied verbatim from a production-written commit input and job
  // (issue-9503-c51a-frozen-input.db.test.ts "replayed commit jobs overlay current committed progress").
  async function copyUnitlessCommitJob(
    source: Readonly<{ jobId: string; payload: Readonly<{ commit?: Readonly<{ inputId: string }> }> }>,
    tamperSnapshotHash = false,
  ) {
    const duplicateInputId = `commit_input_${randomUUID()}`;
    const duplicateJobId = `job_${randomUUID()}`;
    await pool.query(
      `INSERT INTO inventory_import_commit_inputs
      (input_id, tenant_id, actor_user_id, account_id, batch_id, snapshot_version, snapshot_hash, row_count, accepted_rows, created_at)
      SELECT $1, tenant_id, actor_user_id, account_id, batch_id, snapshot_version,
        CASE WHEN $3::boolean THEN repeat('0', 64) ELSE snapshot_hash END, row_count, accepted_rows, now()
      FROM inventory_import_commit_inputs WHERE input_id = $2`,
      [duplicateInputId, source.payload.commit!.inputId, tamperSnapshotHash],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_jobs
      (job_id, job_kind, status, payload, progress, event_context, created_at, updated_at)
      SELECT $1, job_kind, status, jsonb_set(payload, '{commit,inputId}', to_jsonb($2::text)), progress, event_context,
        created_at + interval '1 second', updated_at
      FROM inventory_import_batch_jobs WHERE job_id = $3`,
      [duplicateJobId, duplicateInputId, source.jobId],
    );
    return duplicateJobId;
  }

  async function jobSnapshot(jobId: string) {
    const job = (
      await pool.query<{
        status: string;
        error_message: string | null;
        progress: { phase: string; completed: number; total: number };
      }>("SELECT status, error_message, progress FROM inventory_import_batch_jobs WHERE job_id = $1", [jobId])
    ).rows[0];
    const units = await pool.query<{ unit_kind: string; state: string }>(
      "SELECT unit_kind, state FROM inventory_import_batch_work_units WHERE job_id = $1 ORDER BY state, unit_id",
      [jobId],
    );
    return {
      jobStatus: job?.status ?? null,
      jobErrorMessage: job?.error_message ?? null,
      progress: job
        ? { phase: job.progress.phase, completed: job.progress.completed, total: job.progress.total }
        : null,
      units: units.rows.map(({ unit_kind, state }) => ({ unit_kind, state })),
    };
  }

  async function effectCounts(batchId: string) {
    const result = await pool.query<{ items: number; outbox: number; adjustments: number; committed_count: number }>(
      `SELECT
         (SELECT count(*)::integer FROM inventory_items WHERE account_id = $1) AS items,
         (SELECT count(*)::integer FROM inventory_import_draft_listing_outbox WHERE import_batch_id = $2) AS outbox,
         (SELECT count(*)::integer FROM inventory_item_adjustment_idempotency) AS adjustments,
         (SELECT committed_count FROM inventory_import_batches WHERE batch_id = $2) AS committed_count`,
      [accountId, batchId],
    );
    return result.rows[0]!;
  }

  async function eventCount() {
    return (await pool.query<{ events: number }>("SELECT count(*)::integer AS events FROM event_store_events")).rows[0]!
      .events;
  }

  function units(state: string, count: number) {
    return Array.from({ length: count }, () => ({ unit_kind: "commit-row-v1", state }));
  }

  it("C1 proves every frozen accepted row has one terminal outcome", async () => {
    const seeded = await seed({ rowCount: 3 });
    await expect(censusImportCommitParent(pool, { ...seeded, accountId })).resolves.toEqual({
      total: 3,
      completed: 3,
      complete: true,
    });
  });

  it("C3 zero-row control is never complete", async () => {
    const zero = await seed({ rowCount: 0 });
    await expect(censusImportCommitParent(pool, { ...zero, accountId })).resolves.toEqual({
      total: 0,
      completed: 0,
      complete: false,
    });
  });

  it("C3 partial control is never complete", async () => {
    const partial = await seed({ rowCount: 2, state: "queued" });
    await expect(censusImportCommitParent(pool, { ...partial, accountId })).resolves.toMatchObject({
      total: 2,
      completed: 0,
      complete: false,
    });
  });

  it("container-only-complete mutant is rejected when an outcome is missing", async () => {
    const seeded = await seed({ rowCount: 1 });
    await pool.query("DELETE FROM inventory_import_batch_rows WHERE batch_id = $1", [seeded.batchId]);
    await expect(censusImportCommitParent(pool, { ...seeded, accountId })).rejects.toThrow(
      "Import commit outcomes require reconciliation",
    );
  });

  it("C2 positive census beyond page one completes 250 frozen rows", async () => {
    const seeded = await seed({ rowCount: 250 });
    await expect(censusImportCommitParent(pool, { ...seeded, accountId })).resolves.toEqual({
      total: 250,
      completed: 250,
      complete: true,
    });
  });

  // Saved List is the largest import source profile: saved-list-import.ts caps it at 10,000 lines. The census reads
  // only frozen rows, units and row outcomes, never the source profile, so this seed carries the Saved List
  // source key at that cap instead of replaying Saved List parsing.
  it("C2 10,000-row Saved List control completes only after every page", async () => {
    const seeded = await seed({ rowCount: 10_000, sourceKey: "saved-list" });
    await expect(censusImportCommitParent(pool, { ...seeded, accountId })).resolves.toEqual({
      total: 10_000,
      completed: 10_000,
      complete: true,
    });
  });

  it("first-page-only mutant is rejected by a decisive outcome beyond page one", async () => {
    const seeded = await seed({ rowCount: 10_000, sourceKey: "saved-list" });
    await pool.query(
      "UPDATE inventory_import_batch_rows SET status = 'accepted', commit_generation = 0, committed_at = NULL WHERE row_number = 10_000",
    );
    await expect(censusImportCommitParent(pool, { ...seeded, accountId })).rejects.toThrow(
      "Import commit outcomes require reconciliation",
    );
  });

  it("missing-outcome-ignored mutant is rejected for a missing later-page outcome", async () => {
    const seeded = await seed({ rowCount: 250 });
    await pool.query("DELETE FROM inventory_import_batch_rows WHERE batch_id = $1 AND row_number = 150", [
      seeded.batchId,
    ]);
    await expect(censusImportCommitParent(pool, { ...seeded, accountId })).rejects.toThrow(
      "Import commit outcomes require reconciliation",
    );
  });

  it("later-page claimed units remain fail-closed", async () => {
    const seeded = await seed({ rowCount: 250 });
    await pool.query(
      `UPDATE inventory_import_batch_work_units
       SET claim_owner_id = 'claimed-synthetic', claim_token = 'token-synthetic'
       WHERE job_id = $1 AND unit_id = 'imr_c51c_150'`,
      [seeded.jobId],
    );
    await expect(censusImportCommitParent(pool, { ...seeded, accountId })).rejects.toThrow(
      "Import commit outcomes require reconciliation",
    );
  });

  const laterPageCases: ReadonlyArray<
    Readonly<{
      name: string;
      sql: readonly string[];
      tamperRows?: (rows: InventoryImportCommitCensusRow[]) => InventoryImportCommitCensusRow[];
      expected: "reconciliation" | InventoryImportCommitParentCensus;
    }>
  > = [
    {
      name: "queued unit with an accepted outcome is nonterminal",
      sql: [
        `UPDATE inventory_import_batch_work_units SET state = 'queued', result = NULL, completed_at = NULL
         WHERE unit_id = '${laterPageRowId}'`,
        `UPDATE inventory_import_batch_rows SET status = 'accepted', commit_generation = 0, committed_at = NULL
         WHERE row_id = '${laterPageRowId}'`,
      ],
      expected: { total: 250, completed: 249, complete: false },
    },
    {
      name: "running unit requires reconciliation",
      sql: [`UPDATE inventory_import_batch_work_units SET state = 'running' WHERE unit_id = '${laterPageRowId}'`],
      expected: "reconciliation",
    },
    {
      name: "wrong unit_kind requires reconciliation",
      sql: [
        `UPDATE inventory_import_batch_work_units SET unit_kind = 'create-row-v1' WHERE unit_id = '${laterPageRowId}'`,
      ],
      expected: "reconciliation",
    },
    {
      name: "result status other than committed requires reconciliation",
      sql: [
        `UPDATE inventory_import_batch_work_units
         SET result = jsonb_build_object('rowId', unit_id, 'status', 'rejected') WHERE unit_id = '${laterPageRowId}'`,
      ],
      expected: "reconciliation",
    },
    {
      name: "non-integer unit rowNumber requires reconciliation",
      sql: [
        `UPDATE inventory_import_batch_work_units
         SET payload = jsonb_build_object('rowNumber', 150.5) WHERE unit_id = '${laterPageRowId}'`,
      ],
      expected: "reconciliation",
    },
    {
      // The unit payload matches the malformed frozen row, so only the frozen row_number integer guard rejects.
      name: "non-integer frozen row_number requires reconciliation",
      sql: [
        `UPDATE inventory_import_batch_work_units
         SET payload = jsonb_build_object('rowNumber', 150.5) WHERE unit_id = '${laterPageRowId}'`,
      ],
      tamperRows: (rows) => rows.map((row) => (row.row_id === laterPageRowId ? { ...row, row_number: 150.5 } : row)),
      expected: "reconciliation",
    },
    {
      name: "deleted unit (truncated unit set) requires reconciliation",
      sql: [`DELETE FROM inventory_import_batch_work_units WHERE unit_id = '${laterPageRowId}'`],
      expected: "reconciliation",
    },
    {
      name: "extra unit outside the frozen set requires reconciliation",
      sql: [
        `INSERT INTO inventory_import_batch_work_units
         (job_id, unit_id, unit_kind, state, payload, result, attempt_count, created_at, updated_at, completed_at)
         VALUES ('job_c51c_synthetic', 'imr_c51c_extra', 'commit-row-v1', 'completed',
                 jsonb_build_object('rowNumber', 251),
                 jsonb_build_object('rowId', 'imr_c51c_extra', 'status', 'committed'), 1, now(), now(), now())`,
      ],
      expected: "reconciliation",
    },
    {
      name: "commit_generation 0 requires reconciliation",
      sql: [`UPDATE inventory_import_batch_rows SET commit_generation = 0 WHERE row_id = '${laterPageRowId}'`],
      expected: "reconciliation",
    },
    {
      name: "outcome owned by another batch requires reconciliation",
      sql: [
        `INSERT INTO inventory_import_batches
         (batch_id, account_id, status, total_count, accepted_count, created_at, updated_at)
         VALUES ('imb_c51c_other', '${accountId}', 'uploaded', 1, 1, now(), now())`,
        `UPDATE inventory_import_batch_rows SET batch_id = 'imb_c51c_other' WHERE row_id = '${laterPageRowId}'`,
      ],
      expected: "reconciliation",
    },
  ];

  it.each(laterPageCases)("C2 later page (ordinal 150 of 250): $name", async ({ sql, tamperRows, expected }) => {
    const seeded = await seed({ rowCount: 250 });
    for (const statement of sql) await pool.query(statement);
    const acceptedRows = tamperRows ? tamperRows(seeded.acceptedRows) : seeded.acceptedRows;
    const census = censusImportCommitParent(pool, { ...seeded, acceptedRows, accountId });
    if (expected === "reconciliation") {
      await expect(census).rejects.toThrow("Import commit outcomes require reconciliation");
    } else {
      await expect(census).resolves.toEqual(expected);
    }
  });

  it("queued committed outcomes remain nonterminal for a partial retry", async () => {
    const seeded = await seed({ rowCount: 2, state: "queued" });
    await pool.query(
      `UPDATE inventory_import_batch_rows
       SET status = 'committed', commit_generation = 1, committed_at = now()
       WHERE row_id = 'imr_c51c_1'`,
    );
    await expect(censusImportCommitParent(pool, { ...seeded, accountId })).resolves.toMatchObject({
      total: 2,
      completed: 0,
      complete: false,
    });
  });

  it("C1/F1 completes a production-derived unit-less duplicate commit job only through row units", async () => {
    const { inventory, commitJob, batchId } = await setupAcceptedCommitJob(1);
    const duplicateJobId = await copyUnitlessCommitJob(commitJob);
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    await drainInventory(inventory);
    const before = await effectCounts(batchId);
    const processed = await inventory.importBatches.processNextImportBatchJob(claim);
    await drainInventory(inventory);
    expect({ processed, before, ...(await jobSnapshot(duplicateJobId)), effects: await effectCounts(batchId) }).toEqual(
      {
        processed: 1,
        before: { items: 1, outbox: 1, adjustments: 0, committed_count: 1 },
        jobStatus: "completed",
        jobErrorMessage: null,
        progress: { phase: "completed", completed: 1, total: 1 },
        units: units("completed", 1),
        effects: before,
      },
    );
  });

  it("C1/F1 tamper: a unit-less duplicate with an altered snapshot_hash fails before any unit is enqueued", async () => {
    const { inventory, commitJob, batchId } = await setupAcceptedCommitJob(1);
    const duplicateJobId = await copyUnitlessCommitJob(commitJob, true);
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    await drainInventory(inventory);
    const before = await effectCounts(batchId);
    const processed = await inventory.importBatches.processNextImportBatchJob(claim);
    await drainInventory(inventory);
    expect({ processed, ...(await jobSnapshot(duplicateJobId)), effects: await effectCounts(batchId) }).toEqual({
      processed: 1,
      jobStatus: "failed",
      jobErrorMessage: "import_job_failed_reconciliation_required",
      progress: { phase: "failed", completed: 0, total: 1 },
      units: [],
      effects: before,
    });
  });

  async function stopAfterFirstUnit() {
    const setup = await setupAcceptedCommitJob(3);
    const controller = new AbortController();
    const rowItems = {
      ...setup.inventory.items,
      createItem: async (
        params: Parameters<typeof setup.inventory.items.createItem>[0],
        itemContext: typeof context,
      ) => {
        const result = await setup.inventory.items.createItem(params, itemContext);
        controller.abort();
        return result;
      },
    };
    const worker = createInventoryImportBatchRuntime({
      db: setup.inventory.mutations.db,
      items: setup.inventory.items,
      rowItems,
      catalogItems: setup.inventory.catalogItems,
      executeMutation: setup.inventory.mutations.execute,
    });
    const processed = await worker.processNextImportBatchJob({ ...claim, signal: controller.signal });
    await drainInventory(setup.inventory);
    return { ...setup, processed };
  }

  it("C3 nonsteady: a job stopped after its first unit reports processing progress, never completion", async () => {
    const { commitJob, batchId, processed } = await stopAfterFirstUnit();
    const { items, outbox, committed_count } = await effectCounts(batchId);
    expect({ processed, ...(await jobSnapshot(commitJob.jobId)), items, outbox, committed_count }).toEqual({
      processed: 1,
      jobStatus: "queued",
      jobErrorMessage: null,
      progress: { phase: "processing", completed: 1, total: 3 },
      units: [...units("completed", 1), ...units("queued", 2)],
      items: 1,
      outbox: 1,
      committed_count: 1,
    });
  });

  it("C4 abort: a fresh worker resumes the stopped job and commits each row exactly once", async () => {
    const { inventory, commitJob, batchId } = await stopAfterFirstUnit();
    const processed = await inventory.importBatches.processNextImportBatchJob(claim);
    await drainInventory(inventory);
    const { items, outbox, committed_count } = await effectCounts(batchId);
    expect({ processed, ...(await jobSnapshot(commitJob.jobId)), items, outbox, committed_count }).toEqual({
      processed: 2,
      jobStatus: "completed",
      jobErrorMessage: null,
      progress: { phase: "completed", completed: 3, total: 3 },
      units: units("completed", 3),
      items: 3,
      outbox: 3,
      committed_count: 3,
    });
  });

  it("C4 worker death: an expired unit claim is reclaimed and the census completes the parent once", async () => {
    const { inventory, commitJob, batchId } = await setupAcceptedCommitJob(1);
    let itemAppended!: () => void;
    const appended = new Promise<void>((resolve) => {
      itemAppended = resolve;
    });
    let releaseStale!: () => void;
    const resumeStale = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const rowItems = {
      ...inventory.items,
      createItem: async (params: Parameters<typeof inventory.items.createItem>[0], itemContext: typeof context) => {
        const result = await inventory.items.createItem(params, itemContext);
        itemAppended();
        await resumeStale;
        return result;
      },
    };
    const staleWorker = createInventoryImportBatchRuntime({
      db: inventory.mutations.db,
      items: inventory.items,
      rowItems,
      catalogItems: inventory.catalogItems,
      executeMutation: inventory.mutations.execute,
    });
    const stale = staleWorker.processNextImportBatchJob({ claimOwnerId: "c51c-worker-stale", claimTtlMs: 10 });
    await appended;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replacement = inventory.importBatches.processNextImportBatchJob(claim);
    releaseStale();
    const staleProcessed = await stale;
    const replacementProcessed = await replacement;
    await drainInventory(inventory);
    const { items, outbox, committed_count } = await effectCounts(batchId);
    expect({
      staleProcessed,
      replacementProcessed,
      ...(await jobSnapshot(commitJob.jobId)),
      items,
      outbox,
      committed_count,
    }).toEqual({
      staleProcessed: 1,
      replacementProcessed: 1,
      jobStatus: "completed",
      jobErrorMessage: null,
      progress: { phase: "completed", completed: 1, total: 1 },
      units: units("completed", 1),
      items: 1,
      outbox: 1,
      committed_count: 1,
    });
  });

  it("C4 replay: a completed job reset to queued completes again without rerunning terminal rows", async () => {
    const { inventory, commitJob, batchId } = await setupCommittedJob();
    const before = { events: await eventCount(), ...(await effectCounts(batchId)) };
    await pool.query("UPDATE inventory_import_batch_jobs SET status = 'queued' WHERE job_id = $1", [commitJob.jobId]);
    await pool.query("UPDATE inventory_import_batch_work_units SET state = 'queued', result = NULL WHERE job_id = $1", [
      commitJob.jobId,
    ]);
    const processed = await inventory.importBatches.processNextImportBatchJob(claim);
    expect({
      processed,
      ...(await jobSnapshot(commitJob.jobId)),
      effects: { events: await eventCount(), ...(await effectCounts(batchId)) },
    }).toEqual({
      processed: 1,
      jobStatus: "completed",
      jobErrorMessage: null,
      progress: { phase: "completed", completed: 1, total: 1 },
      units: units("completed", 1),
      effects: before,
    });
    expect(before).toMatchObject({ items: 1, outbox: 1, committed_count: 1 });
  });

  it("C4 day-after: a terminal job aged one day is never reclaimed or rewritten", async () => {
    const { inventory, commitJob, batchId } = await setupCommittedJob();
    await pool.query(
      `UPDATE inventory_import_batch_jobs
       SET completed_at = completed_at - interval '1 day', updated_at = updated_at - interval '1 day'
       WHERE job_id = $1`,
      [commitJob.jobId],
    );
    const read = async () => ({
      job: (
        await pool.query(
          "SELECT status, progress, result, error_message, completed_at FROM inventory_import_batch_jobs WHERE job_id = $1",
          [commitJob.jobId],
        )
      ).rows,
      ...(await jobSnapshot(commitJob.jobId)),
      events: await eventCount(),
      ...(await effectCounts(batchId)),
    });
    const before = await read();
    const processed = await inventory.importBatches.processNextImportBatchJob(claim);
    expect({ processed, state: await read() }).toEqual({ processed: 0, state: before });
    expect(before).toMatchObject({ jobStatus: "completed", items: 1, outbox: 1, committed_count: 1 });
  });

  it("F3 partial retry: a pre-committed row sorting after the accepted row completes without false reconciliation", async () => {
    const { inventory, batchId } = await createAcceptedBatch(2);
    const rows = (
      await pool.query<{ row_id: string; catalog_item_id: string }>(
        "SELECT row_id, catalog_item_id FROM inventory_import_batch_rows WHERE batch_id = $1 ORDER BY row_id",
        [batchId],
      )
    ).rows;
    const [acceptedRow, committedRow] = [rows[0]!, rows[1]!];
    // c51a "accepts a batch with a committed row" shape, with the committed row's unit id sorting last.
    await pool.query("UPDATE inventory_import_batches SET committed_count = 1 WHERE batch_id = $1", [batchId]);
    await pool.query(
      `UPDATE inventory_import_batch_rows
       SET status = 'committed', committed_inventory_item_id = 'inv_c51c_precommitted', committed_at = now()
       WHERE row_id = $1`,
      [committedRow.row_id],
    );
    const commitJob = await inventory.importBatches.enqueueCommitBatchJob(
      { accountId, batchId },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    const committedRowEffects = async () =>
      (
        await pool.query<{ items: number; adjustments: number }>(
          `SELECT
             (SELECT count(*)::integer FROM inventory_items
              WHERE account_id = $1 AND catalog_catalog_item_id = $2) AS items,
             (SELECT count(*)::integer FROM inventory_item_adjustment_idempotency
              WHERE idempotency_key = 'inventory-import-row:' || $3 || ':adjustment') AS adjustments`,
          [accountId, committedRow.catalog_item_id, committedRow.row_id],
        )
      ).rows[0]!;
    const committedBefore = await committedRowEffects();
    const processed = await inventory.importBatches.processNextImportBatchJob(claim);
    await drainInventory(inventory);
    const statuses = await pool.query<{ row_id: string; status: string }>(
      "SELECT row_id, status FROM inventory_import_batch_rows WHERE batch_id = $1 ORDER BY row_id",
      [batchId],
    );
    const acceptedItems = await pool.query<{ items: number }>(
      `SELECT count(*)::integer AS items FROM inventory_items WHERE account_id = $1 AND catalog_catalog_item_id = $2`,
      [accountId, acceptedRow.catalog_item_id],
    );
    const { outbox, committed_count } = await effectCounts(batchId);
    expect({
      processed,
      ...(await jobSnapshot(commitJob.jobId)),
      rows: statuses.rows.map(({ row_id, status }) => ({ row_id, status })),
      acceptedRowItems: acceptedItems.rows[0]!.items,
      committedBefore,
      committedAfter: await committedRowEffects(),
      outbox,
      committed_count,
    }).toEqual({
      processed: 2,
      jobStatus: "completed",
      jobErrorMessage: null,
      progress: { phase: "completed", completed: 2, total: 2 },
      units: units("completed", 2),
      rows: [
        { row_id: acceptedRow.row_id, status: "committed" },
        { row_id: committedRow.row_id, status: "committed" },
      ],
      acceptedRowItems: 1,
      committedBefore: { items: 0, adjustments: 0 },
      committedAfter: { items: 0, adjustments: 0 },
      outbox: 1,
      committed_count: 2,
    });
  });

  it("F4 runs exactly one bounded census after the final unit is terminal", async () => {
    const trace: string[] = [];
    const countedPool = countQueries(pool, (sql, rows) => {
      if (sql.includes("WITH ORDINALITY AS frozen")) trace.push(`census-page:${rows.length}`);
      if (sql.includes("count(*)::integer AS pending")) {
        trace.push(`pending:${Number((rows[0] as { pending?: number | string } | undefined)?.pending)}`);
      }
    });
    const { inventory, commitJob } = await setupAcceptedCommitJob(3, countedPool);
    trace.length = 0;
    const processed = await inventory.importBatches.processNextImportBatchJob(claim);
    expect({ processed, jobStatus: (await jobSnapshot(commitJob.jobId)).jobStatus, trace }).toEqual({
      processed: 3,
      jobStatus: "completed",
      trace: ["pending:2", "pending:1", "pending:0", "census-page:3", "census-page:0"],
    });
  });
});
