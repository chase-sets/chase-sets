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
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { module as inventoryModule } from "../../../index";
import { createInventoryServices } from "../../../support/runtime-support/services";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import { createInventoryImportBatchRuntime } from "../api/runtime";
import { INVENTORY_IMPORT_CREATE_JOB_KINDS } from "../domain/job-kinds";
import { ImportRowResolveConflict, type ImportRowResolveConflictCode } from "../domain/row-resolve-conflict";
import type { InventoryImportBatchDetail } from "../read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for the issue-7169-ac7 resolve authority DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_ac7_synthetic" as AccountId;
const context: EventStoreContext = {
  tenantId: "tnt_ac7_synthetic",
  audit: { performedByUserId: "usr_ac7_synthetic", forAccountId: accountId },
};
const claim = { claimOwnerId: "ac7-resolve-synthetic", claimTtlMs: 30_000 };
const fix = { accountId, catalogItemId: "cat_ac7_active", selectedOptions: [], storageLocationId: "loc_ac7_main" };

type Services = ReturnType<typeof createInventoryServices>;

/** Wraps a pool so the first statement matching `matches` runs `before` first (or throws), on pool and clients alike. */
function intercepted<T extends object>(target: T, matches: (sql: string) => boolean, before: () => Promise<void>): T {
  let fired = false;
  const wrap = <U extends object>(object: U): U =>
    new Proxy(object, {
      get(source, key) {
        const value: unknown = Reflect.get(source, key, source);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (key === "query") {
          return async (...args: unknown[]) => {
            if (!fired && typeof args[0] === "string" && matches(args[0])) {
              fired = true;
              await before();
            }
            return method.apply(source, args);
          };
        }
        if (key === "connect") return async (...args: unknown[]) => wrap((await method.apply(source, args)) as object);
        return method.bind(source);
      },
    });
  return wrap(target);
}

const isResolveWrite = (sql: string) =>
  sql.includes("UPDATE inventory_import_batch_rows") && sql.includes("resolution_status = 'resolved'");

describeDb("issue-7169-ac7 resolve authority fences import rows with current facts", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "inventory_ac7_resolve");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await pools.inventory.query(`INSERT INTO inventory_catalog_items (catalog_item_id, status)
      VALUES ('cat_ac7_active', 'active'), ('cat_ac7_draft', 'draft')`);
    await pools.inventory.query(
      `INSERT INTO inventory_storage_locations (storage_location_id, account_id, name, ship_from_code)
       VALUES ('loc_ac7_main', $1, 'Main shelf', 'MAIN'), ('loc_ac7_second', $1, 'Second shelf', 'MAIN')`,
      [accountId],
    );
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function createBatch(rowCount = 1, inventory: Services = createInventoryServices(pools.inventory)) {
    const queued = await inventory.importBatches.enqueueCreateBatchJob(
      {
        accountId,
        sourceKey: "native-csv",
        defaultStorageLocationId: "loc_ac7_main",
        parsedRows: Array.from({ length: rowCount }, (_, index) => ({
          rowNumber: index + 1,
          values: { catalogItemId: "cat_ac7_draft", totalQuantity: "2" },
        })),
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    const batchId = queued.payload.batchId!;
    const settled = async () => {
      const current = await inventory.importBatches.getBatch(batchId, accountId);
      return current?.status === "ready-to-commit" && current.total_count === rowCount ? current : null;
    };
    for (let pass = 0; pass < 400 && !(await settled()); pass += 1) {
      await inventory.importBatches.processNextImportBatchJob(claim);
    }
    const detail = (await inventory.importBatches.getBatch(batchId, accountId))!;
    expect(detail).toMatchObject({ total_count: rowCount, status: "ready-to-commit" });
    expect(detail.rows.every((row) => row.status === "rejected" && row.needs_seller)).toBe(true);
    return { inventory, batchId, detail };
  }

  function facts(detail: InventoryImportBatchDetail, rowId: string) {
    const row = detail.rows.find((candidate) => candidate.row_id === rowId)!;
    expect(row.row_version).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    return {
      batchId: detail.batch_id,
      rowId,
      expectedRowVersion: row.row_version,
      expectedRowFingerprint: row.row_fingerprint,
    };
  }

  /** Everything a refused resolve must leave untouched: row facts and audit, batch counts, receipts, SKU mappings. */
  async function state(batchId: string) {
    const rows = await pools.inventory.query(
      `SELECT row_id, status, raw_row, row_fingerprint, resolution_status, catalog_item_id, product_id,
              storage_location_id, validation_errors, committed_at,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version
       FROM inventory_import_batch_rows WHERE batch_id = $1 ORDER BY row_number`,
      [batchId],
    );
    const batch = await pools.inventory.query(
      `SELECT status, total_count, accepted_count, rejected_count, committed_count,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version
       FROM inventory_import_batches WHERE batch_id = $1`,
      [batchId],
    );
    const receipts = await pools.inventory.query(
      `SELECT attempt_key, family, target_id, status, result FROM inventory_mutation_attempts
       WHERE family = 'import-resolve-row' ORDER BY attempt_key`,
    );
    const mappings = await pools.inventory.query(
      "SELECT count(*)::integer AS count FROM inventory_import_account_sku_mappings",
    );
    return { rows: rows.rows, batch: batch.rows, receipts: receipts.rows, mappings: mappings.rows };
  }

  async function refusedWith(work: Promise<unknown>, code: ImportRowResolveConflictCode) {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ImportRowResolveConflict);
    expect((error as ImportRowResolveConflict).code).toBe(code);
  }

  it("accepts only the current row version fingerprint and stable attempt", async () => {
    const { inventory, batchId, detail } = await createBatch();
    const rowId = detail.rows[0]!.row_id;
    const t1 = facts(detail, rowId);
    const attempt = withInventoryMutationAttempt(context, randomUUID());
    // The opaque row_version sits beside the unchanged public updated_at, which still serializes as ISO.
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const wire = JSON.parse(JSON.stringify(detail)) as { updated_at: string; rows: Array<{ updated_at: string }> };
    expect(wire.updated_at).toMatch(iso);
    expect(wire.rows[0]!.updated_at).toMatch(iso);

    const resolved = await inventory.importBatches.resolveRow({ ...fix, ...t1 }, attempt);
    expect(resolved.rows[0]).toMatchObject({
      status: "accepted",
      resolution_status: "resolved",
      product_id: "cat_ac7_active::",
    });
    expect(resolved.rows[0]!.row_version).not.toBe(t1.expectedRowVersion);
    const afterWrite = await state(batchId);
    expect(afterWrite.receipts).toEqual([
      expect.objectContaining({
        family: "import-resolve-row",
        target_id: rowId,
        status: "succeeded",
        result: { batchId, rowId },
      }),
    ]);

    // Same attempt and facts: replay, no second write.
    await inventory.importBatches.resolveRow({ ...fix, ...t1 }, attempt);
    expect(await state(batchId)).toEqual(afterWrite);

    // stale-resolve-wins: a new attempt still carrying T1 is refused with zero writes.
    await refusedWith(
      inventory.importBatches.resolveRow(
        { ...fix, ...t1, storageLocationId: "loc_ac7_second" },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
      "stale_row_facts",
    );
    expect(await state(batchId)).toEqual(afterWrite);

    // The first attempt reused with a different fix is a changed intent, refused with zero writes.
    await refusedWith(
      inventory.importBatches.resolveRow({ ...fix, ...t1, storageLocationId: "loc_ac7_second" }, attempt),
      "attempt_conflict",
    );
    expect(await state(batchId)).toEqual(afterWrite);

    // The caller's refreshed facts are current again and win with a new attempt.
    const t2 = facts(resolved, rowId);
    const moved = await inventory.importBatches.resolveRow(
      { ...fix, ...t2, storageLocationId: "loc_ac7_second" },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    expect(moved.rows[0]).toMatchObject({ storage_location_id: "loc_ac7_second" });
    expect((await state(batchId)).receipts).toHaveLength(2);
  });

  it("terminal-row-reruns: a committed row is inert even with its current facts", async () => {
    const { inventory, batchId, detail } = await createBatch();
    const rowId = detail.rows[0]!.row_id;
    await pools.inventory.query(
      "UPDATE inventory_import_batch_rows SET status = 'committed', committed_at = now() WHERE row_id = $1",
      [rowId],
    );
    const current = (await inventory.importBatches.getBatch(batchId, accountId))!;
    const before = await state(batchId);
    await refusedWith(
      inventory.importBatches.resolveRow(
        { ...fix, ...facts(current, rowId) },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
      "terminal_row",
    );
    await refusedWith(
      inventory.importBatches.resolveRow({ ...fix, ...facts(current, rowId) }, context),
      "terminal_row",
    );
    expect(await state(batchId)).toEqual(before);
  });

  it.each([
    ["poison: failed create job", "failed-safe"],
    ["in-flight commit job queued for (re)claim", "committing"],
    ["missing outcome: completed create job with a short count", "ambiguous"],
    ["expired batch", "expired"],
  ] as const)("refuses %s with batch_not_resolvable and no write", async (_case, status) => {
    const { inventory, batchId, detail } = await createBatch();
    const payload = JSON.stringify({ batchId, accountId });
    if (status === "failed-safe" || status === "committing") {
      await pools.inventory.query(
        `INSERT INTO inventory_import_batch_jobs (job_id, job_kind, status, payload, progress, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, '{"total":1}', now(), now())`,
        [
          `job_ac7_${status}`,
          status === "committing" ? "commit" : INVENTORY_IMPORT_CREATE_JOB_KINDS[0],
          status === "committing" ? "queued" : "failed",
          payload,
        ],
      );
    } else if (status === "ambiguous") {
      await pools.inventory.query(
        `UPDATE inventory_import_batch_jobs SET progress = jsonb_set(COALESCE(progress, '{}'::jsonb), '{total}', '99'::jsonb)
         WHERE payload->>'batchId' = $1`,
        [batchId],
      );
    } else {
      await pools.inventory.query("UPDATE inventory_import_batches SET status = 'expired' WHERE batch_id = $1", [
        batchId,
      ]);
    }
    const current = (await inventory.importBatches.getBatch(batchId, accountId))!;
    expect(current.status).toBe(status);
    const before = await state(batchId);
    await refusedWith(
      inventory.importBatches.resolveRow(
        { ...fix, ...facts(current, detail.rows[0]!.row_id) },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
      "batch_not_resolvable",
    );
    expect(await state(batchId)).toEqual(before);
  });

  it("refuses cross-batch, other-account and zero-row targets as row_not_found with no write", async () => {
    const first = await createBatch();
    const second = await createBatch(1, first.inventory);
    const otherRowId = second.detail.rows[0]!.row_id;
    await pools.inventory.query(
      `INSERT INTO inventory_import_batches (batch_id, account_id, status, source_key, created_at, updated_at)
       VALUES ('imb_ac7_empty', $1, 'uploaded', 'native-csv', now(), now())`,
      [accountId],
    );
    const before = [await state(first.batchId), await state(second.batchId), await state("imb_ac7_empty")];
    const secondFacts = facts(second.detail, otherRowId);

    await refusedWith(
      first.inventory.importBatches.resolveRow(
        { ...fix, ...secondFacts, batchId: first.batchId },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
      "row_not_found",
    );
    const otherAccount = "acc_ac7_other" as AccountId;
    await refusedWith(
      first.inventory.importBatches.resolveRow(
        { ...fix, ...secondFacts, accountId: otherAccount },
        withInventoryMutationAttempt(
          { ...context, audit: { ...context.audit, forAccountId: otherAccount } },
          randomUUID(),
        ),
      ),
      "row_not_found",
    );
    await refusedWith(
      first.inventory.importBatches.resolveRow(
        { ...fix, ...secondFacts, batchId: "imb_ac7_empty", rowId: "imb_ac7_empty:0001" },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
      "row_not_found",
    );
    expect([await state(first.batchId), await state(second.batchId), await state("imb_ac7_empty")]).toEqual(before);
  });

  it("fails legacy empty fingerprints and malformed generated facts closed without a write", async () => {
    const { inventory, batchId, detail } = await createBatch();
    const rowId = detail.rows[0]!.row_id;
    const current = facts(detail, rowId);
    const negatives: ReadonlyArray<readonly [unknown, unknown, ImportRowResolveConflictCode]> = [
      [current.expectedRowVersion.slice(0, 10), current.expectedRowFingerprint, "invalid_row_facts"],
      [current.expectedRowVersion.replace("Z", "+00:00"), current.expectedRowFingerprint, "invalid_row_facts"],
      [
        current.expectedRowVersion.replace("T", " ").replace("Z", "+00"),
        current.expectedRowFingerprint,
        "invalid_row_facts",
      ],
      [Date.parse(current.expectedRowVersion), current.expectedRowFingerprint, "invalid_row_facts"],
      [current.expectedRowVersion, "", "missing_row_facts"],
      [current.expectedRowVersion, `${current.expectedRowFingerprint}\u0000`, "invalid_row_facts"],
    ];
    const before = await state(batchId);
    for (const [expectedRowVersion, expectedRowFingerprint, code] of negatives) {
      await refusedWith(
        inventory.importBatches.resolveRow(
          {
            ...fix,
            ...current,
            expectedRowVersion: expectedRowVersion as never,
            expectedRowFingerprint: expectedRowFingerprint as never,
          },
          withInventoryMutationAttempt(context, randomUUID()),
        ),
        code,
      );
    }
    expect(await state(batchId)).toEqual(before);

    // Legacy rows kept the migration default '' and fail closed whatever fingerprint the caller sends.
    await pools.inventory.query("UPDATE inventory_import_batch_rows SET row_fingerprint = '' WHERE row_id = $1", [
      rowId,
    ]);
    const legacy = await state(batchId);
    for (const expectedRowFingerprint of ["legacy", current.expectedRowFingerprint]) {
      await refusedWith(
        inventory.importBatches.resolveRow(
          { ...fix, ...current, expectedRowFingerprint },
          withInventoryMutationAttempt(context, randomUUID()),
        ),
        "missing_row_facts",
      );
    }
    expect(await state(batchId)).toEqual(legacy);
  });

  it("resolves the remaining rows of partial and committed batches but never their committed row", async () => {
    const { inventory, batchId, detail } = await createBatch(3);
    const [committed, accepted, rejected] = detail.rows.map((row) => row.row_id);
    await pools.inventory.query(
      `UPDATE inventory_import_batch_rows SET status = CASE row_id WHEN $1 THEN 'committed' ELSE 'accepted' END,
         committed_at = CASE row_id WHEN $1 THEN now() ELSE NULL END
       WHERE row_id IN ($1, $2)`,
      [committed, accepted],
    );
    await pools.inventory.query(
      `UPDATE inventory_import_batches SET total_count = 3, accepted_count = 2, rejected_count = 1, committed_count = 1
       WHERE batch_id = $1`,
      [batchId],
    );
    const partial = (await inventory.importBatches.getBatch(batchId, accountId))!;
    expect(partial.status).toBe("partial");
    const before = await state(batchId);
    await refusedWith(
      inventory.importBatches.resolveRow(
        { ...fix, ...facts(partial, committed!) },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
      "terminal_row",
    );
    expect(await state(batchId)).toEqual(before);
    const fixed = await inventory.importBatches.resolveRow(
      { ...fix, ...facts(partial, rejected!) },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    expect(fixed.rows.find((row) => row.row_id === rejected)).toMatchObject({ status: "accepted" });
    expect(fixed.rows.find((row) => row.row_id === committed)).toMatchObject({ status: "committed" });

    // Every accepted row committed with a rejected row left over derives 'committed'; the leftover still resolves.
    const { batchId: doneId, detail: done } = await createBatch(2, inventory);
    await pools.inventory.query(
      "UPDATE inventory_import_batch_rows SET status = 'committed', committed_at = now() WHERE row_id = $1",
      [done.rows[0]!.row_id],
    );
    await pools.inventory.query(
      `UPDATE inventory_import_batches SET total_count = 2, accepted_count = 1, rejected_count = 1, committed_count = 1
       WHERE batch_id = $1`,
      [doneId],
    );
    const committedBatch = (await inventory.importBatches.getBatch(doneId, accountId))!;
    expect(committedBatch.status).toBe("committed");
    const leftover = await inventory.importBatches.resolveRow(
      { ...fix, ...facts(committedBatch, done.rows[1]!.row_id) },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    expect(leftover.rows[1]).toMatchObject({ status: "accepted" });
    expect(leftover.rows[0]).toMatchObject({ status: "committed" });
  });

  it("decides a row beyond the first page with facts read from its own page", async () => {
    const { inventory, batchId } = await createBatch(101);
    const firstPage = (await inventory.importBatches.getBatch(batchId, accountId, { limit: 100, offset: 0 }))!;
    expect(firstPage.rows).toHaveLength(100);
    const secondPage = (await inventory.importBatches.getBatch(batchId, accountId, { limit: 100, offset: 100 }))!;
    expect(secondPage.rows.map((row) => row.row_number)).toEqual([101]);
    const lastRowId = secondPage.rows[0]!.row_id;
    expect(firstPage.rows.some((row) => row.row_id === lastRowId)).toBe(false);
    const resolved = await inventory.importBatches.resolveRow(
      { ...fix, ...facts(secondPage, lastRowId) },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    expect(resolved.rows.find((row) => row.row_id === lastRowId)).toMatchObject({ status: "accepted" });
    expect(resolved.accepted_count).toBe(1);
  });

  it("lets exactly one of two concurrent attempts carrying the same facts win", async () => {
    const { batchId, detail } = await createBatch();
    const rowId = detail.rows[0]!.row_id;
    const t1 = facts(detail, rowId);
    const results = await Promise.allSettled([
      createInventoryServices(pools.inventory).importBatches.resolveRow(
        { ...fix, ...t1, storageLocationId: "loc_ac7_main" },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
      createInventoryServices(pools.inventory).importBatches.resolveRow(
        { ...fix, ...t1, storageLocationId: "loc_ac7_second" },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
    ]);
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(ImportRowResolveConflict);
    expect(((losers[0] as PromiseRejectedResult).reason as ImportRowResolveConflict).code).toBe("stale_row_facts");
    const winningLocation = results[0]!.status === "fulfilled" ? "loc_ac7_main" : "loc_ac7_second";
    const after = await state(batchId);
    expect(after.rows).toEqual([expect.objectContaining({ status: "accepted", storage_location_id: winningLocation })]);
    expect(after.receipts).toEqual([expect.objectContaining({ status: "succeeded" })]);
  });

  it("generation predicates stop a stale writer that read before another writer committed", async () => {
    const { batchId, detail } = await createBatch();
    const rowId = detail.rows[0]!.row_id;
    const t1 = facts(detail, rowId);
    const services = createInventoryServices(pools.inventory);
    const racingDb = intercepted(pools.inventory as PgQueryable, isResolveWrite, async () => {
      await createInventoryServices(pools.inventory).importBatches.resolveRow(
        { ...fix, ...t1, storageLocationId: "loc_ac7_second" },
        withInventoryMutationAttempt(context, randomUUID()),
      );
    });
    const stale = createInventoryImportBatchRuntime({
      db: racingDb,
      catalogItems: services.catalogItems,
      items: services.items,
    });
    await refusedWith(stale.resolveRow({ ...fix, ...t1 }, context), "stale_row_facts");
    expect((await state(batchId)).rows).toEqual([
      expect.objectContaining({ status: "accepted", storage_location_id: "loc_ac7_second" }),
    ]);
  });

  it("the status predicate alone keeps a row committed between the read and the write", async () => {
    const { batchId, detail } = await createBatch();
    const rowId = detail.rows[0]!.row_id;
    const services = createInventoryServices(pools.inventory);
    // Synthetic terminal writer that leaves updated_at and row_fingerprint alone, isolating `status <> 'committed'`.
    const racingDb = intercepted(pools.inventory as PgQueryable, isResolveWrite, async () => {
      await pools.inventory.query(
        "UPDATE inventory_import_batch_rows SET status = 'committed', committed_at = now() WHERE row_id = $1",
        [rowId],
      );
    });
    const racing = createInventoryImportBatchRuntime({
      db: racingDb,
      catalogItems: services.catalogItems,
      items: services.items,
    });
    await refusedWith(racing.resolveRow({ ...fix, ...facts(detail, rowId) }, context), "stale_row_facts");
    expect((await state(batchId)).rows).toEqual([
      expect.objectContaining({
        status: "committed",
        catalog_item_id: "cat_ac7_draft",
        resolution_status: detail.rows[0]!.resolution_status,
      }),
    ]);
  });

  it("an attempt that crashes after its row write leaves no trace and the same attempt then succeeds", async () => {
    const { batchId, detail } = await createBatch();
    const rowId = detail.rows[0]!.row_id;
    const attempt = withInventoryMutationAttempt(context, randomUUID());
    const crashing = createInventoryServices(
      intercepted(
        pools.inventory,
        (sql) => sql.includes("UPDATE inventory_import_batches AS batch"),
        async () => {
          throw new Error("synthetic crash after the resolve row write");
        },
      ),
    );
    const before = await state(batchId);
    await expect(crashing.importBatches.resolveRow({ ...fix, ...facts(detail, rowId) }, attempt)).rejects.toThrow(
      "synthetic crash after the resolve row write",
    );
    expect(await state(batchId)).toEqual(before);

    const retried = await createInventoryServices(pools.inventory).importBatches.resolveRow(
      { ...fix, ...facts(detail, rowId) },
      attempt,
    );
    expect(retried.rows[0]).toMatchObject({ status: "accepted" });
    expect((await state(batchId)).receipts).toEqual([
      expect.objectContaining({ status: "succeeded", target_id: rowId }),
    ]);
  });
});
