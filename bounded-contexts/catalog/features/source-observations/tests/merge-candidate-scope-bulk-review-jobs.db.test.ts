import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { module as catalogModule } from "../../../index";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import {
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateCommand,
  type CatalogMergeCandidateEvent,
  type CatalogMergeCandidateReviewSnapshot,
  type CatalogMergeCandidateState,
} from "../domain/catalog-merge-candidate";
import { buildCatalogMergeCandidateProjectionHandlers } from "../read-model/catalog-merge-candidate-projection";
import { createSourceObservationRuntime, type CatalogMergeCandidateBulkJob } from "../api/runtime";
import { bulkJobReasonMarker } from "../api/source-observation-merge-candidate-bulk-job-runtime";
import { catalogMergeCandidateStreamId } from "../api/source-observation-stream-identity";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["catalog"] as const;
const scopeRecordId = "scope_bulk_base_set";

const context = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_catalog_operator" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

type Runtime = ReturnType<typeof createSourceObservationRuntime>;

describeDb("Catalog Merge Candidate scope bulk review jobs (db)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let eventStore: EventStore;
  let runtime: Runtime;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "catalog_merge_candidate_scope_bulk_review",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
    await seedScopeRecord(pools.catalog, scopeRecordId);
    eventStore = createPostgresEventStore({ pool: pools.catalog });
    const deps = {
      db: pools.catalog,
      eventStore,
      checkpointStore: createPostgresProjectionStore({ db: pools.catalog }),
    } as CatalogRuntimeDeps;
    runtime = createSourceObservationRuntime(deps, {} as CatalogItemServices, {} as ReferenceDataServices);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("AC1: one submit promotes all 120 ready candidates and leaves the 5 has-conflicts candidates unchanged", async () => {
    const candidates = candidateWriter(pools.catalog, eventStore);
    const readyIds = range(120).map((index) => `cand_ready_${pad(index)}`);
    const conflictIds = range(5).map((index) => `cand_conflict_${pad(index)}`);
    for (const candidateId of readyIds) {
      await candidates.create(candidateId, snapshot(candidateId));
    }
    for (const candidateId of conflictIds) {
      await candidates.create(candidateId, snapshot(candidateId, { blocking: true }));
    }
    const conflictVersionsBefore = await streamVersions(eventStore, conflictIds);

    const job = await runtime.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-promote",
      scopeRecordId,
      context,
    });
    expect(job).toMatchObject({ kind: "merge-candidate-promote", scopeRecordId, status: "queued" });
    expect(job.progress).toMatchObject({ phase: "queued", completed: 0, total: 125 });

    await drainWorker(runtime);

    const completed = await requireJob(runtime, job.jobId);
    expect(completed.status).toBe("completed");
    expect(completed.progress).toMatchObject({ phase: "completed", completed: 125, total: 125 });
    expect(completed.result).toMatchObject({
      requested: 125,
      promoted: 120,
      deferred: 0,
      skippedNotEligible: 5,
      failed: 0,
    });
    for (const candidateId of readyIds) {
      expect((await candidates.load(candidateId)).status).toBe("promoted");
    }
    for (const candidateId of conflictIds) {
      expect((await candidates.load(candidateId)).status).toBe("has-conflicts");
    }
    expect(await streamVersions(eventStore, conflictIds)).toEqual(conflictVersionsBefore);
    expect(
      completed.result?.outcomes
        .filter((outcome) => outcome.status === "skipped-not-eligible")
        .map((o) => o.candidateId),
    ).toEqual(conflictIds);
  });

  it("AC2: reports progress, then resumes after a killed worker without promoting any candidate twice", async () => {
    const candidates = candidateWriter(pools.catalog, eventStore);
    const readyIds = range(12).map((index) => `cand_ready_${pad(index)}`);
    for (const candidateId of readyIds) {
      await candidates.create(candidateId, snapshot(candidateId));
    }
    const job = await runtime.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-promote",
      scopeRecordId,
      reason: "Seed the scope.",
      context,
    });

    for (let index = 0; index < 4; index += 1) {
      await expect(processOne(runtime)).resolves.toBe(1);
    }
    const midJob = await requireJob(runtime, job.jobId);
    expect(midJob.status).toBe("running");
    expect(midJob.progress).toMatchObject({ phase: "processing", completed: 4, total: 12 });
    expect(midJob.result).toMatchObject({ promoted: 4 });

    // Worker killed after appending one promotion but before recording its
    // terminal, and killed on another unit before it acted: both units are left
    // running under a claim that has expired.
    const [appendedId, unappliedId] = await queuedUnitIds(pools.catalog, job.jobId, 2);
    await candidates.command(appendedId!, {
      type: "PromoteCatalogMergeCandidate",
      reason: `Seed the scope. ${bulkJobReasonMarker(job.jobId)}`,
      actor: { userId: "usr_catalog_operator", accountId: "acc_identity_system" },
      promotedAt: new Date().toISOString(),
    });
    await abandonUnitClaims(pools.catalog, job.jobId, [appendedId!, unappliedId!]);

    await drainWorker(runtime);

    const resumed = await requireJob(runtime, job.jobId);
    expect(resumed.status).toBe("completed");
    expect(resumed.result).toMatchObject({ requested: 12, promoted: 12, skippedNotEligible: 0, failed: 0 });
    expect(resumed.result?.outcomes.find((outcome) => outcome.candidateId === appendedId)).toMatchObject({
      status: "promoted",
    });
    // Exactly one terminal per unit and one promotion event per candidate.
    expect(new Set(resumed.result?.outcomes.map((outcome) => outcome.candidateId)).size).toBe(12);
    for (const candidateId of readyIds) {
      await expect(promotionEventCount(eventStore, candidateId)).resolves.toBe(1);
    }
  });

  it("AC3: a second submit on the same scope promotes nothing", async () => {
    const candidates = candidateWriter(pools.catalog, eventStore);
    for (const candidateId of ["cand_ready_000", "cand_ready_001"]) {
      await candidates.create(candidateId, snapshot(candidateId));
    }
    await candidates.create("cand_conflict_000", snapshot("cand_conflict_000", { blocking: true }));

    const first = await runtime.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-promote",
      scopeRecordId,
      context,
    });
    await drainWorker(runtime);
    await candidates.reproject(["cand_ready_000", "cand_ready_001", "cand_conflict_000"]);
    expect((await requireJob(runtime, first.jobId)).result).toMatchObject({ promoted: 2 });

    const second = await runtime.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-promote",
      scopeRecordId,
      context,
    });
    await drainWorker(runtime);

    const rerun = await requireJob(runtime, second.jobId);
    expect(rerun.status).toBe("completed");
    expect(rerun.result).toMatchObject({ requested: 1, promoted: 0, skippedNotEligible: 1, failed: 0 });
    for (const candidateId of ["cand_ready_000", "cand_ready_001"]) {
      await expect(promotionEventCount(eventStore, candidateId)).resolves.toBe(1);
    }
  });

  it("re-checks eligibility when each unit runs: a candidate that turns has-conflicts after submit is not promoted", async () => {
    const candidates = candidateWriter(pools.catalog, eventStore);
    for (const candidateId of ["cand_ready_000", "cand_ready_001"]) {
      await candidates.create(candidateId, snapshot(candidateId));
    }
    const job = await runtime.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-promote",
      scopeRecordId,
      context,
    });
    await candidates.command("cand_ready_001", {
      type: "UpdateCatalogMergeCandidate",
      snapshot: snapshot("cand_ready_001", { blocking: true }),
      reason: "A provider reported a conflicting rarity.",
      actor: { userId: "usr_catalog_operator", accountId: "acc_identity_system" },
      updatedAt: new Date().toISOString(),
    });

    await drainWorker(runtime);

    const completed = await requireJob(runtime, job.jobId);
    expect(completed.result).toMatchObject({ promoted: 1, skippedNotEligible: 1 });
    expect(completed.result?.outcomes.find((outcome) => outcome.candidateId === "cand_ready_001")).toMatchObject({
      status: "skipped-not-eligible",
      reason: "Catalog Merge Candidate is has-conflicts.",
    });
    expect((await candidates.load("cand_ready_001")).status).toBe("has-conflicts");
  });

  it("AC4: completed promotion jobs and their promoted Catalog Items page newest first, each exactly once", async () => {
    const candidates = candidateWriter(pools.catalog, eventStore);
    await candidates.create("cand_decisive", snapshot("cand_decisive", { catalogItemId: "item_decisive" }));
    await candidates.create("cand_conflict_000", snapshot("cand_conflict_000", { blocking: true }));
    await seedScopeRecord(pools.catalog, "scope_other_set");

    const jobIds: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const job = await runtime.enqueueCatalogMergeCandidateBulkJob({
        kind: "merge-candidate-promote",
        scopeRecordId,
        context,
      });
      jobIds.push(job.jobId);
      await drainWorker(runtime);
      if (index === 0) {
        await candidates.reproject(["cand_decisive"]);
      }
    }
    // Neither another scope's job nor another operator's job joins this list.
    await runtime.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-promote",
      scopeRecordId: "scope_other_set",
      context,
    });
    await runtime.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-promote",
      scopeRecordId,
      context: { ...context, audit: { ...context.audit, performedByUserId: "usr_other_operator" as never } },
    });
    await drainWorker(runtime);

    const firstWalk = await walkCompletedJobs(runtime);
    expect(firstWalk.pages.map((page) => page.length)).toEqual([50, 1]);
    expect(firstWalk.jobIds).toHaveLength(51);
    expect(new Set(firstWalk.jobIds)).toEqual(new Set(jobIds));
    // Newest first: the oldest job — the only one that promoted the decisive
    // item — is reachable only on the last page.
    expect(firstWalk.pages[1]).toEqual([jobIds[0]]);
    expect(firstWalk.promotedCatalogItemIds).toEqual(["item_decisive"]);
    expect(firstWalk.promotedCatalogItemIdsOnFirstPage).toEqual([]);

    // Identical completion times still page every job exactly once.
    await pools.catalog.query(
      `UPDATE catalog_source_observation_bulk_review_jobs
       SET completed_at = '2026-10-09T12:00:00.123456Z'
       WHERE job_id = ANY($1::text[])`,
      [jobIds],
    );
    const tiedWalk = await walkCompletedJobs(runtime);
    expect(tiedWalk.pages.map((page) => page.length)).toEqual([50, 1]);
    expect(tiedWalk.jobIds).toHaveLength(51);
    expect(new Set(tiedWalk.jobIds)).toEqual(new Set(jobIds));
    expect(tiedWalk.promotedCatalogItemIds).toEqual(["item_decisive"]);
  });

  it("AC5: defer-remainder defers only has-conflicts and stale candidates through the same job path", async () => {
    const candidates = candidateWriter(pools.catalog, eventStore);
    await candidates.create("cand_ready_000", snapshot("cand_ready_000"));
    await candidates.create("cand_conflict_000", snapshot("cand_conflict_000", { blocking: true }));
    await candidates.create("cand_stale_000", snapshot("cand_stale_000"));
    await candidates.command("cand_stale_000", {
      type: "MarkCatalogMergeCandidateStale",
      reason: "Source Observation changed.",
      staleAt: new Date().toISOString(),
      triggeredByObservationIds: ["obs_cand_stale_000"],
    });
    await candidates.reproject(["cand_stale_000"]);

    const job = await runtime.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-defer",
      scopeRecordId,
      reason: "Deferred pending conflict review.",
      context,
    });
    await drainWorker(runtime);

    const completed = await requireJob(runtime, job.jobId);
    expect(completed).toMatchObject({ kind: "merge-candidate-defer", status: "completed" });
    expect(completed.result).toMatchObject({ requested: 3, promoted: 0, deferred: 2, skippedNotEligible: 1 });
    expect((await candidates.load("cand_ready_000")).status).toBe("ready");
    expect((await candidates.load("cand_conflict_000")).status).toBe("deferred");
    expect((await candidates.load("cand_stale_000")).status).toBe("deferred");
    expect((await candidates.load("cand_stale_000")).statusReason).toBe(
      `Deferred pending conflict review. ${bulkJobReasonMarker(job.jobId)}`,
    );
  });
});

async function seedScopeRecord(db: PgTransactionalPool, id: string): Promise<void> {
  await db.query(
    `INSERT INTO catalog_scope_records (
       scope_record_id, product_domain, scope_kind, reference_type_key, reference_record_id, reference_record_key, name
     ) VALUES ($1, 'pokemon', 'expansion', 'expansion', $2, $3, $4)`,
    [id, `ref_${id}`, id, `Scope ${id}`],
  );
}

// Writes candidates through the Catalog Merge Candidate aggregate and projects
// their streams into the review read model the job enumerates from.
function candidateWriter(db: PgTransactionalPool, eventStore: EventStore) {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore,
    codec: createPassthroughDomainEventCodec<CatalogMergeCandidateEvent>(),
    initialState: () => initialCatalogMergeCandidateState,
    evolve: evolveCatalogMergeCandidate,
    decide: decideCatalogMergeCandidate,
  });
  const projection = buildCatalogMergeCandidateProjectionHandlers(db);

  async function reproject(candidateIds: readonly string[]): Promise<void> {
    for (const candidateId of candidateIds) {
      const streamId = catalogMergeCandidateStreamId(candidateId);
      for (const event of await eventStore.readStream({ streamId })) {
        await projection[event.eventType]?.({
          streamId,
          data: event.payload,
          timing: { recordedAt: event.recordedAt },
        } as never);
      }
    }
  }

  return {
    async create(candidateId: string, candidateSnapshot: CatalogMergeCandidateReviewSnapshot): Promise<void> {
      await commandHandler({
        streamId: catalogMergeCandidateStreamId(candidateId),
        command: {
          type: "CreateCatalogMergeCandidate",
          candidateId,
          snapshot: candidateSnapshot,
          createdAt: new Date().toISOString(),
        },
        context,
      });
      await reproject([candidateId]);
    },
    async command(candidateId: string, command: CatalogMergeCandidateCommand): Promise<void> {
      await commandHandler({ streamId: catalogMergeCandidateStreamId(candidateId), command, context });
    },
    async load(candidateId: string): Promise<CatalogMergeCandidateState> {
      return (await repository.load(catalogMergeCandidateStreamId(candidateId))).state;
    },
    reproject,
  };
}

function snapshot(
  candidateId: string,
  options: Readonly<{ blocking?: boolean; catalogItemId?: string }> = {},
): CatalogMergeCandidateReviewSnapshot {
  const observationId = `obs_${candidateId}`;
  return {
    identityFingerprint: `sha256:${candidateId}`,
    syncRunIds: ["run_bulk_review"],
    identity: {
      scopeRecordId,
      collectorNumber: candidateId,
      languageCode: "en",
      productForm: "single-card",
      variantKey: "standard",
      barcode: null,
    },
    membership: [
      {
        observationId,
        syncRunId: "run_bulk_review",
        providerKey: "tcgdex",
        externalKey: candidateId,
        sourceRecordHash: `sha256:${observationId}`,
        sourceProfileKey: "pokemon-tcg",
        sourceProfileVersion: "2026.06.24",
        sourceMappingFingerprint: "sha256:mapping",
        observedAt: "2026-10-09T00:00:00.000Z",
        addedAt: "2026-10-09T00:00:00.000Z",
      },
    ],
    matches: { catalogItemId: options.catalogItemId ?? null, productIds: [] },
    proposedCatalogItemFacts: { name: candidateId },
    proposedExternalCatalogItemReferences: [{ providerKey: "tcgdex", externalKey: candidateId }],
    proposedExternalProductReferences: [],
    conflicts: options.blocking
      ? [
          {
            code: "rarity-mismatch",
            severity: "blocking",
            message: "Providers disagree on rarity.",
            fieldPath: "catalogItem.rarity",
            observationIds: [observationId],
            existingValue: "Rare",
            proposedValue: "Common",
          },
        ]
      : [],
    warnings: [],
    fieldProvenance: [],
    promotionIntent: options.catalogItemId ? "link-existing-catalog-item" : "create-catalog-item",
  };
}

async function processOne(runtime: Runtime): Promise<number> {
  return runtime.processNextBulkReviewJob({ claimOwnerId: "bulk-review-db-proof", claimTtlMs: 120_000 });
}

async function drainWorker(runtime: Runtime): Promise<void> {
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    if ((await processOne(runtime)) === 0) {
      return;
    }
  }
  throw new Error("Bulk review worker did not drain within 1000 iterations.");
}

async function requireJob(runtime: Runtime, jobId: string): Promise<CatalogMergeCandidateBulkJob> {
  const job = await runtime.getCatalogMergeCandidateBulkJob(jobId, context);
  if (!job) {
    throw new Error(`Catalog Merge Candidate bulk job ${jobId} was not found.`);
  }
  return job;
}

async function walkCompletedJobs(runtime: Runtime) {
  const pages: string[][] = [];
  const promotedCatalogItemIds: string[] = [];
  let promotedCatalogItemIdsOnFirstPage: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await runtime.listCompletedCatalogMergeCandidateBulkJobs({
      context,
      scopeRecordId,
      kind: "merge-candidate-promote",
      cursor,
    });
    const itemIds = page.items.flatMap((job) =>
      (job.result?.outcomes ?? []).flatMap((outcome) =>
        outcome.status === "promoted" && outcome.catalogItemId ? [outcome.catalogItemId] : [],
      ),
    );
    if (pages.length === 0) {
      promotedCatalogItemIdsOnFirstPage = itemIds;
    }
    pages.push(page.items.map((job) => job.jobId));
    promotedCatalogItemIds.push(...itemIds);
    cursor = page.cursor;
  } while (cursor && pages.length < 10);

  return { pages, jobIds: pages.flat(), promotedCatalogItemIds, promotedCatalogItemIdsOnFirstPage };
}

async function queuedUnitIds(db: PgTransactionalPool, jobId: string, count: number): Promise<readonly string[]> {
  const result = await db.query<{ unit_id: string }>(
    `SELECT unit_id
     FROM catalog_source_observation_bulk_review_work_units
     WHERE job_id = $1 AND state = 'queued'
     ORDER BY created_at ASC, unit_id ASC
     LIMIT $2`,
    [jobId, count],
  );
  return result.rows.map((row) => row.unit_id);
}

async function abandonUnitClaims(db: PgTransactionalPool, jobId: string, unitIds: readonly string[]): Promise<void> {
  await db.query(
    `UPDATE catalog_source_observation_bulk_review_work_units
     SET state = 'running',
         claim_owner_id = 'killed-worker',
         claim_token = 'killed-claim',
         claimed_until = now() - interval '1 second',
         attempt_count = attempt_count + 1,
         updated_at = now()
     WHERE job_id = $1 AND unit_id = ANY($2::text[])`,
    [jobId, [...unitIds]],
  );
}

async function streamVersions(eventStore: EventStore, candidateIds: readonly string[]): Promise<readonly number[]> {
  return Promise.all(
    candidateIds.map(
      async (candidateId) =>
        (await eventStore.readStream({ streamId: catalogMergeCandidateStreamId(candidateId) })).length,
    ),
  );
}

async function promotionEventCount(eventStore: EventStore, candidateId: string): Promise<number> {
  return (await eventStore.readStream({ streamId: catalogMergeCandidateStreamId(candidateId) })).filter(
    (event) => event.eventType === "catalog.merge-candidate.promoted",
  ).length;
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function pad(index: number): string {
  return String(index).padStart(3, "0");
}
