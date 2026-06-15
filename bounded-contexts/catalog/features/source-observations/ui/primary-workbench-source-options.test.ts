import {
  buildCatalogPrimaryWorkbenchReadModel,
  describe,
  expect,
  it,
  profileReview,
  sourceObservationScope,
  validateCatalogPrimaryWorkbenchReadModelContract,
} from "./primary-workbench-read-model-test-support";
import {
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
  type CatalogPrimaryWorkbenchSourceOptionPageSnapshot,
  type CatalogPrimaryWorkbenchSourceOptionRequest,
} from "./primary-workbench-read-model";
import type { SourceObservationIntegrationOptionResponse } from "./contracts";

const requestUrl =
  "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04";

describe("Catalog primary workbench source options", () => {
  it("uses typed route importScope segments when no observed scope row exists yet", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&importScope=ja:3:scarlet-violet:sv01",
      scopes: [],
      profiles: [profile],
      cacheOnly: true,
    });

    expect(requests.find((request) => request.queryKind === "series")).toMatchObject({
      languageCode: "ja",
      selectedParentValue: "ja",
    });
    expect(requests.find((request) => request.queryKind === "expansions")).toMatchObject({
      languageCode: "ja",
      parentValue: "scarlet-violet",
      selectedParentValue: "scarlet-violet",
    });
  });

  it("composes TCGdex language, series, and expansion option pages with parent selections", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const scope = sourceObservationScope();
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl,
      scopes: [scope],
      profiles: [profile],
      cacheOnly: true,
    });
    const pages = requests.map((request) => ({
      request,
      response: responseFor(request),
    }));

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl,
      scopes: { items: [scope], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      sourceOptionPages: pages,
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(() => validateCatalogPrimaryWorkbenchReadModelContract(readModel)).not.toThrow();
    expect(readModel.sourceOptions.optionKinds.map((kind) => kind.queryKind)).toEqual([
      "languages",
      "series",
      "expansions",
    ]);
    expect(readModel.sourceOptions.optionKinds.find((kind) => kind.queryKind === "series")?.parent).toMatchObject({
      scope: "language",
      selectedValue: "en",
      missing: false,
    });
    expect(readModel.sourceOptions.optionKinds.find((kind) => kind.queryKind === "expansions")?.parent).toMatchObject({
      scope: "series",
      selectedValue: "base",
      missing: false,
    });
    expect(Object.fromEntries(readModel.sourceOptions.pages.map((page) => [page.queryKind, page.state]))).toEqual({
      languages: "cached",
      series: "live",
      expansions: "stale",
    });
    expect(readModel.sourceOptions.pages.find((page) => page.queryKind === "expansions")?.cache.diagnostics).toEqual([
      expect.objectContaining({ code: "provider-option-query-stale-cache-used" }),
    ]);
    expect(readModel.sourceOptions.pages.find((page) => page.queryKind === "expansions")?.request).toMatchObject({
      languageCode: "en",
      parentValue: "base",
      cacheOnly: true,
    });
    expect(readModel.sourceOptions.refresh.refreshAllHref).toContain("forceRefresh=true");
    expect(readModel.sourceOptions.summary).toMatchObject({
      declaredKinds: 3,
      loadedPages: 3,
      stalePages: 1,
      degradedPages: 1,
      unavailablePages: 0,
    });
  });

  it("distinguishes unavailable, rollout-blocked, and stale option page states", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const scope = sourceObservationScope();
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl,
      scopes: [scope],
      profiles: [profile],
      cacheOnly: true,
    });
    const pages: readonly CatalogPrimaryWorkbenchSourceOptionPageSnapshot[] = requests.map((request) => {
      if (request.queryKind === "languages") {
        return {
          request,
          error: {
            status: 503,
            code: "catalog_provider_option_query_unavailable",
            message: "Provider option query cache is unavailable.",
            rolloutBlocked: false,
          },
        };
      }
      if (request.queryKind === "series") {
        return {
          request,
          error: {
            status: 403,
            code: "catalog_integration_rollout_control_denied",
            message: "Provider option queries are disabled.",
            rolloutBlocked: true,
          },
        };
      }
      return {
        request,
        response: responseFor(request),
      };
    });

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl,
      scopes: { items: [scope], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      sourceOptionPages: pages,
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(() => validateCatalogPrimaryWorkbenchReadModelContract(readModel)).not.toThrow();
    expect(Object.fromEntries(readModel.sourceOptions.pages.map((page) => [page.queryKind, page.state]))).toEqual({
      languages: "unavailable",
      series: "rollout-blocked",
      expansions: "stale",
    });
    expect(readModel.sourceOptions.status).toBe("blocked");
    expect(readModel.sourceOptions.summary).toMatchObject({
      stalePages: 1,
      unavailablePages: 1,
      rolloutBlockedPages: 1,
      degradedPages: 3,
    });
    expect(readModel.sourceOptions.refresh).toMatchObject({
      state: "blocked",
      blockers: ["read-model-unavailable"],
    });
  });
});

function responseFor(request: CatalogPrimaryWorkbenchSourceOptionRequest): SourceObservationIntegrationOptionResponse {
  if (request.queryKind === "languages") {
    return optionResponse(request, "fresh", "cache", [
      {
        value: "en",
        label: "English",
        parentValue: null,
        metadata: { languageCode: "en" },
      },
    ]);
  }
  if (request.queryKind === "series") {
    return optionResponse(request, "fresh", "live", [
      {
        value: "base",
        label: "Base",
        parentValue: "en",
        metadata: { languageCode: "en", seriesId: "base" },
      },
    ]);
  }
  return optionResponse(
    request,
    "stale",
    "cache",
    [
      {
        value: "base1",
        label: "Base Set",
        parentValue: "base",
        metadata: { languageCode: "en", seriesId: "base", expansionId: "base1" },
      },
    ],
    true,
  );
}

function optionResponse(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  status: NonNullable<SourceObservationIntegrationOptionResponse["cache"]>["status"],
  source: NonNullable<SourceObservationIntegrationOptionResponse["cache"]>["source"],
  items: readonly {
    value: string;
    label: string;
    parentValue: string | null;
    metadata: Record<string, string>;
  }[],
  degraded = false,
): SourceObservationIntegrationOptionResponse {
  return {
    items: items.map((item) => ({
      providerKey: request.providerKey,
      queryKind: request.queryKind,
      value: item.value,
      label: item.label,
      description: null,
      parentValue: item.parentValue,
      imageUrl: null,
      metadata: item.metadata,
    })),
    total: items.length,
    count: items.length,
    page: {
      cursor: request.cursor,
      nextCursor: null,
      limit: request.limit,
      hasMore: false,
    },
    cache: {
      status,
      source,
      cacheKey: `sha256:${request.queryKind}`,
      fetchedAt: "2026-06-09T00:00:00.000Z",
      expiresAt: "2026-06-09T00:15:00.000Z",
      staleUntil: "2026-06-10T00:00:00.000Z",
      cacheOnly: request.cacheOnly,
      forceRefresh: false,
      degraded,
      diagnostics: degraded
        ? [
            {
              code: "provider-option-query-stale-cache-used",
              severity: "warning",
              message: "Provider option query used stale cache.",
              retryAfterSeconds: null,
            },
          ]
        : [],
    },
  };
}
