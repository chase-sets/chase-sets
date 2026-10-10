import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import sharp from "sharp";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresDurableJobStore } from "@chase-sets/platform-runtime/durable-job-store";
import { module as catalogModule } from "../../../index";
import { seedCatalogDatabase } from "../../../support/authoring-support/seed";
import { createCatalogServices } from "../../../support/authoring-support/services";
import { buildCatalogItemProjectionHandlers } from "../../catalog-items/read-model/projection";
import { buildProviderScopeMappingProjectionHandlers } from "../../provider-scope-mapping/read-model/projection";
import { buildCatalogScopeRegistryProjectionHandlers } from "../../scope-registry/read-model/projection";
import { defaultScopeSyncBatchBudget, type ScopeSyncBatchPlannedScope } from "../../scope-sync-batches/domain/batch";
import { createScopeSyncBatchStore } from "../../scope-sync-batches/read-model/store";
import { upsertCatalogScopeSyncUnitState } from "../../scope-sync-state/read-model/queries";
import { pokemonObservation } from "../../source-observations/api/seeding/runtime-test-harness";
import {
  parseProductionCatalogCompletionManifest,
  productionCatalogCompletionManifestVersion,
  reconcileProductionCatalogCompletion,
  type ProductionCatalogCompletionManifest,
} from "../domain/index";
import {
  classifyProviderProductionClass,
  queryProductionCatalogCompletionFacts,
  withCatalogCompletionReadSnapshot,
} from "./query";

describe("classifyProviderProductionClass", () => {
  it("classifies active production, validation lifecycles, and retired units", () => {
    expect(classifyProviderProductionClass({ lifecycle: "active", active: true })).toBe("production");
    expect(classifyProviderProductionClass({ lifecycle: "active", active: false })).toBe("unapproved");
    expect(classifyProviderProductionClass({ lifecycle: "test", active: false })).toBe("validation-only");
    expect(classifyProviderProductionClass({ lifecycle: "draft", active: false })).toBe("validation-only");
    expect(classifyProviderProductionClass({ lifecycle: "retired", active: false })).toBe("retired");
    expect(classifyProviderProductionClass({ lifecycle: "deprecated", active: false })).toBe("unapproved");
  });
});

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["catalog"] as const;

const context: EventStoreContext = {
  tenantId: "tnt_completion" as never,
  audit: { performedByUserId: "usr_completion" as never, forAccountId: "acc_completion" as never },
};

// SYNTHETIC provider coordinates; unit keys are opaque to the report.
const tcgdexUnit = { providerKey: "tcgdex", unitKey: "tcgdex:pokemon-card:en" } as const;
const scrydexUnit = { providerKey: "scrydex", unitKey: "scrydex:pokemon-card:en" } as const;

describeDb("Production Catalog completion facts from the database (db)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let db: PgTransactionalPool;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "catalog_completion_report",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
    db = pools.catalog;
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("AC1: reports the hand-built manifest's blockers for state written by Catalog projectors, by canonical scope id", async () => {
    await projectScope(db, "scope_alpha");
    await projectScope(db, "scope_beta");
    await projectMapping(db, "map_alpha_tcgdex", "scope_alpha", tcgdexUnit);
    await projectMapping(db, "map_beta_tcgdex", "scope_beta", tcgdexUnit);
    await projectItem(db, "cat_published", { publish: true, assets: true });
    await projectItem(db, "cat_draft", {});

    const batch = await createBatch(db, "batch_ac1", [
      plan("scope_alpha", [tcgdexUnit]),
      plan("scope_beta", [tcgdexUnit, scrydexUnit]),
    ]);
    const jobs = integrationJobs(db);
    await batch.runUnit("scope_alpha", "run_alpha", async () => {
      await jobs.run("run_alpha", "catalog-sync-scope", { action: "catalog-sync-scope" }, { completed: true });
      await jobs.run(
        "job_alpha_import",
        "import",
        { action: "import", scope: { provider: "tcgdex" }, syncRunId: "run_alpha" },
        { completed: true, outcomes: [importOutcome("tcgdex", "not-supported")] },
      );
      await recordSyncState(db, "scope_alpha", tcgdexUnit, "completed", "run_alpha", "job_alpha_import");
    });
    await batch.runUnit("scope_beta", "run_beta", async () => {
      await jobs.run("run_beta", "catalog-sync-scope", { action: "catalog-sync-scope" }, { completed: true });
      await jobs.run(
        "job_beta_import",
        "import",
        { action: "import", scope: { provider: "tcgdex" }, syncRunId: "run_beta" },
        { completed: false },
      );
      await recordSyncState(db, "scope_beta", tcgdexUnit, "failed", "run_beta", "job_beta_import");
    });

    const facts = await queryProductionCatalogCompletionFacts(db, {
      batchId: "batch_ac1",
      observedAt: new Date().toISOString(),
    });
    expect(facts.completionProof).toBe(false);
    expect(facts.unknownFacts).toEqual([]);
    expect(() => parseProductionCatalogCompletionManifest(facts.manifest)).not.toThrow();
    expect(facts.manifest.observedUnits.map((unit) => [unit.scopeRecordId, unit.state])).toEqual([
      ["scope_alpha", "settled"],
      ["scope_beta", "failed"],
    ]);
    expect(facts.manifest.catalogItems).toEqual({ draft: 1, published: 1 });
    expect(facts.manifest.sourceObservations.terminalJobFailures).toBe(1);
    expect(facts.manifest.providerUsage).toEqual([
      {
        providerKey: "tcgdex",
        credited: false,
        estimatedRequestCount: 3,
        actualRequestCount: 3,
        pageCount: null,
        cacheHitCount: null,
        cacheMissCount: null,
        usageCheckState: "degraded",
      },
    ]);

    const handBuilt: ProductionCatalogCompletionManifest = {
      ...facts.manifest,
      providerUnits: [],
      scopes: [
        { scopeRecordId: "scope_alpha", eligible: true, acceptedMappings: [tcgdexUnit] },
        { scopeRecordId: "scope_beta", eligible: true, acceptedMappings: [tcgdexUnit] },
      ],
      expectedUnits: [
        { scopeRecordId: "scope_alpha", ...tcgdexUnit },
        { scopeRecordId: "scope_beta", ...tcgdexUnit },
        { scopeRecordId: "scope_beta", ...scrydexUnit },
      ],
      observedUnits: [
        observedUnit("scope_alpha", tcgdexUnit, "settled", facts.manifest.launchCutoff),
        observedUnit("scope_beta", tcgdexUnit, "failed", facts.manifest.launchCutoff),
      ],
      mergeCandidates: [],
      promotions: { create: 0, update: 0, ignore: 0, defer: 0 },
      catalogItems: { draft: 1, published: 1 },
      assetProcessing: { approvedFailures: 0, exclusions: 0 },
      exclusions: [],
    };
    const generatedAt = "2026-10-09T00:00:00.000Z";
    const fromDatabase = reconcileProductionCatalogCompletion(facts.manifest, { generatedAt });
    const fromFile = reconcileProductionCatalogCompletion(parseProductionCatalogCompletionManifest(handBuilt), {
      generatedAt,
    });
    expect(fromDatabase.blockers).toEqual(fromFile.blockers);
    expect(fromDatabase.blockers.map((blocker) => [blocker.code, blocker.scopeRecordId])).toEqual([
      ["failed-job", "scope_beta"],
      ["incomplete-coverage", null],
      ["mapping-missing", "scope_beta"],
    ]);
  });

  it("AC1b: counts an asset storage failure from a real bulk promotion job and lists an unclassified failure as unknown", async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, db);
    await seedCatalogDatabase(db, undefined, { enabledDataProfiles: ["catalog-integration-bootstrap"] });
    await projectScope(db, "scope_alpha");
    await projectMapping(db, "map_alpha_tcgdex", "scope_alpha", tcgdexUnit);
    const batch = await createBatch(db, "batch_ac1b", [plan("scope_alpha", [tcgdexUnit])]);
    await batch.runUnit("scope_alpha", "run_alpha", async () => {
      await recordSyncState(db, "scope_alpha", tcgdexUnit, "completed", "run_alpha", "job_alpha_import");
    });
    await insertObservation(db, {
      observationId: "obs_image_card",
      syncRunId: "run_alpha",
      normalized: {
        ...pokemonObservation({ expansionName: "Mega Evolution", seriesName: "Mega Evolution" }),
        imageBaseUrl: "https://assets.tcgdex.example/me01-001",
      },
    });
    await insertObservation(db, {
      observationId: "obs_unmapped_kind",
      syncRunId: "run_alpha",
      providerKey: "synthetic-unknown",
      normalized: { kind: "synthetic-unknown" },
    });

    const attemptedWrites: string[] = [];
    const runtime = createCatalogServices(db, {
      // SYNTHETIC failing asset store: every object write is refused.
      catalogAssetStorage: {
        async putObject(object) {
          attemptedWrites.push(object.key);
          throw new Error("Synthetic asset storage write refused.");
        },
      },
    }).sourceObservations;
    const image = await syntheticWebpImage();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(image, { status: 200, headers: { "content-type": "image/webp" } })) as typeof globalThis.fetch;
    try {
      await runtime.enqueueBulkReviewJob({
        action: "promote",
        observationIds: ["obs_image_card", "obs_unmapped_kind"],
        context,
      });
      for (let turn = 0; turn < 10; turn += 1) {
        const processed = await runtime.processNextBulkReviewJob({
          claimOwnerId: "completion-report-ac1b",
          claimTtlMs: 120_000,
        });
        if (processed === 0) break;
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    const units = await db.query<{ observation_id: string; result: Record<string, unknown> }>(
      `SELECT payload->>'observationId' AS observation_id, result
         FROM catalog_source_observation_bulk_review_work_units
        ORDER BY payload->>'observationId'`,
    );
    expect(units.rows.map((row) => [row.observation_id, row.result.status, row.result.diagnosticCode])).toEqual([
      ["obs_image_card", "failed", "asset-processing-failed"],
      ["obs_unmapped_kind", "failed", undefined],
    ]);
    expect(attemptedWrites.length).toBeGreaterThan(0);

    const facts = await queryProductionCatalogCompletionFacts(db, {
      batchId: "batch_ac1b",
      observedAt: new Date().toISOString(),
    });
    expect(facts.manifest.assetProcessing).toEqual({ approvedFailures: 1, exclusions: 0 });
    expect(facts.unknownFacts).toHaveLength(1);
    expect(facts.unknownFacts[0]).toMatch(/^promotion-outcome-diagnostic-code:/);
    const report = reconcileProductionCatalogCompletion(facts.manifest, { generatedAt: new Date().toISOString() });
    expect(report.blockers.filter((blocker) => blocker.code === "asset-processing-failure")).toHaveLength(1);
  });

  it("AC2: an absent credited usage-check state is unknown and still parses; with it present the same state completes", async () => {
    await seedSettledCreditedBatch(db, "batch_ac2", null);

    const missing = await queryProductionCatalogCompletionFacts(db, {
      batchId: "batch_ac2",
      observedAt: new Date().toISOString(),
    });
    expect(missing.unknownFacts).toEqual(["provider-usage-check-state:scrydex"]);
    expect(missing.manifest.providerUsage).toEqual([]);
    expect(() => parseProductionCatalogCompletionManifest(missing.manifest)).not.toThrow();

    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
    await seedSettledCreditedBatch(db, "batch_ac2", "checked");

    const present = await queryProductionCatalogCompletionFacts(db, {
      batchId: "batch_ac2",
      observedAt: new Date().toISOString(),
    });
    expect(present.unknownFacts).toEqual([]);
    expect(present.manifest.providerUsage).toEqual([
      expect.objectContaining({ providerKey: "scrydex", credited: true, usageCheckState: "available" }),
    ]);
    const report = reconcileProductionCatalogCompletion(present.manifest, { generatedAt: new Date().toISOString() });
    expect(report.blockers).toEqual([]);
    expect(report.result).toBe("complete");
  });

  it("AC3: reports exact duplicate references, legacy markers, non-terminal jobs, and publication counts", async () => {
    await projectScope(db, "scope_alpha");
    await createBatch(db, "batch_ac3", [plan("scope_alpha", [tcgdexUnit])]);
    await projectItem(db, "cat_one", {
      publish: true,
      productReference: { providerKey: "tcgplayer", externalKey: "product:100" },
      itemReference: { providerKey: "tcgplayer", externalKey: "product:200" },
    });
    await projectItem(db, "cat_two", {
      itemReference: { providerKey: "tcgplayer", externalKey: "product:100" },
    });
    await projectItem(db, "cat_three", {
      productReference: { providerKey: "tcgplayer", externalKey: "product:200" },
      archive: true,
    });
    await insertObservation(db, { observationId: "obs_clean", syncRunId: null, normalized: { kind: "synthetic" } });
    await insertObservation(db, {
      observationId: "obs_legacy_version",
      syncRunId: null,
      normalized: { kind: "synthetic" },
      sourceProfileVersion: "legacy",
    });
    await insertObservation(db, {
      observationId: "obs_blank_fingerprint",
      syncRunId: null,
      normalized: { kind: "synthetic" },
      sourceMappingFingerprint: " ",
    });
    const jobs = integrationJobs(db);
    await jobs.run("job_done", "import", { action: "import", scope: { provider: "tcgdex" } }, { completed: true });
    await jobs.store.enqueue({
      jobId: "job_queued",
      jobKind: "import",
      payload: { action: "import", scope: { provider: "tcgdex" } },
      progress: { phase: "queued" },
    });

    const facts = await queryProductionCatalogCompletionFacts(db, {
      batchId: "batch_ac3",
      observedAt: new Date().toISOString(),
    });
    expect(facts.reportedFacts).toEqual({
      externalReferenceDuplicates: 2,
      legacyProfileMarkerCount: 2,
      nonTerminalIntegrationJobCount: 1,
      publicationCountsByStatus: { active: 1, archived: 1, draft: 1 },
    });
    expect(facts.manifest.catalogItems).toEqual({ draft: 1, published: 1 });
  });

  it("AC4: refuses a write inside the report session", async () => {
    await expect(
      withCatalogCompletionReadSnapshot(db, (tx) =>
        tx.query(`INSERT INTO catalog_items (catalog_item_id) VALUES ('cat_written_by_report')`),
      ),
    ).rejects.toThrow(/read-only transaction/);
    const written = await db.query(`SELECT 1 FROM catalog_items WHERE catalog_item_id = 'cat_written_by_report'`);
    expect(written.rows).toEqual([]);
  });

  it("AC4: a frozen manifest that passed fails once the database gains a failed unit", async () => {
    await seedSettledCreditedBatch(db, "batch_ac4", "checked");
    const frozenManifest = frozenManifestFor("batch_ac4");

    const passing = await queryProductionCatalogCompletionFacts(db, {
      batchId: "batch_ac4",
      observedAt: new Date().toISOString(),
      frozenManifest,
    });
    expect(passing.completionProof).toBe(true);
    expect(passing.manifest.expectedUnits).toEqual(frozenManifest.expectedUnits);
    expect(
      reconcileProductionCatalogCompletion(passing.manifest, { generatedAt: "2026-10-09T00:00:00.000Z" }).result,
    ).toBe("complete");

    await recordSyncState(db, "scope_gamma", scrydexUnit, "failed", "run_gamma_retry", "job_gamma_retry");
    const failing = await queryProductionCatalogCompletionFacts(db, {
      batchId: "batch_ac4",
      observedAt: new Date().toISOString(),
      frozenManifest,
    });
    const report = reconcileProductionCatalogCompletion(failing.manifest, { generatedAt: "2026-10-09T00:00:00.000Z" });
    expect(report.result).toBe("incomplete");
    expect(report.blockers.map((blocker) => [blocker.code, blocker.scopeRecordId])).toContainEqual([
      "failed-job",
      "scope_gamma",
    ]);
  });

  it("F1: an unmeasured sync counter is unknown and withheld, never zero; measured counters are exact", async () => {
    const observe = () =>
      queryProductionCatalogCompletionFacts(db, { batchId: "batch_f1", observedAt: new Date().toISOString() });
    const gammaUnit = "scope_gamma/scrydex/scrydex:pokemon-card:en";

    await seedSettledCreditedBatch(db, "batch_f1", "checked", null);
    const unmeasured = await observe();
    expect(unmeasured.unknownFacts).toEqual([
      `observed-unit-counter:${gammaUnit}/changedCount`,
      `observed-unit-counter:${gammaUnit}/failedCount`,
      `observed-unit-counter:${gammaUnit}/observedCount`,
    ]);
    expect(unmeasured.manifest.observedUnits).toEqual([]);
    expect(() => parseProductionCatalogCompletionManifest(unmeasured.manifest)).not.toThrow();

    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
    await seedSettledCreditedBatch(db, "batch_f1", "checked", { observed: 5, changed: null, failed: 0 });
    const partial = await observe();
    expect(partial.unknownFacts).toEqual([`observed-unit-counter:${gammaUnit}/changedCount`]);
    expect(partial.manifest.observedUnits).toEqual([]);

    for (const counts of [
      { observed: 0, changed: 0, failed: 0 },
      { observed: 12, changed: 3, failed: 1 },
    ]) {
      await resetMultiContextTestSchemas(pools);
      await pools.catalog.query(catalogModule.schemaSql);
      await seedSettledCreditedBatch(db, "batch_f1", "checked", counts);
      const measured = await observe();
      expect(measured.unknownFacts).toEqual([]);
      expect(measured.manifest.observedUnits).toEqual([
        expect.objectContaining({
          scopeRecordId: "scope_gamma",
          state: "settled",
          observedCount: counts.observed,
          changedCount: counts.changed,
          failedCount: counts.failed,
        }),
      ]);
      const report = reconcileProductionCatalogCompletion(measured.manifest, { generatedAt: new Date().toISOString() });
      expect(report.result).toBe("complete");
    }
  });

  it("F2: a frozen manifest binds to the live batch id and plan fingerprint and reports the live batch status", async () => {
    await projectScope(db, "scope_gamma");
    await projectMapping(db, "map_gamma_scrydex", "scope_gamma", scrydexUnit);
    const batch = await createBatch(db, "batch_f2", [plan("scope_gamma", [scrydexUnit], ["scrydex"])]);
    const frozenManifest = frozenManifestFor("batch_f2");
    const observeBatch = async (manifest: ProductionCatalogCompletionManifest) =>
      (
        await queryProductionCatalogCompletionFacts(db, {
          batchId: "batch_f2",
          observedAt: new Date().toISOString(),
          frozenManifest: manifest,
        })
      ).manifest;

    const statuses: string[] = [];
    statuses.push((await observeBatch(frozenManifest)).batch.status);
    await batch.runUnit("scope_gamma", "run_gamma", async () => {
      statuses.push((await observeBatch(frozenManifest)).batch.status);
    });
    const completed = await observeBatch(frozenManifest);
    statuses.push(completed.batch.status);
    expect(statuses).toEqual(["queued", "running", "completed"]);
    expect(completed.batch).toEqual({ batchId: "batch_f2", planFingerprint: "fp_batch_f2", status: "completed" });
    expect(completed.frozenAt).toBe(frozenManifest.frozenAt);
    expect(completed.launchCutoff).toBe(frozenManifest.launchCutoff);
    expect(completed.expectedUnits).toEqual(frozenManifest.expectedUnits);

    const replanned = { ...frozenManifest, batch: { ...frozenManifest.batch, planFingerprint: "fp_other_plan" } };
    await expect(observeBatch(replanned)).rejects.toMatchObject({
      name: "ProductionCatalogCompletionFactsError",
      code: "manifest-batch-mismatch",
    });
  });
});

type ProviderUnit = Readonly<{ providerKey: string; unitKey: string }>;

function plan(scopeRecordId: string, units: readonly ProviderUnit[], credited: readonly string[] = []) {
  return {
    scopeRecordId,
    scopeRecordVersion: "2026-10-01T00:00:00.000Z",
    mappingVersions: [],
    profileVersions: units.map((unit) => ({
      ...unit,
      profileKey: `${unit.providerKey}-profile`,
      profileVersion: "v1",
    })),
    providerKeys: [...new Set(units.map((unit) => unit.providerKey))],
    providerUnitCount: units.length,
    estimatedRequestCount: null,
    creditedProviderRequestEstimates: {},
    scope: { productDomain: "pokemon", reference: { kind: "scope-record", scopeRecordId } },
    participationPreview: {
      estimate: {
        creditConsumingProviders: credited.map((providerKey) => ({
          providerKey,
          displayName: providerKey,
          unitKeys: [],
        })),
      },
    },
    blockers: [],
  } as unknown as ScopeSyncBatchPlannedScope;
}

// Writes the batch through its store and drives each unit through the store's
// own claim, running, and terminal transitions.
async function createBatch(db: PgTransactionalPool, batchId: string, plans: readonly ScopeSyncBatchPlannedScope[]) {
  const store = createScopeSyncBatchStore(db);
  await store.create({
    batchId,
    preview: {
      selection: { mode: "ids", scopeRecordIds: plans.map((entry) => entry.scopeRecordId) },
      budget: defaultScopeSyncBatchBudget,
      planFingerprint: `fp_${batchId}`,
    } as never,
    plans,
    context,
  });
  return {
    async runUnit(scopeRecordId: string, syncRunId: string, work: () => Promise<void>) {
      const claim = await store.repository.claimNext({ claimOwnerId: "completion-report-test", claimTtlMs: 60_000 });
      expect(claim?.scopeRecordId).toBe(scopeRecordId);
      await store.repository.recordRunning({ claim: claim!, syncRunId });
      await work();
      await store.repository.recordTerminal({ claim: claim!, state: "completed", errorMessage: null });
    },
  };
}

function integrationJobs(db: PgTransactionalPool) {
  const store = createPostgresDurableJobStore<
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>
  >(db, {
    jobsTable: "catalog_source_observation_integration_durable_jobs",
    eventsTable: "catalog_source_observation_integration_job_events",
    notifyChannel: "catalog_source_observation_durable_job_events",
  });
  return {
    store,
    async run(
      jobId: string,
      jobKind: string,
      payload: Record<string, unknown>,
      outcome: Readonly<{ completed: boolean; outcomes?: readonly unknown[] }>,
    ) {
      await store.enqueue({ jobId, jobKind, payload, progress: { phase: "queued" } });
      const claimed = await store.claimNext({ claimOwnerId: "completion-report-test", claimTtlMs: 60_000 });
      expect(claimed?.jobId).toBe(jobId);
      const finished = outcome.completed
        ? await store.complete({
            jobId,
            claimOwnerId: "completion-report-test",
            progress: { phase: "completed" },
            result: {
              requested: 1,
              imported: 1,
              observed: 1,
              reapplied: 0,
              skipped: 0,
              failed: 0,
              outcomes: outcome.outcomes ?? [],
            },
          })
        : await store.fail({
            jobId,
            claimOwnerId: "completion-report-test",
            progress: { phase: "failed" },
            errorMessage: "Synthetic provider import failure.",
          });
      expect(finished).toBe(true);
    },
  };
}

function importOutcome(providerKey: string, usageCheckState: string | null) {
  return {
    providerKey,
    languageCode: "en",
    expansionId: null,
    status: "imported",
    observed: 1,
    reapplied: 0,
    reason: null,
    providerUsageEvidence:
      usageCheckState === null
        ? null
        : {
            unitKey: `${providerKey}:pokemon-card:en`,
            requestStrategy: "single-record",
            estimateState: "estimated",
            estimatedRequestCount: 3,
            estimateReason: null,
            actualRequestCount: 3,
            pageCount: null,
            cacheHitCount: null,
            cacheMissCount: null,
            usageCheckState,
            creditDiagnostic: null,
            degradedDiagnostic: null,
            bulkFirstConfirmed: null,
            perRecordFallbackReason: null,
            selectedFields: [],
            pageSize: null,
          },
  };
}

// One settled scope whose only unit is a credited provider; the import job's
// usage evidence carries `usageCheckState` or omits the evidence when null.
async function seedSettledCreditedBatch(
  db: PgTransactionalPool,
  batchId: string,
  usageCheckState: string | null,
  counts: SyncCounts = measuredZeroCounts,
) {
  await projectScope(db, "scope_gamma");
  await projectMapping(db, "map_gamma_scrydex", "scope_gamma", scrydexUnit);
  const batch = await createBatch(db, batchId, [plan("scope_gamma", [scrydexUnit], ["scrydex"])]);
  const jobs = integrationJobs(db);
  await batch.runUnit("scope_gamma", "run_gamma", async () => {
    await jobs.run("run_gamma", "catalog-sync-scope", { action: "catalog-sync-scope" }, { completed: true });
    await jobs.run(
      "job_gamma_import",
      "import",
      { action: "import", scope: { provider: "scrydex" }, syncRunId: "run_gamma" },
      { completed: true, outcomes: [importOutcome("scrydex", usageCheckState)] },
    );
    await recordSyncState(db, "scope_gamma", scrydexUnit, "completed", "run_gamma", "job_gamma_import", counts);
  });
}

function frozenManifestFor(batchId: string): ProductionCatalogCompletionManifest {
  return parseProductionCatalogCompletionManifest({
    manifestVersion: productionCatalogCompletionManifestVersion,
    frozenAt: "2000-01-01T00:00:00.000Z",
    launchCutoff: "2000-01-01T00:00:00.000Z",
    batch: { batchId, planFingerprint: `fp_${batchId}`, status: "completed" },
    providerUnits: [],
    scopes: [{ scopeRecordId: "scope_gamma", eligible: true, acceptedMappings: [scrydexUnit] }],
    expectedUnits: [{ scopeRecordId: "scope_gamma", ...scrydexUnit }],
    observedUnits: [],
    mergeCandidates: [],
    promotions: { create: 0, update: 0, ignore: 0, defer: 0 },
    catalogItems: { draft: 0, published: 0 },
    sourceObservations: { total: 0, observed: 0, changed: 0, promoted: 0, rejected: 0, terminalJobFailures: 0 },
    assetProcessing: { approvedFailures: 0, exclusions: 0 },
    providerUsage: [],
    exclusions: [],
  });
}

function observedUnit(scopeRecordId: string, unit: ProviderUnit, state: "settled" | "failed", cutoff: string) {
  return {
    scopeRecordId,
    ...unit,
    state,
    lastCompletedAt: state === "settled" ? new Date(Date.parse(cutoff) + 60_000).toISOString() : null,
    syncRunId: null,
    observedCount: 0,
    changedCount: 0,
    failedCount: 0,
  };
}

// A null count is one the job result never measured; the writer persists it as NULL.
type SyncCounts = Readonly<{ observed: number | null; changed: number | null; failed: number | null }> | null;
const measuredZeroCounts = { observed: 0, changed: 0, failed: 0 } as const;

// The sync-run runtime's own writer. `scope_key` is a hashed descriptor key in
// production, so it deliberately differs from the canonical Scope Record id.
async function recordSyncState(
  db: PgQueryable,
  scopeRecordId: string,
  unit: ProviderUnit,
  status: "completed" | "failed",
  syncRunId: string,
  jobId: string,
  counts: SyncCounts = measuredZeroCounts,
) {
  const completedAt = new Date(Date.now() + 60_000).toISOString();
  await upsertCatalogScopeSyncUnitState(db, {
    scopeKey: `sha256:${scopeRecordId}`,
    ...unit,
    productDomain: "pokemon",
    productForm: null,
    languageCode: "en",
    referenceKind: "scope-record",
    scopeRecordId,
    displayName: unit.providerKey,
    role: "primary-identity",
    requirement: "required",
    childExecutionScope: {},
    status,
    syncRunId,
    jobId,
    operatorStatus: status,
    observedCount: counts?.observed ?? null,
    changedCount: counts?.changed ?? null,
    failedCount: counts?.failed ?? null,
    errorMessage: status === "failed" ? "Synthetic provider import failure." : null,
    completedAt: status === "completed" ? completedAt : null,
    updatedAt: new Date().toISOString(),
  });
}

async function projectScope(db: PgQueryable, scopeRecordId: string) {
  const handlers = buildCatalogScopeRegistryProjectionHandlers(db);
  const streamId = `catalog.reference-record-${scopeRecordId}`;
  await handlers["catalog.reference-record.created"]!(
    projectionEvent(streamId, {
      referenceRecordId: scopeRecordId,
      typeKey: "expansion",
      key: scopeRecordId,
      name: `Scope ${scopeRecordId}`,
      attributes: { "product-domain": "pokemon" },
      relationships: [],
    }),
  );
  await handlers["catalog.reference-record.published"]!(projectionEvent(streamId, {}));
}

async function projectMapping(db: PgQueryable, mappingId: string, scopeRecordId: string, unit: ProviderUnit) {
  const handlers = buildProviderScopeMappingProjectionHandlers(db);
  await handlers["catalog.provider-scope-mapping.proposed"]!(
    projectionEvent(`catalog.provider-scope-mapping-${mappingId}`, {
      mappingId,
      scopeRecordId,
      ...unit,
      coordinates: { productLineId: null, seriesId: null, setId: scopeRecordId, setName: null, language: {} },
      confidence: "exact",
      reviewStatus: "auto-accepted",
      provenance: {},
      evidence: {},
      actor: "usr_completion",
      policyVersion: "v1",
    }),
  );
}

async function projectItem(
  db: PgQueryable,
  itemId: string,
  options: Readonly<{
    publish?: boolean;
    archive?: boolean;
    assets?: boolean;
    productReference?: Readonly<{ providerKey: string; externalKey: string }>;
    itemReference?: Readonly<{ providerKey: string; externalKey: string }>;
  }>,
) {
  const handlers = buildCatalogItemProjectionHandlers(db);
  const streamId = `catalog.item-${itemId}`;
  const project = (eventType: string, data: Record<string, unknown>) =>
    handlers[eventType]!(projectionEvent(streamId, data), undefined as never);
  await project("catalog.catalog-item.created", { itemId, title: itemId, subtitle: null, description: "" });
  if (options.assets) {
    await project("catalog.catalog-item.product-asset-sets-set", {
      productAssetSets: [{ sourceProviderKey: "tcgdex", variants: [] }],
    });
  }
  if (options.productReference) {
    await project("catalog.catalog-item.external-product-reference-linked", {
      ...options.productReference,
      selectedOptions: [],
    });
  }
  if (options.itemReference) {
    await project("catalog.catalog-item.external-catalog-item-reference-linked", options.itemReference);
  }
  if (options.publish) await project("catalog.catalog-item.published", {});
  if (options.archive) await project("catalog.catalog-item.archived", {});
}

// SYNTHETIC 16x16 WebP so asset processing succeeds and the storage write is
// the step that fails.
async function syntheticWebpImage(): Promise<ArrayBuffer> {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 3, 200);
  const webp = await sharp(pixels, { raw: { width: size, height: size, channels: 3 } })
    .webp()
    .toBuffer();
  return new Uint8Array(webp).buffer;
}

function projectionEvent(streamId: string, data: Record<string, unknown>) {
  return { streamId, data, timing: { recordedAt: new Date().toISOString() } } as never;
}

async function insertObservation(
  db: PgQueryable,
  input: Readonly<{
    observationId: string;
    syncRunId: string | null;
    normalized: unknown;
    providerKey?: string;
    sourceProfileVersion?: string;
    sourceMappingFingerprint?: string;
  }>,
) {
  // SYNTHETIC rows: legacy markers can no longer be projected, so historical
  // shapes are written as the rows they left behind.
  await db.query(
    `INSERT INTO catalog_source_observations (
       observation_id, sync_run_id, provider_key, external_key, source_url, language_code, source_record_hash,
       observed_at, source_profile_key, source_profile_version, source_mapping_fingerprint, normalized, source_payload
     ) VALUES ($1, $2, $3, $1, 'https://synthetic.invalid/observation', 'en', $4,
       now(), 'pokemon-tcg', $5, $6, $7::jsonb, '{}'::jsonb)`,
    [
      input.observationId,
      input.syncRunId,
      input.providerKey ?? "tcgdex",
      `sha256:${input.observationId}`,
      input.sourceProfileVersion ?? "2026.06.03",
      input.sourceMappingFingerprint ?? "sha256:mapping",
      JSON.stringify(input.normalized),
    ],
  );
}
