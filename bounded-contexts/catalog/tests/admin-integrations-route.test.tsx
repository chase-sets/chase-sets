// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IntegrationsRoute, { action } from "../routes/admin/integrations";
import { buildCatalogPrimaryWorkbenchReadModel } from "../features/source-observations/ui/primary-workbench-read-model";
import {
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

  it("queues a scoped provider import from the primary workbench route action", async () => {
    const enqueueSourceObservationIntegrationJob = vi.fn().mockResolvedValue({ jobId: "job_import_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ enqueueSourceObservationIntegrationJob });

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
  });

  it("preserves selected IDs while creating a scoped promotion preview token", async () => {
    const previewBulkPromoteSourceObservations = vi.fn().mockResolvedValue({
      matched: 1,
      eligible: 1,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "changed", search: "" },
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ previewBulkPromoteSourceObservations });

    const response = await runAction(
      {
        _intent: "preview-promotion",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:card:import",
        importScope: "en:3:base:base1",
        profileVersion: "2026.06.04",
        selectedObservationIds: "obs_001",
      },
      "https://admin.example/catalog/integrations?filter.status=changed",
    );

    expect(previewBulkPromoteSourceObservations).toHaveBeenCalledWith({
      provider: "tcgdex",
      language: "en",
      setId: "base1",
      status: "changed",
    });
    expect(response.headers.get("Location")).toContain("selectedObservationIds=obs_001");
    expect(response.headers.get("Location")).toContain(
      "promotionPreviewId=preview-tcgdex_tcgdex_pokemon_card_import_en_3_base_base1_2026.06.04_en_base1_changed_none_obs_001-1-1",
    );
    expect(response.headers.get("Location")).toContain("commandResult=preview-ready");
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
    const previewBulkPromoteSourceObservations = vi.fn().mockResolvedValue({
      matched: 1,
      eligible: 1,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "changed", search: "" },
    });
    const bulkPromoteSourceObservations = vi.fn().mockResolvedValue({ jobId: "job_promote_123" });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      bulkPromoteSourceObservations,
      previewBulkPromoteSourceObservations,
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

    expect(previewBulkPromoteSourceObservations).toHaveBeenCalledWith({
      provider: "tcgdex",
      language: "en",
      setId: "base1",
      status: "changed",
    });
    expect(bulkPromoteSourceObservations).toHaveBeenCalledWith(["obs_001"]);
    expect(response.headers.get("Location")).toContain("jobId=job_promote_123");
    expect(response.headers.get("Location")).not.toContain("promotionPreviewId=");
    expect(response.headers.get("Location")).toContain("commandResult=job-queued");
  });

  it("rejects promotion execution when the stored preview belongs to a different profile context", async () => {
    const previewBulkPromoteSourceObservations = vi.fn().mockResolvedValue({
      matched: 1,
      eligible: 1,
      terminal: 0,
      scope: { provider: "tcgdex", language: "en", setId: "base1", status: "changed", search: "" },
    });
    const bulkPromoteSourceObservations = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({
      bulkPromoteSourceObservations,
      previewBulkPromoteSourceObservations,
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

  it("fails closed for commands without launch-ready backend paths", async () => {
    mockCreateCatalogRequestApiClient.mockReturnValue({});

    const deferResponse = await runAction({
      _intent: "defer-source-observations",
      selectedObservationIds: "obs_001",
    });
    const replayResponse = await runAction({
      _intent: "start-replay",
      selectedObservationIds: "obs_001",
    });

    expect(deferResponse.headers.get("Location")).toContain("commandResult=unsupported-command");
    expect(replayResponse.headers.get("Location")).toContain("commandResult=unsupported-command");
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
