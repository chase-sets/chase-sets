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
});
