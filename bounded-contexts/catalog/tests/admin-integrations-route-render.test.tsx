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
  it("renders the rebuilt primary workbench as the default integrations experience", () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl = "https://admin.example/catalog/integrations?providerKey=tcgdex";
    mockUseLoaderData.mockReturnValue(loaderData({ data: scopes, profileReviews, requestUrl }));
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
    mockUseLoaderData.mockReturnValue(
      loaderData({ data: scopes, profileReviews, requestUrl, controlPlaneOverview: controlPlaneOverview() }),
    );
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
    mockUseLoaderData.mockReturnValue(loaderData({ data: scopes, profileReviews, requestUrl, commandFeedback: null }));
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["catalog.view", "catalog.manage"] },
    });
    // The daily action stays put and returns its result as data; the route reads it
    // via useActionData and renders the same command-feedback banner in place.
    mockUseActionData.mockReturnValue({
      feedback: { status: "success", intent: "scope.import", result: "job-queued" },
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
    mockUseLoaderData.mockReturnValue(loaderData({ data: scopes, profileReviews, requestUrl, commandFeedback: null }));
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["catalog.view", "catalog.manage"] },
    });
    mockUseActionData.mockReturnValue({
      feedback: { status: "error", intent: "scope.sync", result: "catalog-sync-blocked" },
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
    mockUseLoaderData.mockReturnValue(loaderData({ data: scopes, profileReviews, requestUrl, commandFeedback: null }));
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["catalog.view", "catalog.manage"] },
    });
    mockUseActionData.mockReturnValue({
      feedback: { status: "success", intent: "observation.promote", result: "preview-ready" },
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
    expect(readModel.actions.find((actionEntry) => actionEntry.key === "scope.import")?.state).toBe("blocked");
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

    // "readiness" (validation-readiness) is retired (#3832 — folded into the v2
    // Provider detail page); "controls" (governance-controls) is a still-live
    // ?section= workspace, so it now exercises the same generic detour-telemetry
    // mechanism.
    await loader({
      request: new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=controls",
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
        detourTarget: "governance-controls",
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
      routeData.readModel.actions.find((actionEntry) => actionEntry.key === "scope.import")?.blockers,
    ).not.toContain("permission-denied");
  });
});
