// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogApiError } from "../client";
import IntegrationsRoute, { action, loader } from "../routes/admin/integrations";
import { buildCatalogPrimaryWorkbenchReadModel } from "../features/source-observations/ui/primary-workbench-read-model";
import {
  controlPlaneOverview,
  integrationJobSummary,
  profileAuthoringModel,
  profileReview,
  sourceObservationScope,
} from "../features/source-observations/ui/primary-workbench-test-fixtures";

const { mockCreateCatalogRequestApiClient, mockUseLoaderData, mockUseRouteLoaderData } = vi.hoisted(() => ({
  mockCreateCatalogRequestApiClient: vi.fn(),
  mockUseLoaderData: vi.fn(),
  mockUseRouteLoaderData: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useRouteLoaderData: mockUseRouteLoaderData,
  };
});

vi.mock("../support/request-support/api-client", () => ({
  createCatalogRequestApiClient: mockCreateCatalogRequestApiClient,
}));

describe("Catalog integrations route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("queues a scoped provider import from the primary workbench route action", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_123" });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      enqueueSourceObservationIntegrationJob,
      recordCatalogControlPlaneEvent,
    });

    const response = await runAction({
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
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("jobId=job_import_123");
    expect(response.headers.get("Location")).toContain("commandStatus=success");
    expect(response.headers.get("Location")).toContain("commandResult=job-queued");
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

  it("preserves selected IDs while creating a scoped promotion preview token", async () => {
    const previewBulkPromoteSourceObservationIds = vi.fn().mockResolvedValue({
      matched: 1,
      eligible: 1,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "changed", search: "" },
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservationIds });

    const response = await runAction(
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
    expect(response.headers.get("Location")).toContain("selectedObservationIds=obs_001");
    expect(response.headers.get("Location")).toContain(
      "promotionPreviewId=preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_changed_none_obs_001-1-1",
    );
    expect(response.headers.get("Location")).toContain("commandResult=preview-ready");
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

    const response = await runAction({
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

    const response = await runAction({
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
    const listSourceObservationProviderProfiles = vi.fn().mockResolvedValue({
      items: [profileReview({ active: false, lifecycle: "draft", profileVersion: "2026.06.04-draft" })],
      total: 1,
      count: 1,
    });
    const updateSourceObservationProviderProfileSection = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04-draft",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationProviderProfiles,
      updateSourceObservationProviderProfileSection,
      recordCatalogControlPlaneEvent,
    });

    const response = await runAction({
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
    const listSourceObservationProviderProfiles = vi.fn().mockResolvedValue({
      items: [profileReview({ active: true, lifecycle: "active", profileVersion: "2026.06.04" })],
      total: 1,
      count: 1,
    });
    const updateSourceObservationProviderProfileSection = vi.fn().mockResolvedValue({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
    });
    const recordCatalogControlPlaneEvent = vi.fn().mockResolvedValue({ status: "recorded" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationProviderProfiles,
      updateSourceObservationProviderProfileSection,
      recordCatalogControlPlaneEvent,
    });

    const response = await runAction(
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

    const response = await runAction(
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
    const rollbackResponse = await runAction(
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
    const deprecateResponse = await runAction(
      {
        _intent: "deprecate-provider-profile",
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        lifecycleConfirmation: lifecycleConfirmationValue("deprecate-provider-profile", "tcgdex", "2026.06.04"),
      },
      lifecycleUrl,
    );
    const retireResponse = await runAction(
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

    const response = await runAction(
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

    const response = await runAction(
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
    const listSourceObservationProviderProfiles = vi.fn().mockResolvedValue({
      items: [profileReview({ active: false, lifecycle: "draft", profileVersion: "2026.06.04-draft" })],
      total: 1,
      count: 1,
    });
    const updateSourceObservationProviderProfileSection = vi
      .fn()
      .mockRejectedValueOnce(new CatalogApiError(409, { error: { code: "stale" } }))
      .mockRejectedValueOnce(new CatalogApiError(400, { error: { code: "invalid" } }));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationProviderProfiles,
      updateSourceObservationProviderProfileSection,
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
    });

    const conflictResponse = await runAction({
      _intent: "update-provider-profile-section",
      providerKey: "tcgdex",
      profileVersion: "2026.06.04-draft",
      sectionKey: "source-contract",
      sourceOwner: "chase-sets/catalog",
      sourceDocumentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
      fixtureSetVersion: "tcgdex-proof-v1",
    });
    const invalidResponse = await runAction({
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

    const response = await runAction({
      _intent: "execute-promotion",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
    });

    expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(response.headers.get("Location")).toContain("commandStatus=error");
    expect(response.headers.get("Location")).toContain("commandResult=preview-required");
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

    const response = await runAction({
      _intent: "execute-promotion",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
      promotionPreviewId:
        "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_changed_none_obs_001-1-1",
    });

    expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledWith(["obs_001"]);
    expect(bulkPromoteSourceObservations).toHaveBeenCalledWith(["obs_001"]);
    expect(response.headers.get("Location")).toContain("jobId=job_promote_123");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(response.headers.get("Location")).toContain("commandResult=job-queued");
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

    const response = await runAction({
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
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(response.headers.get("Location")).toContain("commandStatus=error");
    expect(response.headers.get("Location")).toContain("commandResult=preview-required");
  });

  it("requires a rejection reason before enqueueing reject jobs", async () => {
    const bulkRejectSourceObservations = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ bulkRejectSourceObservations });

    const response = await runAction({
      _intent: "reject-source-observations",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
    });

    expect(bulkRejectSourceObservations).not.toHaveBeenCalled();
    expect(response.headers.get("Location")).toContain("commandStatus=error");
    expect(response.headers.get("Location")).toContain("commandResult=reason-required");
  });

  it("enqueues reject jobs once the operator supplies an audit reason", async () => {
    const bulkRejectSourceObservations = vi.fn().mockResolvedValue({ jobId: "job_reject_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ bulkRejectSourceObservations });

    const response = await runAction({
      _intent: "reject-source-observations",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
      reason: "Provider evidence is not launch-ready.",
    });

    expect(bulkRejectSourceObservations).toHaveBeenCalledWith(["obs_001"], "Provider evidence is not launch-ready.");
    expect(response.headers.get("Location")).toContain("jobId=job_reject_123");
    expect(response.headers.get("Location")).toContain("commandResult=job-queued");
  });

  it("enqueues active-profile reapply jobs for selected Source Observations", async () => {
    const reapplySourceObservations = vi.fn().mockResolvedValue({ jobId: "job_reapply_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ reapplySourceObservations });

    const response = await runAction({
      _intent: "start-reapply",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(reapplySourceObservations).toHaveBeenCalledWith(["obs_001"]);
    expect(response.headers.get("Location")).toContain("jobId=job_reapply_123");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(response.headers.get("Location")).toContain("commandResult=job-queued");
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

    const retryResponse = await runAction({ _intent: "retry-import-job", jobId: "job_import_123" });
    const resumeResponse = await runAction({ _intent: "resume-import-job", jobId: "job_import_123" });
    const cancelResponse = await runAction({ _intent: "cancel-import-job", jobId: "job_import_123" });

    expect(retrySourceObservationIntegrationJob).toHaveBeenCalledWith("job_import_123");
    expect(resumeSourceObservationIntegrationJob).toHaveBeenCalledWith("job_import_123");
    expect(cancelSourceObservationIntegrationJob).toHaveBeenCalledWith("job_import_123");
    expect(retryResponse.headers.get("Location")).toContain("commandResult=job-queued");
    expect(resumeResponse.headers.get("Location")).toContain("commandResult=job-queued");
    expect(cancelResponse.headers.get("Location")).toContain("commandResult=job-cancelled");
  });

  it("requires a durable import job id before lifecycle commands can run", async () => {
    const retrySourceObservationIntegrationJob = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({ retrySourceObservationIntegrationJob });

    const response = await runAction({ _intent: "retry-import-job" });

    expect(retrySourceObservationIntegrationJob).not.toHaveBeenCalled();
    expect(response.headers.get("Location")).toContain("commandStatus=error");
    expect(response.headers.get("Location")).toContain("commandResult=job-required");
  });

  it("enqueues defer jobs and clears stale promotion previews", async () => {
    const deferSourceObservations = vi.fn().mockResolvedValue({ jobId: "job_defer_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ deferSourceObservations });

    const deferResponse = await runAction({
      _intent: "defer-source-observations",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(deferSourceObservations).toHaveBeenCalledWith(["obs_001"], "Deferred from the primary workbench.");
    expect(deferResponse.headers.get("Location")).toContain("jobId=job_defer_123");
    expect(deferResponse.headers.get("Location")).toContain("commandResult=job-queued");
    expect(deferResponse.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(deferResponse.headers.get("Location")).not.toContain("selectedObservationIds=obs_001");
  });

  it("enqueues original-profile replay jobs for selected Source Observations", async () => {
    const replaySourceObservations = vi.fn().mockResolvedValue({ jobId: "job_replay_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ replaySourceObservations });

    const replayResponse = await runAction({
      _intent: "start-replay",
      selectedObservationIds: "obs_001",
      promotionPreviewId: "preview-stale",
    });

    expect(replaySourceObservations).toHaveBeenCalledWith(["obs_001"]);
    expect(replayResponse.headers.get("Location")).toContain("jobId=job_replay_123");
    expect(replayResponse.headers.get("Location")).toContain("commandResult=job-queued");
    expect(replayResponse.headers.get("Location")).not.toContain("promotionPreviewId=");
  });

  it("returns sanitized feedback for invalid intents and API failures", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockRejectedValue(new Error("provider secret leaked"));
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });

    const invalidResponse = await runAction({ _intent: "legacy-json-patch" });
    const failureResponse = await runAction({
      _intent: "start-provider-import",
      providerKey: "tcgdex",
    });

    expect(invalidResponse.headers.get("Location")).toContain("commandResult=invalid-intent");
    expect(failureResponse.headers.get("Location")).toContain("commandResult=command-failed");
    expect(failureResponse.headers.get("Location")).not.toContain("provider%20secret%20leaked");
  });
});

function lifecycleConfirmationValue(intent: string, providerKey: string, profileVersion: string): string {
  return `confirm:${intent}:${providerKey}:${profileVersion}`;
}

async function runAction(body: Record<string, string>, url = "https://admin.example/catalog/integrations") {
  return action({
    request: new Request(url, {
      method: "POST",
      body: new URLSearchParams(body),
    }),
    params: {},
    context: {},
  } as Parameters<typeof action>[0]);
}
