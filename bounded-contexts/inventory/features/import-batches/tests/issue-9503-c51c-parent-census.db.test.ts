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
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as inventoryModule } from "../../../index";
import { createInventoryServices } from "../../../support/runtime-support/services";
import { createInventoryImportBatchRuntime } from "../api/runtime";
import { censusImportCommitParent } from "../read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for C5.1c census DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_c51c_synthetic" as AccountId;
const context: EventStoreContext = {
  tenantId: "tnt_c51c_synthetic" as never,
  audit: { performedByUserId: "usr_c51c_synthetic" as never, forAccountId: accountId },
};

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
  });

  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ inventory: pool });
  });

  async function seed(input: Readonly<{ rowCount?: number; state?: "queued" | "completed"; withUnits?: boolean }>) {
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
       (batch_id, account_id, status, total_count, accepted_count, created_at, updated_at)
       VALUES ($1, $2, 'uploaded', $3, $3, now(), now())`,
      [batchId, accountId, rowCount],
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
      `INSERT INTO inventory_import_commit_inputs
       (input_id, tenant_id, actor_user_id, account_id, batch_id, snapshot_version, snapshot_hash, row_count, accepted_rows, created_at)
       VALUES ($1, 'tnt_c51c_synthetic', 'usr_c51c_synthetic', $2, $3, 1, repeat('a', 64), $4, $5::jsonb, now())`,
      [inputId, accountId, batchId, rowCount, JSON.stringify(rows)],
    );
    await pool.query(
      `INSERT INTO inventory_import_batch_jobs
       (job_id, job_kind, status, payload, progress, event_context, created_at, updated_at)
       VALUES ($1, 'commit', 'running', $2::jsonb, $3::jsonb, $4::jsonb, now(), now())`,
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
    return {
      jobId,
      inputId,
      batchId,
      acceptedRows: rows.map(({ row_id, batch_id, row_number, status }) => ({ row_id, batch_id, row_number, status })),
    };
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

  it("first-page-only mutant is rejected by a decisive outcome beyond page one", async () => {
    const seeded = await seed({ rowCount: 10_000 });
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

  it("materializes every frozen row before completing a unit-less commit job", async () => {
    const seeded = await seed({ rowCount: 1, state: "completed", withUnits: false });
    const services = createInventoryServices(pool);
    const worker = createInventoryImportBatchRuntime({
      db: pool,
      catalogItems: services.catalogItems,
      items: services.items,
    });
    await expect(worker.processNextImportBatchJob({ claimOwnerId: "c51c-unitless", claimTtlMs: 30_000 })).resolves.toBe(
      1,
    );
    const units = await pool.query<{ state: string }>(
      `SELECT state
       FROM inventory_import_batch_work_units
       WHERE job_id = $1 AND unit_kind = 'commit-row-v1'`,
      [seeded.jobId],
    );
    expect(units.rows).toEqual([{ state: "completed" }]);
    expect((await worker.getImportBatchJob(seeded.jobId))?.status).toBe("completed");
  });
});
