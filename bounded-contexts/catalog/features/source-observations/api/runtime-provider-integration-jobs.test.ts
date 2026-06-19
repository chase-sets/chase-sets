import { describe, expect, it } from "vitest";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import { createSourceObservationRuntime } from "./runtime";
import {
  context,
  createActiveTcgplayerProfileVersions,
  createIntegrationJobClaimHandoffHarness,
  createIntegrationJobDedupeHarness,
  createMutableProfileVersionReader,
  createTcgplayerImportHarness,
  currentTcgdexProfileVersion,
  integrationJobRow,
  tcgdexProfileSnapshot,
  tcgdexProfileVersion,
} from "./runtime-test-harness";

describe("source observation runtime: provider integration jobs", () => {
  it("reuses an active provider integration job with the same actor action and scope", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: integrationJobRow({
        jobId: "job_existing",
        action: "import",
        scope: { provider: "tcgdex", language: "en" },
        profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
        eventContext: context,
      }),
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.enqueueIntegrationJob({
      action: "import",
      scope: { provider: "tcgdex", language: "en", seriesId: undefined, setId: undefined },
      context,
    });

    expect(job.jobId).toBe("job_existing");
    expect(harness.insertedJobs).toEqual([]);
    expect(harness.activeLookupValues[0]).toEqual(["import"]);
  });

  it("rejects production import jobs for inactive provider profile versions before enqueue", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(
      services.enqueueIntegrationJob({
        action: "import",
        scope: { provider: "tcgplayer", productLineId: "3", setName: "Prismatic Evolutions" },
        context,
      }),
    ).rejects.toThrow("Provider 'tcgplayer' does not support background import.");
    expect(harness.insertedJobs).toEqual([]);
  });

  it("does not reuse active provider integration jobs from a different account context", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: integrationJobRow({
        jobId: "job_other_account",
        action: "import",
        scope: { provider: "tcgdex", language: "en" },
        profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
        eventContext: {
          ...context,
          audit: {
            ...context.audit,
            forAccountId: "acc_other" as never,
          },
        },
      }),
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.enqueueIntegrationJob({
      action: "import",
      scope: { provider: "tcgdex", language: "en", seriesId: undefined, setId: undefined },
      context,
    });

    expect(job.jobId).not.toBe("job_other_account");
    expect(job.profileSnapshot).toMatchObject({
      providerKey: "tcgdex",
      profileKey: "pokemon-tcg",
      profileVersion: "2026.06.03",
      ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
      lifecycle: "active",
      connectorKind: "tcgdex-json",
      connectorSourceVersion: null,
    });
    expect(job.consistency.workUnitClaimPolicy).toBe("leased-job-turns");
    expect(job.profileSnapshot?.sourceMappingFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.insertedJobs).toHaveLength(1);
  });

  it("records a durable status event when enqueueing a provider integration job", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.enqueueIntegrationJob({
      action: "import",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
      context,
    });

    expect(harness.jobEvents).toEqual([
      {
        jobKind: "integration",
        jobId: job.jobId,
        snapshot: expect.objectContaining({
          jobId: job.jobId,
          action: "import",
          status: "queued",
        }),
      },
    ]);
  });

  it("snapshots reapply profile mode on integration jobs and work units", async () => {
    const harness = createIntegrationJobDedupeHarness({
      reapplyObservationIds: ["obs_promoted_1", "obs_promoted_2"],
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.enqueueIntegrationJob({
      action: "reapply",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
      context,
    });

    expect(job).toMatchObject({
      action: "reapply",
      reapplyProfileMode: "current-active-profile",
      profileSnapshot: {
        providerKey: "tcgdex",
        profileVersion: "2026.06.03",
        ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
        connectorKind: "tcgdex-json",
        connectorSourceVersion: null,
      },
      operatorStatus: "queued",
      consistency: {
        duplicateSubmissionPolicy: "reuse-active-job",
        profileSnapshotPolicy: "snapshotted-at-enqueue",
        retryResumePolicy: "skip-completed-outcomes",
        partialFailurePolicy: "mixed-outcomes",
        workUnitClaimPolicy: "leased-work-units",
      },
      progress: {
        total: 2,
      },
    });
    expect(harness.insertedWorkUnits.map((unit) => unit.payload)).toEqual([
      expect.objectContaining({
        observationId: "obs_promoted_1",
        reapplyProfileMode: "current-active-profile",
        profileSnapshot: expect.objectContaining({
          providerKey: "tcgdex",
          profileVersion: "2026.06.03",
          ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
        }),
      }),
      expect.objectContaining({
        observationId: "obs_promoted_2",
        reapplyProfileMode: "current-active-profile",
        profileSnapshot: expect.objectContaining({
          providerKey: "tcgdex",
          profileVersion: "2026.06.03",
          ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
        }),
      }),
    ]);
  });

  it("lists active provider connector options for Catalog integration discovery", async () => {
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const providers = await services.listIntegrationOptions({
      providerKey: "tcgdex",
      queryKind: "providers",
    });

    expect(providers).toEqual([
      expect.objectContaining({
        providerKey: "tcgdex",
        value: "tcgdex",
        label: "TCGdex",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "tcgdex-json",
        }),
      }),
    ]);
  });

  it("uses newly activated persisted profile versions for subsequent option queries", async () => {
    const profileVersions = createMutableProfileVersionReader([
      currentTcgdexProfileVersion(),
      tcgdexProfileVersion({
        profileVersion: "2026.06.04",
        lifecycle: "test",
        active: false,
        displayName: "TCGdex Candidate",
      }),
    ]);
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      profileVersions,
    );

    await expect(
      services.listIntegrationOptions({
        providerKey: "tcgdex",
        queryKind: "providers",
      }),
    ).resolves.toEqual([expect.objectContaining({ providerKey: "tcgdex", label: "TCGdex" })]);

    profileVersions.activate("tcgdex", "2026.06.04");

    await expect(
      services.listIntegrationOptions({
        providerKey: "tcgdex",
        queryKind: "providers",
      }),
    ).resolves.toEqual([expect.objectContaining({ providerKey: "tcgdex", label: "TCGdex Candidate" })]);
  });

  it("does not run option queries against inactive provider profile versions", async () => {
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(
      services.listIntegrationOptions({
        providerKey: "tcgplayer",
        queryKind: "languages",
      }),
    ).rejects.toThrow("Unsupported Catalog integration provider: tcgplayer.");
  });

  it("lists TCGplayer product-line and set-name options through the automation client", async () => {
    const harness = createTcgplayerImportHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions(),
    );

    const productLines = await services.listIntegrationOptions({
      providerKey: "tcgplayer",
      queryKind: "product-lines",
    });
    const setNames = await services.listIntegrationOptions({
      providerKey: "tcgplayer",
      queryKind: "set-names",
      parentValue: "3",
    });

    expect(productLines).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        queryKind: "product-lines",
        value: "3",
        label: "Pokemon",
        metadata: expect.objectContaining({
          productLineId: 3,
          productLineUrlName: "pokemon",
        }),
      }),
    ]);
    expect(setNames).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        queryKind: "set-names",
        value: "Prismatic Evolutions",
        label: "Prismatic Evolutions",
        parentValue: "3",
        metadata: expect.objectContaining({
          productLineId: 3,
          setNameId: 7001,
          cleanSetName: "Prismatic Evolutions",
        }),
      }),
    ]);
  });

  it("imports TCGplayer set scopes as provider-product source observations", async () => {
    const harness = createTcgplayerImportHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions(),
    );

    const result = await services.importTcgplayerScope({
      scope: { provider: "tcgplayer", productLineId: "3", setName: "Prismatic Evolutions" },
      context,
    });

    expect(result).toMatchObject({
      requested: 1,
      imported: 1,
      observed: 2,
      failed: 0,
      outcomes: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          expansionId: "set:3:Prismatic Evolutions",
          status: "imported",
          observed: 2,
        }),
      ],
    });
    expect(harness.appendedSourceEvents).toHaveLength(2);
    expect(harness.appendedSourceEvents[0]).toMatchObject({
      eventType: "catalog.source-observation.recorded",
      payload: expect.objectContaining({
        observationId: "tcgplayer_en_product_610001",
        providerKey: "tcgplayer",
        externalKey: "product:610001",
        normalized: expect.objectContaining({
          kind: "provider-product",
          mergeIdentity: expect.objectContaining({
            productLineName: "Pokemon",
            setName: "Prismatic Evolutions",
            collectorNumber: "131",
          }),
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
          externalProductReferences: [],
          skuReferences: [
            expect.objectContaining({
              providerKey: "tcgplayer",
              externalKey: "sku:987654",
              reviewEvidence: expect.objectContaining({
                condition: "Near Mint",
                printing: "Normal",
                language: "English",
                productForm: "single",
              }),
            }),
          ],
        }),
      }),
    });
  });

  it("records fetched TCGplayer products while reporting product detail failures", async () => {
    const harness = createTcgplayerImportHarness({ failProductIds: new Set([610002]) });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions(),
    );

    const result = await services.importTcgplayerScope({
      scope: { provider: "tcgplayer", productLineId: "3", setName: "Prismatic Evolutions" },
      context,
    });

    expect(result).toMatchObject({
      requested: 1,
      imported: 0,
      observed: 1,
      failed: 1,
      outcomes: [
        expect.objectContaining({
          status: "failed",
          observed: 1,
          reason: "Imported 1 TCGplayer product details before Product 610002 unavailable.",
        }),
      ],
    });
    expect(harness.appendedSourceEvents).toHaveLength(1);
    expect(harness.appendedSourceEvents[0]?.payload).toMatchObject({
      observationId: "tcgplayer_en_product_610001",
      externalKey: "product:610001",
    });
  });

  it("retries provider integration jobs by preserving successful outcomes and pruning failed outcomes", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: {
        ...integrationJobRow({
          jobId: "job_retry",
          action: "import",
          scope: { provider: "tcgdex", language: "en", seriesId: "base" },
          profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
          eventContext: context,
        }),
        status: "completed",
        progress: {
          phase: "completed",
          completed: 2,
          total: 2,
          currentName: null,
          status: "failed",
        },
        result: {
          requested: 2,
          imported: 1,
          observed: 102,
          reapplied: 0,
          skipped: 0,
          failed: 1,
          outcomes: [
            {
              providerKey: "tcgdex",
              languageCode: "en",
              expansionId: "base1",
              status: "imported",
              observed: 102,
              reapplied: 0,
              reason: null,
            },
            {
              providerKey: "tcgdex",
              languageCode: "en",
              expansionId: "base2",
              status: "failed",
              observed: 0,
              reapplied: 0,
              reason: "Provider timeout.",
            },
          ],
        },
        completed_at: "2026-05-28T00:00:05.000Z",
      },
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.retryIntegrationJob({ jobId: "job_retry", context });

    expect(job).toMatchObject({
      jobId: "job_retry",
      status: "queued",
      progress: {
        phase: "queued",
        completed: 1,
        total: 2,
      },
      result: {
        requested: 2,
        imported: 1,
        failed: 0,
      },
    });
    expect(job.result?.outcomes).toEqual([expect.objectContaining({ expansionId: "base1", status: "imported" })]);
    expect(harness.jobEvents[harness.jobEvents.length - 1]?.snapshot).toMatchObject({
      jobId: "job_retry",
      status: "queued",
    });
  });

  it("cancels provider integration jobs as operator-cancelled failed durable jobs", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: {
        ...integrationJobRow({
          jobId: "job_cancel",
          action: "import",
          scope: { provider: "tcgdex", language: "en", seriesId: "base" },
          profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
          eventContext: context,
          progress: {
            phase: "processing",
            completed: 1,
            total: 2,
            currentName: "Base Set",
            status: "imported",
          },
        }),
        status: "running",
        claim_owner_id: "worker-1",
        claimed_until: "2026-05-28T00:10:00.000Z",
      },
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.cancelIntegrationJob({ jobId: "job_cancel", context });

    expect(job).toMatchObject({
      jobId: "job_cancel",
      status: "failed",
      operatorStatus: "cancelled",
      progress: {
        phase: "failed",
        completed: 1,
        total: 2,
      },
      errorMessage: "Operator cancelled provider import job.",
    });
  });

  it("processes queued TCGplayer imports through the durable integration worker", async () => {
    const tcgplayerHarness = createTcgplayerImportHarness();
    const harness = createIntegrationJobClaimHandoffHarness({
      scope: { provider: "tcgplayer", productLineId: "3", setName: "Prismatic Evolutions" },
      renewSucceeds: true,
      tcgplayerAutomationCatalogClient: tcgplayerHarness.client,
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      harness.referenceData,
      createActiveTcgplayerProfileVersions(),
    );

    await expect(
      services.processNextIntegrationJob({
        claimOwnerId: "worker-1",
        claimTtlMs: 120_000,
      }),
    ).resolves.toBe(1);

    expect(harness.job.status).toBe("completed");
    expect(harness.job.progress).toMatchObject({
      phase: "completed",
      completed: 1,
      total: 1,
    });
    expect(harness.job.result).toMatchObject({
      requested: 1,
      imported: 1,
      observed: 2,
      failed: 0,
    });
    expect(harness.appendedSourceEvents).toHaveLength(2);
  });

  it("processes queued imports with the snapshotted profile version after a newer version is activated", async () => {
    const harness = createIntegrationJobClaimHandoffHarness({
      profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
      renewSucceeds: true,
    });
    const profileVersions = createMutableProfileVersionReader([
      tcgdexProfileVersion({
        profileVersion: "2026.06.03",
        lifecycle: "deprecated",
        active: false,
        displayName: "TCGdex",
      }),
      tcgdexProfileVersion({
        profileVersion: "2026.06.04",
        lifecycle: "active",
        active: true,
        displayName: "TCGdex Candidate",
      }),
    ]);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      const body =
        fetchCount === 1
          ? {
              id: "base1",
              name: "Base Set",
              serie: { id: "base", name: "Base" },
              cardCount: { official: 102, total: 102 },
              cards: [{ id: "base1-1", localId: "1", name: "Abra" }],
            }
          : {
              id: "base1-1",
              localId: "1",
              name: "Abra",
              category: "Pokemon",
              rarity: "Common",
              set: { id: "base1", name: "Base Set" },
              variants: { normal: true },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      harness.referenceData,
      profileVersions,
    );

    try {
      await expect(
        services.processNextIntegrationJob({
          claimOwnerId: "worker-1",
          claimTtlMs: 120_000,
        }),
      ).resolves.toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(harness.job.status).toBe("completed");
    expect(harness.appendedSourceEvents[0]?.payload).toMatchObject({
      providerKey: "tcgdex",
      sourceProfileVersion: "2026.06.03",
    });
  });

  it("hands off provider integration imports when the durable claim is lost before recording observations", async () => {
    const harness = createIntegrationJobClaimHandoffHarness();
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      const body =
        fetchCount === 1
          ? {
              id: "base1",
              name: "Base Set",
              serie: { id: "base", name: "Base" },
              cardCount: { official: 102, total: 102 },
              cards: [{ id: "base1-1", localId: "1", name: "Abra" }],
            }
          : {
              id: "base1-1",
              localId: "1",
              name: "Abra",
              category: "Pokemon",
              rarity: "Common",
              set: { id: "base1", name: "Base Set" },
              variants: { normal: true },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);

    try {
      await expect(
        services.processNextIntegrationJob({
          claimOwnerId: "worker-1",
          claimTtlMs: 120_000,
        }),
      ).resolves.toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(harness.job.status).toBe("running");
    expect(harness.job.result).toBeNull();
    expect(harness.job.error_message).toBeNull();
    expect(harness.appendedSourceEvents).toEqual([]);
    expect(harness.renewAttempts).toBe(1);
  });

  it("returns an empty active integration job list when request context is missing", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(services.listActiveIntegrationJobs({ context: null })).resolves.toEqual([]);
    expect(harness.queryCount).toBe(0);
  });

  it("propagates credential readiness separately from semantic readiness", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const readiness = await services.getCatalogIntegrationControlPlaneReadiness();
    const unitsByKey = Object.fromEntries(readiness.units.map((unit) => [unit.unitKey, unit]));

    expect(unitsByKey["reference-cards:pokemon:single-card:source-observation-proof"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
    });
    expect(unitsByKey["tcgdex:pokemon:single-card:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
    });
    expect(unitsByKey["tcgplayer:pokemon:single-card:source-observation-import"]).toMatchObject({
      credentialReadiness: "blocked",
      credentialReadinessState: "missing",
      credentialDiagnosticCode: "credential-missing",
      transportReadiness: "blocked",
    });
  });
});
