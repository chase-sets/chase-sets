// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogApiError } from "../client";
import IntegrationsRoute, { action, loader } from "../routes/admin/integrations";
import { loader as providersLoader, action as providerDetailAction } from "../routes/admin/catalog-provider-detail";
import { action as governanceAction } from "../routes/admin/integrations-governance";
import type { CatalogIntegrationsCommandResult } from "../support/route-support/admin-integrations/integrations-command-result";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../features/source-observations/ui/primary-workbench-read-model";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../features/source-observations/ui/primary-workbench-route-context";
import { catalogPrimaryWorkbenchSourceOptionHref } from "../features/source-observations/ui/primary-workbench-source-option-refresh";
import {
  controlPlaneOverview,
  loaderData,
  integrationJobSummary,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "../features/source-observations/ui/primary-workbench-test-fixtures";
import type { CatalogIntegrationControlPlaneUnitReadiness } from "../features/source-observations/ui/contracts";

import {
  actionRequest,
  aliasReviewReadModel,
  lifecycleConfirmationValue,
  redirectLocation,
  lorcastLorcanaProfileReview,
  runDailyAction,
  runDailyActionRedirect,
  runGovernanceAction,
  runProviderDetailAction,
  scrydexLorcanaImportPreview,
  scrydexLorcanaProfileReview,
  scrydexOnePieceImportPreview,
  scrydexOnePieceProfileReview,
  sourceOptionResponse,
  tcgplayerReadinessUnit,
} from "./admin-integrations-route-test-support";

const {
  mockCreateCatalogRequestApiClient,
  mockIsTransientAuthResolutionError,
  mockResolveActorFromAuthApi,
  mockUseLoaderData,
  mockUseNavigate,
  mockUseRouteLoaderData,
  mockUseActionData,
} = vi.hoisted(() => ({
  mockCreateCatalogRequestApiClient: vi.fn(),
  mockIsTransientAuthResolutionError: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
  mockUseLoaderData: vi.fn(),
  mockUseNavigate: vi.fn(),
  mockUseRouteLoaderData: vi.fn(),
  mockUseActionData: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useNavigate: () => mockUseNavigate,
    useRouteLoaderData: mockUseRouteLoaderData,
    useActionData: mockUseActionData,
    // The import-jobs module polls live progress via useRevalidator and the daily
    // import-context form submits context changes via useSubmit; outside a data
    // router (this bare render) both need a stub so the workbench still renders.
    useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
    useSubmit: () => () => undefined,
  };
});

vi.mock("../support/request-support/api-client", () => ({
  createCatalogRequestApiClient: mockCreateCatalogRequestApiClient,
}));

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  isTransientAuthResolutionError: mockIsTransientAuthResolutionError,
  resolveActorFromAuthApi: mockResolveActorFromAuthApi,
}));

describe("Catalog integrations route", () => {
  afterEach(() => {
    cleanup();
    mockUseLoaderData.mockReset();
    mockUseNavigate.mockReset();
    mockUseRouteLoaderData.mockReset();
    mockUseActionData.mockReset();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTransientAuthResolutionError.mockReturnValue(false);
    mockResolveActorFromAuthApi.mockResolvedValue({
      permissions: ["catalog.view", "catalog.manage"],
    });
  });
  it("keeps provider-only TCGplayer importer routes renderable with all configured units selectable", async () => {
    const profileReviews = {
      items: [
        profileReview({
          providerKey: "tcgplayer",
          profileKey: "mtg-single-card-product-sku",
          profileVersion: "2026.06.19",
          ingestionUnitKey: "tcgplayer:mtg:single-card:source-observation-import",
          displayName: "TCGplayer Magic single cards",
          active: true,
          lifecycle: "active",
          status: "active",
          profile: {
            providerKey: "tcgplayer",
            supportedScopes: ["product-line/category", "set-name", "product", "sku"],
          },
          supportedScopes: ["product-line/category", "set-name", "product", "sku"],
        }),
        profileReview({
          providerKey: "tcgplayer",
          profileKey: "yugioh-single-card-product-sku",
          profileVersion: "2026.06.20",
          ingestionUnitKey: "tcgplayer:yugioh:single-card:source-observation-import",
          displayName: "TCGplayer Yu-Gi-Oh single cards",
          active: false,
          lifecycle: "test",
          status: "planned",
          profile: {
            providerKey: "tcgplayer",
            supportedScopes: ["product-line/category", "set-name", "product", "sku"],
          },
          supportedScopes: ["product-line/category", "set-name", "product", "sku"],
        }),
      ],
      total: 2,
      count: 2,
    };
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        count: 0,
        page: { cursor: null, nextCursor: null, limit: 25, hasMore: false },
        cache: {
          status: "stale",
          source: "cache",
          cacheKey: "sha256:empty",
          fetchedAt: null,
          expiresAt: null,
          staleUntil: null,
          cacheOnly: true,
          forceRefresh: false,
          degraded: true,
          diagnostics: [],
        },
      }),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request("https://admin.example/catalog/integrations?providerKey=tcgplayer"),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    const tcgplayer = routeData.readModel.providerScope.providers.find(
      (provider) => provider.providerKey === "tcgplayer",
    );
    expect(tcgplayer?.units.map((unit) => unit.unitKey)).toEqual(
      expect.arrayContaining([
        "tcgplayer:mtg:single-card:source-observation-import",
        "tcgplayer:yugioh:single-card:source-observation-import",
      ]),
    );
    expect(routeData.readModel.routeContext.providerKey).toBe("tcgplayer");
    expect(routeData.requestUrl).toBe("https://admin.example/catalog/integrations?providerKey=tcgplayer");
  });

  it("includes the selected configured TCGplayer Pokemon scope in Catalog sync participation", async () => {
    const pokemonUnit = "tcgplayer:pokemon:single-card:source-observation-import";
    const staleLorcastScope = sourceObservationScope({
      provider_key: "lorcast",
      product_line_id: undefined,
      product_line_name: "Disney Lorcana",
      series_id: undefined,
      series_name: undefined,
      expansion_id: undefined,
      expansion_name: "The First Chapter",
      observed_observations: 37,
      changed_observations: 4,
      promoted_observations: 2,
    });
    const pokemonTcgplayerScope = sourceObservationScope({
      provider_key: "tcgplayer",
      language_code: "en",
      product_line_id: "3",
      product_line_name: "Pokemon",
      series_id: undefined,
      series_name: undefined,
      expansion_id: undefined,
      expansion_name: "Base Set",
      observed_observations: 9,
      changed_observations: 1,
      promoted_observations: 0,
    });
    const tcgplayerProfile = profileReview({
      providerKey: "tcgplayer",
      profileKey: "pokemon-single-card-product-sku",
      profileVersion: "2026.06.03",
      ingestionUnitKey: pokemonUnit,
      displayName: "TCGplayer Pokemon Single Cards",
      active: true,
      lifecycle: "active",
      status: "active",
      profile: {
        providerKey: "tcgplayer",
        supportedScopes: ["product-line/category", "set-name", "product", "sku"],
      },
      supportedScopes: ["product-line/category", "set-name", "product", "sku"],
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi
        .fn()
        .mockResolvedValue({ items: [staleLorcastScope, pokemonTcgplayerScope], total: 2, count: 2 }),
      listSourceObservationProviderProfiles: vi
        .fn()
        .mockResolvedValue({ items: [tcgplayerProfile], total: 1, count: 1 }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(
        controlPlaneOverview({
          readiness: {
            ...controlPlaneOverview().readiness,
            units: [
              {
                ...controlPlaneOverview().readiness.units[0]!,
                unitKey: pokemonUnit,
                providerKey: "tcgplayer",
                displayName: "TCGplayer Pokemon Single Cards",
                productDomain: "pokemon",
                productForm: "single-card",
                ingestionPurpose: "source-observation-import",
                profileVersion: "2026.06.03",
                credentialReadiness: "not-required",
                credentialReadinessState: "not-required",
                credentialRequirement: "not-required",
                credentialDiagnosticCode: null,
                transportReadiness: "ready",
                fixtureValidationStatus: "ready",
                dryRunStatus: "completed",
              },
            ],
          },
          providerReadiness: {
            ...controlPlaneOverview().providerReadiness,
            providers: [
              {
                ...controlPlaneOverview().providerReadiness.providers[0]!,
                providerKey: "tcgplayer",
                adapterKey: "tcgplayer",
                unitKeys: [pokemonUnit],
              },
            ],
          },
          unitActivity: {
            ...controlPlaneOverview().unitActivity,
            units: [],
          },
        }),
      ),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        count: 0,
        page: { cursor: null, nextCursor: null, limit: 25, hasMore: false },
        cache: {
          status: "fresh",
          source: "cache",
          cacheKey: "sha256:empty",
          fetchedAt: "2026-06-26T16:00:00.000Z",
          expiresAt: "2026-06-26T17:00:00.000Z",
          staleUntil: null,
          cacheOnly: true,
          forceRefresh: false,
          degraded: false,
          diagnostics: [],
        },
      }),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Apokemon%3Asingle-card%3Asource-observation-import&languageCode=en&productLineId=3&productLineName=Pokemon&expansionName=Base+Set",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(
      routeData.readModel.providerScope.providers
        .find((provider) => provider.providerKey === "tcgplayer")
        ?.units.map((unit) => unit.unitKey),
    ).toContain(pokemonUnit);
    expect(routeData.readModel.sourceScopeWorkset.units.map((unit) => unit.unitKey)).toEqual([pokemonUnit]);
    expect(routeData.readModel.sourceScopeWorkset.units[0]).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: pokemonUnit,
      state: "changed",
      counts: {
        observed: 9,
        changed: 1,
        eligible: 10,
      },
      commandContext: {
        providerKey: "tcgplayer",
        productLineId: "3",
        productLineName: "Pokemon",
        expansionName: "Base Set",
      },
    });
    expect(routeData.readModel.catalogSync.preview.units).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        unitKey: pokemonUnit,
        selected: true,
        eligibility: "eligible",
        childExecutionScope: expect.objectContaining({
          provider: "tcgplayer",
          ingestionUnitKey: pokemonUnit,
          language: "en",
          productLineId: "3",
          setName: "Base Set",
        }),
      }),
    ]);
    expect(routeData.readModel.catalogSync.action).toMatchObject({
      key: "start-catalog-sync",
      state: "available",
      blockers: [],
    });
    expect(JSON.stringify(routeData.readModel.sourceScopeWorkset)).not.toContain("lorcast");
    expect(JSON.stringify(routeData.readModel.catalogSync)).not.toContain("The First Chapter");
  });

  it("uses canonical Catalog sync preview readiness before enabling a targeted TCGplayer sync", async () => {
    const pokemonUnit = "tcgplayer:pokemon:single-card:source-observation-import";
    const blocker = {
      code: "scope-parent-required" as const,
      severity: "error" as const,
      message: "Choose or map the provider product-line/category value before selecting this provider unit.",
      action: "Choose or map the provider product-line/category value before selecting this provider unit.",
    };
    const previewCatalogSyncScope = vi.fn().mockResolvedValue({
      previewVersion: "catalog-sync-provider-participation-preview-v1",
      scope: {
        scopeVersion: "catalog-sync-scope-v1",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "set", id: "Base Set", name: "Base Set", seriesId: null, seriesName: null },
        providerHints: [
          {
            providerKey: "tcgplayer",
            unitKey: pokemonUnit,
            productLineId: "3",
            setName: "Base Set",
          },
        ],
        providerParticipation: {
          requiredUnitKeys: [],
          selectedUnitKeys: [pokemonUnit],
          excludedUnitKeys: [],
        },
      },
      status: "blocked",
      startAllowed: false,
      explanation: "Required provider units must be eligible before this Catalog sync can start.",
      blockers: [blocker],
      units: [
        {
          providerKey: "tcgplayer",
          unitKey: pokemonUnit,
          profileKey: "pokemon-single-card-product-sku",
          profileVersion: "2026.06.03",
          displayName: "TCGplayer Pokemon Single Cards",
          role: "primary-source-observation",
          requirement: "required",
          eligibility: "ineligible",
          defaultSelected: false,
          selected: true,
          childExecutionScope: null,
          estimate: {
            targetCount: null,
            requestStrategy: null,
            estimatedRequestCount: null,
            estimateState: "not-requested",
            estimateReason: null,
            transportSteps: [],
          },
          blockers: [blocker],
          explanation: "TCGplayer Pokemon Single Cards is ineligible and blocks this Catalog sync.",
        },
      ],
    });

    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({
        items: [
          sourceObservationScope({
            provider_key: "tcgplayer",
            language_code: "en",
            product_line_id: "3",
            product_line_name: "Pokemon",
            series_id: undefined,
            series_name: undefined,
            expansion_id: undefined,
            expansion_name: "Base Set",
          }),
        ],
        total: 1,
        count: 1,
      }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue({
        items: [
          profileReview({
            providerKey: "tcgplayer",
            profileKey: "pokemon-single-card-product-sku",
            profileVersion: "2026.06.03",
            ingestionUnitKey: pokemonUnit,
            displayName: "TCGplayer Pokemon Single Cards",
            active: true,
            lifecycle: "active",
            status: "active",
            profile: {
              providerKey: "tcgplayer",
              supportedScopes: ["product-line/category", "set-name", "product", "sku"],
            },
            supportedScopes: ["product-line/category", "set-name", "product", "sku"],
          }),
        ],
        total: 1,
        count: 1,
      }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      previewCatalogSyncScope,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Apokemon%3Asingle-card%3Asource-observation-import&languageCode=en&productLineId=3&productLineName=Pokemon&expansionName=Base+Set",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(previewCatalogSyncScope).toHaveBeenCalledWith(
      expect.objectContaining({
        providerParticipation: expect.objectContaining({
          requiredUnitKeys: [],
          selectedUnitKeys: [pokemonUnit],
          excludedUnitKeys: [],
        }),
        providerHints: [
          expect.objectContaining({
            providerKey: "tcgplayer",
            unitKey: pokemonUnit,
            productLineId: "3",
            setName: "Base Set",
          }),
        ],
      }),
    );
    expect(routeData.readModel.catalogSync.preview.startAllowed).toBe(false);
    expect(routeData.readModel.catalogSync.action).toMatchObject({
      key: "start-catalog-sync",
      state: "blocked",
      blockers: expect.arrayContaining(["import-scope-required"]),
    });
    expect(routeData.readModel.catalogSync.preview.units[0]).toMatchObject({
      eligibility: "blocked",
      blockers: [expect.objectContaining({ message: blocker.message })],
    });
  });

  it("loads cache-only provider source option pages into the daily read model", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      const queryKind = params.get("queryKind") ?? "";
      return sourceOptionResponse(queryKind, {
        status: queryKind === "expansions" ? "stale" : "fresh",
        source: "cache",
        parentValue: params.get("parentValue"),
        degraded: queryKind === "expansions",
      });
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(listSourceObservationIntegrationOptions).toHaveBeenCalledTimes(3);
    const queries = listSourceObservationIntegrationOptions.mock.calls.map(([query]) => query);
    expect(queries.every((query) => new URLSearchParams(query).get("cacheOnly") === "true")).toBe(true);
    expect(queries.map((query) => new URLSearchParams(query).get("queryKind"))).toEqual([
      "languages",
      "series",
      "expansions",
    ]);
    expect(new URLSearchParams(queries[1]).get("languageCode")).toBe("en");
    expect(new URLSearchParams(queries[2]).get("parentValue")).toBe("base");
    expect(routeData).not.toHaveProperty("data");
    expect(routeData).not.toHaveProperty("profileReviews");
    expect(routeData).not.toHaveProperty("controlPlaneOverview");
    expect(routeData).not.toHaveProperty("reviewObservations");
    // The source-option fan-out is deferred (#1970): the synchronous read model
    // ships the structural skeleton (pages not yet loaded), and the populated
    // pages stream in behind the deferred slice the route view awaits.
    expect(routeData.readModel.sourceOptions.pages.every((page) => page.state === "unavailable")).toBe(true);
    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(Object.fromEntries(deferredSourceOptions.pages.map((page) => [page.queryKind, page.state]))).toEqual({
      languages: "cached",
      series: "cached",
      expansions: "stale",
    });
  });

  it("keeps structured TCGplayer set routes alive when deferred option rendering fails", async () => {
    const scopes = {
      items: [
        sourceObservationScope({
          provider_key: "tcgplayer",
          language_code: "en",
          product_line_id: "1",
          product_line_name: "Magic: The Gathering",
          series_id: "",
          series_name: "",
          expansion_id: "",
          expansion_name: "Classic Sixth Edition",
          total_observations: 0,
          observed_observations: 0,
          changed_observations: 0,
          promoted_observations: 0,
          rejected_observations: 0,
        }),
      ],
      total: 1,
      count: 1,
    };
    const profileReviews = {
      items: [
        profileReview({
          providerKey: "tcgplayer",
          profileKey: "mtg-single-card-product-sku",
          profileVersion: "2026.06.19",
          ingestionUnitKey: "tcgplayer:mtg:single-card:source-observation-import",
          displayName: "TCGplayer Magic Single Cards",
          lifecycle: "active",
          active: true,
          status: "active",
        }),
      ],
      total: 1,
      count: 1,
    };
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const queryKind = new URLSearchParams(query).get("queryKind") ?? "product-lines";
      const response = sourceOptionResponse(queryKind, {
        status: "fresh",
        source: "live",
        parentValue: null,
        degraded: false,
      });
      response.items[0]!.value = null as unknown as string;
      return response;
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&productLineId=1&expansionName=Classic+Sixth+Edition&sourceOptionAction=force-refresh-all",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext.scope).toMatchObject({
      providerKey: "tcgplayer",
      languageCode: "en",
      productLineId: "1",
      expansionName: "Classic Sixth Edition",
    });
    expect(routeData.readModel.routeContext.importScope).toBe("en:1:Classic Sixth Edition");
    expect(routeData.readModel.sourceScopeWorkset.selectedScope).toMatchObject({
      label: "tcgplayer / en / 1 / Classic Sixth Edition",
      importScope: "en:1:Classic Sixth Edition",
    });
    const tcgplayerUnit = routeData.readModel.sourceScopeWorkset.units.find(
      (unit) => unit.unitKey === "tcgplayer:mtg:single-card:source-observation-import",
    );
    expect(tcgplayerUnit?.currentWorkbenchHref).toContain("expansionName=Classic+Sixth+Edition");
    expect(tcgplayerUnit?.currentWorkbenchHref).toContain("importScope=en%3A1%3AClassic+Sixth+Edition");
    expect(tcgplayerUnit?.commandContext).toMatchObject({
      languageCode: "en",
      productLineId: "1",
      expansionName: "Classic Sixth Edition",
      importScope: "en:1:Classic Sixth Edition",
    });
    await expect(routeData.deferredSourceOptions).resolves.toMatchObject({
      pages: expect.arrayContaining([expect.objectContaining({ state: "unavailable" })]),
    });
  });

  it("drops stale legacy import scope before YGOJSON source option refresh", async () => {
    const profileReviews = {
      items: [
        profileReview({
          providerKey: "ygojson",
          profileKey: "ygojson-yugioh-set",
          profileVersion: "2026.06.21",
          ingestionUnitKey: "ygojson:yugioh:set:reference-data",
          displayName: "YGOJSON Yu-Gi-Oh sets",
          lifecycle: "active",
          active: true,
          status: "active",
          connectorKind: "ygojson",
          profile: {
            providerKey: "ygojson",
            supportedScopes: ["set-name"],
          },
          supportedScopes: ["set-name"],
          languageOptions: ["en"],
          sourceOptionKinds: [
            {
              queryKind: "sets",
              queryKeySynonyms: ["setName"],
              displayName: "Set",
              scope: "set-name",
              parentScope: null,
              parentRequired: false,
              parentValueKind: null,
              parentDiagnosticText: null,
            },
          ],
        }),
      ],
      total: 1,
      count: 1,
    };
    const listSourceObservations = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      return sourceOptionResponse(params.get("queryKind") ?? "sets", {
        status: "fresh",
        source: "live",
        parentValue: params.get("parentValue"),
        degraded: false,
        value: "25th Anniversary Rarity Collection",
        label: "25th Anniversary Rarity Collection",
      });
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations,
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=ygojson&unitKey=ygojson%3Ayugioh%3Aset%3Areference-data&importScope=ja%3ASV%3ASV8&seriesId=SV&expansionId=SV8&profileVersion=2026.06.21&filter.importScope=ja%3ASV%3ASV8&filter.providerKey=ygojson&sourceOptionAction=force-refresh&sourceOptionQueryKind=sets",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(listSourceObservations).toHaveBeenCalledOnce();
    const reviewQuery = new URLSearchParams(listSourceObservations.mock.calls[0]?.[0] ?? "");
    expect(reviewQuery.get("provider")).toBe("ygojson");
    expect(reviewQuery.get("language")).toBeNull();
    expect(reviewQuery.get("seriesId")).toBeNull();
    expect(reviewQuery.get("expansionId")).toBeNull();
    expect(reviewQuery.get("setId")).toBeNull();
    expect(routeData.readModel.routeContext.importScope).toBeNull();
    expect(routeData.readModel.routeContext.scope).toMatchObject({
      providerKey: "ygojson",
      languageCode: null,
      seriesId: null,
      expansionId: null,
    });
    expect(routeData.readModel.routeContext.sourceObservationFilters).toEqual({ providerKey: "ygojson" });
    const deferredSourceOptions = await routeData.deferredSourceOptions;
    const optionQuery = new URLSearchParams(listSourceObservationIntegrationOptions.mock.calls[0]?.[0] ?? "");
    expect(optionQuery.get("queryKind")).toBe("sets");
    expect(optionQuery.get("forceRefresh")).toBe("true");
    expect(optionQuery.get("languageCode")).toBe("en");
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "sets")).toMatchObject({
      state: "live",
      items: [expect.objectContaining({ label: "25th Anniversary Rarity Collection" })],
    });
  });
});
