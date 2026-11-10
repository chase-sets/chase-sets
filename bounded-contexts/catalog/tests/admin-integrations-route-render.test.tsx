// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError as CatalogApiError } from "../support/shell-support/api/client";
import IntegrationsRoute, { action, loader } from "../routes/admin/integrations";
import ScopeDetailRoute from "../routes/admin/scope-detail";
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
  syntheticPromotionReceipt,
} from "../features/source-observations/ui/primary-workbench-test-fixtures";
import type { CatalogIntegrationControlPlaneUnitReadiness } from "../features/source-observations/ui/contracts";
import { isActionAvailable } from "../features/source-observations/ui/admin-control-plane/import-to-promotion/command-controls";
import { catalogPrimaryWorkbenchHref } from "../features/source-observations/ui/primary-workbench-route-context";
import type { CatalogDeferredAttentionQueueResult } from "../features/attention-queue/api/contracts";
import { catalogAttentionQueueReadModelFixture } from "../features/attention-queue/api/attention-queue-test-fixtures";

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
  emptyPromotionValidation,
} from "./admin-integrations-route-test-support";

const {
  mockCreateCatalogRequestApiClient,
  mockIsTransientAuthResolutionError,
  mockResolveActorFromAuthApi,
  mockUseLoaderData,
  mockUseNavigate,
  mockUseRouteLoaderData,
  mockUseActionData,
  mockUseNavigation,
} = vi.hoisted(() => ({
  mockCreateCatalogRequestApiClient: vi.fn(),
  mockIsTransientAuthResolutionError: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
  mockUseLoaderData: vi.fn(),
  mockUseNavigate: vi.fn(),
  mockUseRouteLoaderData: vi.fn(),
  mockUseActionData: vi.fn(),
  mockUseNavigation: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useNavigate: () => mockUseNavigate,
    useRouteLoaderData: mockUseRouteLoaderData,
    useActionData: mockUseActionData,
    useNavigation: mockUseNavigation,
    useLocation: () => ({ pathname: "/catalog/integrations", search: "", hash: "", key: "synthetic-daily" }),
    // The import-jobs module polls live progress via useRevalidator and the daily
    // import-context form submits context changes via useSubmit; outside a data
    // router (this bare render) both need a stub so the workbench still renders.
    useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
    useSubmit: () => () => undefined,
  };
});

vi.mock("../support/request-support/api-client", async () => {
  const { withCatalogSurfaceReads } = await vi.importActual<
    typeof import("../features/source-observations/tests/integrations-surface-read-test-client")
  >("../features/source-observations/tests/integrations-surface-read-test-client");
  return {
    createCatalogRequestApiClient: (request: Request) =>
      withCatalogSurfaceReads(mockCreateCatalogRequestApiClient(request), request),
  };
});

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
    mockUseNavigation.mockReset();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseNavigation.mockReturnValue({ state: "idle" });
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

  it.each(["daily", "scope-detail"] as const)(
    "renders the held API sentinel and token-free three-page links on %s",
    (route) => {
      const requestUrl =
        "https://admin.example/catalog/integrations?providerKey=tcgdex&promotionPreviewId=sentinel-token&reviewOffset=25";
      const data = loaderData({ requestUrl });
      const base = data.readModel;
      const heldStages = base.flow.stages.map((stage) => ({
        ...stage,
        state: stage.key === "run-sync" ? ("current" as const) : ("blocked" as const),
      }));
      const readModel = {
        ...base,
        flow: {
          ...base.flow,
          openStage: "run-sync" as const,
          openStageWithHeldPreview: "review-changes" as const,
          stagesByOpenStage: { ...base.flow.stagesByOpenStage, "review-changes": heldStages },
        },
        sourceObservationReview: {
          ...base.sourceObservationReview,
          pagination: {
            ...base.sourceObservationReview.pagination,
            limit: 25,
            offset: 25,
            total: 75,
            previousCursor: "offset:0",
            nextCursor: "offset:50",
            previousHref:
              "/catalog/integrations?section=source-observation-review&sentinel=previous&promotionPreviewId=sentinel-token",
            nextHref:
              "/catalog/integrations?section=source-observation-review&sentinel=next&promotionPreviewId=sentinel-token",
          },
          statusFilters: base.sourceObservationReview.statusFilters.map((filter) => ({
            ...filter,
            href: `${filter.href}&promotionPreviewId=sentinel-token`,
          })),
        },
      };
      const journey = { ...data, readModel };
      mockUseLoaderData.mockReturnValue(
        route === "daily"
          ? journey
          : {
              scope: {
                scopeRecordId: "sentinel",
                productDomain: "pokemon",
                scopeKind: "expansion",
                name: "Synthetic scope",
                referenceTypeKey: "expansion",
                referenceRecordId: "sentinel",
                referenceRecordKey: "sentinel",
                parentScopeRecordId: null,
                productLineScopeRecordId: null,
                seriesScopeRecordId: null,
                releaseDate: null,
                officialSetCode: null,
                languageEditions: [],
                lifecycleStatus: "active",
                updatedAt: "2026-07-14T12:00:00Z",
                promotionReadiness: "ready",
                syncFreshness: "fresh",
              },
              journey,
              languageEditionAliasReview: null,
              coverageMatrix: null,
              candidateReviewJobs: null,
            },
      );
      mockUseRouteLoaderData.mockReturnValue({ actor: { permissions: ["catalog.view", "catalog.manage"] } });
      mockUseActionData.mockReturnValue({
        feedback: { status: "success", intent: "observation.promote", result: "preview-ready" },
        context: parseCatalogPrimaryWorkbenchRouteContext(requestUrl),
        section: "import-to-promotion",
        promotionReceipt: syntheticPromotionReceipt(),
      });
      render(route === "daily" ? <IntegrationsRoute /> : <ScopeDetailRoute />);
      const progress = screen.getAllByRole("list", { name: "Progress" }).at(-1)!;
      expect(progress.querySelector('[aria-current="step"]')?.textContent).toContain("Run sync");
      const previous = document.querySelector<HTMLAnchorElement>('a[rel="prev"]');
      const next = document.querySelector<HTMLAnchorElement>('a[rel="next"]');
      expect(previous).not.toBeNull();
      expect(next).not.toBeNull();
      for (const link of [previous!, next!]) {
        const url = new URL(link.href);
        expect(url.searchParams.has("promotionPreviewId")).toBe(false);
        expect(url.searchParams.has("sentinel")).toBe(true);
        expect(url.pathname).toBe(route === "daily" ? "/catalog/integrations" : "/catalog/scopes/sentinel");
      }
      expect(mockUseNavigate).not.toHaveBeenCalled();
    },
  );

  it("retains Preview evidence in place without navigating or putting its token in links", () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04";
    const data = loaderData({ data: scopes, profileReviews, requestUrl, commandFeedback: null });
    mockUseLoaderData.mockReturnValue(data);
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["catalog.view", "catalog.manage"] },
    });
    const receipt = syntheticPromotionReceipt({ previewId: "preview_001" });
    mockUseActionData.mockReturnValue({
      feedback: { status: "success", intent: "observation.promote", result: "preview-ready" },
      context: parseCatalogPrimaryWorkbenchRouteContext(
        `${requestUrl}&selectedObservationIds=obs_001&promotionPreviewId=preview_001`,
      ),
      section: "import-to-promotion",
      promotionReceipt: receipt,
      promotionCommandPreview: data.readModel.actions.find((entry) => entry.key === "observation.promote")
        ?.commandPreview,
    });

    const { rerender } = render(<IntegrationsRoute />);
    const disclosure = screen
      .getAllByRole("button", { name: /Preview promotion/ })
      .find((button) => button.hasAttribute("aria-expanded"));
    expect(disclosure).toBeTruthy();
    fireEvent.click(disclosure!);
    const receiptNode = document.querySelector(
      '[data-catalog-promotion-receipt="source-observation-promotion-receipt/v1"]',
    );
    expect(receiptNode).not.toBeNull();
    expect(receiptNode?.querySelector('[data-catalog-receipt-field="previewId"]')?.textContent).toBe("preview_001");
    expect(receiptNode?.querySelector('[data-catalog-receipt-field="preview.fingerprint"]')?.textContent).toBe(
      receipt.preview.fingerprint,
    );
    const executeToken = document
      .querySelector<HTMLInputElement>('form input[name="promotionPhase"][value="execute"]')
      ?.form?.querySelector<HTMLInputElement>('input[name="promotionPreviewId"]');
    expect(executeToken?.value).toBe(receipt.previewId);
    expect(mockUseNavigate).not.toHaveBeenCalled();
    for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      expect(link.href).not.toContain("promotionPreviewId");
      expect(link.href).not.toContain(receipt.previewId);
    }
    mockUseNavigation.mockReturnValue({ state: "submitting" });
    rerender(<IntegrationsRoute />);
    expect(
      document
        .querySelector("[data-catalog-promotion-receipt-state]")
        ?.getAttribute("data-catalog-promotion-receipt-state"),
    ).toBe("stale");
    expect(screen.getByLabelText(/I confirm this will promote/).hasAttribute("disabled")).toBe(true);
    expect(mockUseNavigate).not.toHaveBeenCalled();
  });

  it("round-trips a submitted promotion through its routable job id to the rendered durable outcome", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const promotionOutcome = {
      outcome: {
        outcomeId: "job_promote_round_trip:5",
        jobId: "job_promote_round_trip",
        eventSequence: 5,
        terminalState: "completed",
        requested: 1,
        promoted: 1,
        skipped: 0,
        failed: 0,
        outcomes: [
          {
            observationId: "obs_001",
            status: "promoted",
            catalogItemId: "cat_001",
            referenceRecordId: null,
            reason: null,
          },
        ],
        errorMessage: null,
        recordedAt: "2026-07-19T20:00:00.000Z",
      },
    } as const;
    const getSourceObservationPromotionOutcome = vi.fn().mockResolvedValue(promotionOutcome);
    mockCreateCatalogRequestApiClient.mockReturnValue({
      previewBulkPromoteSourceObservationIds: vi.fn().mockResolvedValue({
        matched: 1,
        eligible: 1,
        terminal: 0,
        validation: emptyPromotionValidation(),
        scope: { provider: "tcgdex", language: "en", setId: "base1", status: "", search: "" },
      }),
      bulkPromoteSourceObservations: vi.fn().mockResolvedValue({ jobId: "job_promote_round_trip" }),
      listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue(scopes),
      listSourceObservationProviderProfiles: vi.fn().mockResolvedValue(profileReviews),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(controlPlaneOverview()),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listCatalogMergeCandidates: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      getSourceObservationPromotionOutcome,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const actionResponse = await runDailyActionRedirect({
      _intent: "observation.promote",
      promotionPhase: "execute",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "spp1.round-trip",
    });
    const routedHref = actionResponse.headers.get("Location") ?? "";
    expect(new URL(routedHref, "https://admin.example").searchParams.get("jobId")).toBe("job_promote_round_trip");

    const routeData = await loader({
      request: new Request(new URL(routedHref, "https://admin.example")),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);
    mockUseLoaderData.mockReturnValue(routeData);
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["catalog.view", "catalog.manage"] },
    });

    render(<IntegrationsRoute />);

    expect(getSourceObservationPromotionOutcome).toHaveBeenCalledWith("job_promote_round_trip");
    expect(screen.getByText("Latest promotion outcome")).toBeTruthy();
    expect(screen.getAllByText("job_promote_round_trip").length).toBeGreaterThan(0);
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

  it("takes catalog.manage from the Catalog API's surface read without resolving the actor in the loader", async () => {
    // The Catalog API decides catalog.manage from its own request actor, so a
    // warming auth API in the admin loader can no longer deny the importer.
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl = "https://admin.example/catalog/integrations?providerKey=tcgdex";
    mockIsTransientAuthResolutionError.mockReturnValue(true);
    mockResolveActorFromAuthApi.mockRejectedValue(new Error("auth api warming"));
    const getCatalogPrimaryWorkbenchSurface = vi.fn().mockResolvedValue({
      readModel: buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
        requestUrl,
        scopes,
        profileReviews,
        controlPlaneOverview: null,
        canManageCatalog: true,
      }),
      readModelFailures: [],
      catalogSyncScope: null,
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogPrimaryWorkbenchSurface,
      getCatalogPrimaryWorkbenchDeferredImportPreview: vi.fn().mockResolvedValue(null),
      getCatalogPrimaryWorkbenchDeferredSourceOptions: vi.fn().mockRejectedValue(new Error("not under test")),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const routeData = await loader({
      request: new Request(requestUrl),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);

    expect(getCatalogPrimaryWorkbenchSurface).toHaveBeenCalledWith("daily", "/catalog/integrations?providerKey=tcgdex");
    expect(mockResolveActorFromAuthApi).not.toHaveBeenCalled();
    expect(
      routeData.readModel.actions.find((actionEntry) => actionEntry.key === "scope.import")?.blockers,
    ).not.toContain("permission-denied");
  });

  // ---------------------------------------------------------------------------
  // Attention queue availability (#7845). The daily loader streams the queue
  // as a closed `ready | unavailable` result; these renders drive the route view
  // with each branch directly so loading, empty, unavailable and nonempty are
  // discriminated by what the operator sees, not by which promise state the
  // harness happened to reach.
  // ---------------------------------------------------------------------------
  const WORKBENCH_HEADING = "Pull provider data, review Source Observations, promote Catalog facts";
  const ATTENTION_EMPTY_TITLE = "Nothing needs you";
  const ATTENTION_UNAVAILABLE_TITLE = "Attention queue unavailable";
  const ATTENTION_LOADING_LABEL = "Loading the attention queue…";
  const DAILY_REQUEST_URL = "https://admin.example/catalog/integrations?providerKey=tcgdex";

  function dailyReadModel(input: { canManageCatalog: boolean } = { canManageCatalog: true }) {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    return buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
      requestUrl: DAILY_REQUEST_URL,
      scopes,
      profileReviews,
      controlPlaneOverview: null,
      canManageCatalog: input.canManageCatalog,
    });
  }

  // Rendered inside an awaited act so a settled deferred result commits its
  // Suspense retry before the harness returns. Left to the scheduler, the retry
  // is time-sliced between the polling query's DOM walks over this large
  // workbench; hosted runners starved the ready branch past the query timeout
  // while the smaller unavailable branch squeaked through.
  async function renderDailyRouteWithAttention(
    deferredAttentionQueue: Promise<CatalogDeferredAttentionQueueResult>,
    input: { canManageCatalog: boolean } = { canManageCatalog: true },
  ) {
    const readModel = dailyReadModel(input);
    mockUseLoaderData.mockReturnValue(
      loaderData({
        requestUrl: DAILY_REQUEST_URL,
        readModel,
        commandFeedback: null,
        deferredAttentionQueue,
      }),
    );
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: input.canManageCatalog ? ["catalog.view", "catalog.manage"] : ["catalog.view"] },
    });
    await act(async () => {
      render(<IntegrationsRoute />);
    });
    return readModel;
  }

  // The queue table renders each resolution form in both its desktop and
  // mobile layouts, so command assertions read every rendered form for an intent.
  function attentionCommandButtons(intent: string): HTMLButtonElement[] {
    return Array.from(
      document.querySelectorAll<HTMLButtonElement>(`form[data-attention-resolution="${intent}"] button[type="submit"]`),
    );
  }

  function attentionSlotMarkers() {
    return {
      panel: document.querySelectorAll('[data-catalog-attention-queue="true"]').length,
      unavailable: document.querySelectorAll('[data-catalog-attention-queue="unavailable"]').length,
      loading: document.querySelectorAll('[data-catalog-deferred-panel="loading"]').length,
    };
  }

  it("renders the Catalog attention empty state only from a successful read", async () => {
    const readModel = catalogAttentionQueueReadModelFixture([]);
    await renderDailyRouteWithAttention(Promise.resolve({ status: "ready", readModel }));

    // The zero-item success renders the panel's own localized empty state and
    // its zero count — never the unavailable warning.
    expect(await screen.findByText(ATTENTION_EMPTY_TITLE)).toBeTruthy();
    expect(screen.getByText(/running itself/i)).toBeTruthy();
    expect(screen.getByText("0 need you")).toBeTruthy();
    expect(screen.queryByText(ATTENTION_UNAVAILABLE_TITLE)).toBeNull();
    expect(screen.queryByText(ATTENTION_LOADING_LABEL)).toBeNull();
    expect(attentionSlotMarkers()).toEqual({ panel: 1, unavailable: 0, loading: 0 });
  });

  it("keeps daily work usable while attention is visibly unavailable", async () => {
    const readModel = await renderDailyRouteWithAttention(Promise.resolve({ status: "unavailable" }));

    // Exactly one localized warning in the attention slot, rendered through the
    // design-system banner as a polite status region — and none of the
    // "nothing needs you" signals an empty read would show.
    expect(await screen.findByText(ATTENTION_UNAVAILABLE_TITLE)).toBeTruthy();
    const banner = document.querySelector<HTMLElement>('[data-catalog-attention-queue="unavailable"]');
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toContain(ATTENTION_UNAVAILABLE_TITLE);
    expect(banner?.textContent).toMatch(/reload the page/i);
    expect(screen.getAllByText(ATTENTION_UNAVAILABLE_TITLE)).toHaveLength(1);
    expect(screen.queryByText(ATTENTION_EMPTY_TITLE)).toBeNull();
    expect(screen.queryByText(/running itself/i)).toBeNull();
    expect(screen.queryByText(/\d+ need you/)).toBeNull();
    expect(screen.queryByText(ATTENTION_LOADING_LABEL)).toBeNull();
    expect(attentionSlotMarkers()).toEqual({ panel: 0, unavailable: 1, loading: 0 });

    // The import-to-promotion workflow beneath the slot is present and enabled
    // according to its own readiness, not the queue's.
    expect(screen.getByRole("heading", { name: WORKBENCH_HEADING })).toBeTruthy();
    const importForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="scope.import"]',
    );
    expect(importForm).not.toBeNull();
    const importButton = importForm?.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(importButton).not.toBeNull();
    expect(importButton?.disabled).toBe(!isActionAvailable(readModel, "scope.import"));
  });

  it("preserves attention commands after the result envelope", async () => {
    const queue = catalogAttentionQueueReadModelFixture();
    const readModel = await renderDailyRouteWithAttention(Promise.resolve({ status: "ready", readModel: queue }));

    expect(await screen.findByText("2 need you")).toBeTruthy();
    expect(screen.queryByText(ATTENTION_UNAVAILABLE_TITLE)).toBeNull();

    // The exact items and their resolution controls render unchanged through
    // the `ready` envelope: the alias candidate's accept command plus its
    // reason-bearing secondary reject, posted to the daily route action.
    const expectedActionHref = catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion");
    const acceptForm = document.querySelector<HTMLFormElement>('form[data-attention-resolution="alias.accept"]');
    const rejectForm = document.querySelector<HTMLFormElement>('form[data-attention-resolution="alias.reject"]');
    expect(acceptForm?.getAttribute("action")).toBe(expectedActionHref);
    expect(rejectForm?.getAttribute("action")).toBe(expectedActionHref);
    expect(acceptForm?.querySelector<HTMLInputElement>('input[name="aliasHashes"]')?.value).toBe("h1");
    expect(rejectForm?.querySelector<HTMLInputElement>('input[name="reason"]')?.value).toBe("Reject");
    const acceptButtons = attentionCommandButtons("alias.accept");
    const rejectButtons = attentionCommandButtons("alias.reject");
    expect(acceptButtons.length).toBeGreaterThan(0);
    expect(rejectButtons.length).toBeGreaterThan(0);
    expect(acceptButtons.map((button) => button.disabled)).toEqual(acceptButtons.map(() => false));
    expect(rejectButtons.map((button) => button.disabled)).toEqual(rejectButtons.map(() => false));
    expect(acceptButtons[0]?.getAttribute("aria-label")).toBe("Accept");
    expect(rejectButtons[0]?.getAttribute("aria-label")).toBe("Reject");
    // The drawer-only provider-health item renders without a command form.
    expect(document.querySelector('form[data-attention-resolution="review-provider-health"]')).toBeNull();
  });

  it("keeps catalog.manage gating on attention commands after the result envelope", async () => {
    const queue = catalogAttentionQueueReadModelFixture();
    await renderDailyRouteWithAttention(Promise.resolve({ status: "ready", readModel: queue }), {
      canManageCatalog: false,
    });

    expect(await screen.findByText("2 need you")).toBeTruthy();
    const acceptButtons = attentionCommandButtons("alias.accept");
    const rejectButtons = attentionCommandButtons("alias.reject");
    expect(acceptButtons.length).toBeGreaterThan(0);
    expect(rejectButtons.length).toBeGreaterThan(0);
    expect(acceptButtons.map((button) => button.disabled)).toEqual(acceptButtons.map(() => true));
    expect(rejectButtons.map((button) => button.disabled)).toEqual(rejectButtons.map(() => true));
  });

  it("labels exact cohort totals beyond the summary window without page links on the daily mount", async () => {
    const queue = catalogAttentionQueueReadModelFixture(undefined, undefined, {
      cohorts: { "alias-candidate": { total: 5027 } },
    });
    // Even a result that carried navigation would not add page links here.
    await renderDailyRouteWithAttention(
      Promise.resolve({
        status: "ready",
        readModel: queue,
        navigation: { pathname: "/catalog/integrations", search: "providerKey=tcgdex" },
      }),
    );

    expect(await screen.findByText("5,028 need you")).toBeTruthy();
    const aliasCoverage = document.querySelector<HTMLElement>('[data-attention-coverage-kind="alias-candidate"]');
    expect(aliasCoverage?.textContent).toContain("Showing 1 of 5,027");
    expect(queue.coverage["alias-candidate"].nextOffset).toBe(1);
    expect(document.querySelectorAll("[data-attention-page]")).toHaveLength(0);
    expect(screen.queryByText(/at least/i)).toBeNull();
    // Action keys are unchanged by the window.
    expect(attentionCommandButtons("alias.accept").length).toBeGreaterThan(0);
    expect(attentionCommandButtons("alias.reject").length).toBeGreaterThan(0);
  });

  it("labels an incomplete job snapshot as at least N and an incomplete zero as unknown work", async () => {
    const bounded = catalogAttentionQueueReadModelFixture(undefined, undefined, {
      cohorts: { "import-job": { totalKind: "lower-bound" } },
    });
    await renderDailyRouteWithAttention(Promise.resolve({ status: "ready", readModel: bounded }));
    expect(await screen.findByText("At least 2 need you")).toBeTruthy();
    expect(screen.getAllByText("Some import jobs could not be checked.").length).toBeGreaterThan(0);
    expect(screen.queryByText(ATTENTION_EMPTY_TITLE)).toBeNull();
    cleanup();

    const incompleteZero = catalogAttentionQueueReadModelFixture([], undefined, {
      cohorts: { "import-job": { totalKind: "lower-bound" } },
    });
    await renderDailyRouteWithAttention(Promise.resolve({ status: "ready", readModel: incompleteZero }));
    expect(await screen.findByText("At least 0 need you")).toBeTruthy();
    expect(document.querySelector('[data-attention-incomplete="true"]')?.textContent).toContain(
      "Some import jobs could not be checked.",
    );
    expect(screen.queryByText(ATTENTION_EMPTY_TITLE)).toBeNull();
    expect(screen.queryByText(/running itself/i)).toBeNull();
    expect(screen.queryByText(ATTENTION_UNAVAILABLE_TITLE)).toBeNull();
    expect(attentionSlotMarkers()).toEqual({ panel: 1, unavailable: 0, loading: 0 });
  });

  it("contains rejected supplementary slots without unmounting the workbench", async () => {
    const rejected = <T,>(reason: Error): Promise<T> => {
      const promise = Promise.reject(reason);
      void promise.catch(() => undefined);
      return promise;
    };
    const readModel = dailyReadModel();
    mockUseLoaderData.mockReturnValue(
      loaderData({
        requestUrl: DAILY_REQUEST_URL,
        readModel,
        commandFeedback: null,
        deferredImportPreview: rejected(new Error("preview failed")),
        deferredCatalogSyncRun: rejected(new Error("sync run failed")),
        deferredScopeSyncState: rejected(new Error("scope state failed")),
        deferredAliasReview: rejected(new Error("alias review failed")),
        deferredAttentionQueue: rejected(new Error("attention queue failed")),
      }),
    );
    mockUseRouteLoaderData.mockReturnValue({ actor: { permissions: ["catalog.view", "catalog.manage"] } });

    await act(async () => {
      render(<IntegrationsRoute />);
    });

    await waitFor(() => {
      const unavailablePanels = Array.from(
        document.querySelectorAll<HTMLElement>('[data-catalog-deferred-panel="unavailable"]'),
      );
      expect(unavailablePanels).toHaveLength(4);
      expect(unavailablePanels.map((panel) => panel.textContent)).toEqual(
        expect.arrayContaining([
          "Import preflightUnavailable",
          "StatusUnavailable",
          "Scope sync stateUnavailable",
          "Alias reviewUnavailable",
        ]),
      );
      expect(document.querySelector('[data-catalog-attention-queue="unavailable"]')).not.toBeNull();
    });
    expect(screen.getByRole("heading", { name: WORKBENCH_HEADING })).toBeTruthy();
  });

  // Four-state matrix: each attention state is identified by one signal that
  // the other three states do not render, so presence of any one state is never
  // read as completeness of the slot (ledger: presence-evidence-treated-as-
  // completeness).
  type AttentionState = "loading" | "empty" | "unavailable" | "nonempty";
  const attentionStates: ReadonlyArray<{
    state: AttentionState;
    deferred: () => Promise<CatalogDeferredAttentionQueueResult>;
    visible: string;
  }> = [
    { state: "loading", deferred: () => new Promise(() => undefined), visible: ATTENTION_LOADING_LABEL },
    {
      state: "empty",
      deferred: () => Promise.resolve({ status: "ready", readModel: catalogAttentionQueueReadModelFixture([]) }),
      visible: ATTENTION_EMPTY_TITLE,
    },
    {
      state: "unavailable",
      deferred: () => Promise.resolve({ status: "unavailable" }),
      visible: ATTENTION_UNAVAILABLE_TITLE,
    },
    {
      state: "nonempty",
      deferred: () => Promise.resolve({ status: "ready", readModel: catalogAttentionQueueReadModelFixture() }),
      visible: "2 need you",
    },
  ];
  const attentionSignals: Readonly<Record<AttentionState, string | RegExp>> = {
    loading: ATTENTION_LOADING_LABEL,
    empty: ATTENTION_EMPTY_TITLE,
    unavailable: ATTENTION_UNAVAILABLE_TITLE,
    // A zero count belongs to the empty state; nonempty is a positive count.
    nonempty: /[1-9]\d* need you/,
  };

  it.each(attentionStates)(
    "discriminates the $state attention state from the other three",
    async ({ state, deferred, visible }) => {
      await renderDailyRouteWithAttention(deferred());

      expect(await screen.findByText(visible)).toBeTruthy();
      for (const [other, signal] of Object.entries(attentionSignals) as Array<[AttentionState, string | RegExp]>) {
        if (other !== state) {
          expect(screen.queryByText(signal), `${state} must not show the ${other} signal`).toBeNull();
        }
      }
      expect(screen.getByRole("heading", { name: WORKBENCH_HEADING })).toBeTruthy();
    },
  );

  it("fails the unavailable assertions when an empty read is substituted for unavailable", async () => {
    // Negative control for the state matrix: if the route ever rendered the
    // empty state for an unavailable queue, the unavailable expectations above
    // would not hold. Prove it by feeding the empty branch where unavailable
    // belongs and checking that every unavailable signal is absent.
    await renderDailyRouteWithAttention(
      Promise.resolve({ status: "ready", readModel: catalogAttentionQueueReadModelFixture([]) }),
    );

    expect(await screen.findByText(ATTENTION_EMPTY_TITLE)).toBeTruthy();
    expect(screen.queryByText(ATTENTION_UNAVAILABLE_TITLE)).toBeNull();
    expect(attentionSlotMarkers().unavailable).toBe(0);
    expect(attentionSlotMarkers().panel).toBe(1);
  });
});
