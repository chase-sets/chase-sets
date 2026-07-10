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
  integrationJobSummary,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "../features/source-observations/ui/primary-workbench-test-fixtures";
import type { CatalogIntegrationControlPlaneUnitReadiness } from "../features/source-observations/ui/contracts";

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
      readModel: buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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
      readModel: buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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
      readModel: buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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

  it("renders specific Catalog sync blocked feedback from the action result", () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl = "https://admin.example/catalog/integrations?providerKey=tcgplayer";
    mockUseLoaderData.mockReturnValue({
      data: scopes,
      query: {},
      profileReviews,
      controlPlaneOverview: null,
      requestUrl,
      commandFeedback: null,
      readModel: buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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
    mockUseActionData.mockReturnValue({
      feedback: { status: "error", intent: "start-catalog-sync", result: "catalog-sync-blocked" },
      context: { section: "import-to-promotion" },
      section: "import-to-promotion",
    });

    render(<IntegrationsRoute />);

    expect(screen.getByText("Catalog sync needs attention")).toBeTruthy();
    expect(screen.getByText(/Catalog sync could not start for the selected provider scope/i)).toBeTruthy();
  });

  it("replaces the daily URL when preview-ready action data carries a routable checkpoint", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04";
    mockUseLoaderData.mockReturnValue({
      data: scopes,
      query: {},
      profileReviews,
      controlPlaneOverview: null,
      requestUrl,
      commandFeedback: null,
      readModel: buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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
    mockUseActionData.mockReturnValue({
      feedback: { status: "success", intent: "preview-promotion", result: "preview-ready" },
      context: parseCatalogPrimaryWorkbenchRouteContext(
        `${requestUrl}&selectedObservationIds=obs_001&promotionPreviewId=preview_001`,
      ),
      section: "import-to-promotion",
    });

    render(<IntegrationsRoute />);

    await waitFor(() => expect(mockUseNavigate).toHaveBeenCalledTimes(1));
    const [href, options] = mockUseNavigate.mock.calls[0] ?? [];
    const target = new URL(String(href), "https://admin.example");
    expect(options).toEqual({ replace: true });
    expect(target.pathname).toBe("/catalog/integrations");
    expect(target.searchParams.get("selectedObservationIds")).toBe("obs_001");
    expect(target.searchParams.get("promotionPreviewId")).toBe("preview_001");
    expect(target.searchParams.get("commandResult")).toBe("preview-ready");
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

    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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

    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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

  it("retries transient auth resolution before rendering the shared importer", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const transientAuthError = new Error("auth api warming");
    mockIsTransientAuthResolutionError.mockImplementation((error) => error === transientAuthError);
    mockResolveActorFromAuthApi
      .mockRejectedValueOnce(transientAuthError)
      .mockResolvedValueOnce({ permissions: ["catalog.view", "catalog.manage"] });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request("https://admin.example/catalog/integrations?providerKey=tcgdex"),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(mockResolveActorFromAuthApi).toHaveBeenCalledTimes(2);
    expect(
      routeData.readModel.actions.find((actionEntry) => actionEntry.key === "start-provider-import")?.blockers,
    ).not.toContain("permission-denied");
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
      items: [
        profileReview({
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
        }),
      ],
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
      ingestionUnitKey: "tcgdex:pokemon:card:import",
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

  it("enqueues a scope-first Catalog sync run and carries the parent run id", async () => {
    const enqueueCatalogSyncRun = vi.fn().mockResolvedValue({ syncRunId: "catalog_sync_run_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueCatalogSyncRun,
    });

    const response = await runDailyActionRedirect({
      _intent: "start-catalog-sync",
      productDomain: "pokemon",
      productForm: "single-card",
      languageCode: "ja",
      referenceKind: "expansion",
      referenceId: "SV8",
      referenceName: "Super Electric Breaker",
      seriesId: "SV",
      seriesName: "Scarlet & Violet",
      expansionId: "SV8",
      expansionName: "Super Electric Breaker",
      selectedUnitKeys: "tcgdex:pokemon:single-card:source-observation-import",
      excludedUnitKeys: "",
    });
    const location = redirectLocation(response);

    expect(enqueueCatalogSyncRun).toHaveBeenCalledWith({
      scopeVersion: "catalog-sync-scope-v1",
      productDomain: "pokemon",
      productForm: "single-card",
      languageCode: "ja",
      reference: {
        kind: "expansion",
        id: "SV8",
        name: "Super Electric Breaker",
        seriesId: "SV",
        seriesName: "Scarlet & Violet",
      },
      providerHints: [],
      providerParticipation: {
        requiredUnitKeys: [],
        selectedUnitKeys: ["tcgdex:pokemon:single-card:source-observation-import"],
        excludedUnitKeys: [],
      },
    });
    expect(location.searchParams.get("jobId")).toBe("catalog_sync_run_123");
    expect(location.searchParams.get("commandStatus")).toBe("success");
    expect(location.searchParams.get("commandIntent")).toBe("start-catalog-sync");
    expect(location.searchParams.get("commandResult")).toBe("job-queued");
    expect(location.searchParams.get("importScope")).toBe("ja:SV:SV8");
  });

  it("preserves selected provider hints when starting a set-name Catalog sync run", async () => {
    const enqueueCatalogSyncRun = vi.fn().mockResolvedValue({ syncRunId: "catalog_sync_run_tcgplayer_base" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueCatalogSyncRun,
    });

    const response = await runDailyActionRedirect(
      {
        _intent: "start-catalog-sync",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        referenceKind: "set",
        referenceId: "Base Set",
        referenceName: "Base Set",
        selectedUnitKeys: "tcgplayer:pokemon:single-card:source-observation-import",
        providerHints: JSON.stringify({
          providerKey: "tcgplayer",
          unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
          productLineId: "3",
          productLineName: "Pokemon",
          setName: "Base Set",
        }),
      },
      "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:pokemon:single-card:source-observation-import&languageCode=en&productLineId=3&productLineName=Pokemon&expansionName=Base%20Set",
    );
    const location = redirectLocation(response);

    expect(enqueueCatalogSyncRun).toHaveBeenCalledWith({
      scopeVersion: "catalog-sync-scope-v1",
      productDomain: "pokemon",
      productForm: "single-card",
      languageCode: "en",
      reference: {
        kind: "set",
        id: "Base Set",
        name: "Base Set",
        seriesId: null,
        seriesName: null,
      },
      providerHints: [
        {
          providerKey: "tcgplayer",
          unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
          productLineId: "3",
          productLineName: "Pokemon",
          seriesId: null,
          setId: null,
          setName: "Base Set",
          productId: null,
        },
      ],
      providerParticipation: {
        requiredUnitKeys: [],
        selectedUnitKeys: ["tcgplayer:pokemon:single-card:source-observation-import"],
        excludedUnitKeys: [],
      },
    });
    expect(location.searchParams.get("jobId")).toBe("catalog_sync_run_tcgplayer_base");
    expect(location.searchParams.get("commandIntent")).toBe("start-catalog-sync");
    expect(location.searchParams.get("commandResult")).toBe("job-queued");
  });

  it("derives selected provider hints from the route scope when starting a set-name Catalog sync run", async () => {
    const enqueueCatalogSyncRun = vi.fn().mockResolvedValue({ syncRunId: "catalog_sync_run_tcgplayer_derived" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueCatalogSyncRun,
    });

    const response = await runDailyActionRedirect(
      {
        _intent: "start-catalog-sync",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        referenceKind: "set",
        referenceId: "Base Set",
        referenceName: "Base Set",
        selectedUnitKeys: "tcgplayer:pokemon:single-card:source-observation-import",
      },
      "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:pokemon:single-card:source-observation-import&languageCode=en&productLineId=3&productLineName=Pokemon&expansionName=Base%20Set",
    );
    const location = redirectLocation(response);

    expect(enqueueCatalogSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        providerHints: [
          expect.objectContaining({
            providerKey: "tcgplayer",
            unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
            productLineId: "3",
            productLineName: "Pokemon",
            setName: "Base Set",
          }),
        ],
      }),
    );
    expect(location.searchParams.get("jobId")).toBe("catalog_sync_run_tcgplayer_derived");
    expect(location.searchParams.get("commandResult")).toBe("job-queued");
  });

  it("fills missing provider parent values on partial set-name Catalog sync hints", async () => {
    const enqueueCatalogSyncRun = vi.fn().mockResolvedValue({ syncRunId: "catalog_sync_run_tcgplayer_partial" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueCatalogSyncRun,
    });

    await runDailyActionRedirect(
      {
        _intent: "start-catalog-sync",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        referenceKind: "set",
        referenceId: "Base Set",
        referenceName: "Base Set",
        selectedUnitKeys: "tcgplayer:pokemon:single-card:source-observation-import",
        providerHints: JSON.stringify({
          providerKey: "tcgplayer",
          unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
          setName: "Base Set",
        }),
      },
      "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:pokemon:single-card:source-observation-import&languageCode=en&productLineId=3&productLineName=Pokemon&expansionName=Base%20Set",
    );

    expect(enqueueCatalogSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        providerHints: [
          expect.objectContaining({
            providerKey: "tcgplayer",
            unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
            productLineId: "3",
            productLineName: "Pokemon",
            setName: "Base Set",
          }),
        ],
      }),
    );
  });

  it("keeps Catalog sync scope API blockers specific without leaking raw provider errors", async () => {
    const enqueueCatalogSyncRun = vi.fn().mockRejectedValue(
      new CatalogApiError(400, {
        error: {
          code: "invalid_scope",
          message: "provider secret leaked",
        },
      }),
    );
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueCatalogSyncRun,
    });

    const result = await runDailyAction(
      {
        _intent: "start-catalog-sync",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        referenceKind: "set",
        referenceId: "Base Set",
        referenceName: "Base Set",
        selectedUnitKeys: "tcgplayer:pokemon:single-card:source-observation-import",
        providerHints: JSON.stringify({
          providerKey: "tcgplayer",
          unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
          productLineId: "3",
          setName: "Base Set",
        }),
      },
      "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:pokemon:single-card:source-observation-import&languageCode=en&productLineId=3&expansionName=Base%20Set",
    );

    expect(enqueueCatalogSyncRun).toHaveBeenCalled();
    expect(result.feedback).toEqual({
      status: "error",
      intent: "start-catalog-sync",
      result: "catalog-sync-blocked",
    });
    expect(JSON.stringify(result)).not.toContain("provider secret leaked");
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
      ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
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
      ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
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

  it("queues shared source-scope workset row imports with the selected ingestion unit and set scope", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_magic_5dn" });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueSourceObservationIntegrationJob,
      recordCatalogControlPlaneEvent,
    });

    const result = await runDailyAction({
      _intent: "start-provider-import",
      providerKey: "mtgjson",
      unitKey: "mtgjson:mtg:single-card:reference-data",
      importScope: "en:5DN",
      languageCode: "en",
      productLineName: "Magic: The Gathering",
      seriesId: "",
      expansionId: "5DN",
      expansionName: "Fifth Dawn",
      profileVersion: "2026.06.19",
    });

    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
      provider: "mtgjson",
      ingestionUnitKey: "mtgjson:mtg:single-card:reference-data",
      language: "en",
      setId: "5DN",
      setName: "Fifth Dawn",
    });
    expect(result.feedback.result).toBe("job-queued");
    expect(result.context.jobId).toBe("job_magic_5dn");
  });

  it("queues TCGplayer set-name imports as setName, not a setId fallback", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_tcgplayer_classic_sixth" });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueSourceObservationIntegrationJob,
      recordCatalogControlPlaneEvent,
    });

    const result = await runDailyAction({
      _intent: "start-provider-import",
      providerKey: "tcgplayer",
      unitKey: "tcgplayer:mtg:single-card:source-observation-import",
      importScope: "en:1:Classic Sixth Edition",
      languageCode: "en",
      productLineId: "1",
      productLineName: "Magic: The Gathering",
      seriesId: "",
      seriesName: "",
      expansionId: "",
      expansionName: "Classic Sixth Edition",
      profileVersion: "2026.06.19",
    });

    expect(enqueueSourceObservationIntegrationJob).toHaveBeenCalledWith("import", {
      provider: "tcgplayer",
      ingestionUnitKey: "tcgplayer:mtg:single-card:source-observation-import",
      language: "en",
      productLineId: "1",
      setName: "Classic Sixth Edition",
    });
    expect(result.context.scope).toMatchObject({
      providerKey: "tcgplayer",
      languageCode: "en",
      productLineId: "1",
      expansionId: null,
      expansionName: "Classic Sixth Edition",
    });
    expect(result.context.importScope).toBe("en:1:Classic Sixth Edition");
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

  it("does not fall back to a stale URL importScope when the command form explicitly clears scope", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_stale_scope" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });

    const result = await runDailyAction(
      {
        _intent: "start-provider-import",
        providerKey: "ygoprodeck",
        unitKey: "ygoprodeck:yugioh:single-card:reference-data",
        importScope: "",
        languageCode: "",
        seriesId: "",
        expansionId: "",
        expansionName: "",
        profileVersion: "2026.06.21",
      },
      "https://admin.example/catalog/integrations?providerKey=ygoprodeck&unitKey=ygoprodeck%3Ayugioh%3Asingle-card%3Areference-data&importScope=ja%3ASV%3ASV8&seriesId=SV&expansionId=SV8",
    );

    expect(enqueueSourceObservationIntegrationJob).not.toHaveBeenCalled();
    expect(result.context.importScope).toBeNull();
    expect(result.context.scope).toMatchObject({
      providerKey: "ygoprodeck",
      languageCode: null,
      seriesId: null,
      expansionId: null,
      expansionName: null,
    });
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

    const response = await runDailyActionRedirect(
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
    const location = redirectLocation(response);

    expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledWith(["obs_001"]);
    expect(location.pathname).toBe("/catalog/integrations");
    expect(location.searchParams.get("selectedObservationIds")).toBe("obs_001");
    expect(location.searchParams.get("commandStatus")).toBe("success");
    expect(location.searchParams.get("commandResult")).toBe("preview-ready");
    expect(location.searchParams.get("promotionPreviewId")).toBe(
      "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_changed_none_obs_001-1-1",
    );
  });

  it("previews the matching TCGdex scope without silently narrowing fresh observations out", async () => {
    const previewBulkPromoteSourceObservations = vi.fn().mockResolvedValue({
      matched: 124,
      eligible: 124,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "", search: "" },
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservations });

    const response = await runDailyActionRedirect({
      _intent: "preview-promotion",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    });
    const location = redirectLocation(response);

    expect(previewBulkPromoteSourceObservations).toHaveBeenCalledWith({
      provider: "tcgdex",
      language: "en",
      productLineId: "3",
      seriesId: "base",
      expansionId: "base1",
      setId: "base1",
    });
    expect(location.pathname).toBe("/catalog/integrations");
    expect(location.searchParams.get("commandResult")).toBe("preview-ready");
    expect(location.searchParams.get("promotionPreviewId")).toBe(
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

  it("loads the alias-review read model into the daily surface route data (#1908)", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const getCatalogAliasReviewReadModel = vi.fn().mockResolvedValue(aliasReviewReadModel());
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      getCatalogAliasReviewReadModel,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04",
      ),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    const aliasReviewQuery = new URLSearchParams(getCatalogAliasReviewReadModel.mock.calls[0]?.[0] ?? "");
    expect(aliasReviewQuery.get("providerKey")).toBe("tcgdex");
    expect(aliasReviewQuery.get("sourceProfileVersion")).toBe("2026.06.04");
    // Alias review is deferred (#1970): it streams in behind the deferred slice.
    expect((await routeData.deferredAliasReview)?.counts.needsReview).toBe(1);
  });

  it("keeps the daily surface rendering when the alias-review read model is unavailable", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      getCatalogAliasReviewReadModel: vi.fn().mockRejectedValue(new CatalogApiError(503, { error: { code: "boom" } })),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request("https://admin.example/catalog/integrations?providerKey=tcgdex"),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    // Alias review is supplementary and deferred (#1970): a transient failure
    // resolves to null inside the streamed boundary, never breaking the
    // import-to-promotion workflow or rejecting the boundary into an error page.
    expect(await routeData.deferredAliasReview).toBeNull();
  });

  it("streams the alias-review workspace inline on the daily surface when the loader defers it", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl = "https://admin.example/catalog/integrations?providerKey=tcgdex";
    // The daily loader defers the alias-review read model (#1970); the route view
    // renders it behind a Suspense/Await boundary, so the workspace appears once
    // the streamed promise resolves rather than at first paint.
    mockUseLoaderData.mockReturnValue({
      requestUrl,
      commandFeedback: null,
      deferredAliasReview: Promise.resolve(aliasReviewReadModel()),
      readModel: buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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

    expect((await screen.findAllByText("Alias review")).length).toBeGreaterThan(0);
  });

  it("dispatches the #1905 accept command for the alias-review accept action and stays on the daily surface", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn().mockResolvedValue({
      intent: "accept",
      count: 1,
      applied: [{ aliasHash: "hash_a", reviewStatus: "accepted", version: 2 }],
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand });

    const result = await runDailyAction({ _intent: "accept", aliasHashes: "hash_a" });

    expect(dispatchCatalogAliasReviewCommand).toHaveBeenCalledWith({ intent: "accept", aliasHashes: ["hash_a"] });
    expect(result.section).toBe("import-to-promotion");
    expect(result.feedback.status).toBe("success");
  });

  it("dispatches the #1905 reject command with the operator reason for the alias-review reject action", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn().mockResolvedValue({
      intent: "reject",
      count: 1,
      applied: [{ aliasHash: "hash_a", reviewStatus: "rejected", version: 2 }],
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand });

    const result = await runDailyAction({
      _intent: "reject",
      aliasHashes: "hash_a",
      reason: "Generated, not official",
    });

    expect(dispatchCatalogAliasReviewCommand).toHaveBeenCalledWith({
      intent: "reject",
      aliasHashes: ["hash_a"],
      reason: "Generated, not official",
    });
    expect(result.feedback.status).toBe("success");
  });

  it("fails the alias-review reject action closed when no reason is supplied", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand });

    const result = await runDailyAction({ _intent: "reject", aliasHashes: "hash_a" });

    expect(dispatchCatalogAliasReviewCommand).not.toHaveBeenCalled();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("reason-required");
  });
});

function tcgplayerReadinessUnit(
  unitKey: string,
  displayNameProduct: string,
  productDomain: string,
): CatalogIntegrationControlPlaneUnitReadiness {
  return {
    unitKey,
    providerKey: "tcgplayer",
    displayName: `TCGplayer ${displayNameProduct} Single Cards`,
    productDomain,
    productForm: "single-card",
    ingestionPurpose: "source-observation-import",
    profileVersion: "2026.06.20",
    semanticReadiness: "ready",
    credentialReadiness: "ready",
    credentialReadinessState: "configured",
    credentialRequirement: "required",
    credentialDiagnosticCode: null,
    transportReadiness: "ready",
    fixtureValidationStatus: "ready",
    dryRunStatus: "completed",
    observationFacts: 0,
    diagnosticCounts: { info: 0, warning: 0, error: 0 },
    diagnostics: [],
    latestDiagnosticText: null,
    dryRunEvidence: [],
  };
}

function aliasReviewReadModel() {
  return {
    schemaVersion: "catalog-alias-review-v1" as const,
    generatedAt: "2026-06-16T00:00:00.000Z",
    filter: {
      providerKey: "tcgdex",
      sourceProfileVersion: "2026.06.04",
      aliasType: null,
      reviewStatuses: [],
      observationId: null,
    },
    counts: {
      total: 1,
      pending: 1,
      accepted: 0,
      autoAccepted: 0,
      rejected: 0,
      revoked: 0,
      needsReview: 1,
      autoAcceptEligible: 0,
      warned: 0,
    },
    candidates: [],
    groups: [],
    coverage: {
      cardsWithAcceptedEnglishAlias: 0,
      cardsWithOnlySpeciesAliases: 0,
      cardsNeedingReview: 0,
      expansionsAndSeriesNeedingReview: 0,
      cards: [],
      referenceScopes: [],
    },
  };
}

function scrydexOnePieceProfileReview(unitKey: string) {
  return profileReview({
    providerKey: "scrydex",
    profileKey: "scrydex-one-piece-card",
    profileVersion: "2026.06.22",
    ingestionUnitKey: unitKey,
    displayName: "Scrydex One Piece Cards",
    lifecycle: "active",
    active: true,
    status: "active",
    connectorKind: "scrydex-json",
    profile: {
      providerKey: "scrydex",
      supportedScopes: ["set-name", "product/card"],
    },
    supportedScopes: ["set-name", "product/card"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["set"],
        displayName: "Set",
        scope: "set-name",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
    ],
  });
}

function scrydexLorcanaProfileReview(unitKey: string) {
  return profileReview({
    providerKey: "scrydex",
    profileKey: "lorcana-card-print-source-observation",
    profileVersion: "2026.06.23",
    ingestionUnitKey: unitKey,
    displayName: "Scrydex Lorcana Cards",
    lifecycle: "active",
    active: true,
    status: "active",
    connectorKind: "scrydex-json",
    profile: {
      providerKey: "scrydex",
      supportedScopes: ["set-name", "lorcana/single-card"],
    },
    supportedScopes: ["set-name", "lorcana/single-card"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["set"],
        displayName: "Set",
        scope: "set-name",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
      {
        queryKind: "cards",
        queryKeySynonyms: ["card"],
        displayName: "Card",
        scope: "product/card",
        parentScope: "set-name",
        parentRequired: true,
        parentValueKind: "set-id",
        parentDiagnosticText: "Scrydex Lorcana card option queries require a selected set.",
      },
    ],
  });
}

function lorcastLorcanaProfileReview(unitKey: string) {
  return profileReview({
    providerKey: "lorcast",
    profileKey: "lorcast-lorcana-card-reference",
    profileVersion: "2026.06.23",
    ingestionUnitKey: unitKey,
    displayName: "Lorcast Lorcana single-card reference data",
    lifecycle: "active",
    active: true,
    status: "active",
    connectorKind: "lorcast-json",
    profile: {
      providerKey: "lorcast",
      supportedScopes: ["set-name", "lorcana/single-card"],
    },
    supportedScopes: ["set-name", "lorcana/single-card"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["set"],
        displayName: "Set",
        scope: "set-name",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
    ],
  });
}

function scrydexOnePieceImportPreview(unitKey: string) {
  return {
    action: "import" as const,
    providerKey: "scrydex",
    scope: {
      provider: "scrydex",
      ingestionUnitKey: unitKey,
      language: "en",
      setName: "OP16",
    },
    profileSnapshot: null,
    targetCount: 1,
    targets: [
      {
        targetId: "set:OP16",
        name: "OP16",
        languageCode: "en",
        scopeKey: "expansion-cards",
        planKey: "scrydex:one-piece:expansion:op16:cards",
        estimatedPayloads: null,
        transportSteps: ["Fetch Scrydex One Piece expansion cards with max page size"],
        usageEstimate: {
          requestStrategy: "bulk-first" as const,
          estimateState: "estimate-unavailable" as const,
          estimatedRequestCount: null,
          estimateReason: "Card page count is available only after the first Scrydex paged response.",
          pageSize: 250,
          selectedFields: ["id", "name", "number", "expansion"],
          perRecordFallbackReason: null,
          usageCheckState: "not-configured" as const,
          creditDiagnostic: "Scrydex usage endpoint is not configured for this environment.",
          degradedDiagnostic: null,
        },
      },
    ],
  };
}

function scrydexLorcanaImportPreview(unitKey: string) {
  return {
    action: "import" as const,
    providerKey: "scrydex",
    scope: {
      provider: "scrydex",
      ingestionUnitKey: unitKey,
      language: "en",
      setId: "TFC",
    },
    profileSnapshot: null,
    targetCount: 1,
    targets: [
      {
        targetId: "set:TFC",
        name: "The First Chapter",
        languageCode: "en",
        scopeKey: "expansion-cards",
        planKey: "scrydex:lorcana:expansion:tfc:cards",
        estimatedPayloads: null,
        transportSteps: ["Fetch Scrydex Lorcana expansion cards with max page size"],
        usageEstimate: {
          requestStrategy: "bulk-first" as const,
          estimateState: "estimate-unavailable" as const,
          estimatedRequestCount: null,
          estimateReason: "Card page count is available only after the first Scrydex paged response.",
          pageSize: 250,
          selectedFields: ["id", "name", "number", "expansion"],
          perRecordFallbackReason: null,
          usageCheckState: "not-configured" as const,
          creditDiagnostic: "Scrydex usage endpoint is not configured for this environment.",
          degradedDiagnostic: null,
        },
      },
    ],
  };
}

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

async function runDailyActionRedirect(
  body: Record<string, string>,
  url = "https://admin.example/catalog/integrations",
): Promise<Response> {
  const result = await action(actionRequest(body, url));
  if (!(result instanceof Response)) {
    throw new Error(`Daily command unexpectedly stayed on-page with ${JSON.stringify(result.feedback)}`);
  }
  return result;
}

function redirectLocation(response: Response): URL {
  const location = response.headers.get("Location");
  if (!location) {
    throw new Error("Expected redirect response to include a Location header.");
  }

  return new URL(location, "https://admin.example");
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
