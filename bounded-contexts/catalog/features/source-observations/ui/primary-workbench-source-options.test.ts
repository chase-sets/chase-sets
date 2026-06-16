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
import type { SourceObservationIntegrationOption, SourceObservationIntegrationOptionResponse } from "./contracts";

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

  it("composes native TCGdex language-series-expansion scope parents without a product-line segment", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&importScope=ja:SV:SV8",
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
      parentValue: "SV",
      selectedParentValue: "SV",
    });
  });

  it("does not inherit child parents from a representative row for explicit parent-only routes", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&languageCode=en",
      scopes: [
        sourceObservationScope({
          language_code: "en",
          product_line_id: "",
          product_line_name: "",
          series_id: "me",
          series_name: "Mega Evolution",
          expansion_id: "me01",
          expansion_name: "Mega Evolution Base",
        }),
      ],
      profiles: [profile],
      cacheOnly: true,
    });

    expect(requests.find((request) => request.queryKind === "series")).toMatchObject({
      languageCode: "en",
      selectedParentValue: "en",
    });
    expect(requests.find((request) => request.queryKind === "expansions")).toMatchObject({
      parentValue: null,
      selectedParentValue: null,
    });
  });

  it("hydrates parent source option context from an explicit child-only expansion selection", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const sv8Scope = sourceObservationScope({
      language_code: "ja",
      product_line_id: "",
      product_line_name: "",
      series_id: "SV",
      series_name: "Scarlet & Violet",
      expansion_id: "SV8",
      expansion_name: "Super Electric Breaker",
    });
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&expansionId=SV8";
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl,
      scopes: [sv8Scope],
      profiles: [profile],
      cacheOnly: true,
    });

    expect(requests.find((request) => request.queryKind === "series")).toMatchObject({
      languageCode: "ja",
      selectedParentValue: "ja",
      selectedParentLabel: "Japanese",
    });
    expect(requests.find((request) => request.queryKind === "expansions")).toMatchObject({
      languageCode: "ja",
      parentValue: "SV",
      selectedParentValue: "SV",
      selectedParentLabel: "Scarlet & Violet",
    });

    const pages = requests.map((request) => ({
      request,
      response: responseForJapaneseSv8(request),
    }));
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl,
      scopes: { items: [sv8Scope], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      sourceOptionPages: pages,
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.sourceOptions.optionKinds.find((kind) => kind.queryKind === "series")?.parent).toMatchObject({
      scope: "language",
      selectedValue: "ja",
      selectedLabel: "Japanese",
      missing: false,
    });
    expect(readModel.sourceOptions.optionKinds.find((kind) => kind.queryKind === "expansions")?.parent).toMatchObject({
      scope: "series",
      selectedValue: "SV",
      selectedLabel: "Scarlet & Violet",
      missing: false,
    });
    expect(readModel.sourceOptions.pages.find((page) => page.queryKind === "languages")?.items).toEqual([
      expect.objectContaining({ value: "ja", label: "Japanese" }),
    ]);
    expect(readModel.sourceOptions.pages.find((page) => page.queryKind === "series")?.items).toEqual([
      expect.objectContaining({ value: "SV", label: "Scarlet & Violet", parentValue: "ja" }),
    ]);
  });

  it("hydrates language context from an explicit series selection without inheriting an expansion", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const sv8Scope = sourceObservationScope({
      language_code: "ja",
      product_line_id: "",
      product_line_name: "",
      series_id: "SV",
      series_name: "Scarlet & Violet",
      expansion_id: "SV8",
      expansion_name: "Super Electric Breaker",
    });
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&seriesId=SV",
      scopes: [sv8Scope],
      profiles: [profile],
      cacheOnly: true,
    });

    expect(requests.find((request) => request.queryKind === "series")).toMatchObject({
      languageCode: "ja",
      selectedParentValue: "ja",
    });
    expect(requests.find((request) => request.queryKind === "expansions")).toMatchObject({
      languageCode: "ja",
      parentValue: "SV",
      selectedParentValue: "SV",
      selectedParentLabel: "Scarlet & Violet",
    });
    expect(requests.find((request) => request.queryKind === "expansions")?.queryHref).toContain("parentValue=SV");
  });

  it("surfaces stale Japanese SV8 expansion option cache on the selected-scope path", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const sv8Scope = sourceObservationScope({
      language_code: "ja",
      product_line_id: "",
      product_line_name: "",
      series_id: "sv",
      series_name: "Scarlet & Violet",
      expansion_id: "sv8",
      expansion_name: "Super Electric Breaker",
      total_observations: 130,
      observed_observations: 130,
      changed_observations: 130,
      promoted_observations: 0,
      rejected_observations: 0,
    });
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&languageCode=ja&seriesId=SV&expansionId=SV8";
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl,
      scopes: [sv8Scope],
      profiles: [profile],
      cacheOnly: true,
    });
    const pages = requests.map((request) => ({
      request,
      response:
        request.queryKind === "expansions"
          ? optionResponse(
              request,
              "stale",
              "cache",
              [
                {
                  value: "SV8",
                  label: "Super Electric Breaker",
                  parentValue: "SV",
                  metadata: { languageCode: "ja", seriesId: "SV", expansionId: "SV8" },
                },
              ],
              true,
            )
          : responseFor(request),
    }));

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl,
      scopes: { items: [sv8Scope], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      sourceOptionPages: pages,
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.routeContext.importScope).toBe("ja:SV:SV8");
    expect(readModel.sourceOptions.pages.find((page) => page.queryKind === "expansions")).toMatchObject({
      state: "stale",
      request: expect.objectContaining({
        languageCode: "ja",
        parentValue: "sv",
        cacheOnly: true,
      }),
      items: [expect.objectContaining({ value: "SV8", label: "Super Electric Breaker", metadata: {} })],
      cache: expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: "provider-option-query-stale-cache-used" })],
      }),
    });
    expect(readModel.sourceOptions.summary).toMatchObject({
      stalePages: 1,
      degradedPages: 1,
    });
  });

  it("caps source option page items and strips provider metadata from the route read model", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const request = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl,
      scopes: [sourceObservationScope()],
      profiles: [profile],
      cacheOnly: true,
    }).find((candidate) => candidate.queryKind === "expansions");
    expect(request).toBeTruthy();
    const response = optionResponse(
      request!,
      "fresh",
      "cache",
      Array.from({ length: 75 }, (_, index) => ({
        value: `base-${index}`,
        label: `Base option ${index}`,
        parentValue: "base",
        metadata: { providerPayload: `SENTINEL_METADATA_LEAK_${index}` },
      })),
    );

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl,
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      sourceOptionPages: [{ request: request!, response }],
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const page = readModel.sourceOptions.pages.find((candidate) => candidate.queryKind === "expansions");
    expect(page?.items).toHaveLength(25);
    expect(page?.page).toMatchObject({ total: 75, count: 25, limit: 25 });
    expect(page?.items.every((item) => Object.keys(item.metadata).length === 0)).toBe(true);
    expect(JSON.stringify(page)).not.toContain("SENTINEL_METADATA_LEAK");
  });

  it("renders English alias (native name) from typed option aliases without leaking metadata", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const request = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&languageCode=ja&seriesId=SV",
      scopes: [],
      profiles: [profile],
      cacheOnly: true,
    }).find((candidate) => candidate.queryKind === "expansions");
    expect(request).toBeTruthy();
    const response = optionResponse(request!, "fresh", "cache", [
      {
        value: "SV8",
        label: "超電ブレイカー",
        parentValue: "SV",
        aliases: [
          {
            aliasText: "Surging Sparks",
            aliasLanguageCode: "en",
            aliasType: "set-equivalent",
            confidence: "high",
            reviewStatus: "pending",
            sourceCategory: "provider-same-id-localized-endpoint",
            evidence: {},
          },
        ],
        metadata: { providerPayload: "SENTINEL_METADATA_LEAK" },
      },
    ]);

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&languageCode=ja&seriesId=SV",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      sourceOptionPages: [{ request: request!, response }],
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const page = readModel.sourceOptions.pages.find((candidate) => candidate.queryKind === "expansions");
    expect(page?.items).toEqual([
      expect.objectContaining({
        value: "SV8",
        label: "Surging Sparks (超電ブレイカー)",
        metadata: {},
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain("SENTINEL_METADATA_LEAK");
  });

  it("falls back to the native provider label when an option has no trustworthy English alias", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const request = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&languageCode=ja&seriesId=SV",
      scopes: [],
      profiles: [profile],
      cacheOnly: true,
    }).find((candidate) => candidate.queryKind === "expansions");
    expect(request).toBeTruthy();
    const response = optionResponse(request!, "fresh", "cache", [
      // A low-confidence candidate alias is not strong enough to drive the label.
      {
        value: "SV8",
        label: "超電ブレイカー",
        parentValue: "SV",
        aliases: [
          {
            aliasText: "Surging Sparks",
            aliasLanguageCode: "en",
            aliasType: "set-equivalent",
            confidence: "candidate",
            reviewStatus: "pending",
            sourceCategory: "provider-localized-name",
            evidence: {},
          },
        ],
        metadata: {},
      },
      // No aliases at all: provider with no aliases still renders safely.
      { value: "SV9", label: "バトルパートナーズ", parentValue: "SV", metadata: {} },
    ]);

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&languageCode=ja&seriesId=SV",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      sourceOptionPages: [{ request: request!, response }],
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const page = readModel.sourceOptions.pages.find((candidate) => candidate.queryKind === "expansions");
    expect(page?.items.map((item) => item.label)).toEqual(["超電ブレイカー", "バトルパートナーズ"]);
  });

  it("composes TCGplayer product-line option hierarchy from the same structured scope contract", () => {
    const profile = profileReview({ providerKey: "tcgplayer", active: true, lifecycle: "active" });
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgplayer&importScope=en:3",
      scopes: [],
      profiles: [profile],
      cacheOnly: true,
    });

    expect(requests.find((request) => request.queryKind === "product-lines")).toMatchObject({
      languageCode: "en",
      parentValue: null,
    });
    expect(requests.find((request) => request.queryKind === "set-names")).toMatchObject({
      languageCode: "en",
      parentValue: "3",
      selectedParentValue: "3",
    });
  });

  it("does not borrow another provider active profile for source option requests", () => {
    const tcgdexProfile = profileReview({ active: true, lifecycle: "active" });
    const scrydexProfile = profileReview({
      providerKey: "scrydex",
      profileKey: "scrydex-profile",
      displayName: "Scrydex",
      active: false,
      lifecycle: "test",
      profile: {
        providerKey: "scrydex",
        supportedScopes: ["product/card"],
      },
      supportedScopes: ["product/card"],
    });

    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=scrydex",
      scopes: [],
      profiles: [tcgdexProfile, scrydexProfile],
      cacheOnly: true,
    });

    expect(requests).toEqual([]);
  });

  it("uses the selected provider profile when a stale active profile from another provider is supplied", () => {
    const staleTcgdexProfile = profileReview({ active: true, lifecycle: "active" });
    const selectedTcgplayerProfile = profileReview({
      providerKey: "tcgplayer",
      profileKey: "pokemon-tcg-automation-client",
      profileVersion: "2026.06.05",
      displayName: "TCGplayer automation client",
      connectorKind: "tcgplayer-automation-client",
      active: true,
      lifecycle: "active",
    });
    const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&profileVersion=2026.06.05&importScope=en:3",
      scopes: [],
      profiles: [staleTcgdexProfile, selectedTcgplayerProfile],
      activeProfile: staleTcgdexProfile,
      cacheOnly: true,
    });

    expect(requests.map((request) => request.queryKind)).toEqual(["product-lines", "set-names", "products", "skus"]);
    expect(requests.every((request) => request.providerKey === "tcgplayer")).toBe(true);
    expect(requests.every((request) => request.profileVersion === "2026.06.05")).toBe(true);
    expect(requests.map((request) => request.queryKind)).not.toEqual(
      expect.arrayContaining(["languages", "series", "expansions"]),
    );
    expect(requests.find((request) => request.queryKind === "set-names")).toMatchObject({
      parentScope: "product-line/category",
      languageCode: "en",
      parentValue: "3",
      selectedParentValue: "3",
    });
  });

  it("does not borrow TCGdex option kinds or pages for a selected Scrydex profile route", () => {
    const activeTcgdexProfile = profileReview({ active: true, lifecycle: "active" });
    const selectedScrydexProfile = profileReview({
      providerKey: "scrydex",
      profileKey: "scryfall-card-fixture",
      profileVersion: "2026.06.03",
      displayName: "Scrydex",
      connectorKind: "scrydex-scryfall-json",
      active: false,
      lifecycle: "test",
      capabilities: ["source-observation-import", "external-reference-extraction"],
      supportedScopes: ["product/card"],
      mappingOutputKind: "provider-product",
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=scrydex&profileVersion=2026.06.03&languageCode=en&seriesId=base&expansionId=base1",
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "scrydex",
            product_line_id: "",
            product_line_name: "",
            series_id: "",
            series_name: "",
            expansion_id: "khm",
            expansion_name: "Kaldheim",
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: [activeTcgdexProfile, selectedScrydexProfile], total: 2, count: 2 },
      sourceOptionPages: [],
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.sourceOptions.selectedProviderKey).toBe("scrydex");
    expect(readModel.sourceOptions.selectedProfile).toMatchObject({
      providerKey: "scrydex",
      profileVersion: "2026.06.03",
      active: false,
    });
    expect(readModel.sourceOptions.optionKinds).toEqual([]);
    expect(readModel.sourceOptions.pages).toEqual([]);
    expect(readModel.sourceOptions.summary).toMatchObject({ declaredKinds: 0, loadedPages: 0, availableOptions: 0 });
    expect(JSON.stringify(readModel.sourceOptions)).not.toMatch(/languages|series|expansions/);
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
      selectedLabel: "English",
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
    expect(readModel.sourceOptions.pages.find((page) => page.queryKind === "languages")?.items).toEqual([
      expect.objectContaining({ value: "en", label: "English" }),
    ]);
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
        label: "en",
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

function responseForJapaneseSv8(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
): SourceObservationIntegrationOptionResponse {
  if (request.queryKind === "languages") {
    return optionResponse(request, "fresh", "cache", [
      {
        value: "ja",
        label: "ja",
        parentValue: null,
        metadata: { languageCode: "ja" },
      },
    ]);
  }
  if (request.queryKind === "series") {
    return optionResponse(request, "fresh", "cache", [
      {
        value: "SV",
        label: "Scarlet & Violet",
        parentValue: "ja",
        metadata: { languageCode: "ja", seriesId: "SV" },
      },
    ]);
  }
  return optionResponse(request, "fresh", "cache", [
    {
      value: "SV8",
      label: "Super Electric Breaker",
      parentValue: "SV",
      metadata: { languageCode: "ja", seriesId: "SV", expansionId: "SV8" },
    },
  ]);
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
    aliases?: SourceObservationIntegrationOption["aliases"];
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
      aliases: item.aliases ?? [],
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
