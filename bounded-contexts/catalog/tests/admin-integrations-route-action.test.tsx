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
      "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_changed_none_obs_001-1-1-no-fingerprint",
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
      "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_all_none_filtered-124-124-no-fingerprint",
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

    const response = await runProviderDetailAction({
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
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
    expect(response.headers.get("Location")).toContain("profileVersion=2026.06.04-draft");
    // The v2 Provider detail page carries only entity references (providerKey,
    // profileVersion) — no daily-review selection/preview state (#3832).
    expect(response.headers.get("Location")).not.toContain("selectedObservationIds=");
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

    const response = await runProviderDetailAction({
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
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
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

    const response = await runProviderDetailAction({
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
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
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

    const response = await runProviderDetailAction(
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
      "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04",
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
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
    expect(response.headers.get("Location")).toContain("commandResult=section-saved");
    expect(response.headers.get("Location")).toContain("commandSection=migration-evidence");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    // provider-setup-command-handler.ts's migration-evidence special case keys
    // off an incoming context.section === "validation-readiness", which can no
    // longer be parsed from a URL (#3832 retires that workspace key), so this
    // section save now always returns the profile-authoring detour target. The
    // v2 page's own action ignores this field for routing — it always redirects
    // to itself — so this is a telemetry-label detail, not a behavior change.
    expect(recordCatalogControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "catalog_control_plane.profile_section_saved",
        providerKey: "tcgdex",
        profileRef: "tcgdex:2026.06.04",
        promotionResult: "section-saved",
        detourTarget: "profile-authoring",
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

    const response = await runProviderDetailAction(
      {
        _intent: "activate-provider-profile",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        selectedObservationIds: "obs_001",
        promotionPreviewId: "preview-stale",
      },
      "https://admin.example/catalog/providers/tcgdex?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04",
    );

    expect(activateSourceObservationProviderProfile).toHaveBeenCalledWith("tcgdex", "2026.06.04");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
    expect(response.headers.get("Location")).toContain("profileVersion=2026.06.04");
    expect(response.headers.get("Location")).not.toContain("selectedObservationIds=");
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

    const lifecycleUrl = "https://admin.example/catalog/providers/tcgdex";
    const rollbackResponse = await runProviderDetailAction(
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
    const deprecateResponse = await runProviderDetailAction(
      {
        _intent: "deprecate-provider-profile",
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        lifecycleConfirmation: lifecycleConfirmationValue("deprecate-provider-profile", "tcgdex", "2026.06.04"),
      },
      lifecycleUrl,
    );
    const retireResponse = await runProviderDetailAction(
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
    expect(rollbackResponse.headers.get("Location")).toContain("/catalog/providers/tcgdex");
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

    const response = await runProviderDetailAction(
      {
        _intent: "retire-provider-profile",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.02",
      },
      "https://admin.example/catalog/providers/tcgdex",
    );

    expect(retireSourceObservationProviderProfile).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
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

    const response = await runProviderDetailAction(
      {
        _intent: "retire-provider-profile",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.02",
        lifecycleConfirmation: lifecycleConfirmationValue("retire-provider-profile", "tcgdex", "2026.06.02"),
        promotionPreviewId: "preview-stale",
      },
      "https://admin.example/catalog/providers/tcgdex",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/catalog/providers/tcgdex");
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

    const conflictResponse = await runProviderDetailAction({
      _intent: "update-provider-profile-section",
      providerKey: "tcgdex",
      profileVersion: "2026.06.04-draft",
      sectionKey: "source-contract",
      sourceOwner: "chase-sets/catalog",
      sourceDocumentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
      fixtureSetVersion: "tcgdex-proof-v1",
    });
    const invalidResponse = await runProviderDetailAction({
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
        "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_all_none_obs_001-1-1-no-fingerprint",
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
        "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_changed_none_obs_001-1-1-no-fingerprint",
    });

    expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(result.context.promotionPreviewId).toBeNull();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("preview-required");
  });

  it("rejects promotion when the eligible observations changed content since the preview (observe-change-then-promote)", async () => {
    // The stored token was minted from a preview whose eligible observations
    // hashed to "content-a". A re-import changed a field on the same in-scope
    // observation, so a fresh preview now hashes to "content-b". The recomputed
    // token no longer matches the one the operator is executing, so execution is
    // rejected server-side with a re-preview affordance — self-invalidation is not
    // a UI nicety the operator can bypass by resubmitting the stale token.
    const previewBulkPromoteSourceObservationIds = vi.fn().mockResolvedValue({
      matched: 1,
      eligible: 1,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "", search: "" },
      fingerprint: "content-b",
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
      profileVersion: "2026.06.04",
      selectedObservationIds: "obs_001",
      promotionPreviewId:
        "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_all_none_obs_001-1-1-content-a",
    });

    expect(previewBulkPromoteSourceObservationIds).toHaveBeenCalledWith(["obs_001"]);
    expect(bulkPromoteSourceObservations).not.toHaveBeenCalled();
    expect(result.context.promotionPreviewId).toBeNull();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("preview-required");
  });

  it("executes promotion when the preview's content fingerprint still matches the eligible observations", async () => {
    const previewBulkPromoteSourceObservationIds = vi.fn().mockResolvedValue({
      matched: 1,
      eligible: 1,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "", search: "" },
      fingerprint: "content-a",
    });
    const bulkPromoteSourceObservations = vi.fn().mockResolvedValue({ jobId: "job_promote_fresh" });
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
        "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_all_none_obs_001-1-1-content-a",
    });

    expect(bulkPromoteSourceObservations).toHaveBeenCalledWith(["obs_001"]);
    expect(result.context.jobId).toBe("job_promote_fresh");
    expect(result.feedback.status).toBe("success");
    expect(result.feedback.result).toBe("job-queued");
    expect(result.context.promotionPreviewId).toBeNull();
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
        "preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_all_none_filtered-124-124-no-fingerprint",
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

  it("streams the alias-review supplementary slot inline on the daily surface when the loader defers it", async () => {
    const scopes = { items: [sourceObservationScope()], total: 1, count: 1 };
    const profileReviews = { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 };
    const requestUrl = "https://admin.example/catalog/integrations?providerKey=tcgdex";
    // The daily loader defers the alias-review read model; the route view renders
    // it behind a Suspense/Await boundary, so the workspace appears once the
    // streamed promise resolves rather than at first paint. The language-edition
    // equivalence review now lives on Scope Detail (see
    // language-editions-panel.test.tsx); the all-scopes table here stops
    // streaming open by default (see integrations-surface-route-view.tsx), which
    // this bare (non-router) render harness cannot resolve past the Suspense
    // fallback, so this test keeps asserting the fallback/shared title renders.
    mockUseLoaderData.mockReturnValue(
      loaderData({
        data: scopes,
        profileReviews,
        requestUrl,
        commandFeedback: null,
        deferredAliasReview: Promise.resolve(aliasReviewReadModel()),
      }),
    );
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["catalog.view", "catalog.manage"] },
    });

    render(<IntegrationsRoute />);

    expect((await screen.findAllByText("Alias review")).length).toBeGreaterThan(0);
  });
});
