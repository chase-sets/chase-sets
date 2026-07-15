import { describe, expect, it, vi } from "vitest";
import type { SourceObservationRouteServices } from "./route";
import { SourceObservationIntegrationJobLifecycleCommandError } from "./runtime";
import {
  buildApp,
  bulkJobFixture,
  context,
  integrationJob,
  integrationJobFixture,
  jobEvent,
  readSseData,
  rolloutDenied,
} from "./route-test-harness";

describe("source observation routes: integration and bulk review jobs", () => {
  it("enqueues provider integration jobs with normalized scope aliases", async () => {
    const job = integrationJob({ status: "queued" });
    const enqueueIntegrationJob = vi.fn(async () => job);
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs", {
      method: "POST",
      body: JSON.stringify({
        action: "import",
        scope: { source: "tcgdex", languageCode: "en", expansionId: "base1", seriesId: "base" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ jobId: "job_integration", action: "import" });
    expect(enqueueIntegrationJob).toHaveBeenCalledWith({
      action: "import",
      scope: {
        provider: "tcgdex",
        language: "en",
        seriesId: "base",
        setId: "base1",
      },
      context,
    });
  });

  it("enqueues TCGplayer integration jobs with provider-product scope aliases", async () => {
    const job = integrationJob({ status: "queued" });
    const enqueueIntegrationJob = vi.fn(async () => job);
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs", {
      method: "POST",
      body: JSON.stringify({
        action: "import",
        scope: {
          source: "tcgplayer",
          languageCode: "en",
          categoryId: "3",
          cleanSetName: "Base Set",
          tcgplayerProductId: "12345",
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ jobId: "job_integration", action: "import" });
    expect(enqueueIntegrationJob).toHaveBeenCalledWith({
      action: "import",
      scope: {
        provider: "tcgplayer",
        language: "en",
        productLineId: "3",
        setName: "Base Set",
        productId: "12345",
      },
      context,
    });
  });

  it("preserves generic provider set-name scopes from shared importer aliases", async () => {
    const job = integrationJob({ status: "queued" });
    const enqueueIntegrationJob = vi.fn(async () => job);
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs", {
      method: "POST",
      body: JSON.stringify({
        action: "import",
        scope: {
          source: "scrydex",
          unitKey: "scrydex:one-piece:single-card:source-observation-import",
          languageCode: "en",
          expansionName: "op-01",
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ jobId: "job_integration", action: "import" });
    expect(enqueueIntegrationJob).toHaveBeenCalledWith({
      action: "import",
      scope: {
        provider: "scrydex",
        ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
        language: "en",
        setName: "op-01",
      },
      context,
    });
  });

  it("previews provider integration imports with normalized selected-scope aliases", async () => {
    const preview = {
      action: "import",
      providerKey: "scrydex",
      scope: {
        provider: "scrydex",
        ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
        language: "en",
        setId: "op-01",
      },
      profileSnapshot: null,
      targetCount: 1,
      targets: [
        {
          targetId: "set:op-01",
          name: "op-01",
          languageCode: "en",
          scopeKey: "expansion-cards",
          planKey: "scrydex:one-piece:expansion:op-01:cards",
          estimatedPayloads: null,
          transportSteps: ["Fetch Scrydex One Piece expansion cards with max page size"],
          usageEstimate: {
            requestStrategy: "bulk-first",
            estimateState: "estimate-unavailable",
            estimatedRequestCount: null,
            estimateReason: "Card page count is available only after the first Scrydex paged response.",
            pageSize: 250,
            selectedFields: ["id", "name", "number", "expansion"],
            perRecordFallbackReason: null,
            usageCheckState: "not-configured",
            creditDiagnostic: "Scrydex usage endpoint is not configured for this environment.",
            degradedDiagnostic: null,
          },
        },
      ],
    };
    const previewIntegrationImport = vi.fn(async () => preview);
    const services = {
      previewIntegrationImport,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs/preview", {
      method: "POST",
      body: JSON.stringify({
        action: "import",
        scope: {
          source: "scrydex",
          unitKey: "scrydex:one-piece:single-card:source-observation-import",
          languageCode: "en",
          expansionId: "op-01",
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(preview);
    expect(previewIntegrationImport).toHaveBeenCalledWith({
      scope: {
        provider: "scrydex",
        ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
        language: "en",
        setId: "op-01",
      },
      context,
    });
  });

  it("previews Catalog sync scope provider participation before enqueueing provider jobs", async () => {
    const preview = {
      previewVersion: "catalog-sync-provider-participation-preview-v1",
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId: "scope_pokemon_base_set" },
      },
      status: "ready",
      startAllowed: true,
      units: [],
      estimate: {
        totalEstimatedRequestCount: 0,
        estimateState: "estimated",
        estimateReason: null,
        creditConsumingProviders: [],
      },
      blockers: [],
      explanation: "Eligible provider units are ready to pull Source Observations for this Catalog scope.",
    };
    const previewCatalogSyncScope = vi.fn(async () => preview);
    const services = {
      previewCatalogSyncScope,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/catalog-sync-scope/preview", {
      method: "POST",
      body: JSON.stringify({
        scope: {
          productDomain: "pokemon",
          productForm: "single-card",
          languageCode: "en",
          reference: { kind: "expansion", scopeRecordId: "scope_pokemon_base_set" },
          providerParticipation: {
            selectedUnitKeys: ["tcgdex:pokemon:single-card:source-observation-import"],
          },
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(preview);
    expect(previewCatalogSyncScope).toHaveBeenCalledWith({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId: "scope_pokemon_base_set" },
        providerParticipation: {
          requiredUnitKeys: [],
          selectedUnitKeys: ["tcgdex:pokemon:single-card:source-observation-import"],
          excludedUnitKeys: [],
        },
      },
      context,
    });
  });

  it("returns durable per-scope sync state for every provider unit", async () => {
    const units = [
      {
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        displayName: "tcgdex Pokemon card import",
        role: "primary-source-observation",
        requirement: "required",
        state: "settled",
        lastSyncRunId: "job_catalog_sync_run",
        lastJobId: "job_integration",
        lastOperatorStatus: "completed",
        observedCount: 42,
        changedCount: 3,
        requestedCount: 42,
        failedCount: 0,
        errorMessage: null,
        lastStartedAt: "2026-07-13T00:00:00.000Z",
        lastCompletedAt: "2026-07-13T00:01:00.000Z",
        updatedAt: "2026-07-13T00:01:00.000Z",
      },
    ];
    const getCatalogScopeSyncState = vi.fn(async () => units);
    const services = {
      getCatalogScopeSyncState,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/catalog-sync-scope/state", {
      method: "POST",
      body: JSON.stringify({
        scope: {
          productDomain: "pokemon",
          productForm: "single-card",
          languageCode: "en",
          reference: { kind: "expansion", scopeRecordId: "scope_pokemon_base_set" },
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: units, total: 1, count: 1 });
    expect(getCatalogScopeSyncState).toHaveBeenCalledWith({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId: "scope_pokemon_base_set" },
        providerParticipation: null,
      },
      context,
    });
  });

  it("enqueues a Catalog sync scope parent run with selected provider fan-out", async () => {
    const run = {
      syncRunId: "job_catalog_sync_run",
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId: "scope_pokemon_base_set" },
      },
      status: "queued",
      progress: {
        childJobs: { total: 1, queued: 1, running: 0, completed: 0, partial: 0, failed: 0, cancelled: 0, stale: 0 },
        providerTargets: { completed: 0, total: 1 },
      },
      selectedUnits: [],
      childJobs: [],
      consistency: {
        duplicateSubmissionPolicy: "reuse-active-sync-run",
        childScopePolicy: "deterministic-from-provider-participation-preview",
        profileSnapshotPolicy: "selected-active-provider-units-snapshotted-at-enqueue",
        childRetryResumeCancelPolicy: "delegated-to-provider-import-jobs",
        partialFailurePolicy: "visible-per-provider-child-job",
      },
      preview: {
        previewVersion: "catalog-sync-provider-participation-preview-v1",
        scope: {
          scopeVersion: "catalog-sync-scope-v2",
          productDomain: "pokemon",
          productForm: "single-card",
          languageCode: "en",
          reference: { kind: "expansion", scopeRecordId: "scope_pokemon_base_set" },
        },
        status: "ready",
        startAllowed: true,
        units: [],
        estimate: {
          totalEstimatedRequestCount: 0,
          estimateState: "estimated",
          estimateReason: null,
          creditConsumingProviders: [],
        },
        blockers: [],
        explanation: "Eligible provider units are ready to pull Source Observations for this Catalog scope.",
      },
      errorMessage: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:02.000Z",
    };
    const enqueueCatalogSyncRun = vi.fn(async () => run);
    const services = {
      enqueueCatalogSyncRun,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/catalog-sync-scope/runs", {
      method: "POST",
      body: JSON.stringify({
        scope: {
          productDomain: "pokemon",
          productForm: "single-card",
          languageCode: "en",
          reference: { kind: "expansion", scopeRecordId: "scope_pokemon_base_set" },
          providerParticipation: {
            selectedUnitKeys: ["tcgdex:pokemon:single-card:source-observation-import"],
          },
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(run);
    expect(enqueueCatalogSyncRun).toHaveBeenCalledWith({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId: "scope_pokemon_base_set" },
        providerParticipation: {
          requiredUnitKeys: [],
          selectedUnitKeys: ["tcgdex:pokemon:single-card:source-observation-import"],
          excludedUnitKeys: [],
        },
      },
      context,
    });
  });

  it("returns Catalog sync scope parent run progress", async () => {
    const run = {
      syncRunId: "job_catalog_sync_run",
      status: "completed",
      progress: {
        childJobs: { total: 1, queued: 0, running: 0, completed: 1, partial: 0, failed: 0, cancelled: 0, stale: 0 },
        providerTargets: { completed: 1, total: 1 },
      },
    };
    const getCatalogSyncRun = vi.fn(async () => run);
    const services = {
      getCatalogSyncRun,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/catalog-sync-scope/runs/job_catalog_sync_run");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(run);
    expect(getCatalogSyncRun).toHaveBeenCalledWith({
      syncRunId: "job_catalog_sync_run",
      context,
    });
  });

  it("returns a validation error when a provider integration job is not importable", async () => {
    const enqueueIntegrationJob = vi.fn(async () => {
      throw new Error("Provider 'tcgplayer' does not support background import.");
    });
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs", {
      method: "POST",
      body: JSON.stringify({
        action: "import",
        scope: { source: "tcgplayer", categoryId: "3", cleanSetName: "Base Set" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_scope",
        message: "Provider 'tcgplayer' does not support background import.",
      },
    });
    expect(enqueueIntegrationJob).toHaveBeenCalledWith({
      action: "import",
      scope: {
        provider: "tcgplayer",
        productLineId: "3",
        setName: "Base Set",
      },
      context,
    });
  });

  it("lists active provider integration jobs for the current request context", async () => {
    const activeJob = integrationJob({ status: "running" });
    const listActiveIntegrationJobs = vi.fn(async () => [activeJob]);
    const services = {
      listActiveIntegrationJobs,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs/active");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      count: 1,
      items: [{ jobId: "job_integration", action: "import", status: "running" }],
    });
    expect(listActiveIntegrationJobs).toHaveBeenCalledWith({ context });
  });

  it("runs provider import lifecycle commands through the current request context", async () => {
    const retryJob = integrationJob({ status: "queued" });
    const resumeJob = integrationJob({ status: "running" });
    const cancelJob = integrationJobFixture({
      status: "failed",
      operatorStatus: "cancelled",
      progress: {
        phase: "failed",
        completed: 7,
        total: 24,
        currentName: "Base Set",
        status: null,
      },
      errorMessage: "Operator cancelled provider import job.",
    });
    const retryIntegrationJob = vi.fn(async () => retryJob);
    const resumeIntegrationJob = vi.fn(async () => resumeJob);
    const cancelIntegrationJob = vi.fn(async () => cancelJob);
    const services = {
      retryIntegrationJob,
      resumeIntegrationJob,
      cancelIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    await expect(
      app.request("/source-observations/integration-jobs/job_import/retry", { method: "POST" }),
    ).resolves.toMatchObject({ status: 202 });
    await expect(
      app.request("/source-observations/integration-jobs/job_import/resume", { method: "POST" }),
    ).resolves.toMatchObject({ status: 202 });
    const cancelResponse = await app.request("/source-observations/integration-jobs/job_import/cancel", {
      method: "POST",
    });

    expect(cancelResponse.status).toBe(202);
    await expect(cancelResponse.json()).resolves.toMatchObject({
      jobId: "job_integration",
      operatorStatus: "cancelled",
    });
    expect(retryIntegrationJob).toHaveBeenCalledWith({ jobId: "job_import", context });
    expect(resumeIntegrationJob).toHaveBeenCalledWith({ jobId: "job_import", context });
    expect(cancelIntegrationJob).toHaveBeenCalledWith({ jobId: "job_import", context });
  });

  it("fails closed when provider import lifecycle commands are not available for the job state", async () => {
    const retryIntegrationJob = vi.fn(async () => {
      throw new SourceObservationIntegrationJobLifecycleCommandError(
        "unsupported_state",
        "Completed provider import jobs without failed outcomes cannot be retried.",
      );
    });
    const services = {
      retryIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs/job_done/retry", { method: "POST" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "unsupported_state",
      },
    });
  });

  it("streams provider integration job status events until completion", async () => {
    const completedJob = integrationJob({ status: "completed" });
    const getIntegrationJob = vi.fn(async () => completedJob);
    const listIntegrationJobEvents = vi.fn(async () => [jobEvent(completedJob)]);
    const services = {
      getIntegrationJob,
      listIntegrationJobEvents,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs/job_integration/events");

    expect(response.status).toBe(200);
    const events = await response.text();
    expect(events).toContain("id: 1");
    expect(events).toContain("event: status");
    expect(events).toContain('"jobId":"job_integration"');
    expect(events).toContain('"status":"completed"');
    expect(getIntegrationJob).toHaveBeenCalledWith("job_integration", context);
    expect(listIntegrationJobEvents).toHaveBeenCalledWith("job_integration", 0);
  });

  it("enqueues bulk promotion jobs for observations matching an explicit filter scope", async () => {
    const job = bulkJobFixture({
      jobId: "job_promote_scope",
      action: "promote",
      selectionMode: "filter",
      scope: { status: "observed", language: "en", setId: "base1" },
    });
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote", {
      method: "POST",
      body: JSON.stringify({
        scope: { status: "observed", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_promote_scope",
      action: "promote",
      status: "queued",
    });
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "promote",
      observationIds: [],
      scope: {
        search: undefined,
        status: "observed",
        provider: undefined,
        language: "en",
        setId: "base1",
      },
      context,
    });
  });

  it("returns rollout evidence when bulk promotion is disabled", async () => {
    const enqueueBulkReviewJob = vi.fn(async () => {
      throw rolloutDenied({ capability: "promotion", providerKey: "tcgdex" });
    });
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote", {
      method: "POST",
      body: JSON.stringify({
        scope: { source: "tcgdex", status: "observed", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "catalog_integration_rollout_control_denied",
        capability: "promotion",
        controlId: "promotion-disabled",
      },
    });
  });

  it("previews filter-scoped reapply for promoted observations", async () => {
    const previewReapplyObservationScope = vi.fn(async () => ({
      matched: 102,
      eligible: 88,
      ineligible: 14,
      scope: {
        search: "",
        status: "",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
    }));
    const services = {
      previewReapplyObservationScope,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/reapply/preview", {
      method: "POST",
      body: JSON.stringify({
        scope: { source: "tcgdex", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matched: 102,
      eligible: 88,
      ineligible: 14,
    });
    expect(previewReapplyObservationScope).toHaveBeenCalledWith({
      scope: {
        search: undefined,
        status: undefined,
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
    });
  });

  it("enqueues reapply jobs for promoted observations matching an explicit filter scope", async () => {
    const job = integrationJobFixture({
      jobId: "job_reapply_scope",
      action: "reapply",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
    });
    const enqueueIntegrationJob = vi.fn(async () => job);
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/reapply", {
      method: "POST",
      body: JSON.stringify({
        scope: { source: "tcgdex", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_reapply_scope",
      action: "reapply",
      status: "queued",
    });
    expect(enqueueIntegrationJob).toHaveBeenCalledWith({
      action: "reapply",
      scope: {
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
      reapplyProfileMode: "current-active-profile",
      context,
    });
  });

  it("passes original source profile mode for scoped replay jobs", async () => {
    const job = integrationJobFixture({
      jobId: "job_replay_scope",
      action: "reapply",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
    });
    const enqueueIntegrationJob = vi.fn(async () => job);
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/reapply", {
      method: "POST",
      body: JSON.stringify({
        scope: { source: "tcgdex", language: "en", setId: "base1" },
        reapplyProfileMode: "original-source-profile",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_replay_scope",
      action: "reapply",
      status: "queued",
    });
    expect(enqueueIntegrationJob).toHaveBeenCalledWith({
      action: "reapply",
      scope: {
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
      reapplyProfileMode: "original-source-profile",
      context,
    });
  });

  it("returns rollout evidence when reapply is disabled", async () => {
    const enqueueIntegrationJob = vi.fn(async () => {
      throw rolloutDenied({ capability: "reapply", providerKey: "tcgdex" });
    });
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/reapply", {
      method: "POST",
      body: JSON.stringify({
        scope: { source: "tcgdex", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "catalog_integration_rollout_control_denied",
        capability: "reapply",
        controlId: "reapply-disabled",
      },
    });
  });

  it("streams durable reapply job status events", async () => {
    const job = integrationJobFixture({
      jobId: "job_reapply_progress",
      action: "reapply",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
      status: "completed",
      progress: {
        phase: "processing",
        completed: 1,
        total: 2,
        currentName: "Bulbasaur",
        status: "reapplied",
      },
      result: {
        requested: 2,
        imported: 0,
        observed: 0,
        reapplied: 1,
        skipped: 1,
        failed: 0,
        outcomes: [],
      },
    });
    const getIntegrationJob = vi.fn(async () => job);
    const listIntegrationJobEvents = vi.fn(async () => [jobEvent(job)]);
    const services = {
      getIntegrationJob,
      listIntegrationJobEvents,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs/job_reapply_progress/events");

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("id: 1");
    expect(readSseData(text)).toEqual([job]);
    expect(listIntegrationJobEvents).toHaveBeenCalledWith("job_reapply_progress", 0);
  });

  it("enqueues bulk promotion jobs for explicit observation ids from the request body", async () => {
    const job = bulkJobFixture({
      jobId: "job_promote_ids",
      action: "promote",
      observationIds: ["obs_1", "obs_2"],
    });
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote", {
      method: "POST",
      body: JSON.stringify({ observationIds: ["obs_1", "obs_2"] }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_promote_ids",
      action: "promote",
      status: "queued",
    });
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "promote",
      observationIds: ["obs_1", "obs_2"],
      scope: undefined,
      context,
    });
  });

  it("enqueues original-profile replay jobs for explicit observation ids", async () => {
    const job = bulkJobFixture({
      jobId: "job_replay_ids",
      action: "reapply",
      observationIds: ["obs_1", "obs_2"],
      reapplyProfileMode: "original-source-profile",
    });
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/reapply", {
      method: "POST",
      body: JSON.stringify({
        observationIds: ["obs_1", "obs_2"],
        reapplyProfileMode: "original-source-profile",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_replay_ids",
      action: "reapply",
      status: "queued",
    });
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "reapply",
      observationIds: ["obs_1", "obs_2"],
      reapplyProfileMode: "original-source-profile",
      context,
    });
  });

  it("streams bulk promotion job status events", async () => {
    const job = {
      jobId: "job_1",
      action: "promote",
      selectionMode: "filter",
      observationIds: [],
      scope: {},
      reason: null,
      status: "completed",
      progress: {
        phase: "processing",
        completed: 1,
        total: 2,
        currentName: "Bulbasaur",
        status: "promoted",
      },
      result: {
        requested: 2,
        promoted: 1,
        skipped: 1,
        failed: 0,
        outcomes: [],
      },
      errorMessage: null,
      createdAt: "2026-05-21T00:00:00.000Z",
      startedAt: "2026-05-21T00:00:01.000Z",
      completedAt: "2026-05-21T00:00:02.000Z",
      updatedAt: "2026-05-21T00:00:02.000Z",
    } as const;
    const getBulkReviewJob = vi.fn(async () => job);
    const listBulkReviewJobEvents = vi.fn(async () => [jobEvent(job)]);
    const services = {
      getBulkReviewJob,
      listBulkReviewJobEvents,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-jobs/job_1/events");

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("id: 1");
    expect(readSseData(text)).toEqual([job]);
    expect(getBulkReviewJob).toHaveBeenCalledWith("job_1", context);
    expect(listBulkReviewJobEvents).toHaveBeenCalledWith("job_1", 0);
  });

  it("requires a reason for bulk rejection", async () => {
    const services = {
      rejectObservations: vi.fn(),
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-reject", {
      method: "POST",
      body: JSON.stringify({ observationIds: ["obs_1"], reason: " " }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(services.rejectObservations).not.toHaveBeenCalled();
  });

  it("enqueues bulk rejection jobs for explicit observation ids with the shared reason", async () => {
    const job = bulkJobFixture({
      jobId: "job_reject_ids",
      action: "reject",
      observationIds: ["obs_1", "obs_2"],
      reason: "Duplicate provider row.",
    });
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-reject", {
      method: "POST",
      body: JSON.stringify({
        observationIds: ["obs_1", "obs_2"],
        reason: "Duplicate provider row.",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_reject_ids",
      action: "reject",
      status: "queued",
    });
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "reject",
      observationIds: ["obs_1", "obs_2"],
      scope: undefined,
      reason: "Duplicate provider row.",
      context,
    });
  });

  it("enqueues bulk rejection jobs for observations matching an explicit filter scope", async () => {
    const job = bulkJobFixture({
      jobId: "job_reject_scope",
      action: "reject",
      scope: { status: "observed", provider: "tcgdex", language: "en", setId: "base1" },
      reason: "Out of scope.",
    });
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-reject", {
      method: "POST",
      body: JSON.stringify({
        scope: { status: "observed", source: "tcgdex", language: "en", setId: "base1" },
        reason: "Out of scope.",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_reject_scope",
      action: "reject",
      status: "queued",
    });
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "reject",
      observationIds: [],
      scope: {
        search: undefined,
        status: "observed",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
      reason: "Out of scope.",
      context,
    });
  });

  it("enqueues bulk defer jobs without removing observations from review scope", async () => {
    const job = bulkJobFixture({
      jobId: "job_defer_scope",
      action: "defer",
      scope: { status: "changed", provider: "tcgdex", language: "en", setId: "base1" },
      reason: "Needs provider evidence.",
    });
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-defer/jobs", {
      method: "POST",
      body: JSON.stringify({
        scope: { status: "changed", source: "tcgdex", language: "en", setId: "base1" },
        reason: " Needs provider evidence. ",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_defer_scope",
      action: "defer",
      status: "queued",
    });
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "defer",
      observationIds: [],
      scope: {
        search: undefined,
        status: "changed",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
      reason: "Needs provider evidence.",
      context,
    });
  });

  it("requires explicit Source Observation ids or review scope for bulk defer jobs", async () => {
    const enqueueBulkReviewJob = vi.fn();
    const services = {
      enqueueBulkReviewJob,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-defer/jobs", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Bulk deferral requires selected observations or an explicit review scope.",
    });
    expect(enqueueBulkReviewJob).not.toHaveBeenCalled();
  });

  it("streams bulk rejection job status events", async () => {
    const job = {
      jobId: "job_2",
      action: "reject",
      selectionMode: "ids",
      observationIds: ["obs_1"],
      scope: {},
      reason: "Duplicate provider row.",
      status: "completed",
      progress: {
        phase: "processing",
        completed: 1,
        total: 1,
        currentName: "Ivysaur",
        status: "rejected",
      },
      result: {
        requested: 1,
        promoted: 0,
        rejected: 1,
        skipped: 0,
        failed: 0,
        outcomes: [],
      },
      errorMessage: null,
      createdAt: "2026-05-21T00:00:00.000Z",
      startedAt: "2026-05-21T00:00:01.000Z",
      completedAt: "2026-05-21T00:00:02.000Z",
      updatedAt: "2026-05-21T00:00:02.000Z",
    } as const;
    const getBulkReviewJob = vi.fn(async () => job);
    const listBulkReviewJobEvents = vi.fn(async () => [jobEvent(job)]);
    const services = {
      getBulkReviewJob,
      listBulkReviewJobEvents,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-jobs/job_2/events");

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("id: 1");
    expect(readSseData(text)).toEqual([job]);
    expect(listBulkReviewJobEvents).toHaveBeenCalledWith("job_2", 0);
  });

  it("lists active bulk review jobs for the current request context", async () => {
    const activeJob = {
      jobId: "job_active",
      action: "promote",
      selectionMode: "filter",
      observationIds: [],
      scope: { status: "observed" },
      reason: null,
      status: "running",
      progress: {
        phase: "processing",
        completed: 12,
        total: 100,
        currentName: "Pikachu",
        status: "promoted",
      },
      result: null,
      errorMessage: null,
      createdAt: "2026-05-21T00:00:00.000Z",
      startedAt: "2026-05-21T00:00:01.000Z",
      completedAt: null,
      updatedAt: "2026-05-21T00:00:02.000Z",
    } as const;
    const listActiveBulkReviewJobs = vi.fn(async () => [activeJob]);
    const services = {
      listActiveBulkReviewJobs,
    } as unknown as SourceObservationRouteServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-jobs/active");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          jobId: "job_active",
          action: "promote",
          selectionMode: "filter",
          status: "running",
          progress: {
            completed: 12,
            total: 100,
          },
        },
      ],
      total: 1,
      count: 1,
    });
    expect(listActiveBulkReviewJobs).toHaveBeenCalledWith({ context });
  });
});
