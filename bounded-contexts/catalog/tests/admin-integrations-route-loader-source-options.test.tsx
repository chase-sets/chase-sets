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
  tcgplayerYugiohProfileReview,
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
  it("keeps an explicit YGOJSON set selection clean when stale Pokemon scope params remain in the URL", async () => {
    const selectedSetId = "9baa1b43-8a60-44dd-a144-dbef99c8c7a4";
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
        value: selectedSetId,
        label: "2-Player Starter Set",
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
        `https://admin.example/catalog/integrations?providerKey=ygojson&unitKey=ygojson%3Ayugioh%3Aset%3Areference-data&importScope=ja%3ASV%3ASV8&seriesId=SV&expansionId=SV8&expansionName=${selectedSetId}&profileVersion=&filter.importScope=ja%3ASV%3ASV8&filter.providerKey=ygojson&sourceOptionAction=force-refresh-all`,
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext.scope).toMatchObject({
      providerKey: "ygojson",
      languageCode: null,
      seriesId: null,
      expansionId: null,
      expansionName: selectedSetId,
    });
    expect(routeData.readModel.routeContext.importScope).toBeNull();
    expect(routeData.readModel.routeContext.sourceObservationFilters).toEqual({ providerKey: "ygojson" });
    const canonicalHref = new URL(
      routeData.readModel.sourceScopeWorkset.units[0]?.currentWorkbenchHref ?? "",
      "https://admin.example",
    );
    expect(canonicalHref.searchParams.get("providerKey")).toBe("ygojson");
    expect(canonicalHref.searchParams.get("unitKey")).toBe("ygojson:yugioh:set:reference-data");
    expect(canonicalHref.searchParams.get("expansionName")).toBe(selectedSetId);
    expect(canonicalHref.searchParams.has("seriesId")).toBe(false);
    expect(canonicalHref.searchParams.has("expansionId")).toBe(false);
    expect(canonicalHref.searchParams.has("filter.importScope")).toBe(false);
    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).toHaveBeenCalledTimes(1);
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "sets")).toMatchObject({
      state: "live",
      items: [expect.objectContaining({ value: selectedSetId, label: "2-Player Starter Set" })],
    });
  });

  it("previews a Scrydex One Piece set-name selection from the shared importer route", async () => {
    const unitKey = "scrydex:one-piece:single-card:source-observation-import";
    const profileReviews = { items: [scrydexOnePieceProfileReview(unitKey)], total: 1, count: 1 };
    const previewSourceObservationIntegrationImport = vi.fn().mockResolvedValue(scrydexOnePieceImportPreview(unitKey));
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      return sourceOptionResponse(params.get("queryKind") ?? "sets", {
        status: "fresh",
        source: "live",
        parentValue: params.get("parentValue"),
        degraded: false,
        value: "OP16",
        label: "The Time Of Battle",
        metadata: { expansionId: "OP16", languageCode: "en" },
      });
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions,
      previewSourceObservationIntegrationImport,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        `https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(unitKey)}&expansionName=OP16&profileVersion=2026.06.22&sourceOptionAction=force-refresh-all`,
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext.importScope).toBe("en:OP16");
    expect(routeData.readModel.importJobs.selectedScope).toMatchObject({
      providerKey: "scrydex",
      unitKey,
      importScope: "en:OP16",
    });
    expect(
      routeData.readModel.actions.find((actionEntry) => actionEntry.key === "start-provider-import")?.blockers,
    ).not.toContain("import-scope-required");
    await expect(routeData.deferredImportPreview).resolves.toMatchObject({
      providerKey: "scrydex",
      targetCount: 1,
      targets: [
        expect.objectContaining({
          usageEstimate: expect.objectContaining({ requestStrategy: "bulk-first" }),
        }),
      ],
    });
    expect(previewSourceObservationIntegrationImport).toHaveBeenCalledWith({
      provider: "scrydex",
      ingestionUnitKey: unitKey,
      language: "en",
      setName: "OP16",
    });
  });

  it("keeps Scrydex Lorcana source-option recovery concrete for import preflight", async () => {
    const unitKey = "scrydex:lorcana:single-card:source-observation-import";
    const profileReviews = { items: [scrydexLorcanaProfileReview(unitKey)], total: 1, count: 1 };
    const previewSourceObservationIntegrationImport = vi.fn().mockResolvedValue(scrydexLorcanaImportPreview(unitKey));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({
        items: [
          sourceObservationScope({
            provider_key: "scrydex",
            language_code: "en",
            product_line_id: "",
            product_line_name: "Disney Lorcana",
            series_id: "",
            series_name: "",
            expansion_id: "TFC",
            expansion_name: "The First Chapter",
            total_observations: 1,
            observed_observations: 1,
            changed_observations: 0,
            promoted_observations: 0,
            rejected_observations: 0,
          }),
        ],
        total: 1,
        count: 1,
      }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions: vi.fn().mockResolvedValue(
        sourceOptionResponse("sets", {
          status: "fresh",
          source: "live",
          parentValue: null,
          degraded: false,
          value: "TFC",
          label: "The First Chapter",
          metadata: { expansionId: "TFC", languageCode: "en" },
        }),
      ),
      previewSourceObservationIntegrationImport,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        `https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(
          unitKey,
        )}&expansionId=TFC&expansionName=&profileVersion=&sourceOptionAction=force-refresh-all`,
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext.importScope).toBe("en:TFC");
    expect(routeData.readModel.importJobs.selectedScope).toMatchObject({
      providerKey: "scrydex",
      unitKey,
      importScope: "en:TFC",
    });
    await expect(routeData.deferredImportPreview).resolves.toMatchObject({
      providerKey: "scrydex",
      scope: expect.objectContaining({
        provider: "scrydex",
        ingestionUnitKey: unitKey,
        language: "en",
        setId: "TFC",
      }),
      targets: [
        expect.objectContaining({
          usageEstimate: expect.objectContaining({ requestStrategy: "bulk-first" }),
        }),
      ],
    });
    expect(previewSourceObservationIntegrationImport).toHaveBeenCalledWith({
      provider: "scrydex",
      ingestionUnitKey: unitKey,
      language: "en",
      setId: "TFC",
    });
  });

  it("keeps Lorcast selected set commands available before provider scope rows exist", async () => {
    const unitKey = "lorcast:lorcana:single-card:reference-data";
    const profileReviews = { items: [lorcastLorcanaProfileReview(unitKey)], total: 1, count: 1 };
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions: vi.fn().mockResolvedValue(
        sourceOptionResponse("sets", {
          status: "fresh",
          source: "live",
          parentValue: null,
          degraded: false,
          value: "1",
          label: "The First Chapter",
          metadata: { expansionId: "1", languageCode: "en" },
        }),
      ),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        `https://admin.example/catalog/integrations?providerKey=lorcast&unitKey=${encodeURIComponent(
          unitKey,
        )}&languageCode=en&productLineName=Disney%20Lorcana&expansionId=1&profileVersion=2026.06.23&sourceOptionAction=force-refresh-all`,
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);
    const unit = routeData.readModel.sourceScopeWorkset.units.find((candidate) => candidate.unitKey === unitKey);

    expect(routeData.readModel.routeContext.importScope).toBe("en:1");
    expect(unit?.commandContext).toMatchObject({
      providerKey: "lorcast",
      unitKey,
      importScope: "en:1",
      productLineName: "Disney Lorcana",
      expansionId: "1",
    });
    expect(unit?.actions.import).toMatchObject({
      state: "available",
      blockers: [],
    });
    expect(unit?.currentWorkbenchHref).toContain("importScope=en%3A1");
  });

  it("drops stale import preview evidence when a structured set-name selection changes", async () => {
    const unitKey = "scrydex:one-piece:sealed-product:source-observation-import";
    const profileReviews = { items: [scrydexOnePieceProfileReview(unitKey)], total: 1, count: 1 };
    const previewSourceObservationIntegrationImport = vi.fn().mockResolvedValue(scrydexOnePieceImportPreview(unitKey));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      previewSourceObservationIntegrationImport,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        `https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(
          unitKey,
        )}&importScope=en%3AOP16&expansionName=OP09&profileVersion=2026.06.22`,
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext.importScope).toBe("en:OP09");
    expect(routeData.readModel.routeContext.sourceObservationFilters).toEqual({
      providerKey: "scrydex",
      importScope: "en:OP09",
    });
    expect(previewSourceObservationIntegrationImport).toHaveBeenCalledWith({
      provider: "scrydex",
      ingestionUnitKey: unitKey,
      language: "en",
      setName: "OP09",
    });
    await expect(routeData.deferredImportPreview).resolves.toBeNull();
  });

  it("drops stale legacy Pokemon scope before TCGplayer Yu-Gi-Oh product-line refresh", async () => {
    const profileReviews = {
      items: [tcgplayerYugiohProfileReview("tcgplayer:yugioh:single-card:source-observation-import")],
      total: 1,
      count: 1,
    };
    const listSourceObservations = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      if (params.get("queryKind") !== "product-lines") {
        throw new Error(`Unexpected source option query ${params.get("queryKind") ?? "unknown"}.`);
      }
      return sourceOptionResponse(params.get("queryKind") ?? "product-lines", {
        status: "fresh",
        source: "live",
        parentValue: params.get("parentValue"),
        degraded: false,
        value: "2",
        label: "Yu-Gi-Oh!",
      });
    });
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
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi
        .fn()
        .mockResolvedValue({ items: [stalePokemonScope], total: 1, count: 1 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations,
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Ayugioh%3Asingle-card%3Asource-observation-import&importScope=ja%3ASV%3ASV8&profileVersion=2026.06.20&filter.importScope=ja%3ASV%3ASV8&filter.providerKey=tcgplayer&sourceOptionAction=force-refresh&sourceOptionQueryKind=product-lines",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(listSourceObservations).toHaveBeenCalledOnce();
    const reviewQuery = new URLSearchParams(listSourceObservations.mock.calls[0]?.[0] ?? "");
    expect(reviewQuery.get("provider")).toBe("tcgplayer");
    expect(reviewQuery.get("language")).toBeNull();
    expect(reviewQuery.get("productLineId")).toBeNull();
    expect(reviewQuery.get("seriesId")).toBeNull();
    expect(reviewQuery.get("expansionId")).toBeNull();
    expect(reviewQuery.get("setId")).toBeNull();
    expect(routeData.readModel.routeContext.importScope).toBeNull();
    expect(routeData.readModel.routeContext.profileVersion).toBe("2026.06.20");
    expect(routeData.readModel.routeContext.scope).toMatchObject({
      providerKey: "tcgplayer",
      languageCode: null,
      productLineId: null,
      seriesId: null,
      expansionId: null,
    });
    expect(routeData.readModel.routeContext.sourceObservationFilters).toEqual({ providerKey: "tcgplayer" });
    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).toHaveBeenCalledTimes(1);
    const optionQuery = new URLSearchParams(listSourceObservationIntegrationOptions.mock.calls[0]?.[0] ?? "");
    expect(optionQuery.get("queryKind")).toBe("product-lines");
    expect(optionQuery.get("forceRefresh")).toBe("true");
    expect(optionQuery.get("profileKey")).toBe("yugioh-single-card-product-sku");
    expect(optionQuery.get("ingestionUnitKey")).toBe("tcgplayer:yugioh:single-card:source-observation-import");
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "product-lines")).toMatchObject({
      state: "live",
      items: [expect.objectContaining({ label: "Yu-Gi-Oh!" })],
    });
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "set-names")).toMatchObject({
      state: "not-requested",
      request: expect.objectContaining({ parentValue: null }),
    });
  });

  it("keeps stale TCGplayer Yu-Gi-Oh source-option failures inside the deferred panel", async () => {
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const mtgProfile = profileReview({
      providerKey: "tcgplayer",
      profileKey: "mtg-single-card-product-sku",
      profileVersion: "2026.06.19",
      ingestionUnitKey: mtgUnit,
      displayName: "TCGplayer Magic single cards",
      lifecycle: "active",
      active: true,
      status: "active",
      connectorKind: "tcgplayer-automation-client",
      profile: {
        providerKey: "tcgplayer",
        supportedScopes: ["product-line/category", "set-name"],
      },
      supportedScopes: ["product-line/category", "set-name"],
      languageOptions: ["en"],
    });
    const yugiohProfile = profileReview({
      providerKey: "tcgplayer",
      profileKey: "yugioh-single-card-product-sku",
      profileVersion: "2026.06.20",
      ingestionUnitKey: yugiohUnit,
      displayName: "TCGplayer Yu-Gi-Oh Single Cards",
      lifecycle: "test",
      active: false,
      status: "planned",
      connectorKind: "tcgplayer-automation-client",
      profile: {
        providerKey: "tcgplayer",
        supportedScopes: ["product-line/category", "set-name"],
      },
      supportedScopes: ["product-line/category", "set-name"],
      languageOptions: ["en"],
      sourceOptionKinds: [
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
      ],
    });
    const profileReviews = { items: [mtgProfile, yugiohProfile], total: 2, count: 2 };
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
    const listSourceObservations = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
    const listSourceObservationIntegrationOptions = vi.fn().mockRejectedValue(
      new CatalogApiError(500, {
        error: { code: "tcgplayer_option_query_failed", message: "Provider source options are unavailable." },
      }),
    );
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi
        .fn()
        .mockResolvedValue({ items: [stalePokemonScope], total: 1, count: 1 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations,
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Ayugioh%3Asingle-card%3Asource-observation-import&importScope=ja%3ASV%3ASV8&profileVersion=2026.06.20&filter.importScope=ja%3ASV%3ASV8&filter.providerKey=tcgplayer&sourceOptionAction=force-refresh&sourceOptionQueryKind=product-lines",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    const reviewQuery = new URLSearchParams(listSourceObservations.mock.calls[0]?.[0] ?? "");
    expect(reviewQuery.get("provider")).toBe("tcgplayer");
    expect(reviewQuery.get("language")).toBeNull();
    expect(reviewQuery.get("productLineId")).toBeNull();
    expect(reviewQuery.get("seriesId")).toBeNull();
    expect(reviewQuery.get("expansionId")).toBeNull();
    expect(routeData.readModel.routeContext.importScope).toBeNull();
    expect(routeData.readModel.routeContext.sourceObservationFilters).toEqual({ providerKey: "tcgplayer" });
    const operatorRefreshHref = new URL(
      catalogPrimaryWorkbenchSourceOptionHref(routeData.readModel.routeContext, {
        action: "force-refresh",
        queryKind: "product-lines",
      }),
      "https://admin.example",
    );
    expect(operatorRefreshHref.searchParams.get("unitKey")).toBe(yugiohUnit);
    expect(operatorRefreshHref.searchParams.get("profileVersion")).toBe("2026.06.20");
    expect(operatorRefreshHref.searchParams.has("importScope")).toBe(false);
    expect(operatorRefreshHref.searchParams.has("filter.importScope")).toBe(false);

    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).toHaveBeenCalledTimes(1);
    const optionQuery = new URLSearchParams(listSourceObservationIntegrationOptions.mock.calls[0]?.[0] ?? "");
    expect(optionQuery.get("queryKind")).toBe("product-lines");
    expect(optionQuery.get("forceRefresh")).toBe("true");
    expect(optionQuery.get("profileKey")).toBe("yugioh-single-card-product-sku");
    expect(optionQuery.get("ingestionUnitKey")).toBe(yugiohUnit);
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "product-lines")).toMatchObject({
      state: "unavailable",
      degraded: true,
      cache: expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: "tcgplayer_option_query_failed",
            severity: "error",
          }),
        ],
      }),
    });
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "set-names")).toMatchObject({
      state: "not-requested",
      request: expect.objectContaining({ parentValue: null }),
    });
  });

  it("does not request TCGplayer Yu-Gi-Oh set names from a stale Pokemon scope without the product-line parent", async () => {
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const mtgProfile = profileReview({
      providerKey: "tcgplayer",
      profileKey: "mtg-single-card-product-sku",
      profileVersion: "2026.06.19",
      ingestionUnitKey: mtgUnit,
      displayName: "TCGplayer Magic single cards",
      lifecycle: "active",
      active: true,
      status: "active",
      connectorKind: "tcgplayer-automation-client",
      profile: {
        providerKey: "tcgplayer",
        supportedScopes: ["product-line/category", "set-name"],
      },
      supportedScopes: ["product-line/category", "set-name"],
      languageOptions: ["en"],
    });
    const yugiohProfile = profileReview({
      providerKey: "tcgplayer",
      profileKey: "yugioh-single-card-product-sku",
      profileVersion: "2026.06.20",
      ingestionUnitKey: yugiohUnit,
      displayName: "TCGplayer Yu-Gi-Oh Single Cards",
      lifecycle: "test",
      active: false,
      status: "planned",
      connectorKind: "tcgplayer-automation-client",
      profile: {
        providerKey: "tcgplayer",
        supportedScopes: ["product-line/category", "set-name"],
      },
      supportedScopes: ["product-line/category", "set-name"],
      languageOptions: ["en"],
      sourceOptionKinds: [
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
      ],
    });
    const profileReviews = { items: [mtgProfile, yugiohProfile], total: 2, count: 2 };
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
    const listSourceObservations = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
    const listSourceObservationIntegrationOptions = vi
      .fn()
      .mockRejectedValue(new Error("should not request set names"));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi
        .fn()
        .mockResolvedValue({ items: [stalePokemonScope], total: 1, count: 1 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations,
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Ayugioh%3Asingle-card%3Asource-observation-import&importScope=ja%3ASV%3ASV8&profileVersion=2026.06.20&filter.importScope=ja%3ASV%3ASV8&filter.providerKey=tcgplayer&sourceOptionAction=force-refresh&sourceOptionQueryKind=set-names",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext.importScope).toBeNull();
    expect(routeData.readModel.routeContext.sourceObservationFilters).toEqual({ providerKey: "tcgplayer" });
    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(
      listSourceObservationIntegrationOptions.mock.calls.map(([query]) =>
        new URLSearchParams(String(query)).get("queryKind"),
      ),
    ).toEqual([]);
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "set-names")).toMatchObject({
      state: "not-requested",
      request: expect.objectContaining({ parentValue: null }),
    });
  });

  it("drops stale legacy Pokemon scope before a TCGplayer Yu-Gi-Oh refresh-all when the option profile has no option kinds", async () => {
    const yugiohProfileWithoutOptionKinds = profileReview({
      providerKey: "tcgplayer",
      profileKey: "yugioh-single-card-product-sku",
      profileVersion: "2026.06.20",
      ingestionUnitKey: "tcgplayer:yugioh:single-card:source-observation-import",
      displayName: "TCGplayer Yu-Gi-Oh Single Cards",
      lifecycle: "active",
      active: true,
      status: "active",
      connectorKind: "tcgplayer-automation-client",
      profile: {
        providerKey: "tcgplayer",
        supportedScopes: ["product-line/category", "set-name"],
      },
      supportedScopes: ["product-line/category", "set-name"],
      languageOptions: ["en"],
      sourceOptionKinds: [],
    });
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
    const listSourceObservations = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
    const listSourceObservationIntegrationOptions = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi
        .fn()
        .mockResolvedValue({ items: [stalePokemonScope], total: 1, count: 1 }),
      listSourceObservationProviderProfiles: vi
        .fn()
        .mockResolvedValue({ items: [yugiohProfileWithoutOptionKinds], total: 1, count: 1 }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations,
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Ayugioh%3Asingle-card%3Asource-observation-import&importScope=ja%3ASV%3ASV8&profileVersion=2026.06.20&filter.importScope=ja%3ASV%3ASV8&filter.providerKey=tcgplayer&sourceOptionAction=force-refresh-all",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    const reviewQuery = new URLSearchParams(listSourceObservations.mock.calls[0]?.[0] ?? "");
    expect(reviewQuery.get("provider")).toBe("tcgplayer");
    expect(reviewQuery.get("language")).toBeNull();
    expect(reviewQuery.get("productLineId")).toBeNull();
    expect(reviewQuery.get("seriesId")).toBeNull();
    expect(reviewQuery.get("expansionId")).toBeNull();
    expect(routeData.readModel.routeContext.importScope).toBeNull();
    expect(routeData.readModel.routeContext.sourceObservationFilters).toEqual({ providerKey: "tcgplayer" });
    await expect(routeData.deferredSourceOptions).resolves.toMatchObject({
      pages: [],
      refresh: expect.objectContaining({ refreshAllHref: null }),
    });
    expect(listSourceObservationIntegrationOptions).not.toHaveBeenCalled();
  });

  it("drops stale legacy Pokemon scope before a TCGplayer Yu-Gi-Oh refresh-all with missing parent controls", async () => {
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const yugiohProfile = tcgplayerYugiohProfileReview(yugiohUnit);
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
    const listSourceObservations = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      if (params.get("queryKind") !== "product-lines") {
        throw new Error(`Unexpected source option query ${params.get("queryKind") ?? "unknown"}.`);
      }
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
      listSourceObservationIntegrationScopes: vi
        .fn()
        .mockResolvedValue({ items: [stalePokemonScope], total: 1, count: 1 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue({ items: [yugiohProfile], total: 1, count: 1 }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations,
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Ayugioh%3Asingle-card%3Asource-observation-import&importScope=ja%3ASV%3ASV8&profileVersion=2026.06.20&filter.importScope=ja%3ASV%3ASV8&filter.providerKey=tcgplayer&sourceOptionAction=force-refresh-all",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    const reviewQuery = new URLSearchParams(listSourceObservations.mock.calls[0]?.[0] ?? "");
    expect(reviewQuery.get("provider")).toBe("tcgplayer");
    expect(reviewQuery.get("language")).toBeNull();
    expect(reviewQuery.get("productLineId")).toBeNull();
    expect(reviewQuery.get("seriesId")).toBeNull();
    expect(reviewQuery.get("expansionId")).toBeNull();
    expect(routeData.readModel.routeContext.unitKey).toBe(yugiohUnit);
    expect(routeData.readModel.routeContext.importScope).toBeNull();
    expect(routeData.readModel.routeContext.sourceObservationFilters).toEqual({ providerKey: "tcgplayer" });
    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).toHaveBeenCalledTimes(1);
    const optionQuery = new URLSearchParams(listSourceObservationIntegrationOptions.mock.calls[0]?.[0] ?? "");
    expect(optionQuery.get("queryKind")).toBe("product-lines");
    expect(optionQuery.get("forceRefresh")).toBe("true");
    expect(optionQuery.get("profileKey")).toBe("yugioh-single-card-product-sku");
    expect(optionQuery.get("ingestionUnitKey")).toBe(yugiohUnit);
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "product-lines")).toMatchObject({
      state: "live",
      items: [expect.objectContaining({ label: "Yu-Gi-Oh!" })],
    });
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "set-names")).toMatchObject({
      state: "not-requested",
      blockers: ["selection-empty"],
      request: expect.objectContaining({ parentValue: null }),
    });
    expect(deferredSourceOptions.refresh).toMatchObject({
      state: "disabled",
      blockers: ["selection-empty"],
      refreshAllHref: null,
    });
  });

  it("time-bounds a slow TCGplayer Yu-Gi-Oh source-option refresh-all with a selected product line", async () => {
    vi.useFakeTimers();
    try {
      const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
      const yugiohProfile = tcgplayerYugiohProfileReview(yugiohUnit);
      const listSourceObservations = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
      const listSourceObservationIntegrationOptions = vi.fn((query: string) => {
        const params = new URLSearchParams(query);
        if (params.get("queryKind") === "product-lines") {
          return Promise.resolve(
            sourceOptionResponse("product-lines", {
              status: "fresh",
              source: "live",
              parentValue: params.get("parentValue"),
              degraded: false,
              value: "2",
              label: "Yu-Gi-Oh!",
            }),
          );
        }

        return new Promise<never>(() => undefined);
      });
      mockCreateCatalogRequestApiClient.mockReturnValue({
        listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
        listSourceObservationProviderProfiles: vi
          .fn()
          .mockResolvedValue({ items: [yugiohProfile], total: 1, count: 1 }),
        getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
        listSourceObservations,
        listSourceObservationIntegrationOptions,
        recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
      });

      const routeData = await loader({
        request: new Request(
          "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Ayugioh%3Asingle-card%3Asource-observation-import&productLineId=2&profileVersion=&sourceOptionAction=force-refresh-all",
        ),
        params: {},
        context: {},
      } as Parameters<typeof loader>[0]);

      expect(routeData.readModel.routeContext.unitKey).toBe(yugiohUnit);
      expect(routeData.readModel.routeContext.scope).toMatchObject({
        providerKey: "tcgplayer",
        productLineId: "2",
      });
      await vi.advanceTimersByTimeAsync(20_000);
      const deferredSourceOptions = await routeData.deferredSourceOptions;
      expect(listSourceObservationIntegrationOptions).toHaveBeenCalledTimes(2);
      const optionQueries = listSourceObservationIntegrationOptions.mock.calls.map(([query]) =>
        Object.fromEntries(new URLSearchParams(String(query))),
      );
      expect(optionQueries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            queryKind: "product-lines",
            forceRefresh: "true",
            profileKey: "yugioh-single-card-product-sku",
            ingestionUnitKey: yugiohUnit,
          }),
          expect.objectContaining({
            queryKind: "set-names",
            forceRefresh: "true",
            parentValue: "2",
            profileKey: "yugioh-single-card-product-sku",
            ingestionUnitKey: yugiohUnit,
          }),
        ]),
      );
      expect(deferredSourceOptions.pages.find((page) => page.queryKind === "product-lines")).toMatchObject({
        state: "live",
        items: [expect.objectContaining({ label: "Yu-Gi-Oh!" })],
      });
      expect(deferredSourceOptions.pages.find((page) => page.queryKind === "set-names")).toMatchObject({
        state: "unavailable",
        degraded: true,
        request: expect.objectContaining({ parentValue: "2" }),
        cache: expect.objectContaining({
          diagnostics: [
            expect.objectContaining({
              code: "catalog_provider_option_query_timeout",
              severity: "error",
            }),
          ],
        }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a TCGplayer Yu-Gi-Oh refresh-all route without a selected product line", async () => {
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
      supportedScopes: ["yugioh/single-card"],
    });
    const listSourceObservations = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      if (params.get("queryKind") !== "product-lines") {
        throw new Error(`Unexpected source option query ${params.get("queryKind") ?? "unknown"}.`);
      }
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
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue({ items: [yugiohProfile], total: 1, count: 1 }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations,
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Ayugioh%3Asingle-card%3Asource-observation-import&profileVersion=2026.06.20&filter.providerKey=tcgplayer&sourceOptionAction=force-refresh-all",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData.readModel.routeContext.unitKey).toBe(yugiohUnit);
    expect(routeData.readModel.routeContext.importScope).toBeNull();
    expect(routeData.readModel.routeContext.sourceObservationFilters).toEqual({ providerKey: "tcgplayer" });
    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).toHaveBeenCalledTimes(1);
    const optionQuery = new URLSearchParams(listSourceObservationIntegrationOptions.mock.calls[0]?.[0] ?? "");
    expect(optionQuery.get("queryKind")).toBe("product-lines");
    expect(optionQuery.get("forceRefresh")).toBe("true");
    expect(optionQuery.get("profileKey")).toBe("yugioh-single-card-product-sku");
    expect(optionQuery.get("ingestionUnitKey")).toBe(yugiohUnit);
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "product-lines")).toMatchObject({
      state: "live",
      items: [expect.objectContaining({ label: "Yu-Gi-Oh!" })],
    });
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "set-names")).toMatchObject({
      state: "not-requested",
      blockers: ["selection-empty"],
      request: expect.objectContaining({ parentValue: null }),
    });
    expect(deferredSourceOptions.refresh).toMatchObject({
      state: "disabled",
      blockers: ["selection-empty"],
      refreshAllHref: null,
    });
  });

  it("loads provider-only TCGplayer retries without ambiguous option queries", async () => {
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
    const listSourceObservations = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
    const listSourceObservationIntegrationOptions = vi.fn().mockRejectedValue(new Error("ambiguous option query"));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi
        .fn()
        .mockResolvedValue({ items: [stalePokemonScope], total: 1, count: 1 }),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue({ items: profiles, total: 3, count: 3 }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations,
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request("https://admin.example/catalog/integrations?providerKey=tcgplayer"),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    const reviewQuery = new URLSearchParams(listSourceObservations.mock.calls[0]?.[0] ?? "");
    expect(reviewQuery.get("provider")).toBe("tcgplayer");
    expect(reviewQuery.get("language")).toBeNull();
    expect(reviewQuery.get("productLineId")).toBeNull();
    expect(reviewQuery.get("seriesId")).toBeNull();
    expect(reviewQuery.get("expansionId")).toBeNull();
    expect(routeData.readModel.routeContext.unitKey).toBeNull();
    expect(routeData.readModel.routeContext.importScope).toBeNull();
    expect(routeData.readModel.routeContext.sourceObservationFilters).toEqual({ providerKey: "tcgplayer" });
    expect(
      routeData.readModel.providerScope.providers
        .find((provider) => provider.providerKey === "tcgplayer")
        ?.units.map((unit) => unit.unitKey),
    ).toEqual([mtgUnit, pokemonUnit, yugiohUnit]);

    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(listSourceObservationIntegrationOptions).not.toHaveBeenCalled();
    expect(deferredSourceOptions.selectedProfile).toBeNull();
    expect(deferredSourceOptions.pages).toEqual([]);
    expect(deferredSourceOptions.refresh.refreshAllHref).toBeNull();
  });
});
