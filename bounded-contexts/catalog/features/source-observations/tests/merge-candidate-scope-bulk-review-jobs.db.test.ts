import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPostgresDurableJobStore } from "@chase-sets/platform-runtime/durable-job-store";
import { createPostgresDurableJobWorkUnitStore } from "@chase-sets/platform-runtime/durable-job-work-units";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { JsonObject } from "@chase-sets/primitives/json";
import { module as catalogModule } from "../../../index";
import type { CatalogItemId } from "../../../ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedCatalogDatabase } from "../../../support/authoring-support/seed";
import { evolveCatalogItem, initialCatalogItemState, type CatalogItemEvent } from "../../catalog-items/domain/domain";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import { queryProductionCatalogCompletionFacts } from "../../completion-report/read-model/query";
import { defaultScopeSyncBatchBudget } from "../../scope-sync-batches/domain/batch";
import { createScopeSyncBatchStore } from "../../scope-sync-batches/read-model/store";
import fixture from "../api/__fixtures__/tcgdex/normal.json";
import { unitKeyForCatalogProviderProfileVersion } from "../api/governance/catalog-integration-impact-analysis";
import { createCatalogIntegrationRolloutControlPolicyFromEnv } from "../api/governance/catalog-integration-rollout-controls";
import { catalogMergeCandidateTargetId } from "../api/promotion/catalog-merge-candidate-application";
import { buildCatalogMergeCandidatesFromObservations } from "../api/promotion/catalog-merge-candidate-matcher";
import {
  createPostgresPromotionTargetExclusion,
  type PromotionTargetExclusion,
} from "../api/promotion/promotion-target-exclusion";
import { sourceObservationTargetId } from "../api/promotion/promotion-target-identity";
import {
  normalizeCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationInput,
} from "../api/promotion/provider-source-observation-normalizer";
import { createCatalogProviderIntegrationProfileVersionStore } from "../api/providers/provider-integration-profile-store";
import {
  loadCatalogItemPromotionProfile,
  requireCatalogItemPromotionObservation,
  requireCatalogPromotionProfileVersion,
  requireSourceObservationMappingContract,
} from "../api/source-observation-promotion-execution";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../api/tcgdex-executable-mapping-contract";
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
import {
  bulkJobReasonMarker,
  catalogMergeCandidatePromotionApplicationJobKind,
  CatalogMergeCandidateBulkJobMalformedError,
  reconcileCatalogMergeCandidateApplications,
} from "../api/source-observation-merge-candidate-bulk-job-runtime";
import { catalogMergeCandidateStreamId } from "../api/source-observation-stream-identity";
import { getSourceObservationDetail, listCatalogMergeCandidates } from "../read-model/queries";
import { furySliver, magicCandidate, magicObservation, registeredMagicProfile } from "./magic-provider-role-fixture";

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

  it("F1: an empty English page still enumerates eligible Japanese scope candidates for promotion", async () => {
    const candidates = candidateWriter(pools.catalog, eventStore);
    await pools.catalog.query(
      `INSERT INTO catalog_source_observations (
        observation_id, provider_key, external_key, source_url, language_code, source_record_hash,
        observed_at, source_profile_key, source_profile_version, source_mapping_fingerprint, normalized, source_payload
      ) VALUES ('obs_cand_japanese', 'tcgdex', 'cand_japanese', 'https://synthetic.invalid/candidate', 'ja', 'sha256:synthetic',
        now(), 'pokemon-tcg', '2026.06.24', 'sha256:mapping', '{}'::jsonb, '{}'::jsonb)`,
    );
    const candidateSnapshot = snapshot("cand_japanese");
    await candidates.create("cand_japanese", {
      ...candidateSnapshot,
      identity: { ...candidateSnapshot.identity, languageCode: "ja" },
    });
    const page = await listCatalogMergeCandidates(pools.catalog, { scopeRecordId, language: "en", limit: 25 });
    expect(page.items).toEqual([]);
    const japanesePage = await listCatalogMergeCandidates(pools.catalog, { scopeRecordId, language: "ja", limit: 25 });
    expect(japanesePage.items.map((candidate) => candidate.candidate_id)).toEqual(["cand_japanese"]);
    const job = await runtime.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-promote",
      scopeRecordId,
      context,
    });
    await drainWorker(runtime);
    // Enumerated despite the empty English page; with no retained member stream
    // the application preflight blocks visibly and leaves the candidate ready.
    const completed = await requireJob(runtime, job.jobId);
    expect(completed).toMatchObject({ status: "completed", result: { requested: 1, promoted: 0, failed: 1 } });
    expect(completed.result?.outcomes[0]?.reason).toMatch(/^promotion-plan-blocked:member-revision-missing/);
    expect((await candidates.load("cand_japanese")).status).toBe("ready");
  });

  it("F3: filters active jobs before the 50-row limit and retains a bounded matching window", async () => {
    for (let index = 0; index < 60; index += 1) {
      await runtime.enqueueCatalogMergeCandidateBulkJob({
        kind: "merge-candidate-promote",
        scopeRecordId: index % 2 === 0 ? "scope_foreign" : scopeRecordId,
        context:
          index % 2 === 0
            ? context
            : { ...context, audit: { ...context.audit, performedByUserId: "usr_foreign" as never } },
      });
    }
    const matching = await runtime.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-promote",
      scopeRecordId,
      context,
    });
    expect(
      (await runtime.listActiveCatalogMergeCandidateBulkJobs({ scopeRecordId, context })).map((job) => job.jobId),
    ).toEqual([matching.jobId]);
    for (let index = 0; index < 50; index += 1) {
      await runtime.enqueueCatalogMergeCandidateBulkJob({ kind: "merge-candidate-promote", scopeRecordId, context });
    }
    const page = await runtime.listActiveCatalogMergeCandidateBulkJobs({ scopeRecordId, context });
    expect(page).toHaveLength(50);
    expect(page[0]?.jobId).toBe(matching.jobId);
    expect(page.every((job) => job.scopeRecordId === scopeRecordId && job.kind === "merge-candidate-promote")).toBe(
      true,
    );
  });

  it("F2: failed readback stays scope/operator isolated and bounded without joining completed pages", async () => {
    const candidates = candidateWriter(pools.catalog, eventStore);
    await candidates.create("cand_missing", snapshot("cand_missing"));
    const matchingIds: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const job = await runtime.enqueueCatalogMergeCandidateBulkJob({
        kind: "merge-candidate-promote",
        scopeRecordId,
        context,
      });
      matchingIds.push(job.jobId);
    }
    const foreignInputs = [
      { scopeRecordId: "scope_foreign", context },
      { scopeRecordId, context: { ...context, tenantId: "tnt_foreign" as never } },
      { scopeRecordId, context: { ...context, audit: { ...context.audit, forAccountId: "acc_foreign" as never } } },
      {
        scopeRecordId,
        context: { ...context, audit: { ...context.audit, performedByUserId: "usr_foreign" as never } },
      },
    ];
    for (const input of foreignInputs) {
      await runtime.enqueueCatalogMergeCandidateBulkJob({ kind: "merge-candidate-promote", ...input });
    }
    await pools.catalog.query(
      `UPDATE catalog_source_observation_bulk_review_jobs SET status = 'failed', error_message = 'Synthetic lost units.', progress = jsonb_set(progress, '{phase}', '"failed"'::jsonb)`,
    );
    const failed = await runtime.listFailedCatalogMergeCandidateBulkJobs({ scopeRecordId, context });
    expect(failed).toHaveLength(50);
    expect(failed.every((job) => matchingIds.includes(job.jobId))).toBe(true);
    expect(failed[0]).toMatchObject({
      status: "failed",
      errorMessage: "Synthetic lost units.",
      progress: { completed: 0, total: 1 },
    });
    expect((await runtime.listCompletedCatalogMergeCandidateBulkJobs({ scopeRecordId, context })).items).toEqual([]);
    expect(await runtime.listActiveCatalogMergeCandidateBulkJobs({ scopeRecordId, context })).toEqual([]);
    const foreignContext = foreignInputs[3]!.context;
    expect(await runtime.getCatalogMergeCandidateBulkJob(matchingIds[0]!, foreignContext)).toBeNull();
  });

  it("AC1: one submit enumerates 125 candidates; ready ones without retained evidence fail visibly and none is approved", async () => {
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
    expect(completed).toMatchObject({ promotionApplicationVersion: 1 });
    expect(completed.result).toMatchObject({
      requested: 125,
      promoted: 0,
      deferred: 0,
      skippedNotEligible: 5,
      failed: 120,
    });
    // Approval-only success is gone: a blocked preflight appends no approval.
    for (const candidateId of readyIds) {
      expect((await candidates.load(candidateId)).status).toBe("ready");
      await expect(promotionEventCount(eventStore, candidateId)).resolves.toBe(0);
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

  it("AC2: reports progress, then resumes after a killed worker with one terminal per unit and no second approval", async () => {
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
    expect(midJob.result).toMatchObject({ promoted: 0, failed: 4 });

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
    expect(resumed.result).toMatchObject({ requested: 12, promoted: 0, skippedNotEligible: 0, failed: 12 });
    // The approved unit is catch-up work; it still needs retained evidence to apply.
    expect(resumed.result?.outcomes.find((outcome) => outcome.candidateId === appendedId)).toMatchObject({
      status: "failed",
      appliedCatalogItemId: null,
    });
    // Exactly one terminal per unit and never a second approval.
    expect(new Set(resumed.result?.outcomes.map((outcome) => outcome.candidateId)).size).toBe(12);
    for (const candidateId of readyIds) {
      await expect(promotionEventCount(eventStore, candidateId)).resolves.toBe(candidateId === appendedId ? 1 : 0);
    }
  });

  it("AC3: blocked scope submits promote and approve nothing, however often they repeat", async () => {
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
    expect((await requireJob(runtime, first.jobId)).result).toMatchObject({ promoted: 0, failed: 2 });

    const second = await runtime.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-promote",
      scopeRecordId,
      context,
    });
    await drainWorker(runtime);

    const rerun = await requireJob(runtime, second.jobId);
    expect(rerun.status).toBe("completed");
    expect(rerun.result).toMatchObject({ requested: 3, promoted: 0, skippedNotEligible: 1, failed: 2 });
    for (const candidateId of ["cand_ready_000", "cand_ready_001"]) {
      await expect(promotionEventCount(eventStore, candidateId)).resolves.toBe(0);
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
    expect(completed.result).toMatchObject({ promoted: 0, failed: 1, skippedNotEligible: 1 });
    expect(completed.result?.outcomes.find((outcome) => outcome.candidateId === "cand_ready_001")).toMatchObject({
      status: "skipped-not-eligible",
      reason: "Catalog Merge Candidate is has-conflicts.",
    });
    expect((await candidates.load("cand_ready_001")).status).toBe("has-conflicts");
  });

  it("AC4: completed promotion jobs and their outcomes page newest first, each exactly once", async () => {
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
        // Only the oldest job enumerates the decisive candidate.
        await candidates.command("cand_decisive", {
          type: "IgnoreCatalogMergeCandidate",
          reason: "Retired after the first submit.",
          actor: { userId: "usr_catalog_operator", accountId: "acc_identity_system" },
          ignoredAt: new Date().toISOString(),
        });
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
    // Newest first: the oldest job — the only one with the decisive outcome —
    // is reachable only on the last page.
    expect(firstWalk.pages[1]).toEqual([jobIds[0]]);
    expect(firstWalk.decisiveOutcomes).toEqual(["cand_decisive"]);
    expect(firstWalk.decisiveOutcomesOnFirstPage).toEqual([]);

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
    expect(tiedWalk.decisiveOutcomes).toEqual(["cand_decisive"]);
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
  const decisiveOutcomes: string[] = [];
  let decisiveOutcomesOnFirstPage: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await runtime.listCompletedCatalogMergeCandidateBulkJobs({
      context,
      scopeRecordId,
      kind: "merge-candidate-promote",
      cursor,
    });
    const decisive = page.items.flatMap((job) =>
      (job.result?.outcomes ?? []).flatMap((outcome) =>
        outcome.candidateId === "cand_decisive" ? [outcome.candidateId] : [],
      ),
    );
    if (pages.length === 0) {
      decisiveOutcomesOnFirstPage = decisive;
    }
    pages.push(page.items.map((job) => job.jobId));
    decisiveOutcomes.push(...decisive);
    cursor = page.cursor;
  } while (cursor && pages.length < 10);

  return { pages, jobIds: pages.flat(), decisiveOutcomes, decisiveOutcomesOnFirstPage };
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

const applicationScopeId = "scope_application";
type CrashPoint = "a" | "b" | "c" | "d" | "e";
const crashPoints: readonly CrashPoint[] = ["a", "b", "c", "d", "e"];
const lostLease = () => new Error("Lost lease (synthetic crash)");
const bulkReviewJobTables = {
  jobsTable: "catalog_source_observation_bulk_review_jobs",
  eventsTable: "catalog_source_observation_bulk_review_job_events",
  workUnitsTable: "catalog_source_observation_bulk_review_work_units",
  notifyChannel: "catalog_source_observation_durable_job_events",
};

describeDb("Catalog Merge Candidate application through real Catalog services (db)", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  let store: ReturnType<typeof createPostgresEventStore>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["catalog"],
      "catalog_merge_candidate_application",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    await seedCatalogDatabase(pool, undefined, { enabledDataProfiles: ["catalog-integration-bootstrap"] });
    services = createCatalogServices(pool);
    store = createPostgresEventStore({ pool });
    await seedScopeRecord(pool, applicationScopeId);
  });
  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  async function mappingContract() {
    const identity = tcgdexPokemonCardSourceObservationMappingContract;
    const version = await services.providerIntegrationProfiles.getProfileVersion(
      identity.providerKey,
      identity.profileVersion,
      { profileKey: identity.profileKey },
    );
    if (!version) throw new Error("Seeded executable mapping profile is missing");
    return { version, contract: requireSourceObservationMappingContract(version) };
  }

  // Observations come from the executable mapper over the checked-in fixture,
  // varied only by card number so each one is its own candidate identity.
  async function record(id: string, localId: string, overrides: Record<string, unknown> = {}) {
    const mapped = normalizeCatalogProviderSourceObservation({
      contract: (await mappingContract()).contract,
      payload: {
        ...fixture,
        ...overrides,
        card: { ...fixture.card, localId },
        mergeIdentity: { ...fixture.mergeIdentity, cardNumber: localId },
        catalogHashMaterial: { ...fixture.catalogHashMaterial, id: `${fixture.mergeIdentity.setId}-${localId}` },
        observationId: id,
        externalKey: id,
        sourceUrl: `https://synthetic.invalid/source/${id}`,
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: `product:synthetic-${id}` }],
      },
      observedAt: "2026-10-11T00:00:00.000Z",
    });
    expect(mapped.diagnostics).toEqual([]);
    if (!mapped.observation) throw new Error("Executable mapper did not produce an observation");
    await services.sourceObservations.commandHandler({
      streamId: `catalog.source-observation-${id}`,
      command: { type: "RecordSourceObservation", ...mapped.observation },
      context,
    });
    await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
    return mapped.observation;
  }

  // Candidates come from the real matcher over the recorded observation rows.
  async function candidateFrom(
    observationIds: readonly string[],
    change: (snapshot: CatalogMergeCandidateReviewSnapshot) => CatalogMergeCandidateReviewSnapshot = (s) => s,
  ): Promise<string> {
    const rows = [];
    for (const id of observationIds) rows.push((await getSourceObservationDetail(pool, id))!);
    const { version } = await mappingContract();
    const unitKey = unitKeyForCatalogProviderProfileVersion(version);
    const normalized = rows[0]!.normalized as unknown as Readonly<Record<string, unknown>>;
    const now = new Date().toISOString();
    const batch = buildCatalogMergeCandidatesFromObservations(rows, {
      addedAt: now,
      acceptedScopeMappings: [
        {
          mapping_id: "map_application",
          scope_record_id: applicationScopeId,
          provider_key: "tcgdex",
          unit_key: unitKey,
          product_line_id: null,
          series_id: null,
          set_id: null,
          set_name: String(normalized.expansionName ?? normalized.setName),
          language_coordinates: null,
          confidence: "exact",
          review_status: "accepted",
          provenance: {},
          evidence: {},
          last_actor: null,
          last_reason: null,
          policy_version: "synthetic",
          proposed_at: now,
          reviewed_at: now,
          updated_at: now,
        } as unknown as ProviderScopeMappingRow,
      ],
      providerUnitKeyByObservationId: Object.fromEntries(rows.map((row) => [row.observation_id, unitKey])),
    });
    expect(batch.exclusions).toEqual([]);
    expect(batch.candidates).toHaveLength(1);
    const candidate = batch.candidates[0]!;
    await candidateWriter(pool, store).create(candidate.candidateId, change(candidate.snapshot));
    return candidate.candidateId;
  }

  async function submit() {
    return services.sourceObservations.enqueueCatalogMergeCandidateBulkJob({
      kind: "merge-candidate-promote",
      scopeRecordId: applicationScopeId,
      context,
    });
  }

  async function completionFacts() {
    const candidates = await pool.query<{ candidate_id: string }>(
      "SELECT candidate_id FROM catalog_merge_candidates WHERE scope_record_id = $1 ORDER BY candidate_id",
      [applicationScopeId],
    );
    await candidateWriter(pool, store).reproject(candidates.rows.map((row) => row.candidate_id));
    const batchId = "batch_application_completion";
    const batches = createScopeSyncBatchStore(pool);
    if (!(await batches.get(batchId, context))) {
      await batches.create({
        batchId,
        preview: {
          selection: { mode: "ids", scopeRecordIds: [applicationScopeId] },
          budget: defaultScopeSyncBatchBudget,
          planFingerprint: "fp_application_completion",
        } as never,
        plans: [],
        context,
      });
    }
    const at = new Date().toISOString();
    return queryProductionCatalogCompletionFacts(pool, {
      batchId,
      observedAt: at,
      frozenManifest: {
        manifestVersion: "production-catalog-completion-manifest-v1",
        frozenAt: at,
        launchCutoff: at,
        batch: { batchId, planFingerprint: "fp_application_completion", status: "completed" },
        providerUnits: [],
        scopes: [{ scopeRecordId: applicationScopeId, eligible: true, acceptedMappings: [] }],
        expectedUnits: [],
        observedUnits: [],
        mergeCandidates: [],
        promotions: { create: 0, update: 0, ignore: 0, defer: 0 },
        catalogItems: { draft: 0, published: 0 },
        sourceObservations: { total: 0, observed: 0, changed: 0, promoted: 0, rejected: 0, terminalJobFailures: 0 },
        assetProcessing: { approvedFailures: 0, exclusions: 0 },
        providerUsage: [],
        exclusions: [],
      },
    });
  }

  // The same composition as production, with a worker that dies right after
  // (or, for d, right before) one durable effect: its claim is released, so the
  // next worker resumes the unit from durable state.
  function runtimeWith(
    input: Readonly<{
      crash?: CrashPoint;
      rollout?: Parameters<typeof createCatalogIntegrationRolloutControlPolicyFromEnv>[0];
    }>,
  ): Runtime {
    const has = (append: { events: readonly { eventType: string }[] }, eventType: string) =>
      append.events.some((event) => event.eventType === eventType);
    const eventStore = {
      ...store,
      async appendToStream(append: Parameters<typeof store.appendToStream>[0]) {
        if (input.crash === "d" && has(append, "catalog.merge-candidate.promotion-applied")) throw lostLease();
        const appended = await store.appendToStream(append);
        if (
          (input.crash === "a" && has(append, "catalog.merge-candidate.promoted")) ||
          (input.crash === "b" && has(append, "catalog.merge-candidate.promotion-planned")) ||
          (input.crash === "e" && has(append, "catalog.merge-candidate.promotion-applied"))
        )
          throw lostLease();
        return appended;
      },
    } as typeof store;
    const exclusion = createPostgresPromotionTargetExclusion({ pool, eventStore: store });
    const promotionTargetExclusion: PromotionTargetExclusion = {
      async acquire(request) {
        const session = await exclusion.acquire(request);
        let committed = 0;
        return {
          ...session,
          async commandHandler(command) {
            const result = await session.commandHandler(command);
            committed += 1;
            if (input.crash === "c" && committed === 1) throw lostLease();
            return result;
          },
        };
      },
    };
    const deps = {
      db: pool,
      eventStore,
      checkpointStore: createPostgresProjectionStore({ db: pool }),
      promotionTargetExclusion,
    } as CatalogRuntimeDeps;
    return createSourceObservationRuntime(
      deps,
      services.items,
      services.referenceData,
      services.providerIntegrationProfiles,
      createCatalogIntegrationRolloutControlPolicyFromEnv(input.rollout ?? {}),
    );
  }

  async function readItem(catalogItemId: string) {
    const history = await readCompleteStream(store, { streamId: `catalog.item-${catalogItemId}` });
    const codec = createPassthroughDomainEventCodec<CatalogItemEvent>();
    return { history, state: history.map(codec.decode).reduce(evolveCatalogItem, initialCatalogItemState) };
  }

  async function itemCreations(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM event_store_events WHERE event_type = 'catalog.catalog-item.created'",
    );
    return Number(result.rows[0]!.count);
  }

  async function candidateEvents(candidateId: string) {
    const events = await readCompleteStream(store, { streamId: catalogMergeCandidateStreamId(candidateId) });
    const count = (eventType: string) => events.filter((event) => event.eventType === eventType).length;
    return {
      length: events.length,
      approved: count("catalog.merge-candidate.promoted"),
      planned: count("catalog.merge-candidate.promotion-planned"),
      applied: count("catalog.merge-candidate.promotion-applied"),
      payloadOf: (eventType: string) => events.find((event) => event.eventType === eventType)?.payload,
    };
  }

  async function promotionProfile(observationId: string) {
    const detail = (await getSourceObservationDetail(pool, observationId))!;
    return requireCatalogPromotionProfileVersion(
      services.providerIntegrationProfiles,
      detail.provider_key,
      requireCatalogItemPromotionObservation(detail.normalized, detail.provider_key),
    );
  }

  type Mode = "create" | "refresh" | "link-existing";
  // create: a fresh identity. refresh: the candidate was reviewed as a create,
  // then its member was promoted by Source Observation promotion before the job
  // ran (create intent becomes refresh). link-existing: a reviewed link to the
  // member's existing item.
  async function arrange(mode: Mode, id: string, localId: string) {
    await record(id, localId);
    if (mode === "create") {
      const candidateId = await candidateFrom([id]);
      return { candidateId, expectedTarget: catalogMergeCandidateTargetId(candidateId), creationsBefore: 0 };
    }
    const reviewedAsCreate = mode === "refresh" ? await candidateFrom([id]) : null;
    const promoted = await services.sourceObservations.promoteObservation({ observationId: id, context });
    await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
    const expectedTarget = sourceObservationTargetId(id);
    expect(promoted.catalogItemId).toBe(expectedTarget);
    const candidateId =
      reviewedAsCreate ??
      (await candidateFrom([id], (snapshot) => ({ ...snapshot, promotionIntent: "link-existing-catalog-item" })));
    return { candidateId, expectedTarget, creationsBefore: 1 };
  }

  describe.each(["create", "refresh", "link-existing"] as const)("AC1/AC2 %s application", (mode) => {
    it.each(crashPoints)(
      "survives interruption at %s with one completion and the same applied id and mode",
      async (point) => {
        const observationId = `obs_${mode}_${point}`;
        const { candidateId, expectedTarget, creationsBefore } = await arrange(
          mode,
          observationId,
          `9${crashPoints.indexOf(point)}`,
        );
        const targetBefore = mode === "create" ? null : (await readItem(expectedTarget)).state;
        await completionFacts();
        const job = await submit();

        await expect(processOne(runtimeWith({ crash: point }))).resolves.toBe(0);
        const interrupted = await candidateEvents(candidateId);
        const itemLengthAtCrash = (await readItem(expectedTarget)).history.length;
        expect(interrupted.applied).toBe(point === "e" ? 1 : 0);
        const incompleteReport = await completionFacts();
        expect(incompleteReport.manifest.promotions).toEqual({ create: 0, update: 0, ignore: 0, defer: 0 });
        expect(incompleteReport.unknownFacts).toContain(`merge-candidate-application:${candidateId}`);

        await drainWorker(services.sourceObservations);
        const completed = await requireJob(services.sourceObservations, job.jobId);
        expect(completed).toMatchObject({ status: "completed", promotionApplicationVersion: 1 });
        expect(completed.result).toMatchObject({ requested: 1, promoted: 1, failed: 0 });
        expect(completed.result?.outcomes[0]).toMatchObject({
          candidateId,
          status: "promoted",
          appliedCatalogItemId: expectedTarget,
          appliedMode: mode,
        });
        const appliedReport = await completionFacts();
        expect(appliedReport.manifest.promotions).toEqual({
          create: mode === "create" ? 1 : 0,
          update: mode === "create" ? 0 : 1,
          ignore: 0,
          defer: 0,
        });
        expect(appliedReport.unknownFacts).toEqual([]);
        const after = await candidateEvents(candidateId);
        expect(after).toMatchObject({ approved: 1, planned: 1, applied: 1 });
        if (point === "e") {
          // The completion was already durable: recovery appends nothing anywhere.
          expect(after.length).toBe(interrupted.length);
          expect((await readItem(expectedTarget)).history.length).toBe(itemLengthAtCrash);
        }

        const { state } = await readItem(expectedTarget);
        const mapping = await loadCatalogItemPromotionProfile(
          {
            db: pool,
            eventStore: store,
            checkpointStore: createPostgresProjectionStore({ db: pool }),
          } as CatalogRuntimeDeps,
          (await promotionProfile(observationId)).profile,
        );
        expect(await itemCreations()).toBe(mode === "create" ? 1 : creationsBefore);
        expect(state.status).toBe(mode === "create" ? "draft" : targetBefore!.status);
        expect(state.blueprintId).toBe(mapping.blueprintId);
        expect(state.externalCatalogItemReferences).toEqual(
          expect.arrayContaining([expect.objectContaining({ externalKey: `product:synthetic-${observationId}` })]),
        );

        const later = await submit();
        await drainWorker(services.sourceObservations);
        expect((await requireJob(services.sourceObservations, later.jobId)).result).toMatchObject({
          requested: 1,
          promoted: 0,
          skippedNotEligible: 1,
        });
        expect(await itemCreations()).toBe(mode === "create" ? 1 : creationsBefore);
        expect((await candidateEvents(candidateId)).applied).toBe(1);
        expect((await completionFacts()).manifest.promotions).toEqual(appliedReport.manifest.promotions);
      },
    );
  });

  it("AC2: a competing job finishes another job's bound plan once; the initiator recovers the same result", async () => {
    const { candidateId, expectedTarget } = await arrange("create", "obs_competing", "81");
    const first = await submit();
    await expect(processOne(runtimeWith({ crash: "c" }))).resolves.toBe(0);
    // The first job's worker is only slow: its unit stays claimed.
    await pool.query(
      `UPDATE catalog_source_observation_bulk_review_work_units
       SET state = 'running', claim_owner_id = 'slow-worker', claim_token = 'slow-claim',
           claimed_until = now() + interval '1 hour'
       WHERE job_id = $1`,
      [first.jobId],
    );
    const second = await submit();
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const processed = await services.sourceObservations.processNextBulkReviewJob({
        claimOwnerId: "competing-worker",
        claimTtlMs: 120_000,
        workflowMaxActiveClaims: 2,
      });
      if (processed === 0) break;
    }
    const competing = await requireJob(services.sourceObservations, second.jobId);
    expect(competing.result?.outcomes[0]).toMatchObject({
      status: "promoted",
      appliedCatalogItemId: expectedTarget,
      appliedMode: "create",
    });
    expect((await candidateEvents(candidateId)).payloadOf("catalog.merge-candidate.promotion-applied")).toMatchObject({
      jobId: first.jobId,
      unitId: candidateId,
    });

    await abandonUnitClaims(pool, first.jobId, [candidateId]);
    const lengthBefore = (await candidateEvents(candidateId)).length;
    await drainWorker(services.sourceObservations);
    const initiator = await requireJob(services.sourceObservations, first.jobId);
    expect(initiator.result?.outcomes[0]).toEqual(competing.result?.outcomes[0]);
    expect((await candidateEvents(candidateId)).length).toBe(lengthBefore);
    expect(await itemCreations()).toBe(1);
    expect(reconcileCatalogMergeCandidateApplications([initiator, competing]).applied.size).toBe(1);
  });

  it("AC3: a profile activation between interruption and resume completes the pinned plan, even with a lagging read model", async () => {
    const { candidateId, expectedTarget } = await arrange("create", "obs_pinned", "82");
    const pinned = await promotionProfile("obs_pinned");
    const job = await submit();
    await expect(processOne(runtimeWith({ crash: "c" }))).resolves.toBe(0);
    const planned = (await candidateEvents(candidateId)).payloadOf("catalog.merge-candidate.promotion-planned") as {
      plan: { profiles: unknown; planFingerprint: string };
    };

    const profiles = createCatalogProviderIntegrationProfileVersionStore(pool);
    const next = "synthetic-activated-b";
    await profiles.upsertProfileVersion({
      ...pinned,
      profileVersion: next,
      lifecycle: "draft",
      active: false,
      executableMappingContract: {
        ...requireSourceObservationMappingContract(pinned),
        profileVersion: next,
        lifecycle: "draft",
      },
    });
    await profiles.activateProfileVersion(pinned.providerKey, next, { profileKey: pinned.profileKey });
    // Projections never authorize replay writes: drop the target's read model row.
    await pool.query("DELETE FROM catalog_items WHERE catalog_item_id = $1", [expectedTarget]);

    await drainWorker(services.sourceObservations);
    expect((await requireJob(services.sourceObservations, job.jobId)).result?.outcomes[0]).toMatchObject({
      status: "promoted",
      appliedCatalogItemId: expectedTarget,
      appliedMode: "create",
      planFingerprint: planned.plan.planFingerprint,
    });
    expect(planned.plan.profiles).toEqual([
      { providerKey: pinned.providerKey, profileKey: pinned.profileKey, profileVersion: pinned.profileVersion },
    ]);
    expect(await candidateEvents(candidateId)).toMatchObject({ planned: 1, applied: 1 });
    expect(await itemCreations()).toBe(1);
  });

  it("AC3: unrelated history after the bound baseline refuses without overwriting or completing", async () => {
    const { candidateId, expectedTarget } = await arrange("refresh", "obs_unrelated", "83");
    const job = await submit();
    await expect(processOne(runtimeWith({ crash: "b" }))).resolves.toBe(0);
    await services.items.commandHandler({
      streamId: `catalog.item-${expectedTarget}`,
      command: {
        type: "ReviseCatalogItemMetadata",
        languageCode: "en",
        title: { defaultLocale: "en", values: { en: "Operator edit" } },
        subtitle: { defaultLocale: "en", values: { en: "" } },
        description: { defaultLocale: "en", values: { en: "" } },
      },
      context,
    });
    const before = (await readItem(expectedTarget)).history.length;
    await drainWorker(services.sourceObservations);
    const refused = (await requireJob(services.sourceObservations, job.jobId)).result?.outcomes[0];
    expect(refused).toMatchObject({ status: "failed", appliedCatalogItemId: null });
    expect(refused?.reason).toMatch(/^promotion-application-target-history-conflict/);
    expect((await readItem(expectedTarget)).history.length).toBe(before);
    expect(await candidateEvents(candidateId)).toMatchObject({ planned: 1, applied: 0 });
  });

  it("AC3: revoking the pinned profile between interruption and resume refuses and keeps the checkpoint", async () => {
    const revoked = await arrange("create", "obs_revoked", "84");
    const pinned = await promotionProfile("obs_revoked");
    const revokedJob = await submit();
    await expect(processOne(runtimeWith({ crash: "b" }))).resolves.toBe(0);
    await createCatalogProviderIntegrationProfileVersionStore(pool).deprecateProfileVersion(
      pinned.providerKey,
      pinned.profileVersion,
      { profileKey: pinned.profileKey },
    );
    await drainWorker(services.sourceObservations);
    const outcome = (await requireJob(services.sourceObservations, revokedJob.jobId)).result?.outcomes.find(
      (entry) => entry.candidateId === revoked.candidateId,
    );
    expect(outcome?.reason).toMatch(/^promotion-application-profile-revoked/);
    expect((await readItem(revoked.expectedTarget)).history).toEqual([]);
    expect(await candidateEvents(revoked.candidateId)).toMatchObject({ planned: 1, applied: 0 });
  });

  // Retained checkpoints count only as the decider admits them. Each poison is
  // appended raw to the real candidate stream for the running job's own unit, so
  // a reader that trusted it would report that unit applied without any Catalog Item write.
  const poisons = ["poisoned-plan", "repeated-completion", "wrong-candidate", "reordered"] as const;
  it.each(poisons)("AC3: retained %s checkpoint history refuses visibly with no writes", async (poison) => {
    const observationId = `obs_${poison.replaceAll("-", "_")}`;
    const { candidateId, expectedTarget } = await arrange("create", observationId, `7${poisons.indexOf(poison)}`);
    await services.sourceObservations.promoteCatalogMergeCandidate({ candidateId, reason: "Approved.", context });
    const job = await submit();
    const streamId = catalogMergeCandidateStreamId(candidateId);
    const approvedHistory = await readCompleteStream(store, { streamId });
    const approvalVersion = approvedHistory.find(
      (event) => event.eventType === "catalog.merge-candidate.promoted",
    )!.streamVersion;
    const { snapshot } = await candidateWriter(pool, store).load(candidateId);
    const plan: JsonObject = {
      approvalVersion,
      jobId: job.jobId,
      unitId: candidateId,
      catalogItemId: expectedTarget,
      mode: "create",
      targetBaseline: { streamVersion: 0, status: null },
      identityFingerprint: snapshot!.identityFingerprint,
      membership: snapshot!.membership,
      profiles: [{ providerKey: "tcgdex", profileKey: "pokemon-tcg", profileVersion: "synthetic" }],
      catalogMapping: {},
      referenceRecordIds: {},
      assetPlan: null,
      commands: [{ type: "CreateCatalogItem", itemId: expectedTarget }],
      planFingerprint: `sha256:${"a".repeat(64)}`,
    };
    const at = new Date().toISOString();
    const planned = (retained: JsonObject, owner = candidateId) => ({
      eventType: "catalog.merge-candidate.promotion-planned",
      payload: { candidateId: owner, plan: retained, plannedAt: at },
    });
    const applied = (retained: JsonObject, owner = candidateId) => ({
      eventType: "catalog.merge-candidate.promotion-applied",
      payload: {
        candidateId: owner,
        approvalVersion,
        catalogItemId: expectedTarget,
        appliedMode: "create",
        planFingerprint: retained.planFingerprint!,
        jobId: job.jobId,
        unitId: candidateId,
        appliedAt: at,
      },
    });
    const poisoned = { ...plan, commands: [], planFingerprint: "synthetic-invalid-fingerprint" };
    const events = {
      "poisoned-plan": [planned(poisoned), applied(poisoned)],
      "repeated-completion": [planned(plan), applied(plan), applied(plan)],
      "wrong-candidate": [planned(plan, "cand_synthetic_other"), applied(plan, "cand_synthetic_other")],
      reordered: [applied(plan), planned(plan)],
    }[poison];
    await store.appendToStream({ streamId, expectedVersion: approvedHistory.length, events, context });

    await drainWorker(services.sourceObservations);
    const outcome = (await requireJob(services.sourceObservations, job.jobId)).result?.outcomes[0];
    expect(outcome).toMatchObject({ candidateId, status: "failed", appliedCatalogItemId: null });
    expect(outcome?.reason).toMatch(/^promotion-application-conflicting-history/);
    expect((await candidateEvents(candidateId)).length).toBe(approvedHistory.length + events.length);
    expect((await readItem(expectedTarget)).history).toEqual([]);
    expect(await itemCreations()).toBe(0);
  });

  it("AC3: a completion repeated after a real application refuses later units without new writes", async () => {
    const { candidateId, expectedTarget } = await arrange("create", "obs_repeated", "79");
    const first = await submit();
    await drainWorker(services.sourceObservations);
    const initiated = (await requireJob(services.sourceObservations, first.jobId)).result?.outcomes[0];
    expect(initiated).toMatchObject({ status: "promoted", appliedCatalogItemId: expectedTarget });
    const streamId = catalogMergeCandidateStreamId(candidateId);
    const history = await readCompleteStream(store, { streamId });
    const completion = history.find((event) => event.eventType === "catalog.merge-candidate.promotion-applied")!;
    await store.appendToStream({
      streamId,
      expectedVersion: history.length,
      events: [{ eventType: completion.eventType, payload: completion.payload }],
      context,
    });
    const itemLength = (await readItem(expectedTarget)).history.length;

    const later = await submit();
    await drainWorker(services.sourceObservations);
    const outcome = (await requireJob(services.sourceObservations, later.jobId)).result?.outcomes[0];
    expect(outcome).toMatchObject({ candidateId, status: "failed", appliedCatalogItemId: null });
    expect(outcome?.reason).toMatch(/^promotion-application-conflicting-history/);
    expect((await candidateEvents(candidateId)).length).toBe(history.length + 1);
    expect((await readItem(expectedTarget)).history.length).toBe(itemLength);
    expect(await itemCreations()).toBe(1);
    expect((await requireJob(services.sourceObservations, first.jobId)).result?.outcomes[0]).toEqual(initiated);
  });

  it("AC4: retained member targets are reused under lag; partial targets, degraded display and revoked units refuse without item writes", async () => {
    // A complete retained cat_source_ item with a lagging read model is refreshed; no cat_candidate_ is minted.
    const retained = await arrange("refresh", "obs_retained", "85");
    await pool.query("DELETE FROM catalog_items WHERE catalog_item_id = $1", [retained.expectedTarget]);
    // A partial Source Observation prefix: the deterministic item exists, but its member never recorded completion.
    await record("obs_partial", "86");
    const partialCandidate = await candidateFrom(["obs_partial"]);
    const partialTarget = sourceObservationTargetId("obs_partial");
    await services.items.commandHandler({
      streamId: `catalog.item-${partialTarget}`,
      command: {
        type: "CreateCatalogItem",
        itemId: partialTarget as CatalogItemId,
        languageCode: "en",
        title: { defaultLocale: "en", values: { en: "Partial" } },
        subtitle: { defaultLocale: "en", values: { en: "" } },
        description: { defaultLocale: "en", values: { en: "" } },
      },
      context,
    });
    // A reviewed snapshot without the collector number leaves an unresolvable display identity.
    await record("obs_degraded", "87");
    const degradedCandidate = await candidateFrom(["obs_degraded"], (snapshot) => ({
      ...snapshot,
      proposedCatalogItemFacts: { ...snapshot.proposedCatalogItemFacts, collectorNumber: null },
    }));
    const creationsBefore = await itemCreations();

    const job = await submit();
    await drainWorker(services.sourceObservations);
    const outcomes = new Map(
      (await requireJob(services.sourceObservations, job.jobId)).result!.outcomes.map((outcome) => [
        outcome.candidateId,
        outcome,
      ]),
    );
    expect(outcomes.get(retained.candidateId)).toMatchObject({
      status: "promoted",
      appliedCatalogItemId: retained.expectedTarget,
      appliedMode: "refresh",
    });
    expect(outcomes.get(partialCandidate)?.reason).toMatch(/^promotion-application-partial-target/);
    expect(outcomes.get(degradedCandidate)?.reason).toMatch(/^promotion-plan-blocked:display-identity-unresolvable/);
    expect(await itemCreations()).toBe(creationsBefore);
    expect((await readItem(catalogMergeCandidateTargetId(retained.candidateId))).history).toEqual([]);
    expect((await readItem(catalogMergeCandidateTargetId(partialCandidate))).history).toEqual([]);
    expect((await readItem(partialTarget)).history).toHaveLength(1);
    for (const candidateId of [partialCandidate, degradedCandidate]) {
      expect(await candidateEvents(candidateId)).toMatchObject({ approved: 0, planned: 0, applied: 0 });
    }

    await record("obs_denied", "88");
    const deniedCandidate = await candidateFrom(["obs_denied"]);
    const denied = await submit();
    await drainWorker(runtimeWith({ rollout: { CATALOG_INTEGRATION_PROMOTION_DISABLED: "tcgdex" } }));
    const deniedOutcome = (await requireJob(services.sourceObservations, denied.jobId)).result!.outcomes.find(
      (outcome) => outcome.candidateId === deniedCandidate,
    );
    expect(deniedOutcome).toMatchObject({ status: "failed", appliedCatalogItemId: null });
    expect(await candidateEvents(deniedCandidate)).toMatchObject({ approved: 0, planned: 0 });
    expect(await itemCreations()).toBe(creationsBefore);
  });

  it("AC5: legacy bytes stay unchanged, legacy approvals catch up once, malformed version-1 jobs fail closed, asset failures are classified", async () => {
    await completionFacts();
    const legacyJobs = createPostgresDurableJobStore<
      { scopeRecordId: string; reason: string },
      ReturnType<typeof queuedProgress>,
      unknown,
      unknown
    >(pool, bulkReviewJobTables);
    const { candidateId, expectedTarget } = await arrange("create", "obs_legacy", "89");
    // Approved by single-candidate promotion (approval only) and reported by a retained #9219 job.
    await services.sourceObservations.promoteCatalogMergeCandidate({
      candidateId,
      reason: "Approved earlier.",
      context,
    });
    await legacyJobs.enqueue({
      jobId: "job_legacy_retained",
      jobKind: "merge-candidate-promote",
      payload: { scopeRecordId: applicationScopeId, reason: "Legacy." },
      progress: queuedProgress(),
      eventContext: context,
    });
    await pool.query(
      `UPDATE catalog_source_observation_bulk_review_jobs
       SET status = 'completed', completed_at = now() - interval '1 day', result = $2::jsonb
       WHERE job_id = $1`,
      [
        "job_legacy_retained",
        JSON.stringify({
          requested: 1,
          promoted: 1,
          deferred: 0,
          skippedNotEligible: 0,
          failed: 0,
          outcomes: [{ candidateId, status: "promoted", catalogItemId: null, reason: null }],
        }),
      ],
    );
    const legacyBytes = async () =>
      (
        await pool.query<{ payload: string; result: string }>(
          "SELECT payload::text AS payload, result::text AS result FROM catalog_source_observation_bulk_review_jobs WHERE job_id = $1",
          ["job_legacy_retained"],
        )
      ).rows[0];
    const bytesBefore = await legacyBytes();
    const legacy = await requireJob(services.sourceObservations, "job_legacy_retained");
    expect(legacy).toMatchObject({ kind: "merge-candidate-promote", promotionApplicationVersion: null });
    expect(reconcileCatalogMergeCandidateApplications([legacy]).approvalOnly).toEqual(new Set([candidateId]));
    const approvalReport = await completionFacts();
    expect(approvalReport.manifest.promotions.create).toBe(0);
    expect(approvalReport.unknownFacts).toContain(`merge-candidate-application:${candidateId}`);

    const catchUp = await submit();
    await drainWorker(services.sourceObservations);
    const caughtUp = await requireJob(services.sourceObservations, catchUp.jobId);
    expect(caughtUp.result?.outcomes[0]).toMatchObject({
      candidateId,
      status: "promoted",
      appliedCatalogItemId: expectedTarget,
      appliedMode: "create",
    });
    // Catch-up of an approval recorded outside any job is attributed to the applying unit.
    expect((await candidateEvents(candidateId)).payloadOf("catalog.merge-candidate.promotion-planned")).toMatchObject({
      plan: { jobId: catchUp.jobId, unitId: candidateId },
    });
    expect(await candidateEvents(candidateId)).toMatchObject({ approved: 1, planned: 1, applied: 1 });
    expect(await legacyBytes()).toEqual(bytesBefore);
    const mixed = reconcileCatalogMergeCandidateApplications([legacy, caughtUp]);
    expect([...mixed.applied.keys()]).toEqual([candidateId]);
    expect(mixed.approvalOnly.size).toBe(0);
    expect((await completionFacts()).manifest.promotions.create).toBe(1);
    const again = await submit();
    await drainWorker(services.sourceObservations);
    expect((await requireJob(services.sourceObservations, again.jobId)).result).toMatchObject({ promoted: 0 });
    expect(await itemCreations()).toBe(1);

    expect((await completionFacts()).manifest.promotions.create).toBe(1);

    const recordedResult = (
      await pool.query<{ result: string }>(
        "SELECT result::text AS result FROM catalog_source_observation_bulk_review_jobs WHERE job_id = $1",
        [catchUp.jobId],
      )
    ).rows[0]!.result;
    await pool.query(
      `UPDATE catalog_source_observation_bulk_review_jobs
       SET result = jsonb_set(result, '{outcomes,0}', (result->'outcomes'->0) - 'appliedCatalogItemId')
       WHERE job_id = $1`,
      [catchUp.jobId],
    );
    await expect(services.sourceObservations.getCatalogMergeCandidateBulkJob(catchUp.jobId, context)).rejects.toThrow(
      CatalogMergeCandidateBulkJobMalformedError,
    );
    await expect(completionFacts()).rejects.toThrow(CatalogMergeCandidateBulkJobMalformedError);
    await expect(
      services.sourceObservations.listCompletedCatalogMergeCandidateBulkJobs({
        context,
        scopeRecordId: applicationScopeId,
      }),
    ).rejects.toThrow(CatalogMergeCandidateBulkJobMalformedError);
    // An unknown or missing outcome status is malformed even when the stored counts agree with it.
    const recorded = JSON.parse(recordedResult) as NonNullable<CatalogMergeCandidateBulkJob["result"]>;
    for (const status of ["unrecognized-synthetic-status", undefined]) {
      const outcome = {
        ...recorded.outcomes[0]!,
        status,
        appliedCatalogItemId: null,
        appliedMode: null,
        approvalVersion: null,
        planFingerprint: null,
      };
      await pool.query("UPDATE catalog_source_observation_bulk_review_jobs SET result = $2::jsonb WHERE job_id = $1", [
        catchUp.jobId,
        JSON.stringify({ ...recorded, promoted: 0, outcomes: [outcome] }),
      ]);
      await expect(services.sourceObservations.getCatalogMergeCandidateBulkJob(catchUp.jobId, context)).rejects.toThrow(
        CatalogMergeCandidateBulkJobMalformedError,
      );
      await expect(
        services.sourceObservations.listCompletedCatalogMergeCandidateBulkJobs({
          context,
          scopeRecordId: applicationScopeId,
        }),
      ).rejects.toThrow(CatalogMergeCandidateBulkJobMalformedError);
    }
    await pool.query("UPDATE catalog_source_observation_bulk_review_jobs SET result = $2::jsonb WHERE job_id = $1", [
      catchUp.jobId,
      recordedResult,
    ]);

    await record("obs_asset", "90", { imageBaseUrl: "https://synthetic.invalid/images/obs_asset" });
    const assetCandidate = await candidateFrom(["obs_asset"]);
    const creations = await itemCreations();
    const assetJob = await submit();
    await drainWorker(services.sourceObservations);
    const assetOutcome = (await requireJob(services.sourceObservations, assetJob.jobId)).result!.outcomes.find(
      (outcome) => outcome.candidateId === assetCandidate,
    );
    expect(assetOutcome).toMatchObject({ status: "failed", diagnosticCode: "asset-processing-failed" });
    expect(await itemCreations()).toBe(creations);
    expect((await candidateWriter(pool, store).load(assetCandidate)).status).toBe("ready");
    const assetReport = await completionFacts();
    expect(assetReport.manifest.promotions.create).toBe(1);
    expect(assetReport.manifest.assetProcessing.approvedFailures).toBe(1);
  });

  it("AC6: a pre-application worker cannot claim a version-1 job, and a queued legacy job never reports approval as success", async () => {
    const { candidateId } = await arrange("create", "obs_version_skew", "91");
    const legacyJobs = createPostgresDurableJobStore<
      { scopeRecordId: string; reason: string },
      ReturnType<typeof queuedProgress>,
      unknown,
      unknown
    >(pool, bulkReviewJobTables);
    const legacyWorkUnits = createPostgresDurableJobWorkUnitStore<
      { scopeRecordId: string; reason: string },
      ReturnType<typeof queuedProgress>,
      unknown,
      { candidateId: string },
      unknown
    >(pool, bulkReviewJobTables, { workflowName: "catalog.source-observation-bulk-review" });
    const job = await submit();
    const stored = await pool.query<{ job_kind: string; payload: unknown }>(
      "SELECT job_kind, payload FROM catalog_source_observation_bulk_review_jobs WHERE job_id = $1",
      [job.jobId],
    );
    expect(stored.rows[0]).toMatchObject({
      job_kind: catalogMergeCandidatePromotionApplicationJobKind,
      payload: { promotionApplicationVersion: 1 },
    });
    // The #9219 worker claims only the stored kinds it knows.
    const oldClaim = await legacyWorkUnits.claimNext({
      claimOwnerId: "pre-application-worker",
      claimTtlMs: 60_000,
      workflowMaxActiveClaims: 1,
      jobMaxActiveClaims: 1,
      jobKinds: ["merge-candidate-promote", "merge-candidate-defer"],
      laneName: null,
    });
    expect(oldClaim.claim).toBeNull();
    await drainWorker(services.sourceObservations);
    expect((await requireJob(services.sourceObservations, job.jobId)).result).toMatchObject({ promoted: 1 });

    // A legacy job left queued across the cutover fails visibly instead.
    await record("obs_straggler", "92");
    const straggler = await candidateFrom(["obs_straggler"]);
    await legacyJobs.enqueue({
      jobId: "job_legacy_queued",
      jobKind: "merge-candidate-promote",
      payload: { scopeRecordId: applicationScopeId, reason: "Legacy." },
      progress: queuedProgress(),
      eventContext: context,
    });
    await legacyWorkUnits.enqueue({
      jobId: "job_legacy_queued",
      units: [{ unitId: straggler, unitKind: "merge-candidate-promote", payload: { candidateId: straggler } }],
    });
    // A pre-cutover job holds no provider-send binding, so drain it without the send gate.
    await drainWorker(runtimeWith({}));
    const legacy = await requireJob(services.sourceObservations, "job_legacy_queued");
    expect(legacy).toMatchObject({ promotionApplicationVersion: null, result: { promoted: 0, failed: 1 } });
    expect(legacy.result?.outcomes[0]?.reason).toMatch(/^promotion-application-legacy-job/);
    expect(await candidateEvents(straggler)).toMatchObject({ approved: 0, planned: 0 });
    expect(await candidateEvents(candidateId)).toMatchObject({ applied: 1 });
  });

  describe("registered Magic provider roles", () => {
    const scryfallCardPrint = registeredMagicProfile("scryfall-card-print");
    const scryfallPin = [
      {
        providerKey: "scryfall",
        profileKey: scryfallCardPrint.profileKey,
        profileVersion: scryfallCardPrint.profileVersion,
      },
    ];

    // Observations come from the registered MTGJSON and Scryfall mappers; the
    // real matcher builds each candidate in the application scope.
    async function magicCandidateFrom(observations: readonly CatalogProviderSourceObservationInput[]) {
      const rows = [];
      for (const observation of observations) {
        await services.sourceObservations.commandHandler({
          streamId: `catalog.source-observation-${observation.observationId}`,
          command: { type: "RecordSourceObservation", ...observation },
          context,
        });
        await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
        rows.push((await getSourceObservationDetail(pool, observation.observationId))!);
      }
      const candidate = magicCandidate(rows, applicationScopeId);
      await candidateWriter(pool, store).create(candidate.candidateId, candidate.snapshot);
      return candidate.candidateId;
    }

    const mixed = () => magicCandidateFrom([magicObservation("mtgjson-card"), magicObservation("scryfall-card-print")]);
    const referenceOnly = (collectorNumber: string) =>
      magicCandidateFrom([magicObservation("mtgjson-card", { collectorNumber })]);

    async function streamEvents(prefix: string): Promise<number> {
      const result = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM event_store_events WHERE stream_id LIKE $1",
        [`${prefix}%`],
      );
      return Number(result.rows[0]!.count);
    }

    async function plannedProfiles(candidateId: string) {
      const planned = (await candidateEvents(candidateId)).payloadOf("catalog.merge-candidate.promotion-planned") as
        | { plan: { profiles: unknown } }
        | undefined;
      return planned?.plan.profiles;
    }

    async function completedJobs(): Promise<readonly CatalogMergeCandidateBulkJob[]> {
      const jobs: CatalogMergeCandidateBulkJob[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const listed = await services.sourceObservations.listCompletedCatalogMergeCandidateBulkJobs({
          context,
          scopeRecordId: applicationScopeId,
          kind: "merge-candidate-promote",
          cursor,
        });
        jobs.push(...listed.items);
        cursor = listed.cursor ?? undefined;
        if (!cursor) return jobs;
      }
      throw new Error("Completed promotion jobs did not end within 20 pages.");
    }

    it.each(["b", "e"] as const)(
      "AC4: a mixed MTGJSON/Scryfall candidate interrupted at %s recovers its bound plan into one Scryfall-authored Item; a second submit is zero",
      async (point) => {
        const candidateId = await mixed();
        const target = catalogMergeCandidateTargetId(candidateId);
        const job = await submit();

        const processResult = await processOne(runtimeWith({ crash: point }));
        expect(processResult).toBe(0);
        expect(await candidateEvents(candidateId)).toMatchObject({
          approved: 1,
          planned: 1,
          applied: point === "e" ? 1 : 0,
        });

        await drainWorker(services.sourceObservations);
        const completed = await requireJob(services.sourceObservations, job.jobId);
        const outcome = completed.result?.outcomes[0];
        console.info(
          JSON.stringify({
            candidateId: outcome?.candidateId ?? null,
            status: outcome?.status ?? null,
            reason: outcome?.reason ?? null,
            diagnosticCode: outcome?.diagnosticCode ?? null,
            appliedCatalogItemId: outcome?.appliedCatalogItemId ?? null,
            appliedMode: outcome?.appliedMode ?? null,
          }),
        );
        expect(completed.result).toMatchObject({ requested: 1, promoted: 1, skippedNotEligible: 0, failed: 0 });
        expect(completed.result?.outcomes[0]).toMatchObject({
          candidateId,
          status: "promoted",
          appliedCatalogItemId: target,
          appliedMode: "create",
        });
        expect(await candidateEvents(candidateId)).toMatchObject({ approved: 1, planned: 1, applied: 1 });
        expect(await plannedProfiles(candidateId)).toEqual(scryfallPin);
        expect(await itemCreations()).toBe(1);

        const later = await submit();
        await drainWorker(services.sourceObservations);
        expect((await requireJob(services.sourceObservations, later.jobId)).result).toMatchObject({
          requested: 1,
          promoted: 0,
          skippedNotEligible: 1,
          failed: 0,
        });
        expect(await itemCreations()).toBe(1);
        expect((await candidateEvents(candidateId)).applied).toBe(1);
      },
    );

    it("AC4: reference-only MTGJSON candidates skip with zero approval, plan, Item or Reference Record writes, however often submitted", async () => {
      const candidateIds = [await referenceOnly(furySliver), await referenceOnly("158")];
      const writes = async () => ({
        items: await streamEvents("catalog.item-"),
        referenceRecords: await streamEvents("catalog.reference-record-"),
      });
      const before = await writes();

      for (let submission = 0; submission < 2; submission += 1) {
        const job = await submit();
        await drainWorker(services.sourceObservations);
        const completed = await requireJob(services.sourceObservations, job.jobId);
        expect(completed.result).toMatchObject({ requested: 2, promoted: 0, skippedNotEligible: 2, failed: 0 });
        for (const outcome of completed.result!.outcomes) {
          expect(outcome).toMatchObject({
            status: "skipped-not-eligible",
            disposition: "reference-only",
            appliedCatalogItemId: null,
          });
          expect(outcome).not.toHaveProperty("diagnosticCode");
        }
      }

      for (const candidateId of candidateIds) {
        expect(await candidateEvents(candidateId)).toMatchObject({ length: 1, approved: 0, planned: 0, applied: 0 });
      }
      expect(await writes()).toEqual(before);
      expect(await itemCreations()).toBe(0);
    });

    it("AC5: a job over mixed and reference-only candidates never settles from a prefix and reads back one terminal per unit from complete pages", async () => {
      const mixedId = await mixed();
      const referenceIds = [];
      for (const collectorNumber of ["158", "159", "160"]) referenceIds.push(await referenceOnly(collectorNumber));
      const independent = await pool.query<{ candidate_id: string }>(
        "SELECT candidate_id FROM catalog_merge_candidates WHERE scope_record_id = $1 ORDER BY candidate_id",
        [applicationScopeId],
      );
      const expected = independent.rows.map((row) => row.candidate_id);
      expect(new Set(expected)).toEqual(new Set([mixedId, ...referenceIds]));

      const job = await submit();
      await expect(processOne(services.sourceObservations)).resolves.toBe(1);
      const prefix = await requireJob(services.sourceObservations, job.jobId);
      expect(prefix).toMatchObject({ status: "running", completedAt: null });
      expect(prefix.progress).toMatchObject({ completed: 1, total: expected.length });
      expect((await completedJobs()).map((completed) => completed.jobId)).not.toContain(job.jobId);

      await drainWorker(services.sourceObservations);
      const completed = await requireJob(services.sourceObservations, job.jobId);
      expect(completed.status).toBe("completed");
      console.info(
        JSON.stringify(
          (completed.result?.outcomes ?? []).map((outcome) => ({
            candidateId: outcome.candidateId,
            status: outcome.status,
            reason: outcome.reason ?? null,
            diagnosticCode: outcome.diagnosticCode ?? null,
            appliedCatalogItemId: outcome.appliedCatalogItemId ?? null,
            appliedMode: outcome.appliedMode ?? null,
          })),
        ),
      );
      expect(completed.result).toMatchObject({
        requested: expected.length,
        promoted: 1,
        skippedNotEligible: referenceIds.length,
        failed: 0,
      });
      const outcomes = new Map(completed.result!.outcomes.map((outcome) => [outcome.candidateId, outcome]));
      expect(completed.result!.outcomes).toHaveLength(expected.length);
      expect([...outcomes.keys()].sort()).toEqual([...expected].sort());
      expect(outcomes.get(mixedId)).toMatchObject({
        status: "promoted",
        appliedCatalogItemId: catalogMergeCandidateTargetId(mixedId),
        appliedMode: "create",
      });
      for (const candidateId of referenceIds) {
        expect(outcomes.get(candidateId)).toMatchObject({
          status: "skipped-not-eligible",
          disposition: "reference-only",
        });
      }

      const units = await pool.query<{ unit_id: string; state: string }>(
        `SELECT unit_id, state
         FROM catalog_source_observation_bulk_review_work_units
         WHERE job_id = $1
         ORDER BY unit_id`,
        [job.jobId],
      );
      expect(units.rows).toEqual(
        expected.map((candidateId) => ({
          unit_id: candidateId,
          state: candidateId === mixedId ? "completed" : "skipped",
        })),
      );

      const readBack = (await completedJobs()).filter((listed) => listed.jobId === job.jobId);
      expect(readBack).toHaveLength(1);
      expect(readBack[0]!.result).toEqual(completed.result);
      expect(await plannedProfiles(mixedId)).toEqual(scryfallPin);
      expect(await itemCreations()).toBe(1);
    });
  });
});

function queuedProgress() {
  return { phase: "queued" as const, completed: 0, total: 1, currentName: null, status: null };
}
