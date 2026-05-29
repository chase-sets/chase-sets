import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { sourceObservationRoutes } from "./route";
import type { SourceObservationServices } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

function buildApp(services: SourceObservationServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.use("/source-observations/*", async (c, next) => {
    c.set("context", context);
    await next();
  });
  app.route("/source-observations", sourceObservationRoutes(services));

  return app;
}

describe("source observation routes", () => {
  it("lists observations using the shared source query param as provider scope", async () => {
    const listSourceObservations = vi.fn(async () => ({
      items: [],
      total: 0,
    }));
    const services = {
      listSourceObservations,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations?source=tcgdex&language=en&setId=base1&limit=50&offset=0");

    expect(response.status).toBe(200);
    expect(listSourceObservations).toHaveBeenCalledWith({
      search: undefined,
      status: undefined,
      limit: 50,
      offset: undefined,
      provider: "tcgdex",
      language: "en",
      setId: "base1",
    });
  });

  it("previews filter-scoped bulk promotion", async () => {
    const previewPromoteObservationScope = vi.fn(async () => ({
      matched: 102,
      eligible: 100,
      terminal: 2,
      scope: {
        search: "",
        status: "observed",
        provider: "",
        language: "en",
        setId: "base1",
      },
    }));
    const services = {
      previewPromoteObservationScope,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote/preview", {
      method: "POST",
      body: JSON.stringify({
        scope: { status: "observed", source: "tcgdex", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matched: 102,
      eligible: 100,
      terminal: 2,
    });
    expect(previewPromoteObservationScope).toHaveBeenCalledWith({
      scope: {
        search: undefined,
        status: "observed",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
    });
  });

  it("lists integration scopes using provider language and expansion filters", async () => {
    const listIntegrationScopes = vi.fn(async () => [
      {
        provider_key: "tcgdex",
        language_code: "en",
        expansion_id: "base1",
        expansion_name: "Base Set",
        series_id: "base",
        series_name: "Base",
        total_observations: 102,
        observed_observations: 100,
        changed_observations: 0,
        promoted_observations: 2,
        rejected_observations: 0,
        first_observed_at: "2026-05-16T00:00:00.000Z",
        latest_observed_at: "2026-05-16T00:01:00.000Z",
        latest_source_updated_at: null,
      },
    ]);
    const services = {
      listIntegrationScopes,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-scopes?source=tcgdex&language=en&setId=base1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      count: 1,
      items: [
        {
          provider_key: "tcgdex",
          language_code: "en",
          expansion_id: "base1",
          series_name: "Base",
        },
      ],
    });
    expect(listIntegrationScopes).toHaveBeenCalledWith({
      provider: "tcgdex",
      language: "en",
      setId: "base1",
    });
  });

  it("accepts TCGdex expansion ID as the Catalog-facing import request field", async () => {
    const job = integrationJobFixture({
      jobId: "job_import_base1",
      action: "import",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
    });
    const enqueueIntegrationJob = vi.fn(async () => job);
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/imports/tcgdex-set", {
      method: "POST",
      body: JSON.stringify({ languageCode: "en", expansionId: "base1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_import_base1",
      action: "import",
      status: "queued",
    });
    expect(enqueueIntegrationJob).toHaveBeenCalledWith({
      action: "import",
      scope: {
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
      context,
    });
  });

  it("streams TCGdex import job status events", async () => {
    const job = integrationJobFixture({
      jobId: "job_import_base1",
      action: "import",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
      status: "completed",
      progress: {
        phase: "completed",
        completed: 1,
        total: 1,
        currentName: null,
        status: "imported",
      },
      result: {
        requested: 1,
        imported: 1,
        observed: 2,
        reapplied: 0,
        skipped: 0,
        failed: 0,
        outcomes: [],
      },
    });
    const getIntegrationJob = vi.fn(async () => job);
    const listIntegrationJobEvents = vi.fn(async () => [jobEvent(job)]);
    const services = {
      getIntegrationJob,
      listIntegrationJobEvents,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/integration-jobs/job_import_base1/events");

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("id: 1");
    expect(text).toContain("event: status");
    expect(readSseData(text)).toEqual([job]);
    expect(getIntegrationJob).toHaveBeenCalledWith("job_import_base1", context);
    expect(listIntegrationJobEvents).toHaveBeenCalledWith("job_import_base1", 0);
  });

  it("lists TCGdex metadata for language, series, and expansion selectors", async () => {
    const listTcgdexLanguages = vi.fn(async () => [{ languageCode: "en" }]);
    const listTcgdexSeries = vi.fn(async () => [{ seriesId: "me", name: "Mega Evolution", logoUrl: null }]);
    const listTcgdexExpansions = vi.fn(async () => [
      {
        expansionId: "me02.5",
        name: "Ascended Heroes",
        seriesId: "me",
        seriesName: "Mega Evolution",
        logoUrl: null,
        symbolUrl: null,
        cardCount: 295,
        officialCardCount: 217,
      },
    ]);
    const services = {
      listTcgdexLanguages,
      listTcgdexSeries,
      listTcgdexExpansions,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const languagesResponse = await app.request("/source-observations/tcgdex/languages");
    const seriesResponse = await app.request("/source-observations/tcgdex/series?languageCode=en");
    const expansionsResponse = await app.request("/source-observations/tcgdex/expansions?languageCode=en&seriesId=me");

    expect(languagesResponse.status).toBe(200);
    await expect(languagesResponse.json()).resolves.toMatchObject({
      items: [{ languageCode: "en" }],
      total: 1,
      count: 1,
    });
    expect(seriesResponse.status).toBe(200);
    await expect(seriesResponse.json()).resolves.toMatchObject({
      items: [{ seriesId: "me", name: "Mega Evolution" }],
      total: 1,
      count: 1,
    });
    expect(expansionsResponse.status).toBe(200);
    await expect(expansionsResponse.json()).resolves.toMatchObject({
      items: [{ expansionId: "me02.5", name: "Ascended Heroes" }],
      total: 1,
      count: 1,
    });
    expect(listTcgdexSeries).toHaveBeenCalledWith({ languageCode: "en" });
    expect(listTcgdexExpansions).toHaveBeenCalledWith({
      languageCode: "en",
      seriesId: "me",
    });
  });

  it("lists provider-neutral integration options for Catalog import selectors", async () => {
    const listIntegrationOptions = vi.fn(async () => [
      {
        providerKey: "tcgdex",
        queryKind: "expansions",
        value: "me02.5",
        label: "Ascended Heroes",
        description: "Mega Evolution - 217 official cards",
        parentValue: "me",
        imageUrl: null,
        metadata: {
          languageCode: "en",
          expansionId: "me02.5",
        },
      },
    ]);
    const services = {
      listIntegrationOptions,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request(
      "/source-observations/integration-options?provider=tcgdex&kind=expansions&language=en&seriesId=me",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          providerKey: "tcgdex",
          queryKind: "expansions",
          value: "me02.5",
          label: "Ascended Heroes",
        },
      ],
      total: 1,
      count: 1,
    });
    expect(listIntegrationOptions).toHaveBeenCalledWith({
      providerKey: "tcgdex",
      queryKind: "expansions",
      languageCode: "en",
      parentValue: "me",
    });
  });

  it("enqueues provider integration jobs with normalized scope aliases", async () => {
    const job = integrationJob({ status: "queued" });
    const enqueueIntegrationJob = vi.fn(async () => job);
    const services = {
      enqueueIntegrationJob,
    } as unknown as SourceObservationServices;
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

  it("lists active provider integration jobs for the current request context", async () => {
    const activeJob = integrationJob({ status: "running" });
    const listActiveIntegrationJobs = vi.fn(async () => [activeJob]);
    const services = {
      listActiveIntegrationJobs,
    } as unknown as SourceObservationServices;
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

  it("streams provider integration job status events until completion", async () => {
    const completedJob = integrationJob({ status: "completed" });
    const getIntegrationJob = vi.fn(async () => completedJob);
    const listIntegrationJobEvents = vi.fn(async () => [jobEvent(completedJob)]);
    const services = {
      getIntegrationJob,
      listIntegrationJobEvents,
    } as unknown as SourceObservationServices;
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
    } as unknown as SourceObservationServices;
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
    } as unknown as SourceObservationServices;
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
    } as unknown as SourceObservationServices;
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
      context,
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
    } as unknown as SourceObservationServices;
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
    } as unknown as SourceObservationServices;
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
    } as unknown as SourceObservationServices;
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
    } as unknown as SourceObservationServices;
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
    } as unknown as SourceObservationServices;
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
    } as unknown as SourceObservationServices;
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
    } as unknown as SourceObservationServices;
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
    } as unknown as SourceObservationServices;
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

function jobEvent<TJob>(job: TJob, sequence = 1) {
  return {
    sequence,
    eventName: "status" as const,
    job,
    createdAt: "2026-05-28T00:00:00.000Z",
  };
}

function readSseData(text: string): unknown[] {
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data:".length).trim()));
}

function integrationJob(input: { status: "queued" | "running" | "completed" | "failed" }) {
  return integrationJobFixture({
    jobId: "job_integration",
    action: "import",
    scope: { provider: "tcgdex", language: "en", seriesId: "base" },
    status: input.status,
    progress: {
      phase: input.status === "completed" ? "completed" : "processing",
      completed: input.status === "completed" ? 1 : 0,
      total: 1,
      currentName: "Base Set",
      status: input.status === "completed" ? "imported" : null,
    },
    result:
      input.status === "completed"
        ? {
            requested: 1,
            imported: 1,
            observed: 102,
            reapplied: 0,
            skipped: 0,
            failed: 0,
            outcomes: [],
          }
        : null,
    errorMessage: null,
    createdAt: "2026-05-23T00:00:00.000Z",
    startedAt: input.status === "queued" ? null : "2026-05-23T00:00:01.000Z",
    completedAt: input.status === "completed" ? "2026-05-23T00:00:02.000Z" : null,
    updatedAt: "2026-05-23T00:00:02.000Z",
  });
}

function integrationJobFixture(
  input: Record<string, unknown> & {
    jobId?: string;
    action?: "import" | "reapply";
  },
) {
  return {
    ...baseIntegrationJob(),
    ...input,
  } as const;
}

function baseIntegrationJob() {
  return {
    jobId: "job_integration",
    action: "import" as const,
    scope: { provider: "tcgdex", language: "en", seriesId: "base" },
    status: "queued" as const,
    progress: {
      phase: "queued" as const,
      completed: 0,
      total: 0,
      currentName: null,
      status: null,
    },
    result: null as null | Record<string, unknown>,
    errorMessage: null,
    createdAt: "2026-05-23T00:00:00.000Z",
    startedAt: null as string | null,
    completedAt: null as string | null,
    updatedAt: "2026-05-23T00:00:02.000Z",
  };
}

function bulkJobFixture(
  input: Record<string, unknown> & {
    jobId?: string;
    action?: "promote" | "reject" | "reapply";
  },
) {
  return {
    ...baseBulkJob(),
    ...input,
  } as const;
}

function baseBulkJob() {
  return {
    jobId: "job_bulk",
    action: "promote" as const,
    selectionMode: "ids" as const,
    observationIds: [] as readonly string[],
    scope: {},
    reason: null as string | null,
    status: "queued" as const,
    progress: {
      phase: "queued" as const,
      completed: 0,
      total: 0,
      currentName: null,
      status: null,
    },
    result: null as null | Record<string, unknown>,
    errorMessage: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    startedAt: null as string | null,
    completedAt: null as string | null,
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}
