// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogApiError } from "../client";
import IntegrationsRoute, { action, loader } from "../routes/admin/integrations";
import { loader as providersLoader, action as providerSetupAction } from "../routes/admin/integrations-providers";
import { action as governanceAction } from "../routes/admin/integrations-governance";
import type { CatalogIntegrationsCommandResult } from "../support/route-support/admin-integrations/integrations-command-result";
import { buildCatalogPrimaryWorkbenchReadModel } from "../features/source-observations/ui/primary-workbench-read-model";
import {
  controlPlaneOverview,
  integrationJobSummary,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "../features/source-observations/ui/primary-workbench-test-fixtures";

const {
  mockCreateCatalogRequestApiClient,
  mockResolveActorFromAuthApi,
  mockUseLoaderData,
  mockUseRouteLoaderData,
  mockUseActionData,
} = vi.hoisted(() => ({
  mockCreateCatalogRequestApiClient: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
  mockUseLoaderData: vi.fn(),
  mockUseRouteLoaderData: vi.fn(),
  mockUseActionData: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useRouteLoaderData: mockUseRouteLoaderData,
    useActionData: mockUseActionData,
  };
});

vi.mock("../support/request-support/api-client", () => ({
  createCatalogRequestApiClient: mockCreateCatalogRequestApiClient,
}));

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  resolveActorFromAuthApi: mockResolveActorFromAuthApi,
}));

describe("Catalog integrations route", () => {
  afterEach(() => {
    cleanup();
    mockUseLoaderData.mockReset();
    mockUseRouteLoaderData.mockReset();
    mockUseActionData.mockReset();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveActorFromAuthApi.mockResolvedValue({
      permissions: ["catalog.view", "catalog.manage"],
    });
  });

  it("renders the rebuilt primary workbench as the default integrations experience", () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl = "https://admin.example/catalog/integrations?providerKey=tcgdex";
    mockUseLoaderData.mockReturnValue({
      data: scopes,
      query: {},
      profileReviews,
      controlPlaneOverview: null,
      requestUrl,
      readModel: buildCatalogPrimaryWorkbenchReadModel({
        requestUrl,
        scopes,
        profileReviews,
        controlPlaneOverview: null,
        canManageCatalog: true,
      }),
    });
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["catalog.view", "catalog.manage"] },
    });

    render(<IntegrationsRoute />);

    expect(
      screen.getByRole("heading", {
        name: "Pull provider data, review Source Observations, promote Catalog facts",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Integration Management")).toBeNull();
    expect(screen.queryByText("Old integrations surface")).toBeNull();
  });

  it("renders the provider import operation context and durable job evidence", () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1";
    mockUseLoaderData.mockReturnValue({
      data: scopes,
      query: {},
      profileReviews,
      controlPlaneOverview: controlPlaneOverview(),
      requestUrl,
      readModel: buildCatalogPrimaryWorkbenchReadModel({
        requestUrl,
        scopes,
        profileReviews,
        controlPlaneOverview: controlPlaneOverview(),
        canManageCatalog: true,
      }),
    });
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["catalog.view", "catalog.manage"] },
    });

    render(<IntegrationsRoute />);

    expect(screen.getAllByText("Provider import operations").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Profile snapshot").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tcgdex-pokemon-card@2026.06.04").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Observed observations").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Changed observations").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Current scope").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Consistency").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Snapshot: tcgdex-pokemon-card@2026.06.04").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Operator: Running").length).toBeGreaterThan(0);
  });

  it("renders the command-feedback banner from the action result while staying on the daily route", () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl = "https://admin.example/catalog/integrations?providerKey=tcgdex";
    mockUseLoaderData.mockReturnValue({
      data: scopes,
      query: {},
      profileReviews,
      controlPlaneOverview: null,
      requestUrl,
      commandFeedback: null,
      readModel: buildCatalogPrimaryWorkbenchReadModel({
        requestUrl,
        scopes,
        profileReviews,
        controlPlaneOverview: null,
        canManageCatalog: true,
      }),
    });
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["catalog.view", "catalog.manage"] },
    });
    // The daily action stays put and returns its result as data; the route reads it
    // via useActionData and renders the same command-feedback banner in place.
    mockUseActionData.mockReturnValue({
      feedback: { status: "success", intent: "start-provider-import", result: "job-queued" },
      context: { section: "import-to-promotion" },
      section: "import-to-promotion",
    });

    render(<IntegrationsRoute />);

    expect(screen.getByText("Command queued")).toBeTruthy();
  });

  it("scopes durable import jobs to the selected provider unit while keeping overlap conflicts visible", () => {
    const scopes = {
      items: [
        sourceObservationScope(),
        sourceObservationScope({ expansion_id: "jungle", series_id: "jungle", total_observations: 64 }),
      ],
      total: 2,
      count: 2,
    };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1";
    const overview = controlPlaneOverview({
      unitActivity: {
        generatedAt: "2026-06-09T01:05:00.000Z",
        units: [
          {
            unitKey: "tcgdex:pokemon:card:import",
            recentJobs: [
              integrationJobSummary({ jobId: "job_selected_scope", importScope: "en:3:base:base1" }),
              integrationJobSummary({ jobId: "job_selected_scope", importScope: "en:3:base:base1" }),
              integrationJobSummary({
                jobId: "job_overlapping_scope",
                importScope: "en:3:jungle:jungle",
                startedAt: "2026-06-09T01:02:00.000Z",
              }),
            ],
          },
          {
            unitKey: "scryfall:magic:card:import",
            recentJobs: [
              integrationJobSummary({
                jobId: "job_other_provider",
                unitKey: "scryfall:magic:card:import",
                providerKey: "scryfall",
                importScope: "en:magic:lea:lea",
                summary: "Scryfall import",
              }),
            ],
          },
        ],
      },
    });

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl,
      scopes,
      profileReviews,
      controlPlaneOverview: overview,
      canManageCatalog: true,
    });

    expect(readModel.importJobs.jobs.map((job) => job.jobId)).toEqual(["job_selected_scope", "job_overlapping_scope"]);
    expect(readModel.importJobs.jobs[0]?.scopeMatchesRoute).toBe(true);
    expect(readModel.importJobs.jobs[1]?.scopeMatchesRoute).toBe(false);
    expect(readModel.importJobs.jobs[1]?.blockers).toContain("active-job-conflict");
    expect(readModel.importJobs.activeJobCount).toBe(2);
    expect(readModel.importJobs.selectedScope?.readiness.blockers).toContain("active-job-conflict");
    expect(readModel.importJobs.selectedScope?.readiness.blockers).toContain("concurrent-job");
    expect(readModel.actions.find((actionEntry) => actionEntry.key === "start-provider-import")?.state).toBe("blocked");
    expect(readModel.importJobs.jobs[0]?.sourceObservationReviewHref).toContain("jobId=job_selected_scope");
    expect(readModel.importJobs.jobs[0]?.sourceObservationReviewHref).toContain("importScope=en%3A3%3Abase%3Abase1");
  });

  it("groups durable failures separately from provider transport failure categories", () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1";
    const baseOverview = controlPlaneOverview();
    const overview = controlPlaneOverview({
      providerReadiness: {
        ...baseOverview.providerReadiness,
        providers: [
          {
            ...baseOverview.providerReadiness.providers[0],
            apiReachability: {
              status: "blocked",
              diagnosticCodes: ["provider_timeout"],
              message: "Provider request timeout",
            },
            diagnostics: [
              {
                code: "provider_timeout",
                severity: "error",
                message: "Provider request timeout",
                unitKey: "tcgdex:pokemon:card:import",
                retryAfterSeconds: null,
                source: "provider-adapter",
              },
            ],
          },
        ],
      },
      unitActivity: {
        generatedAt: "2026-06-09T01:05:00.000Z",
        units: [
          {
            unitKey: "tcgdex:pokemon:card:import",
            recentJobs: [
              integrationJobSummary({
                jobId: "job_failed_provider_timeout",
                operatorStatus: "failed",
                phase: "failed",
                completed: 1,
                total: 3,
              }),
            ],
          },
        ],
      },
    });

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl,
      scopes,
      profileReviews,
      controlPlaneOverview: overview,
      canManageCatalog: true,
    });

    expect(readModel.readiness.providerTransport).toContain("timeout");
    expect(readModel.importJobs.selectedScope?.readiness.blockers).toContain("provider-transport-timeout");
    expect(readModel.importJobs.jobs[0]?.failureGroups.map((group) => group.key)).toEqual([
      "durable-job-failed",
      "provider-transport-timeout",
    ]);
  });

  it("records primary workbench view, provider scope, and support detour telemetry from the loader", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getSourceObservationProviderProfileAuthoringModel: vi
        .fn()
        .mockResolvedValue(profileAuthoringModel({ review: profileReviews.items[0] })),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      recordCatalogControlPlaneEvent,
    });

    await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=readiness",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.primary_workbench_viewed",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        scopeId: "en:3:base:base1",
      }),
    );
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.provider_scope_selected",
      }),
    );
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.supporting_workflow_detour_opened",
        detourTarget: "validation-readiness",
        detourOutcome: "opened",
      }),
    );
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
    expect(
      Object.fromEntries(routeData.readModel.sourceOptions.pages.map((page) => [page.queryKind, page.state])),
    ).toEqual({
      languages: "cached",
      series: "cached",
      expansions: "stale",
    });
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
    const scopes = { items: [sv8Scope], total: 1, count: 1 };
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
        });
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
    expect(routeData.readModel.sourceOptions.pages.find((page) => page.queryKind === "expansions")).toMatchObject({
      state: "stale",
      items: [expect.objectContaining({ value: "SV8", label: "Super Electric Breaker" })],
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
    expect(
      routeData.readModel.actions.find((actionEntry) => actionEntry.key === "start-provider-import"),
    ).toMatchObject({
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
    expect(routeData.readModel.sourceOptions.pages.find((page) => page.queryKind === "expansions")).toMatchObject({
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
        _intent: "start-provider-import",
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
    const previewResult = await runDailyAction(
      {
        _intent: "preview-promotion",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        languageCode: "ja",
        seriesId: "SV",
        expansionId: "SV8",
        profileVersion: "2026.06.04",
      },
      selectedScopeUrl,
    );
    const selectedScopePromotionFilter = {
      provider: "tcgdex",
      language: "ja",
      seriesId: "sv",
      expansionId: "sv8",
      setId: "sv8",
    };
    expect(previewBulkPromoteSourceObservations).toHaveBeenCalledWith(selectedScopePromotionFilter);
    expect(previewResult.context.promotionPreviewId).toBe(
      "preview-tcgdex_tcgdex_pokemon_single-card_source-observation-import_ja_SV_SV8_2026.06.04_ja_sv8_all_none_filtered-130-130",
    );

    const bulkPromoteSourceObservationsByScope = vi.fn().mockResolvedValue({ jobId: "job_promote_ja_sv8" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      previewBulkPromoteSourceObservations,
      bulkPromoteSourceObservationsByScope,
    });
    const promoteResult = await runDailyAction(
      {
        _intent: "execute-promotion",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        languageCode: "ja",
        seriesId: "SV",
        expansionId: "SV8",
        profileVersion: "2026.06.04",
        promotionPreviewId: previewResult.context.promotionPreviewId ?? "",
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
    // Only the targeted expansions group is forced live; the rest stay cache-only.
    expect(byKind).toEqual({ languages: false, series: false, expansions: true });
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

  it("stays on the daily route and returns a job-queued result when queuing a scoped provider import", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_123" });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueSourceObservationIntegrationJob,
      recordCatalogControlPlaneEvent,
    });

    const result = await runDailyAction({
      _intent: "start-provider-import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    });

    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
      provider: "tcgdex",
      language: "en",
      productLineId: "3",
      seriesId: "base",
      setId: "base1",
    });
    // The run-sync path stays on the daily surface (no redirect) and returns its
    // result as data so the daily route renders the command-feedback banner.
    expect(result.section).toBe("import-to-promotion");
    expect(result.context.jobId).toBe("job_import_123");
    expect(result.feedback.status).toBe("success");
    expect(result.feedback.result).toBe("job-queued");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.import_started",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        scopeId: "en:3:base:base1",
        profileRef: "tcgdex:2026.06.04",
        jobRefState: "present",
        promotionResult: "job-queued",
      }),
    );
  });

  it("queues a TCGdex native language-series-set scope as a concrete expansion import", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_ja_sv8" });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueSourceObservationIntegrationJob,
      recordCatalogControlPlaneEvent,
    });

    await runDailyAction({
      _intent: "start-provider-import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      importScope: "ja:SV:SV8",
      profileVersion: "2026.06.03",
    });

    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
      provider: "tcgdex",
      language: "ja",
      seriesId: "SV",
      setId: "SV8",
    });
  });

  it("queues provider imports from structured scope fields without requiring legacy importScope", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_structured" });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueSourceObservationIntegrationJob,
      recordCatalogControlPlaneEvent,
    });

    const result = await runDailyAction({
      _intent: "start-provider-import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      languageCode: "ja",
      seriesId: "SV",
      expansionId: "SV8",
      profileVersion: "2026.06.03",
    });

    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
      provider: "tcgdex",
      language: "ja",
      seriesId: "SV",
      setId: "SV8",
    });
    expect(result.context.importScope).toBe("ja:SV:SV8");
    expect(result.context.scope).toMatchObject({
      providerKey: "tcgdex",
      languageCode: "ja",
      seriesId: "SV",
      expansionId: "SV8",
    });
  });

  it("does not enqueue a provider import until a concrete source scope is selected", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_provider_wide" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });

    const result = await runDailyAction({
      _intent: "start-provider-import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      profileVersion: "2026.06.03",
    });

    expect(enqueueSourceObservationIntegrationJob).not.toHaveBeenCalled();
    expect(result.section).toBe("import-to-promotion");
    expect(result.context.jobId).toBeNull();
    expect(result.feedback).toEqual({
      status: "error",
      intent: "start-provider-import",
      result: "command-failed",
    });
  });

  it("preserves selected IDs while creating a scoped promotion preview token", async () => {
    const previewBulkPromoteSourceObservationIds = vi.fn().mockResolvedValue({
      matched: 1,
      eligible: 1,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "changed", search: "" },
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservationIds });

    const result = await runDailyAction(
      {
        _intent: "preview-promotion",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        selectedObservationIds: " obs_001,obs_001 ",
      },
      "https://admin.example/catalog/integrations?filter.status=changed",
    );

    expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledWith(["obs_001"]);
    expect(result.section).toBe("import-to-promotion");
    expect(result.context.selectedObservationIds).toEqual(["obs_001"]);
    expect(result.context.promotionPreviewId).toBe(
      "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_changed_none_obs_001-1-1",
    );
    expect(result.feedback.result).toBe("preview-ready");
  });

  it("previews the matching TCGdex scope without silently narrowing fresh observations out", async () => {
    const previewBulkPromoteSourceObservations = vi.fn().mockResolvedValue({
      matched: 124,
      eligible: 124,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "", search: "" },
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservations });

    const result = await runDailyAction({
      _intent: "preview-promotion",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    });

    expect(previewBulkPromoteSourceObservations).toHaveBeenCalledWith({
      provider: "tcgdex",
      language: "en",
      productLineId: "3",
      seriesId: "base",
      expansionId: "base1",
      setId: "base1",
    });
    expect(result.context.promotionPreviewId).toBe(
      "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_all_none_filtered-124-124",
    );
  });

  it("fails closed when a scope preview has provider and unit but no concrete scope", async () => {
    const previewBulkPromoteSourceObservations = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservations });

    const result = await runDailyAction({
      _intent: "preview-promotion",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      profileVersion: "2026.06.04",
    });

    expect(previewBulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("command-failed");
    expect(result.context.promotionPreviewId).toBeNull();
  });

  it("bridges profile draft creation through the typed provider profile clone API", async () => {
    const cloneSourceObservationProviderProfile = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04-draft",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      cloneSourceObservationProviderProfile,
      recordCatalogControlPlaneEvent,
    });

    const response = await runProviderSetupAction({
      _intent: "clone-provider-profile",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      sourceProviderKey: "tcgdex",
      sourceProfileVersion: "2026.06.04",
      targetProfileVersion: "2026.06.04-draft",
      targetLifecycle: "draft",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(cloneSourceObservationProviderProfile).toHaveBeenCalledWith("tcgdex", "2026.06.04", {
      targetProfileVersion: "2026.06.04-draft",
      lifecycle: "draft",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/integrations/providers");
    expect(response.headers.get("Location")).toContain("providerKey=tcgdex");
    expect(response.headers.get("Location")).toContain("profileVersion=2026.06.04-draft");
    expect(response.headers.get("Location")).toContain("selectedObservationIds=obs_001");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(response.headers.get("Location")).toContain("commandStatus=success");
    expect(response.headers.get("Location")).toContain("commandResult=draft-created");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_draft_created",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        scopeId: "en:3:base:base1",
        profileRef: "tcgdex:2026.06.04-draft",
        promotionResult: "draft-created",
        detourTarget: "profile-authoring",
        detourOutcome: "returned",
      }),
    );
  });

  it("fails closed when profile draft creation receives a non-draft lifecycle", async () => {
    const cloneSourceObservationProviderProfile = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ cloneSourceObservationProviderProfile });

    const response = await runProviderSetupAction({
      _intent: "clone-provider-profile",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      sourceProviderKey: "tcgdex",
      sourceProfileVersion: "2026.06.04",
      targetProfileVersion: "2026.06.04-test",
      targetLifecycle: "test",
    });

    expect(cloneSourceObservationProviderProfile).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/integrations/providers");
    expect(response.headers.get("Location")).toContain("commandStatus=error");
    expect(response.headers.get("Location")).toContain("commandResult=invalid-intent");
  });

  it("bridges guided profile section saves through the typed section PATCH API", async () => {
    const getSourceObservationProviderProfileAuthoringModel = vi.fn().mockResolvedValue(
      profileAuthoringModel({
        review: profileReview({ active: false, lifecycle: "draft", profileVersion: "2026.06.04-draft" }),
      }),
    );
    const updateSourceObservationProviderProfileSection = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04-draft",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getSourceObservationProviderProfileAuthoringModel,
      updateSourceObservationProviderProfileSection,
      recordCatalogControlPlaneEvent,
    });

    const response = await runProviderSetupAction({
      _intent: "update-provider-profile-section",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04-draft",
      sectionKey: "basics",
      displayName: "TCGdex Pokemon cards draft",
      lifecycle: "draft",
      status: "planned",
      capabilities: "source-observation-import, catalog-item-promotion",
      supportedScopes: "pokemon/card",
      languageOptions: "en, fr",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(updateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
      "tcgdex",
      "2026.06.04-draft",
      "basics",
      expect.objectContaining({
        section: "basics",
        displayName: "TCGdex Pokemon cards draft",
        lifecycle: "draft",
        status: "planned",
        capabilities: ["source-observation-import", "catalog-item-promotion"],
        languageOptions: ["en", "fr"],
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/integrations/providers");
    expect(response.headers.get("Location")).toContain("profileVersion=2026.06.04-draft");
    expect(response.headers.get("Location")).toContain("commandResult=section-saved");
    expect(response.headers.get("Location")).toContain("commandSection=basics");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_section_saved",
        providerKey: "tcgdex",
        profileRef: "tcgdex:2026.06.04-draft",
        promotionResult: "section-saved",
        detourTarget: "profile-authoring",
      }),
    );
  });

  it("keeps migration-evidence saves inside validation readiness", async () => {
    const getSourceObservationProviderProfileAuthoringModel = vi.fn().mockResolvedValue(
      profileAuthoringModel({
        review: profileReview({ active: true, lifecycle: "active", profileVersion: "2026.06.04" }),
      }),
    );
    const updateSourceObservationProviderProfileSection = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getSourceObservationProviderProfileAuthoringModel,
      updateSourceObservationProviderProfileSection,
      recordCatalogControlPlaneEvent,
    });

    const response = await runProviderSetupAction(
      {
        _intent: "update-provider-profile-section",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        sectionKey: "migration-evidence",
        migrationEvidenceText: "Dry-run and replay evidence reviewed for the activation decision.",
        migrationFixtureRunId: "fixture-run-1037",
        migrationFingerprintBefore: "sha256:active-mapping",
        migrationFingerprintAfter: "sha256:candidate-mapping",
        migrationRecordedAt: "2026-06-11T00:00:00.000Z",
        promotionPreviewId: "preview-stale",
      },
      "https://admin.example/catalog/integrations?section=readiness&providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04",
    );

    expect(updateSourceObservationProviderProfileSection).toHaveBeenCalledWith(
      "tcgdex",
      "2026.06.04",
      "migration-evidence",
      expect.objectContaining({
        section: "migration-evidence",
        migrationEvidence: expect.objectContaining({
          evidenceText: "Dry-run and replay evidence reviewed for the activation decision.",
          fixtureRunId: "fixture-run-1037",
          mappingFingerprintBefore: "sha256:active-mapping",
          mappingFingerprintAfter: "sha256:candidate-mapping",
          recordedAt: "2026-06-11T00:00:00.000Z",
        }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/integrations/providers");
    expect(response.headers.get("Location")).toContain("section=readiness");
    expect(response.headers.get("Location")).toContain("commandResult=section-saved");
    expect(response.headers.get("Location")).toContain("commandSection=migration-evidence");
    expect(response.headers.get("Location")).not.toContain("section=profile-work");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_section_saved",
        providerKey: "tcgdex",
        profileRef: "tcgdex:2026.06.04",
        promotionResult: "section-saved",
        detourTarget: "validation-readiness",
        detourOutcome: "returned",
      }),
    );
  });

  it("activates provider profiles from validation readiness", async () => {
    const activateSourceObservationProviderProfile = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      activateSourceObservationProviderProfile,
      recordCatalogControlPlaneEvent,
    });

    const response = await runProviderSetupAction(
      {
        _intent: "activate-provider-profile",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        selectedObservationIds: "obs_001",
        promotionPreviewId: "preview-stale",
      },
      "https://admin.example/catalog/integrations?section=readiness&providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04",
    );

    expect(activateSourceObservationProviderProfile).toHaveBeenCalledWith("tcgdex", "2026.06.04");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/integrations/providers");
    expect(response.headers.get("Location")).toContain("section=readiness");
    expect(response.headers.get("Location")).toContain("providerKey=tcgdex");
    expect(response.headers.get("Location")).toContain("profileVersion=2026.06.04");
    expect(response.headers.get("Location")).toContain("selectedObservationIds=obs_001");
    expect(response.headers.get("Location")).toContain("commandStatus=success");
    expect(response.headers.get("Location")).toContain("commandResult=profile-activated");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_activated",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        scopeId: "en:3:base:base1",
        profileRef: "tcgdex:2026.06.04",
        promotionResult: "profile-activated",
        detourTarget: "validation-readiness",
        detourOutcome: "returned",
      }),
    );
  });

  it("runs provider profile rollback, deprecation, and retirement from lifecycle recovery", async () => {
    const rollbackSourceObservationProviderProfile = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.03",
    });
    const deprecateSourceObservationProviderProfile = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
    });
    const retireSourceObservationProviderProfile = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.02",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      rollbackSourceObservationProviderProfile,
      deprecateSourceObservationProviderProfile,
      retireSourceObservationProviderProfile,
      recordCatalogControlPlaneEvent,
    });

    const lifecycleUrl =
      "https://admin.example/catalog/integrations?section=lifecycle&providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1";
    const rollbackResponse = await runGovernanceAction(
      {
        _intent: "rollback-provider-profile",
        providerKey: "tcgdex",
        profileVersion: "2026.06.03",
        lifecycleConfirmation: lifecycleConfirmationValue("rollback-provider-profile", "tcgdex", "2026.06.03"),
        selectedObservationIds: "obs_001",
        promotionPreviewId: "preview-stale",
      },
      lifecycleUrl,
    );
    const deprecateResponse = await runGovernanceAction(
      {
        _intent: "deprecate-provider-profile",
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        lifecycleConfirmation: lifecycleConfirmationValue("deprecate-provider-profile", "tcgdex", "2026.06.04"),
      },
      lifecycleUrl,
    );
    const retireResponse = await runGovernanceAction(
      {
        _intent: "retire-provider-profile",
        providerKey: "tcgdex",
        profileVersion: "2026.06.02",
        lifecycleConfirmation: lifecycleConfirmationValue("retire-provider-profile", "tcgdex", "2026.06.02"),
      },
      lifecycleUrl,
    );

    expect(rollbackSourceObservationProviderProfile).toHaveBeenCalledWith("tcgdex", "2026.06.03");
    expect(deprecateSourceObservationProviderProfile).toHaveBeenCalledWith("tcgdex", "2026.06.04");
    expect(retireSourceObservationProviderProfile).toHaveBeenCalledWith("tcgdex", "2026.06.02");
    expect(rollbackResponse.headers.get("Location")).toContain("/catalog/integrations/governance");
    expect(rollbackResponse.headers.get("Location")).toContain("section=lifecycle");
    expect(rollbackResponse.headers.get("Location")).toContain("commandResult=profile-rolled-back");
    expect(rollbackResponse.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(deprecateResponse.headers.get("Location")).toContain("commandResult=profile-deprecated");
    expect(retireResponse.headers.get("Location")).toContain("commandResult=profile-retired");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_rolled_back",
        detourTarget: "lifecycle-recovery",
        detourOutcome: "returned",
        promotionResult: "profile-rolled-back",
      }),
    );
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_deprecated",
        promotionResult: "profile-deprecated",
      }),
    );
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_retired",
        promotionResult: "profile-retired",
      }),
    );
  });

  it("fails closed when profile lifecycle confirmation is missing", async () => {
    const retireSourceObservationProviderProfile = vi.fn();
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      retireSourceObservationProviderProfile,
      recordCatalogControlPlaneEvent,
    });

    const response = await runGovernanceAction(
      {
        _intent: "retire-provider-profile",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.02",
      },
      "https://admin.example/catalog/integrations?section=lifecycle&providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
    );

    expect(retireSourceObservationProviderProfile).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/integrations/governance");
    expect(response.headers.get("Location")).toContain("section=lifecycle");
    expect(response.headers.get("Location")).toContain("commandStatus=error");
    expect(response.headers.get("Location")).toContain("commandResult=confirmation-required");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.blocker_hit",
        providerKey: "tcgdex",
        profileRef: "tcgdex:2026.06.02",
        promotionResult: "confirmation-required",
        detourTarget: "lifecycle-recovery",
        detourOutcome: "blocked",
        blockerCategory: "readiness",
      }),
    );
  });

  it("returns lifecycle-scoped feedback for profile lifecycle consistency conflicts", async () => {
    const retireSourceObservationProviderProfile = vi
      .fn()
      .mockRejectedValue(new CatalogApiError(409, { error: { code: "profile_lifecycle_active_jobs" } }));
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      retireSourceObservationProviderProfile,
      recordCatalogControlPlaneEvent,
    });

    const response = await runGovernanceAction(
      {
        _intent: "retire-provider-profile",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.02",
        lifecycleConfirmation: lifecycleConfirmationValue("retire-provider-profile", "tcgdex", "2026.06.02"),
        promotionPreviewId: "preview-stale",
      },
      "https://admin.example/catalog/integrations?section=lifecycle&providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/integrations/governance");
    expect(response.headers.get("Location")).toContain("section=lifecycle");
    expect(response.headers.get("Location")).toContain("commandStatus=error");
    expect(response.headers.get("Location")).toContain("commandResult=lifecycle-conflict");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.blocker_hit",
        providerKey: "tcgdex",
        profileRef: "tcgdex:2026.06.02",
        promotionResult: "lifecycle-conflict",
        detourTarget: "lifecycle-recovery",
        detourOutcome: "blocked",
        blockerCategory: "active-job",
      }),
    );
  });

  it("returns section-scoped feedback for stale and invalid section saves", async () => {
    const getSourceObservationProviderProfileAuthoringModel = vi.fn().mockResolvedValue(
      profileAuthoringModel({
        review: profileReview({ active: false, lifecycle: "draft", profileVersion: "2026.06.04-draft" }),
      }),
    );
    const updateSourceObservationProviderProfileSection = vi
      .fn()
      .mockRejectedValueOnce(new CatalogApiError(409, { error: { code: "stale" } }))
      .mockRejectedValueOnce(new CatalogApiError(400, { error: { code: "invalid" } }));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getSourceObservationProviderProfileAuthoringModel,
      updateSourceObservationProviderProfileSection,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const conflictResponse = await runProviderSetupAction({
      _intent: "update-provider-profile-section",
      providerKey: "tcgdex",
      profileVersion: "2026.06.04-draft",
      sectionKey: "source-contract",
      sourceOwner: "chase-sets/catalog",
      sourceDocumentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
      fixtureSetVersion: "tcgdex-proof-v1",
    });
    const invalidResponse = await runProviderSetupAction({
      _intent: "update-provider-profile-section",
      providerKey: "tcgdex",
      profileVersion: "2026.06.04-draft",
      sectionKey: "source-contract",
      sourceOwner: "chase-sets/catalog",
      sourceDocumentPath: "",
      fixtureSetVersion: "tcgdex-proof-v1",
    });

    expect(conflictResponse.headers.get("Location")).toContain("commandResult=section-conflict");
    expect(conflictResponse.headers.get("Location")).toContain("commandSection=source-contract");
    expect(invalidResponse.headers.get("Location")).toContain("commandResult=section-invalid");
    expect(invalidResponse.headers.get("Location")).toContain("commandSection=source-contract");
  });

  it("fails closed when promotion execution has no fresh preview", async () => {
    const bulkPromoteSourceObservations = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ bulkPromoteSourceObservations });

    const result = await runDailyAction({
      _intent: "execute-promotion",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
    });

    expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(result.section).toBe("import-to-promotion");
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("preview-required");
  });

  it("executes promotion only when the live preview token matches the submitted context", async () => {
    const previewBulkPromoteSourceObservationIds = vi.fn().mockResolvedValue({
      matched: 1,
      eligible: 1,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "changed", search: "" },
    });
    const bulkPromoteSourceObservations = vi.fn().mockResolvedValue({ jobId: "job_promote_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      bulkPromoteSourceObservations,
      previewBulkPromoteSourceObservationIds,
    });

    const result = await runDailyAction({
      _intent: "execute-promotion",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
      promotionPreviewId:
        "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_all_none_obs_001-1-1",
    });

    expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledWith(["obs_001"]);
    expect(bulkPromoteSourceObservations).toHaveBeenCalledWith(["obs_001"]);
    // The create-update (promote) path stays on the daily surface with a banner.
    expect(result.section).toBe("import-to-promotion");
    expect(result.context.jobId).toBe("job_promote_123");
    expect(result.context.promotionPreviewId).toBeNull();
    expect(result.feedback.result).toBe("job-queued");
  });

  it("rejects promotion execution when the stored preview belongs to a different profile context", async () => {
    const previewBulkPromoteSourceObservationIds = vi.fn().mockResolvedValue({
      matched: 1,
      eligible: 1,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "changed", search: "" },
    });
    const bulkPromoteSourceObservations = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({
      bulkPromoteSourceObservations,
      previewBulkPromoteSourceObservationIds,
    });

    const result = await runDailyAction({
      _intent: "execute-promotion",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.05",
      selectedObservationIds: "obs_001",
      promotionPreviewId:
        "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_changed_none_obs_001-1-1",
    });

    expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(result.context.promotionPreviewId).toBeNull();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("preview-required");
  });

  it("executes matching-filter promotion with the same explicit broad scope used for preview", async () => {
    const previewBulkPromoteSourceObservations = vi.fn().mockResolvedValue({
      matched: 124,
      eligible: 124,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "", search: "" },
    });
    const bulkPromoteSourceObservationsByScope = vi.fn().mockResolvedValue({ jobId: "job_promote_scope" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      bulkPromoteSourceObservationsByScope,
      previewBulkPromoteSourceObservations,
    });

    const result = await runDailyAction({
      _intent: "execute-promotion",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      promotionPreviewId:
        "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_all_none_filtered-124-124",
    });

    expect(previewBulkPromoteSourceObservations).toHaveBeenCalledWith({
      provider: "tcgdex",
      language: "en",
      productLineId: "3",
      seriesId: "base",
      expansionId: "base1",
      setId: "base1",
    });
    expect(bulkPromoteSourceObservationsByScope).toHaveBeenCalledWith({
      provider: "tcgdex",
      language: "en",
      productLineId: "3",
      seriesId: "base",
      expansionId: "base1",
      setId: "base1",
    });
    expect(result.context.jobId).toBe("job_promote_scope");
    expect(result.feedback.result).toBe("job-queued");
  });

  it("fails closed when scoped promotion execution has no concrete scope", async () => {
    const previewBulkPromoteSourceObservations = vi.fn();
    const bulkPromoteSourceObservationsByScope = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({
      bulkPromoteSourceObservationsByScope,
      previewBulkPromoteSourceObservations,
    });

    const result = await runDailyAction({
      _intent: "execute-promotion",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      profileVersion: "2026.06.04",
      promotionPreviewId: "preview-tcgdex_tcgdex_pokemon_card_import_none-124-124",
    });

    expect(previewBulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(bulkPromoteSourceObservationsByScope).not.toHaveBeenCalled();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("preview-required");
    expect(result.context.promotionPreviewId).toBeNull();
  });

  it("requires a rejection reason before enqueueing reject jobs", async () => {
    const bulkRejectSourceObservations = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ bulkRejectSourceObservations });

    const result = await runDailyAction({
      _intent: "reject-source-observations",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
    });

    expect(bulkRejectSourceObservations).not.toHaveBeenCalled();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("reason-required");
  });

  it("enqueues reject jobs once the operator supplies an audit reason", async () => {
    const bulkRejectSourceObservations = vi.fn().mockResolvedValue({ jobId: "job_reject_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ bulkRejectSourceObservations });

    const result = await runDailyAction({
      _intent: "reject-source-observations",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
      reason: "Provider evidence is not launch-ready.",
    });

    expect(bulkRejectSourceObservations).toHaveBeenCalledWith(["obs_001"], "Provider evidence is not launch-ready.");
    expect(result.context.jobId).toBe("job_reject_123");
    expect(result.feedback.result).toBe("job-queued");
  });

  it("enqueues active-profile reapply jobs for selected Source Observations", async () => {
    const reapplySourceObservations = vi.fn().mockResolvedValue({ jobId: "job_reapply_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ reapplySourceObservations });

    const result = await runDailyAction({
      _intent: "start-reapply",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(reapplySourceObservations).toHaveBeenCalledWith(["obs_001"]);
    expect(result.context.jobId).toBe("job_reapply_123");
    expect(result.context.promotionPreviewId).toBeNull();
    expect(result.feedback.result).toBe("job-queued");
  });

  it("bridges provider import lifecycle commands to durable job APIs", async () => {
    const retrySourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_123" });
    const resumeSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_123" });
    const cancelSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      retrySourceObservationIntegrationJob,
      resumeSourceObservationIntegrationJob,
      cancelSourceObservationIntegrationJob,
    });

    const retryResult = await runDailyAction({ _intent: "retry-import-job", jobId: "job_import_123" });
    const resumeResult = await runDailyAction({ _intent: "resume-import-job", jobId: "job_import_123" });
    const cancelResult = await runDailyAction({ _intent: "cancel-import-job", jobId: "job_import_123" });

    expect(retrySourceObservationIntegrationJob).toHaveBeenCalledWith("job_import_123");
    expect(resumeSourceObservationIntegrationJob).toHaveBeenCalledWith("job_import_123");
    expect(cancelSourceObservationIntegrationJob).toHaveBeenCalledWith("job_import_123");
    expect(retryResult.feedback.result).toBe("job-queued");
    expect(resumeResult.feedback.result).toBe("job-queued");
    expect(cancelResult.feedback.result).toBe("job-cancelled");
  });

  it("requires a durable import job id before lifecycle commands can run", async () => {
    const retrySourceObservationIntegrationJob = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ retrySourceObservationIntegrationJob });

    const result = await runDailyAction({ _intent: "retry-import-job" });

    expect(retrySourceObservationIntegrationJob).not.toHaveBeenCalled();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("job-required");
  });

  it("enqueues defer jobs and clears stale promotion previews", async () => {
    const deferSourceObservations = vi.fn().mockResolvedValue({ jobId: "job_defer_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ deferSourceObservations });

    const deferResult = await runDailyAction({
      _intent: "defer-source-observations",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(deferSourceObservations).toHaveBeenCalledWith(["obs_001"], "Deferred from the primary workbench.");
    expect(deferResult.context.jobId).toBe("job_defer_123");
    expect(deferResult.feedback.result).toBe("job-queued");
    expect(deferResult.context.promotionPreviewId).toBeNull();
    expect(deferResult.context.selectedObservationIds).toEqual([]);
  });

  it("enqueues original-profile replay jobs for selected Source Observations", async () => {
    const replaySourceObservations = vi.fn().mockResolvedValue({ jobId: "job_replay_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ replaySourceObservations });

    const replayResult = await runDailyAction({
      _intent: "start-replay",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(replaySourceObservations).toHaveBeenCalledWith(["obs_001"]);
    expect(replayResult.context.jobId).toBe("job_replay_123");
    expect(replayResult.feedback.result).toBe("job-queued");
    expect(replayResult.context.promotionPreviewId).toBeNull();
  });

  it("returns sanitized feedback for invalid intents and API failures", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockRejectedValue(new Error("provider secret leaked"));
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });

    const invalidResult = await runDailyAction({ _intent: "legacy-json-patch" });
    const failureResult = await runDailyAction({
      _intent: "start-provider-import",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
    });

    expect(invalidResult.feedback.result).toBe("invalid-intent");
    expect(failureResult.feedback.result).toBe("command-failed");
    // The sanitized result never carries the underlying error message.
    expect(JSON.stringify(failureResult)).not.toContain("provider secret leaked");
  });
});

function sourceOptionResponse(
  queryKind: string,
  input: Readonly<{
    status: "fresh" | "stale";
    source: "cache" | "live";
    parentValue: string | null;
    degraded: boolean;
    value?: string;
    label?: string;
    metadata?: Record<string, string>;
  }>,
) {
  const value =
    input.value ??
    (queryKind === "languages"
      ? "en"
      : queryKind === "series"
        ? "base"
        : queryKind === "expansions"
          ? "base1"
          : "option");
  const label =
    input.label ??
    (queryKind === "languages"
      ? "English"
      : queryKind === "series"
        ? "Base"
        : queryKind === "expansions"
          ? "Base Set"
          : "Option");

  return {
    items: [
      {
        providerKey: "tcgdex",
        queryKind,
        value,
        label,
        description: null,
        parentValue: input.parentValue,
        imageUrl: null,
        metadata: input.metadata ?? {},
      },
    ],
    total: 1,
    count: 1,
    page: {
      cursor: null,
      nextCursor: null,
      limit: 25,
      hasMore: false,
    },
    cache: {
      status: input.status,
      source: input.source,
      cacheKey: `sha256:${queryKind}`,
      fetchedAt: "2026-06-09T00:00:00.000Z",
      expiresAt: "2026-06-09T00:15:00.000Z",
      staleUntil: "2026-06-10T00:00:00.000Z",
      cacheOnly: true,
      forceRefresh: false,
      degraded: input.degraded,
      diagnostics: input.degraded
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

function lifecycleConfirmationValue(intent: string, providerKey: string, profileVersion: string): string {
  return `confirm:${intent}:${providerKey}:${profileVersion}`;
}

function actionRequest(body: Record<string, string>, url: string) {
  return {
    request: new Request(url, { method: "POST", body: new URLSearchParams(body) }),
    params: {},
    context: {},
  } as Parameters<typeof action>[0];
}

// The daily surface action stays put and returns its command result as data. The
// daily-command tests assert on that structured result (feedback + context).
async function runDailyAction(
  body: Record<string, string>,
  url = "https://admin.example/catalog/integrations",
): Promise<CatalogIntegrationsCommandResult> {
  const result = await action(actionRequest(body, url));
  if (result instanceof Response) {
    throw new Error(`Daily command unexpectedly redirected to ${result.headers.get("Location") ?? "(none)"}`);
  }
  return result;
}

// The provider-setup and governance surfaces own a redirect after their commands;
// those tests assert on the redirect Response the surface decides from the result.
async function runProviderSetupAction(
  body: Record<string, string>,
  url = "https://admin.example/catalog/integrations/providers",
): Promise<Response> {
  return providerSetupAction(actionRequest(body, url) as Parameters<typeof providerSetupAction>[0]);
}

async function runGovernanceAction(
  body: Record<string, string>,
  url = "https://admin.example/catalog/integrations/governance",
): Promise<Response> {
  return governanceAction(actionRequest(body, url) as Parameters<typeof governanceAction>[0]);
}
