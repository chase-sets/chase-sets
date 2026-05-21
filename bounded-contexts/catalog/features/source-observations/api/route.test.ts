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
    const importTcgdexSet = vi.fn(async () => ({
      setId: "base1",
      expansionId: "base1",
      languageCode: "en",
      observed: 102,
      observationIds: [],
    }));
    const services = {
      importTcgdexSet,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/imports/tcgdex-set", {
      method: "POST",
      body: JSON.stringify({ languageCode: "en", expansionId: "base1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(importTcgdexSet).toHaveBeenCalledWith({
      languageCode: "en",
      setId: "base1",
      context,
    });
  });

  it("streams TCGdex import progress events", async () => {
    const importTcgdexSet = vi.fn(async (input: {
      onProgress?: (progress: unknown) => void;
    }) => {
      input.onProgress?.({
        phase: "fetching",
        completed: 1,
        total: 2,
        currentName: "Bulbasaur",
      });

      return {
        setId: "base1",
        expansionId: "base1",
        languageCode: "en",
        observed: 2,
        observationIds: ["obs_1", "obs_2"],
      };
    });
    const services = {
      importTcgdexSet,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request(
      "/source-observations/imports/tcgdex-set/progress",
      {
        method: "POST",
        body: JSON.stringify({ languageCode: "en", expansionId: "base1" }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual([
      {
        type: "progress",
        progress: {
          phase: "fetching",
          completed: 1,
          total: 2,
          currentName: "Bulbasaur",
        },
      },
      {
        type: "result",
        result: {
          setId: "base1",
          expansionId: "base1",
          languageCode: "en",
          observed: 2,
          observationIds: ["obs_1", "obs_2"],
        },
      },
    ]);
  });

  it("lists TCGdex metadata for language, series, and expansion selectors", async () => {
    const listTcgdexLanguages = vi.fn(async () => [
      { languageCode: "en" },
    ]);
    const listTcgdexSeries = vi.fn(async () => [
      { seriesId: "me", name: "Mega Evolution", logoUrl: null },
    ]);
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

  it("bulk promotes observations matching an explicit filter scope", async () => {
    const promoteObservationScope = vi.fn(async () => ({
      requested: 100,
      promoted: 99,
      skipped: 1,
      failed: 0,
      outcomes: [],
    }));
    const services = {
      promoteObservationScope,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote", {
      method: "POST",
      body: JSON.stringify({
        scope: { status: "observed", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requested: 100,
      promoted: 99,
      skipped: 1,
      failed: 0,
    });
    expect(promoteObservationScope).toHaveBeenCalledWith({
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

  it("bulk promotes the explicit observation ids from the request body", async () => {
    const promoteObservations = vi.fn(async () => ({
      requested: 2,
      promoted: 1,
      skipped: 1,
      failed: 0,
      outcomes: [
        {
          observationId: "obs_1",
          status: "promoted" as const,
          catalogItemId: "cat_1" as never,
          reason: null,
        },
        {
          observationId: "obs_2",
          status: "skipped" as const,
          catalogItemId: "cat_existing" as never,
          reason: "Source observation is already promoted.",
        },
      ],
    }));
    const services = {
      promoteObservations,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote", {
      method: "POST",
      body: JSON.stringify({ observationIds: ["obs_1", "obs_2"] }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requested: 2,
      promoted: 1,
      skipped: 1,
      failed: 0,
    });
    expect(promoteObservations).toHaveBeenCalledWith({
      observationIds: ["obs_1", "obs_2"],
      context,
    });
  });

  it("streams bulk promotion progress events", async () => {
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
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const getBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
      getBulkReviewJob,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote/progress", {
      method: "POST",
      body: JSON.stringify({
        scope: { status: "observed", source: "tcgdex", language: "en", setId: "base1" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual([
      {
        type: "progress",
        progress: {
          phase: "processing",
          completed: 1,
          total: 2,
          currentName: "Bulbasaur",
          status: "promoted",
        },
        jobId: "job_1",
      },
      {
        type: "result",
        result: {
          requested: 2,
          promoted: 1,
          skipped: 1,
          failed: 0,
          outcomes: [],
        },
        jobId: "job_1",
      },
    ]);
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "promote",
      observationIds: [],
      scope: {
        search: undefined,
        status: "observed",
        provider: "tcgdex",
        language: "en",
        setId: "base1",
      },
      context,
    });
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

  it("bulk rejects explicit observation ids with the shared reason", async () => {
    const rejectObservations = vi.fn(async () => ({
      requested: 2,
      promoted: 0,
      rejected: 2,
      skipped: 0,
      failed: 0,
      outcomes: [],
    }));
    const services = {
      rejectObservations,
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requested: 2,
      rejected: 2,
    });
    expect(rejectObservations).toHaveBeenCalledWith({
      observationIds: ["obs_1", "obs_2"],
      reason: "Duplicate provider row.",
      context,
    });
  });

  it("bulk rejects observations matching an explicit filter scope", async () => {
    const rejectObservationScope = vi.fn(async () => ({
      requested: 3,
      promoted: 0,
      rejected: 3,
      skipped: 0,
      failed: 0,
      outcomes: [],
    }));
    const services = {
      rejectObservationScope,
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requested: 3,
      rejected: 3,
    });
    expect(rejectObservationScope).toHaveBeenCalledWith({
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

  it("streams bulk rejection progress events", async () => {
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
    const enqueueBulkReviewJob = vi.fn(async () => job);
    const getBulkReviewJob = vi.fn(async () => job);
    const services = {
      enqueueBulkReviewJob,
      getBulkReviewJob,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-reject/progress", {
      method: "POST",
      body: JSON.stringify({
        observationIds: ["obs_1"],
        reason: "Duplicate provider row.",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual([
      {
        type: "progress",
        progress: {
          phase: "processing",
          completed: 1,
          total: 1,
          currentName: "Ivysaur",
          status: "rejected",
        },
        jobId: "job_2",
      },
      {
        type: "result",
        result: {
          requested: 1,
          promoted: 0,
          rejected: 1,
          skipped: 0,
          failed: 0,
          outcomes: [],
        },
        jobId: "job_2",
      },
    ]);
    expect(enqueueBulkReviewJob).toHaveBeenCalledWith({
      action: "reject",
      observationIds: ["obs_1"],
      scope: undefined,
      reason: "Duplicate provider row.",
      context,
    });
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
