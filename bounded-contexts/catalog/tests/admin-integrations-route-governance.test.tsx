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
  it("dispatches the #1905 accept command for the alias-review accept action and stays on the daily surface", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn().mockResolvedValue({
      intent: "accept",
      count: 1,
      applied: [{ aliasHash: "hash_a", reviewStatus: "accepted", version: 2 }],
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand });

    const result = await runDailyAction({ _intent: "alias.accept", aliasHashes: "hash_a" });

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
      _intent: "alias.reject",
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

    const result = await runDailyAction({ _intent: "alias.reject", aliasHashes: "hash_a" });

    expect(dispatchCatalogAliasReviewCommand).not.toHaveBeenCalled();
    expect(result.feedback.status).toBe("error");
    expect(result.feedback.result).toBe("reason-required");
  });
});
