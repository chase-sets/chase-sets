import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresDurableJobWorkUnitStore } from "@chase-sets/platform-runtime/durable-job-work-units";
import { module as catalogModule } from "../../../index";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import {
  createCatalogAuthoringBulkJobServices,
  toCatalogAuthoringBulkJob,
} from "../../../support/authoring-support/bulk-authoring-jobs";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const context = {
  tenantId: "tnt_remove_db" as never,
  audit: { performedByUserId: "usr_original" as never, forAccountId: "acc_remove_db" as never },
};
const kind = "catalog.authoring.items.remove-drafts" as const;

describeDb("Catalog bulk draft removal jobs (db)", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  let eventStore: ReturnType<typeof createPostgresEventStore>;
  let jobs: ReturnType<typeof createCatalogAuthoringBulkJobServices>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "catalog_bulk_remove_drafts_jobs");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    services = createCatalogServices(pool);
    eventStore = createPostgresEventStore({ pool });
    jobs = createCatalogAuthoringBulkJobServices(pool);
  });
  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  async function create(id: string, language = "en", title = id) {
    await services.items.commandHandler({
      streamId: `catalog.item-${id}`,
      context,
      command: {
        type: "CreateCatalogItem",
        itemId: id as never,
        languageCode: language,
        title: localizedTextMapFromEnglish(title),
        subtitle: null,
        description: localizedTextMapFromEnglish(""),
      },
    });
  }
  async function project() {
    await drainLocalProjectionHandlerSets("catalog", pool, services.items.projectors);
  }
  async function publish(id: string) {
    const history = await readCompleteStream(eventStore, { streamId: `catalog.item-${id}` });
    await eventStore.appendToStream({
      streamId: `catalog.item-${id}`,
      expectedVersion: history.length,
      context,
      events: [{ eventType: "catalog.catalog-item.published", payload: { blueprintId: "bpr_synthetic" } }],
    });
  }
  const enqueue = (itemIds: string[]) => jobs.enqueue({ kind, action: "remove-drafts", itemIds, context });
  const process = (claimOwnerId: string) => jobs.processNext({ claimOwnerId, services, workflowMaxActiveClaims: 1 });
  async function removalEvents(id: string) {
    return (await readCompleteStream(eventStore, { streamId: `catalog.item-${id}` })).filter(
      (event) => event.eventType === "catalog.catalog-item.draft-removed",
    );
  }
  function unitStore() {
    return createPostgresDurableJobWorkUnitStore(
      pool,
      {
        jobsTable: "catalog_authoring_bulk_jobs",
        eventsTable: "catalog_authoring_bulk_job_events",
        workUnitsTable: "catalog_authoring_bulk_work_units",
      },
      { workflowName: "catalog.authoring-bulk", eventSnapshot: toCatalogAuthoringBulkJob },
    );
  }

  it("D1: real filter preview spans page one, excludes a nonmatch and blocks active items", async () => {
    for (let index = 0; index < 51; index += 1)
      await create(`cat_d${index}`, "en", `Draft ${String(index).padStart(2, "0")}`);
    await create("cat_active", "en", "Active row");
    await publish("cat_active");
    await create("cat_excluded", "ja", "Excluded row");
    await project();
    const preview = await services.items.previewBulkRemoveDrafts({
      mode: "filter",
      query: { language: "en", limit: 50, offset: 100 },
    });
    expect(preview).toMatchObject({ total: 52, ready_count: 51, blocked_count: 1 });
    expect(preview.item_ids).not.toContain("cat_excluded");
    expect(preview.item_ids.indexOf("cat_d50")).toBeGreaterThanOrEqual(50);
    expect(preview.candidates).toContainEqual(
      expect.objectContaining({ catalog_item_id: "cat_d50", outcome: "ready" }),
    );
    expect(preview.candidates).toContainEqual(
      expect.objectContaining({
        catalog_item_id: "cat_active",
        outcome: "blocked",
        reason: "Only draft items can be removed.",
      }),
    );
  });

  it("D2: persists partial progress, expired-owner handoff, aggregate refusal and original attribution", async () => {
    for (const id of ["cat_1", "cat_2", "cat_3", "cat_4"]) await create(id);
    await publish("cat_4");
    await project();
    const preview = await services.items.previewBulkRemoveDrafts({
      mode: "ids",
      ids: ["cat_1", "cat_2", "cat_3", "cat_4"],
    });
    expect(preview).toMatchObject({ ready_count: 3, blocked_count: 1 });
    await publish("cat_2");
    const stale = await pool.query<{ status: string }>(
      "SELECT status FROM catalog_admin_catalog_item_list_pages WHERE catalog_item_id = 'cat_2'",
    );
    expect(stale.rows[0]!.status).toBe("draft");
    const job = await enqueue([...preview.item_ids]);
    expect(await process("owner_a")).toBe(true);
    const partial = await jobs.get(job.jobId, context);
    expect(partial).toMatchObject({
      status: "running",
      progress: { completed: 1, total: 4 },
      result: { total: 1, candidates: expect.any(Array) },
    });
    const abandoned = await unitStore().claimNext({
      claimOwnerId: "owner_b",
      claimTtlMs: 20,
      workflowMaxActiveClaims: 1,
      jobMaxActiveClaims: 1,
      jobKinds: [kind],
    });
    expect(abandoned.claim?.unit.unitId).toBe("cat_2");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const replacement = createCatalogAuthoringBulkJobServices(pool);
    for (let index = 0; index < 3; index += 1)
      expect(await replacement.processNext({ claimOwnerId: "owner_c", services, workflowMaxActiveClaims: 1 })).toBe(
        true,
      );
    const completed = await replacement.get(job.jobId, context);
    expect(completed).toMatchObject({
      status: "completed",
      progress: { completed: 4, total: 4 },
      result: { total: 4, succeeded_count: 2, skipped_count: 1, failed_count: 1 },
    });
    expect(completed?.result).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({
          catalog_item_id: "cat_2",
          outcome: "failed",
          reason: "Only draft items can be removed.",
        }),
      ]),
    });
    for (const id of ["cat_1", "cat_3"]) {
      const events = await removalEvents(id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tenantId: context.tenantId,
        performedByUserId: context.audit.performedByUserId,
        forAccountId: context.audit.forAccountId,
      });
    }
    expect(await removalEvents("cat_2")).toHaveLength(0);
    expect(await removalEvents("cat_4")).toHaveLength(0);
    const summary = await replacement.getWorkUnitSummary({ jobId: job.jobId });
    expect(summary).toMatchObject({ total: 4, completed: 2, skipped: 1, failed: 1, running: 0, queued: 0 });
    const attempts = await pool.query<{ attempt_count: number }>(
      "SELECT attempt_count FROM catalog_authoring_bulk_work_units WHERE job_id = $1 AND unit_id = 'cat_2'",
      [job.jobId],
    );
    expect(Number(attempts.rows[0]!.attempt_count)).toBe(2);
  });

  it("D3: terminal and day-after polling retain an identical scoped result", async () => {
    await create("cat_1");
    await project();
    const job = await enqueue(["cat_1"]);
    expect(await process("owner_a")).toBe(true);
    const first = await jobs.get(job.jobId, context);
    expect(first?.status).toBe("completed");
    expect(await process("owner_b")).toBe(false);
    expect(await jobs.get(job.jobId, context)).toEqual(first);
    await pool.query(
      "UPDATE catalog_authoring_bulk_jobs SET completed_at = now() - interval '1 day' WHERE job_id = $1",
      [job.jobId],
    );
    expect(await jobs.pruneRetention()).toBe(0);
    expect((await jobs.get(job.jobId, context))?.result).toEqual(first?.result);
    const foreign = { ...context, tenantId: "tnt_foreign" as never };
    expect(await jobs.get(job.jobId, foreign)).toBeNull();
    expect(await jobs.listEvents(job.jobId, 0, foreign)).toEqual([]);
  });

  it("D4: exhausted real unit budget never falls back to whole-job removal", async () => {
    await create("cat_1");
    await create("cat_2");
    await project();
    const first = await enqueue(["cat_1"]);
    const second = await enqueue(["cat_2"]);
    const held = await unitStore().claimNext({
      claimOwnerId: "owner_a",
      claimTtlMs: 60000,
      workflowMaxActiveClaims: 1,
      jobMaxActiveClaims: 1,
      jobKinds: [kind],
    });
    expect(held.claim?.job.jobId).toBe(first.jobId);
    expect(await process("owner_b")).toBe(false);
    expect((await jobs.get(second.jobId, context))?.status).toBe("queued");
    expect(await removalEvents("cat_2")).toHaveLength(0);
  });

  it("D5: already removed items and repeated confirms emit no second event or terminal", async () => {
    await create("cat_1");
    await project();
    const job = await enqueue(["cat_1", "cat_1"]);
    await services.items.commandHandler({
      streamId: "catalog.item-cat_1",
      command: { type: "RemoveDraftCatalogItem" },
      context,
    });
    expect(await process("owner_a")).toBe(true);
    expect(await process("owner_b")).toBe(false);
    expect(await removalEvents("cat_1")).toHaveLength(1);
    expect(await jobs.getWorkUnitSummary({ jobId: job.jobId })).toMatchObject({
      total: 1,
      failed: 1,
      completed: 0,
      skipped: 0,
    });
    const repeat = await enqueue(["cat_1"]);
    expect(await process("owner_c")).toBe(true);
    expect(await removalEvents("cat_1")).toHaveLength(1);
    expect(await jobs.getWorkUnitSummary({ jobId: repeat.jobId })).toMatchObject({ total: 1, failed: 1 });
  });
});
