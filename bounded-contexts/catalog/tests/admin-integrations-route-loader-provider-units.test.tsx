// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogApiError } from "../client";
import IntegrationsRoute, { action, loader } from "../routes/admin/integrations";
import { loader as providersLoader, action as providerSetupAction } from "../routes/admin/integrations-providers";
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
  runProviderSetupAction,
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
  it("keeps provider-only TCGplayer units selectable when profile reviews are temporarily unavailable", async () => {
    const pokemonUnit = "tcgplayer:pokemon:single-card:source-observation-import";
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const baseOverview = controlPlaneOverview();
    const overview = controlPlaneOverview({
      readiness: {
        ...baseOverview.readiness,
        units: [
          tcgplayerReadinessUnit(pokemonUnit, "Pokemon", "pokemon"),
          tcgplayerReadinessUnit(mtgUnit, "Magic", "mtg"),
          tcgplayerReadinessUnit(yugiohUnit, "Yu-Gi-Oh", "yugioh"),
        ],
      },
      unitActivity: {
        ...baseOverview.unitActivity,
        units: [
          { unitKey: pokemonUnit, recentJobs: [] },
          { unitKey: mtgUnit, recentJobs: [] },
          { unitKey: yugiohUnit, recentJobs: [] },
        ],
      },
      providerReadiness: {
        ...baseOverview.providerReadiness,
        providers: [
          {
            ...baseOverview.providerReadiness.providers[0]!,
            providerKey: "tcgplayer",
            adapterKey: "tcgplayer",
            unitKeys: [pokemonUnit, mtgUnit, yugiohUnit],
          },
        ],
      },
    });
    const listSourceObservationProviderProfiles = vi.fn().mockRejectedValue(new Error("profile review API failed"));
    const listSourceObservationIntegrationOptions = vi.fn().mockRejectedValue(new Error("ambiguous option query"));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationProviderProfiles,
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(overview),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request("https://admin.example/catalog/integrations?providerKey=tcgplayer"),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(listSourceObservationProviderProfiles).toHaveBeenCalledOnce();
    expect(routeData.readModel.routeContext).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: null,
      importScope: null,
    });
    expect(
      routeData.readModel.providerScope.providers
        .find((provider) => provider.providerKey === "tcgplayer")
        ?.units.map((unit) => unit.unitKey),
    ).toEqual([mtgUnit, pokemonUnit, yugiohUnit]);
    expect(routeData.readModel.sourceScopeWorkset.units.map((unit) => unit.unitKey)).toEqual([
      mtgUnit,
      pokemonUnit,
      yugiohUnit,
    ]);

    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).not.toHaveBeenCalled();
    expect(deferredSourceOptions.pages).toEqual([]);
  });

  it("keeps the provider-only TCGplayer importer shell renderable when optional read projections fail", async () => {
    const pokemonUnit = "tcgplayer:pokemon:single-card:source-observation-import";
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const profiles = [
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "pokemon-single-card-product-sku",
        profileVersion: "2026.06.05",
        ingestionUnitKey: pokemonUnit,
        displayName: "TCGplayer Pokemon Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        supportedScopes: ["pokemon/single-card"],
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "mtg-single-card-product-sku",
        profileVersion: "2026.06.19",
        ingestionUnitKey: mtgUnit,
        displayName: "TCGplayer Magic Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        supportedScopes: ["mtg/single-card"],
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "yugioh-single-card-product-sku",
        profileVersion: "2026.06.20",
        ingestionUnitKey: yugiohUnit,
        displayName: "TCGplayer Yu-Gi-Oh Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        supportedScopes: ["yugioh/single-card"],
      }),
    ];
    const stalePokemonScope = sourceObservationScope({
      provider_key: "tcgplayer",
      language_code: "ja",
      product_line_id: "3",
      product_line_name: "Pokemon",
      series_id: "SV",
      series_name: "Scarlet & Violet",
      expansion_id: "SV8",
      expansion_name: "Super Electric Breaker",
    });
    const listSourceObservationIntegrationScopes = vi
      .fn()
      .mockResolvedValue({ items: [stalePokemonScope], total: 1, count: 1 });
    const listSourceObservations = vi.fn().mockRejectedValue(new Error("review projection failed"));
    const getCatalogIntegrationControlPlaneOverview = vi
      .fn()
      .mockRejectedValue(new Error("overview projection failed"));
    const listSourceObservationIntegrationOptions = vi.fn().mockRejectedValue(new Error("ambiguous option query"));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes,
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue({ items: profiles, total: 3, count: 3 }),
      getCatalogIntegrationControlPlaneOverview,
      listSourceObservations,
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request("https://admin.example/catalog/integrations?providerKey=tcgplayer"),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(listSourceObservationIntegrationScopes).toHaveBeenCalled();
    expect(getCatalogIntegrationControlPlaneOverview).toHaveBeenCalledWith("daily");
    const reviewQuery = new URLSearchParams(listSourceObservations.mock.calls[0]?.[0] ?? "");
    expect(reviewQuery.get("provider")).toBe("tcgplayer");
    expect(routeData.readModel.routeContext).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: null,
      importScope: null,
      sourceObservationFilters: { providerKey: "tcgplayer" },
    });
    expect(routeData.readModel.readiness.freshness).toBe("unavailable");
    expect(routeData.readModel.sourceObservationReview.freshness).toBe("unavailable");
    expect(routeData.readModel.sourceScopeWorkset.status).toBe("scope-required");
    expect(routeData.readModel.actions.find((actionEntry) => actionEntry.key === "preview-promotion")).toMatchObject({
      state: "unavailable",
      blockers: ["read-model-unavailable"],
      copyKey: "catalog.primary.review.blocked",
    });
    expect(
      routeData.readModel.actions.find((actionEntry) => actionEntry.key === "reject-source-observations"),
    ).toMatchObject({
      state: "unavailable",
      blockers: ["read-model-unavailable"],
      copyKey: "catalog.primary.review.blocked",
    });
    expect(
      routeData.readModel.providerScope.providers
        .find((provider) => provider.providerKey === "tcgplayer")
        ?.units.map((unit) => unit.unitKey),
    ).toEqual([mtgUnit, pokemonUnit, yugiohUnit]);
    expect(routeData.readModel.sourceScopeWorkset.units.map((unit) => unit.unitKey)).toEqual([
      mtgUnit,
      pokemonUnit,
      yugiohUnit,
    ]);

    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).not.toHaveBeenCalled();
    expect(deferredSourceOptions.selectedProfile).toBeNull();
    expect(deferredSourceOptions.pages).toEqual([]);
    expect(deferredSourceOptions.refresh.refreshAllHref).toBeNull();
  });

  it("keeps the provider-only TCGplayer importer shell renderable when the optional overview payload is incomplete", async () => {
    const pokemonUnit = "tcgplayer:pokemon:single-card:source-observation-import";
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const profiles = [
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "pokemon-single-card-product-sku",
        profileVersion: "2026.06.05",
        ingestionUnitKey: pokemonUnit,
        displayName: "TCGplayer Pokemon Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        supportedScopes: ["pokemon/single-card"],
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "mtg-single-card-product-sku",
        profileVersion: "2026.06.19",
        ingestionUnitKey: mtgUnit,
        displayName: "TCGplayer Magic Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        supportedScopes: ["mtg/single-card"],
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "yugioh-single-card-product-sku",
        profileVersion: "2026.06.20",
        ingestionUnitKey: yugiohUnit,
        displayName: "TCGplayer Yu-Gi-Oh Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        supportedScopes: ["yugioh/single-card"],
      }),
    ];
    const stalePokemonScope = sourceObservationScope({
      provider_key: "tcgplayer",
      language_code: "ja",
      product_line_id: "3",
      product_line_name: "Pokemon",
      series_id: "SV",
      series_name: "Scarlet & Violet",
      expansion_id: "SV8",
      expansion_name: "Super Electric Breaker",
    });
    const incompleteOverview = {
      ...controlPlaneOverview(),
      generatedAt: "2026-06-22T04:18:00.000Z",
    };
    delete (incompleteOverview as unknown as Record<string, unknown>).readiness;
    const listSourceObservationIntegrationOptions = vi.fn().mockRejectedValue(new Error("ambiguous option query"));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi
        .fn()
        .mockResolvedValue({ items: [stalePokemonScope], total: 1, count: 1 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue({ items: profiles, total: 3, count: 3 }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(incompleteOverview),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request("https://admin.example/catalog/integrations?providerKey=tcgplayer"),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: null,
      importScope: null,
      sourceObservationFilters: { providerKey: "tcgplayer" },
    });
    expect(routeData.readModel.readiness.freshness).toBe("unavailable");
    expect(routeData.readModel.importJobs.freshness).toBe("unavailable");
    expect(routeData.readModel.sourceScopeWorkset.status).toBe("scope-required");
    expect(
      routeData.readModel.providerScope.providers
        .find((provider) => provider.providerKey === "tcgplayer")
        ?.units.map((unit) => unit.unitKey),
    ).toEqual([mtgUnit, pokemonUnit, yugiohUnit]);

    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).not.toHaveBeenCalled();
    expect(deferredSourceOptions.pages).toEqual([]);
  });

  it("keeps the provider-only TCGplayer importer shell renderable when optional fulfilled projections are malformed", async () => {
    const pokemonUnit = "tcgplayer:pokemon:single-card:source-observation-import";
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const profiles = [
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "pokemon-single-card-product-sku",
        profileVersion: "2026.06.05",
        ingestionUnitKey: pokemonUnit,
        displayName: "TCGplayer Pokemon Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        supportedScopes: ["pokemon/single-card"],
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "mtg-single-card-product-sku",
        profileVersion: "2026.06.19",
        ingestionUnitKey: mtgUnit,
        displayName: "TCGplayer Magic Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        supportedScopes: ["mtg/single-card"],
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "yugioh-single-card-product-sku",
        profileVersion: "2026.06.20",
        ingestionUnitKey: yugiohUnit,
        displayName: "TCGplayer Yu-Gi-Oh Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        supportedScopes: ["yugioh/single-card"],
      }),
    ];
    const malformedOverview = {
      ...controlPlaneOverview(),
      generatedAt: "2026-06-22T04:50:00.000Z",
    };
    delete (malformedOverview as unknown as Record<string, unknown>).readiness;
    const malformedScopes = {
      items: { provider_key: "tcgplayer" },
      total: "bad-total",
      count: null,
    };
    const malformedReviewObservations = {
      items: [
        sourceObservationListItem({
          provider_key: "tcgplayer",
          normalized: null as never,
        }),
      ],
      total: 1,
      count: 1,
    };
    const listSourceObservationIntegrationOptions = vi.fn().mockRejectedValue(new Error("ambiguous option query"));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(malformedScopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue({ items: profiles, total: 3, count: 3 }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(malformedOverview),
      listSourceObservations: vi.fn().mockResolvedValue(malformedReviewObservations),
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request("https://admin.example/catalog/integrations?providerKey=tcgplayer"),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: null,
      importScope: null,
      sourceObservationFilters: { providerKey: "tcgplayer" },
    });
    expect(routeData.readModel.readiness.freshness).toBe("unavailable");
    expect(routeData.readModel.importJobs.freshness).toBe("unavailable");
    expect(routeData.readModel.sourceObservationReview.freshness).toBe("unavailable");
    expect(routeData.readModel.sourceObservationReview.rows).toEqual([]);
    expect(routeData.readModel.sourceScopeWorkset.status).toBe("scope-required");
    expect(
      routeData.readModel.providerScope.providers
        .find((provider) => provider.providerKey === "tcgplayer")
        ?.units.map((unit) => unit.unitKey),
    ).toEqual([mtgUnit, pokemonUnit, yugiohUnit]);
    expect(routeData.readModel.sourceScopeWorkset.units.map((unit) => unit.unitKey)).toEqual([
      mtgUnit,
      pokemonUnit,
      yugiohUnit,
    ]);

    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).not.toHaveBeenCalled();
    expect(deferredSourceOptions.pages).toEqual([]);
    expect(deferredSourceOptions.refresh.refreshAllHref).toBeNull();
  });

  it("keeps the TCGplayer Yu-Gi-Oh unit importer shell renderable before source scope selection", async () => {
    const pokemonUnit = "tcgplayer:pokemon:single-card:source-observation-import";
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const sourceOptionKinds = [
      {
        queryKind: "product-lines",
        queryKeySynonyms: ["productLineId"],
        displayName: "Product Line",
        scope: "product-line/category",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
      {
        queryKind: "set-names",
        queryKeySynonyms: ["setName"],
        displayName: "Set Name",
        scope: "set-name",
        parentScope: "product-line/category",
        parentRequired: true,
        parentValueKind: "product-line-id",
        parentDiagnosticText: "Select Product Line before Set Name.",
      },
    ];
    const profiles = [
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "pokemon-single-card-product-sku",
        profileVersion: "2026.06.05",
        ingestionUnitKey: pokemonUnit,
        displayName: "TCGplayer Pokemon Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        connectorKind: "tcgplayer-automation-client",
        supportedScopes: ["product-line/category", "set-name"],
        sourceOptionKinds,
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "mtg-single-card-product-sku",
        profileVersion: "2026.06.19",
        ingestionUnitKey: mtgUnit,
        displayName: "TCGplayer Magic Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        connectorKind: "tcgplayer-automation-client",
        supportedScopes: ["product-line/category", "set-name"],
        sourceOptionKinds,
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "yugioh-single-card-product-sku",
        profileVersion: "2026.06.20",
        ingestionUnitKey: yugiohUnit,
        displayName: "TCGplayer Yu-Gi-Oh Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        connectorKind: "tcgplayer-automation-client",
        supportedScopes: ["product-line/category", "set-name"],
        sourceOptionKinds,
      }),
    ];
    const stalePokemonScope = sourceObservationScope({
      provider_key: "tcgplayer",
      language_code: "ja",
      product_line_id: "3",
      product_line_name: "Pokemon",
      series_id: "SV",
      series_name: "Scarlet & Violet",
      expansion_id: "SV8",
      expansion_name: "Super Electric Breaker",
    });
    const listSourceObservationIntegrationScopes = vi
      .fn()
      .mockResolvedValue({ items: [stalePokemonScope], total: 1, count: 1 });
    const listSourceObservations = vi.fn().mockRejectedValue(new Error("review projection failed"));
    const getCatalogIntegrationControlPlaneOverview = vi
      .fn()
      .mockRejectedValue(new Error("overview projection failed"));
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      return sourceOptionResponse(params.get("queryKind") ?? "product-lines", {
        status: "fresh",
        source: "live",
        parentValue: params.get("parentValue"),
        degraded: false,
        value: "2",
        label: "Yu-Gi-Oh!",
      });
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes,
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue({ items: profiles, total: 3, count: 3 }),
      getCatalogIntegrationControlPlaneOverview,
      listSourceObservations,
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Ayugioh%3Asingle-card%3Asource-observation-import",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(listSourceObservationIntegrationScopes).toHaveBeenCalled();
    expect(getCatalogIntegrationControlPlaneOverview).toHaveBeenCalledWith("daily");
    const reviewQuery = new URLSearchParams(listSourceObservations.mock.calls[0]?.[0] ?? "");
    expect(reviewQuery.get("provider")).toBe("tcgplayer");
    expect(reviewQuery.get("language")).toBeNull();
    expect(reviewQuery.get("productLineId")).toBeNull();
    expect(reviewQuery.get("seriesId")).toBeNull();
    expect(reviewQuery.get("expansionId")).toBeNull();
    expect(routeData.readModel.routeContext).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: yugiohUnit,
      importScope: null,
      sourceObservationFilters: { providerKey: "tcgplayer" },
    });
    expect(routeData.readModel.readiness.freshness).toBe("unavailable");
    expect(routeData.readModel.sourceObservationReview.freshness).toBe("unavailable");
    expect(routeData.readModel.sourceScopeWorkset.status).toBe("scope-required");
    expect(routeData.readModel.sourceOptions.selectedProfile).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "yugioh-single-card-product-sku",
    });
    expect(routeData.readModel.sourceOptions.selectedUnitKey).toBe(yugiohUnit);
    expect(
      routeData.readModel.providerScope.providers
        .find((provider) => provider.providerKey === "tcgplayer")
        ?.units.map((unit) => unit.unitKey),
    ).toEqual([mtgUnit, pokemonUnit, yugiohUnit]);

    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).toHaveBeenCalledTimes(1);
    const optionQuery = new URLSearchParams(listSourceObservationIntegrationOptions.mock.calls[0]?.[0] ?? "");
    expect(optionQuery.get("queryKind")).toBe("product-lines");
    expect(optionQuery.get("profileKey")).toBe("yugioh-single-card-product-sku");
    expect(optionQuery.get("ingestionUnitKey")).toBe(yugiohUnit);
    expect(deferredSourceOptions.selectedProfile).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "yugioh-single-card-product-sku",
    });
    expect(deferredSourceOptions.selectedUnitKey).toBe(yugiohUnit);
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "product-lines")).toMatchObject({
      state: "live",
      items: [expect.objectContaining({ label: "Yu-Gi-Oh!" })],
    });
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "set-names")).toMatchObject({
      state: "not-requested",
      request: expect.objectContaining({ parentValue: null }),
    });
  });

  it("keeps the selected TCGplayer Yu-Gi-Oh route renderable with legacy required-parent option metadata", async () => {
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const legacySourceOptionKinds = [
      {
        queryKind: "product-lines",
        queryKeySynonyms: ["productLineId"],
        displayName: "Product Line",
        scope: "product-line/category",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
      {
        queryKind: "set-names",
        queryKeySynonyms: ["setName"],
        displayName: "Set Name",
        scope: "set-name",
        parentScope: null,
        parentRequired: true,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
    ];
    const profiles = [
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "mtg-single-card-product-sku",
        profileVersion: "2026.06.19",
        ingestionUnitKey: mtgUnit,
        displayName: "TCGplayer Magic Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        connectorKind: "tcgplayer-automation-client",
        supportedScopes: ["product-line/category", "set-name"],
        sourceOptionKinds: legacySourceOptionKinds,
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "yugioh-single-card-product-sku",
        profileVersion: "2026.06.20",
        ingestionUnitKey: yugiohUnit,
        displayName: "TCGplayer Yu-Gi-Oh Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        connectorKind: "tcgplayer-automation-client",
        supportedScopes: ["product-line/category", "set-name"],
        sourceOptionKinds: legacySourceOptionKinds,
      }),
    ];
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      return sourceOptionResponse(params.get("queryKind") ?? "product-lines", {
        status: "fresh",
        source: "live",
        parentValue: params.get("parentValue"),
        degraded: false,
        value: "2",
        label: "Yu-Gi-Oh!",
      });
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue({ items: profiles, total: 2, count: 2 }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Ayugioh%3Asingle-card%3Asource-observation-import",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: yugiohUnit,
      importScope: null,
      sourceObservationFilters: { providerKey: "tcgplayer" },
    });
    expect(routeData.readModel.sourceOptions.optionKinds.find((kind) => kind.queryKind === "set-names")).toMatchObject({
      parent: expect.objectContaining({
        scope: "product-line/category",
        required: true,
        valueKind: "product-line-id",
        missing: true,
        diagnosticText: "Select a product-line/category value before loading Set Name.",
      }),
    });

    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).toHaveBeenCalledTimes(1);
    const optionQuery = new URLSearchParams(listSourceObservationIntegrationOptions.mock.calls[0]?.[0] ?? "");
    expect(optionQuery.get("queryKind")).toBe("product-lines");
    expect(optionQuery.get("profileKey")).toBe("yugioh-single-card-product-sku");
    expect(optionQuery.get("ingestionUnitKey")).toBe(yugiohUnit);
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "set-names")).toMatchObject({
      state: "not-requested",
      blockers: ["selection-empty"],
      request: expect.objectContaining({ parentValue: null }),
      cache: expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: "provider-source-option-parent-required",
          }),
        ],
      }),
    });
  });

  it("keeps the TCGplayer Yu-Gi-Oh unit importer shell renderable when overview reports active jobs", async () => {
    const pokemonUnit = "tcgplayer:pokemon:single-card:source-observation-import";
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const sourceOptionKinds = [
      {
        queryKind: "product-lines",
        queryKeySynonyms: ["productLineId"],
        displayName: "Product Line",
        scope: "product-line/category",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
      {
        queryKind: "set-names",
        queryKeySynonyms: ["setName"],
        displayName: "Set Name",
        scope: "set-name",
        parentScope: "product-line/category",
        parentRequired: true,
        parentValueKind: "product-line-id",
        parentDiagnosticText: "Select Product Line before Set Name.",
      },
    ];
    const profiles = [
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "pokemon-single-card-product-sku",
        profileVersion: "2026.06.05",
        ingestionUnitKey: pokemonUnit,
        displayName: "TCGplayer Pokemon Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        connectorKind: "tcgplayer-automation-client",
        supportedScopes: ["product-line/category", "set-name"],
        sourceOptionKinds,
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "mtg-single-card-product-sku",
        profileVersion: "2026.06.19",
        ingestionUnitKey: mtgUnit,
        displayName: "TCGplayer Magic Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        connectorKind: "tcgplayer-automation-client",
        supportedScopes: ["product-line/category", "set-name"],
        sourceOptionKinds,
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "yugioh-single-card-product-sku",
        profileVersion: "2026.06.20",
        ingestionUnitKey: yugiohUnit,
        displayName: "TCGplayer Yu-Gi-Oh Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        connectorKind: "tcgplayer-automation-client",
        supportedScopes: ["product-line/category", "set-name"],
        sourceOptionKinds,
      }),
    ];
    const baseOverview = controlPlaneOverview();
    const overview = controlPlaneOverview({
      generatedAt: "2026-06-22T05:00:00.000Z",
      readiness: {
        ...baseOverview.readiness,
        generatedAt: "2026-06-22T05:00:00.000Z",
        units: [
          {
            ...baseOverview.readiness.units[0]!,
            unitKey: yugiohUnit,
            providerKey: "tcgplayer",
            displayName: "TCGplayer Yu-Gi-Oh Single Cards",
            productDomain: "yugioh",
            productForm: "single-card",
            ingestionPurpose: "source-observation-import",
            profileVersion: "2026.06.20",
            credentialReadiness: "ready",
            credentialReadinessState: "configured",
            credentialRequirement: "required",
          },
        ],
      },
      unitActivity: {
        generatedAt: "2026-06-22T05:00:00.000Z",
        units: [
          {
            unitKey: yugiohUnit,
            recentJobs: [
              integrationJobSummary({
                jobId: "job_running_yugioh_scope",
                unitKey: yugiohUnit,
                providerKey: "tcgplayer",
                importScope: "en:1",
                profileVersion: "2026.06.19",
                profileSnapshot: {
                  schemaVersion: "catalog-provider-profile-version-v1",
                  compatibilityPolicy: "provider-profile-version",
                  providerKey: "tcgplayer",
                  profileKey: "mtg-single-card-product-sku",
                  profileVersion: "2026.06.19",
                  lifecycle: "active",
                  active: true,
                  connectorKind: "tcgplayer-automation-client",
                  connectorSourceVersion: null,
                  sourceMappingFingerprint: "sha256:mtg",
                },
              }),
            ],
          },
        ],
      },
      providerReadiness: {
        ...baseOverview.providerReadiness,
        generatedAt: "2026-06-22T05:00:00.000Z",
        providers: [
          {
            ...baseOverview.providerReadiness.providers[0]!,
            providerKey: "tcgplayer",
            adapterKey: "tcgplayer",
            credentialReadiness: "ready",
            credentialReadinessState: "configured",
            credentialRequirement: "required",
            unitKeys: [yugiohUnit],
          },
        ],
      },
    });
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      return sourceOptionResponse(params.get("queryKind") ?? "product-lines", {
        status: "fresh",
        source: "live",
        parentValue: params.get("parentValue"),
        degraded: false,
        value: "2",
        label: "Yu-Gi-Oh!",
      });
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue({ items: profiles, total: 3, count: 3 }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(overview),
      listSourceObservations: vi.fn().mockRejectedValue(new Error("review projection failed")),
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Ayugioh%3Asingle-card%3Asource-observation-import",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: yugiohUnit,
      importScope: null,
      sourceObservationFilters: { providerKey: "tcgplayer" },
    });
    expect(routeData.readModel.importJobs.jobs).toHaveLength(1);
    expect(routeData.readModel.sourceObservationReview.freshness).toBe("unavailable");
    expect(routeData.readModel.importJobs.jobs[0]).toMatchObject({
      jobId: "job_running_yugioh_scope",
      unitKey: yugiohUnit,
      providerKey: "tcgplayer",
      importScope: "en:1",
      scopeMatchesRoute: false,
      blockers: ["active-job-conflict"],
    });
    expect(routeData.readModel.sourceScopeWorkset.status).toBe("scope-required");
    expect(routeData.readModel.sourceScopeWorkset.units.find((unit) => unit.unitKey === yugiohUnit)).toEqual(
      expect.objectContaining({
        providerKey: "tcgplayer",
        unitKey: yugiohUnit,
        activeJobCount: 0,
        actions: expect.objectContaining({
          import: expect.objectContaining({ state: "disabled", blockers: ["import-scope-required"] }),
        }),
      }),
    );

    await expect(routeData.deferredSourceOptions).resolves.toMatchObject({
      selectedUnitKey: yugiohUnit,
    });
  });

  it("treats a unit-selected TCGplayer profile without source option metadata as not configured", async () => {
    const pokemonUnit = "tcgplayer:pokemon:single-card:source-observation-import";
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const yugiohProfile = profileReview({
      providerKey: "tcgplayer",
      profileKey: "yugioh-single-card-product-sku",
      profileVersion: "2026.06.20",
      ingestionUnitKey: yugiohUnit,
      displayName: "TCGplayer Yu-Gi-Oh Single Cards",
      lifecycle: "active",
      active: true,
      status: "active",
      connectorKind: "tcgplayer-automation-client",
      supportedScopes: ["product-line/category", "set-name"],
    });
    delete (yugiohProfile as unknown as Record<string, unknown>).sourceOptionKinds;
    const profiles = [
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "pokemon-single-card-product-sku",
        profileVersion: "2026.06.05",
        ingestionUnitKey: pokemonUnit,
        displayName: "TCGplayer Pokemon Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        supportedScopes: ["product-line/category", "set-name"],
      }),
      profileReview({
        providerKey: "tcgplayer",
        profileKey: "mtg-single-card-product-sku",
        profileVersion: "2026.06.19",
        ingestionUnitKey: mtgUnit,
        displayName: "TCGplayer Magic Single Cards",
        lifecycle: "active",
        active: true,
        status: "active",
        supportedScopes: ["product-line/category", "set-name"],
      }),
      yugiohProfile,
    ];
    const listSourceObservationIntegrationOptions = vi.fn().mockRejectedValue(new Error("should not fan out"));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue({ items: profiles, total: 3, count: 3 }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Ayugioh%3Asingle-card%3Asource-observation-import",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: yugiohUnit,
      importScope: null,
      sourceObservationFilters: { providerKey: "tcgplayer" },
    });
    expect(routeData.readModel.sourceOptions.selectedUnitKey).toBe(yugiohUnit);
    expect(routeData.readModel.sourceOptions.selectedProfile).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "yugioh-single-card-product-sku",
    });
    expect(routeData.readModel.sourceOptions.pages).toEqual([]);
    expect(routeData.readModel.sourceScopeWorkset.status).toBe("scope-required");
    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).not.toHaveBeenCalled();
    expect(deferredSourceOptions.pages).toEqual([]);
    expect(deferredSourceOptions.refresh.refreshAllHref).toBeNull();
  });

  it("fetches the audit-trimmed daily overview from the daily loader and the full overview from the providers loader", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const dailyOverview = vi.fn().mockResolvedValue(null);
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getSourceObservationProviderProfileAuthoringModel: vi.fn().mockResolvedValue(null),
      getCatalogIntegrationControlPlaneOverview: dailyOverview,
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    await loader({
      request: new Request("https://admin.example/catalog/integrations?providerKey=tcgdex"),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);
    // The daily surface opts into the audit-lifecycle-trimmed projection (#1972).
    expect(dailyOverview).toHaveBeenCalledWith("daily");

    const providersOverview = vi.fn().mockResolvedValue(null);
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getSourceObservationProviderProfileAuthoringModel: vi.fn().mockResolvedValue(null),
      getCatalogIntegrationControlPlaneOverview: providersOverview,
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    await providersLoader({
      request: new Request("https://admin.example/catalog/integrations/providers?providerKey=tcgdex"),
      params: {},
      context: {},
    } as Parameters<typeof providersLoader>[0]);
    // The providers surface keeps the full overview (no daily audience).
    expect(providersOverview).toHaveBeenCalledWith("full");
  });

  it("keeps the staging Japanese SV8 deep-link payload trimmed", async () => {
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
    const additionalScopes = Array.from({ length: 80 }, (_, index) =>
      sourceObservationScope({
        language_code: "ja",
        product_line_id: "",
        product_line_name: "",
        series_id: "sv",
        series_name: "Scarlet & Violet",
        expansion_id: `sv${index + 20}`,
        expansion_name: `Oversized scope ${index}`,
      }),
    );
    const scopes = { items: [sv8Scope, ...additionalScopes], total: 81, count: 81 };
    const profileReviews = {
      items: [profileReview({ active: true, lifecycle: "active", profileVersion: "2026.06.03" })],
      total: 1,
      count: 1,
    };
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions: vi.fn(async (query: string) => {
        const params = new URLSearchParams(query);
        const queryKind = params.get("queryKind") ?? "";
        const selectedValue = queryKind === "languages" ? "ja" : queryKind === "series" ? "SV" : "SV8";
        const selectedLabel =
          queryKind === "languages"
            ? "Japanese"
            : queryKind === "series"
              ? "Scarlet & Violet"
              : "Super Electric Breaker";
        const response = sourceOptionResponse(queryKind, {
          status: queryKind === "expansions" ? "stale" : "fresh",
          source: "cache",
          parentValue: params.get("parentValue"),
          degraded: queryKind === "expansions",
          value: selectedValue,
          label: selectedLabel,
        });
        return {
          ...response,
          items: [
            {
              providerKey: "tcgdex",
              queryKind,
              value: selectedValue,
              label: selectedLabel,
              description: null,
              parentValue: params.get("parentValue"),
              imageUrl: null,
              metadata: { providerPayload: "SENTINEL_ROUTE_OPTION_METADATA_LEAK" },
            },
            ...Array.from({ length: 99 }, (_, index) => ({
              providerKey: "tcgdex",
              queryKind,
              value: `${selectedValue}-${index}`,
              label: `${selectedLabel} ${index}`,
              description: null,
              parentValue: params.get("parentValue"),
              imageUrl: null,
              metadata: { providerPayload: `SENTINEL_ROUTE_OPTION_METADATA_LEAK_${index}` },
            })),
          ],
          total: 100,
          count: 100,
          page: {
            cursor: null,
            nextCursor: "offset:25",
            limit: 25,
            hasMore: true,
          },
        };
      }),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Asingle-card%3Asource-observation-import&importScope=ja%3ASV%3ASV8&profileVersion=2026.06.03",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData).not.toHaveProperty("data");
    expect(routeData).not.toHaveProperty("profileReviews");
    expect(routeData).not.toHaveProperty("controlPlaneOverview");
    expect(routeData).not.toHaveProperty("reviewObservations");
    expect(routeData).not.toHaveProperty("profileAuthoringModel");
    expect(routeData).not.toHaveProperty("lifecycleImpacts");
    expect(routeData.readModel.routeContext.importScope).toBe("ja:SV:SV8");
    expect(routeData.readModel.importJobs.selectedScope).not.toBeNull();
    expect(routeData.readModel.importJobs.selectedScope?.importScope).toBe("ja:SV:SV8");
    expect(routeData.readModel.providerScope.providers[0]?.units[0]?.importScopes.length).toBeLessThanOrEqual(25);
    expect(routeData.readModel.providerScope.providers[0]?.units[0]?.importScopes[0]).toBe("ja:SV:SV8");
    // The populated option pages stream in behind the deferred slice (#1970); the
    // synchronous read model carries only the not-yet-loaded skeleton.
    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "expansions")).toMatchObject({
      state: "stale",
      page: expect.objectContaining({ total: 100, count: 25, limit: 25, hasMore: true }),
      items: expect.arrayContaining([expect.objectContaining({ value: "SV8", label: "Super Electric Breaker" })]),
    });
    // The leak guard and payload bound now apply to the streamed slice — the part
    // that carries the provider option items — plus the synchronous route data.
    const serialized = JSON.stringify(routeData) + JSON.stringify(deferredSourceOptions);
    expect(serialized).not.toContain("SENTINEL_ROUTE_OPTION_METADATA_LEAK");
    expect(serialized.length).toBeLessThan(180_000);
  });
});
