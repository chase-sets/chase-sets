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
  it("builds a trimmed read model with denied write actions for catalog view-only operators", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      permissions: ["catalog.view"],
    });
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSourceObservationIntegrationOptions: vi.fn().mockResolvedValue(
        sourceOptionResponse("languages", {
          status: "fresh",
          source: "cache",
          parentValue: null,
          degraded: false,
        }),
      ),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(routeData).not.toHaveProperty("data");
    expect(routeData).not.toHaveProperty("profileReviews");
    expect(routeData.readModel.readiness.rbacAllowed).toBe(false);
    expect(routeData.readModel.readiness.blockers).toContain("permission-denied");
    expect(routeData.readModel.actions.find((actionEntry) => actionEntry.key === "scope.import")).toMatchObject({
      state: "blocked",
      blockers: expect.arrayContaining(["permission-denied"]),
    });
  });

  it("proves the Japanese SV8 operator journey without raw importScope authoring", async () => {
    const selectedScopeUrl =
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&languageCode=ja&seriesId=SV&expansionId=SV8&profileVersion=2026.06.04";
    expect(new URL(selectedScopeUrl).searchParams.has("importScope")).toBe(false);

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
    const scopes = { items: [sv8Scope], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const sv8Observation = sourceObservationListItem({
      observation_id: "obs_ja_sv8_001",
      external_key: "SV8-001",
      language_code: "ja",
      normalized: {
        ...sourceObservationListItem().normalized,
        languageCode: "ja",
        name: "Pikachu ex",
        cardNumber: "001",
        setId: "SV8",
        setName: "Super Electric Breaker",
        expansionId: "SV8",
        expansionName: "Super Electric Breaker",
        seriesId: "SV",
        seriesName: "Scarlet & Violet",
      },
      status: "changed",
      promoted_catalog_item_id: null,
      promoted_at: null,
    });
    const listSourceObservations = vi.fn().mockResolvedValue({ items: [sv8Observation], total: 1, count: 1 });
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      const queryKind = params.get("queryKind") ?? "";
      return sourceOptionResponse(queryKind, {
        status: queryKind === "expansions" ? "stale" : "fresh",
        source: "cache",
        parentValue: params.get("parentValue"),
        degraded: queryKind === "expansions",
        value: queryKind === "languages" ? "ja" : queryKind === "series" ? "SV" : "SV8",
        label:
          queryKind === "languages"
            ? "Japanese"
            : queryKind === "series"
              ? "Scarlet & Violet"
              : "Super Electric Breaker",
        metadata:
          queryKind === "languages"
            ? { languageCode: "ja" }
            : queryKind === "series"
              ? { languageCode: "ja", seriesId: "SV" }
              : { languageCode: "ja", seriesId: "SV", expansionId: "SV8" },
      });
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations,
      listSourceObservationIntegrationOptions,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(selectedScopeUrl),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    const optionQueries = listSourceObservationIntegrationOptions.mock.calls.map(
      ([query]) => new URLSearchParams(query),
    );
    expect(optionQueries.map((params) => params.get("queryKind"))).toEqual(["languages", "series", "expansions"]);
    expect(optionQueries.every((params) => params.get("cacheOnly") === "true")).toBe(true);
    expect(optionQueries[1]?.get("languageCode")).toBe("ja");
    expect(optionQueries[2]?.get("parentValue")).toBe("sv");
    const reviewQuery = new URLSearchParams(listSourceObservations.mock.calls[0]?.[0] ?? "");
    expect(reviewQuery.get("provider")).toBe("tcgdex");
    expect(reviewQuery.get("language")).toBe("ja");
    expect(reviewQuery.get("seriesId")).toBe("sv");
    expect(reviewQuery.get("setId")).toBe("sv8");
    expect(routeData.readModel.importJobs.selectedScope).toMatchObject({
      importScope: "ja:SV:SV8",
      expectedObservationVolume: 130,
      observedCount: 130,
      changedCount: 130,
      promotedCount: 0,
    });
    // Source options stream in behind the deferred slice (#1970).
    const deferredSourceOptions = await routeData.deferredSourceOptions;
    expect(deferredSourceOptions.pages.find((page) => page.queryKind === "expansions")).toMatchObject({
      state: "stale",
      items: [expect.objectContaining({ value: "SV8", label: "Super Electric Breaker" })],
    });
    expect(routeData.readModel.sourceObservationReview).toMatchObject({
      counts: expect.objectContaining({ observed: 130, changed: 130, promoted: 0 }),
      rows: [
        expect.objectContaining({
          observationId: "obs_ja_sv8_001",
          providerKey: "tcgdex",
          promotionReadiness: expect.objectContaining({ state: "eligible" }),
        }),
      ],
    });

    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_ja_sv8" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });
    const syncResult = await runDailyAction(
      {
        _intent: "scope.import",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        languageCode: "ja",
        seriesId: "SV",
        expansionId: "SV8",
        profileVersion: "2026.06.04",
      },
      selectedScopeUrl,
    );
    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
      provider: "tcgdex",
      ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
      language: "ja",
      seriesId: "SV",
      setId: "SV8",
    });
    expect(syncResult.context.importScope).toBe("ja:SV:SV8");
    expect(syncResult.context.jobId).toBe("job_import_ja_sv8");

    const previewBulkPromoteSourceObservations = vi.fn().mockResolvedValue({
      matched: 130,
      eligible: 130,
      terminal: 0,
      scope: { provider: "tcgdex", language: "ja", setId: "sv8", status: "", search: "" },
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservations });
    const previewResponse = await runDailyActionRedirect(
      {
        _intent: "observation.promote",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        languageCode: "ja",
        seriesId: "SV",
        expansionId: "SV8",
        profileVersion: "2026.06.04",
      },
      selectedScopeUrl,
    );
    const previewLocation = redirectLocation(previewResponse);
    const promotionPreviewId = previewLocation.searchParams.get("promotionPreviewId");
    const selectedScopePromotionFilter = {
      provider: "tcgdex",
      language: "ja",
      seriesId: "sv",
      expansionId: "sv8",
      setId: "sv8",
    };
    expect(previewBulkPromoteSourceObservations).toHaveBeenCalledWith(selectedScopePromotionFilter);
    expect(previewLocation.pathname).toBe("/catalog/integrations");
    expect(previewLocation.searchParams.get("commandResult")).toBe("preview-ready");
    expect(promotionPreviewId).toBe(
      "preview-tcgdex_tcgdex_pokemon_single-card_source-observation-import_ja_SV_SV8_2026.06.04_ja_sv8_all_none_filtered-130-130-no-fingerprint",
    );

    const bulkPromoteSourceObservationsByScope = vi.fn().mockResolvedValue({ jobId: "job_promote_ja_sv8" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      previewBulkPromoteSourceObservations,
      bulkPromoteSourceObservationsByScope,
    });
    const promoteResult = await runDailyAction(
      {
        _intent: "observation.promote",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        languageCode: "ja",
        seriesId: "SV",
        expansionId: "SV8",
        profileVersion: "2026.06.04",
        promotionPreviewId: promotionPreviewId ?? "",
      },
      selectedScopeUrl,
    );

    expect(bulkPromoteSourceObservationsByScope).toHaveBeenCalledWith(selectedScopePromotionFilter);
    expect(promoteResult.context.jobId).toBe("job_promote_ja_sv8");
    expect(promoteResult.context.promotionPreviewId).toBeNull();
    expect(promoteResult.feedback.result).toBe("job-queued");
  });

  it("force-refreshes every option group when the workbench refresh-all intent is present", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      const queryKind = params.get("queryKind") ?? "";
      return sourceOptionResponse(queryKind, {
        status: "fresh",
        source: "live",
        parentValue: params.get("parentValue"),
        degraded: false,
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

    await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&sourceOptionAction=force-refresh-all",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(listSourceObservationIntegrationOptions).toHaveBeenCalledTimes(3);
    const queries = listSourceObservationIntegrationOptions.mock.calls.map(([query]) => new URLSearchParams(query));
    // Every request escalates to the force-refresh (live) query; none stays cache-only.
    expect(queries.every((params) => params.get("forceRefresh") === "true")).toBe(true);
    expect(queries.some((params) => params.get("cacheOnly") === "true")).toBe(false);
  });

  it("force-refreshes only the targeted group for a per-group workbench force-refresh intent", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
      const params = new URLSearchParams(query);
      const queryKind = params.get("queryKind") ?? "";
      return sourceOptionResponse(queryKind, {
        status: "fresh",
        source: params.get("forceRefresh") === "true" ? "live" : "cache",
        parentValue: params.get("parentValue"),
        degraded: false,
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

    await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&sourceOptionAction=force-refresh&sourceOptionQueryKind=expansions",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    const byKind = Object.fromEntries(
      listSourceObservationIntegrationOptions.mock.calls.map(([query]) => {
        const params = new URLSearchParams(query);
        return [params.get("queryKind"), params.get("forceRefresh") === "true"];
      }),
    );
    // Only the targeted expansions group is requested and forced live.
    expect(byKind).toEqual({ expansions: true });
  });

  it("renders the providers surface absent-state when the deep-linked profileVersion does not resolve", async () => {
    // A daily-blocker deep-link can carry a provider + a stale/unknown
    // profileVersion (e.g. the operator is meant to author the missing profile).
    // The backend answers the authoring-model fetch with 404 for that version;
    // the providers loader must treat it as the existing "no authoring model"
    // absent state and render, not surface a 500.
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    const getSourceObservationProviderProfileAuthoringModel = vi
      .fn()
      .mockRejectedValue(new CatalogApiError(404, { error: { code: "profile_version_not_found" } }));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getSourceObservationProviderProfileAuthoringModel,
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      recordCatalogControlPlaneEvent,
    });

    // The carried profileVersion (2099.01.01-unknown) resolves nowhere: it is not
    // in the profile-review list and the authoring-model endpoint answers 404.
    const routeData = await providersLoader({
      request: new Request(
        "https://admin.example/catalog/integrations/providers?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2099.01.01-unknown",
      ),
      params: {},
      context: {},
    } as Parameters<typeof providersLoader>[0]);

    // The loader did take the deep-link path (it fetched the authoring model for
    // the carried version) and recovered from the 404 instead of throwing.
    expect(getSourceObservationProviderProfileAuthoringModel).toHaveBeenCalledWith("tcgdex", "2099.01.01-unknown");
    expect(routeData).not.toHaveProperty("profileAuthoringModel");
    // Both providers workspaces resolve to their absent-selection states: profile
    // authoring flags the stale selection and validation readiness is unavailable
    // without a resolved authoring model.
    expect(routeData.readModel.profileAuthoring.status).toBe("stale-selection");
    expect(routeData.readModel.validationReadiness.status).toBe("unavailable");
    expect(routeData.readModel.validationReadiness.freshness).toBe("unavailable");
  });

  it("propagates non-not-found errors from the providers authoring-model fetch", async () => {
    // Robustness is narrow: only the 404 not-found case maps to the absent state.
    // A genuine 5xx (or any other error) must still surface, not be swallowed.
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getSourceObservationProviderProfileAuthoringModel: vi
        .fn()
        .mockRejectedValue(new CatalogApiError(500, { error: { code: "boom" } })),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    await expect(
      providersLoader({
        request: new Request(
          "https://admin.example/catalog/integrations/providers?providerKey=tcgdex&profileVersion=2026.06.04",
        ),
        params: {},
        context: {},
      } as Parameters<typeof providersLoader>[0]),
    ).rejects.toBeInstanceOf(CatalogApiError);
  });
});
