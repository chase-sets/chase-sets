// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError as CatalogApiError } from "../support/shell-support/api/client";
import IntegrationsRoute, { action, loader } from "../routes/admin/integrations";
import { loader as providersLoader, action as providerDetailAction } from "../routes/admin/catalog-provider-detail";
import { action as governanceAction } from "../routes/admin/integrations-governance";
import { action as settingsAction } from "../routes/admin/integrations-settings";
import { action as healthAction } from "../routes/admin/integrations-health";
import { action as scopeLandingAction } from "../routes/admin/scope-landing";
import { CATALOG_ATTENTION_DISMISS_INTENT } from "../features/attention-queue/read-model/attention-intents";
import type { CatalogIntegrationsCommandResult } from "../support/route-support/admin-integrations/integrations-command-result";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../features/source-observations/ui/primary-workbench-read-model";
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

    const result = await runDailyAction(
      { _intent: "alias.accept", aliasHashes: "hash_a" },
      "https://admin.example/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&aliasType=language-edition&reviewStatuses=rejected,pending&targetKind=reference-record&targetId=synthetic-reference-record",
    );

    expect(dispatchCatalogAliasReviewCommand).toHaveBeenCalledWith({ intent: "accept", aliasHashes: ["hash_a"] });
    expect(result).not.toHaveProperty("section");
    expect(result.feedback.status).toBe("success");
    expect(result.context).toMatchObject({
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      aliasType: "language-edition",
      reviewStatuses: ["rejected", "pending"],
      targetKind: "reference-record",
      targetId: "synthetic-reference-record",
    });
  });

  it("forwards the auto-accept eligible form's eligibleOnly to Catalog instead of filtering the selection", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn().mockResolvedValue({
      intent: "accept",
      count: 1,
      applied: [{ aliasHash: "hash_a", reviewStatus: "accepted", version: 2 }],
      skipped: [{ aliasHash: "hash_b", reason: "not-eligible" }],
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ dispatchCatalogAliasReviewCommand });

    const result = await runDailyAction({
      _intent: "alias.accept",
      aliasHashes: "hash_a,hash_b",
      eligibleOnly: "true",
    });

    expect(dispatchCatalogAliasReviewCommand).toHaveBeenCalledWith({
      intent: "accept",
      aliasHashes: ["hash_a", "hash_b"],
      eligibleOnly: true,
    });
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

  // A profile activation once carried a "validation-readiness" section that sent
  // the operator to another integrations surface; each surface now owns its path.
  it.each([
    ["Settings", settingsAction, "/catalog/integrations/settings"],
    ["governance", governanceAction, "/catalog/integrations/governance"],
    ["health", healthAction, "/catalog/integrations/health"],
  ] as const)("lands a %s command back on its own fixed path with its feedback", async (_page, routeAction, path) => {
    const activateSourceObservationProviderProfile = vi
      .fn()
      .mockResolvedValue({ providerKey: "tcgdex", profileVersion: "2026.06.04" });
    mockCreateCatalogRequestApiClient.mockReturnValue({ activateSourceObservationProviderProfile });

    const response = await routeAction(
      actionRequest(
        { _intent: "provider-profile.activate", providerKey: "tcgdex", profileVersion: "2026.06.04" },
        `https://admin.example${path}?providerKey=tcgdex`,
      ) as Parameters<typeof routeAction>[0],
    );
    const location = redirectLocation(response);

    expect(activateSourceObservationProviderProfile).toHaveBeenCalledWith("tcgdex", "2026.06.04");
    expect(location.pathname).toBe(path);
    expect(location.searchParams.get("providerKey")).toBe("tcgdex");
    expect(location.searchParams.get("commandIntent")).toBe("provider-profile.activate");
    expect(location.searchParams.get("commandStatus")).toBe("success");
    expect(location.searchParams.get("commandResult")).toBe("profile-activated");
  });

  it("keeps home alias and attention results on the home page as action data", async () => {
    const dispatchCatalogAliasReviewCommand = vi.fn().mockResolvedValue({});
    const dispatchCatalogAttentionQueueCommand = vi.fn().mockResolvedValue({});
    mockCreateCatalogRequestApiClient.mockReturnValue({
      dispatchCatalogAliasReviewCommand,
      dispatchCatalogAttentionQueueCommand,
    });
    const home = "https://admin.example/catalog/scopes";

    const alias = await scopeLandingAction(actionRequest({ _intent: "alias.accept", aliasHashes: "hash_a" }, home));
    const attention = await scopeLandingAction(
      actionRequest(
        {
          _intent: CATALOG_ATTENTION_DISMISS_INTENT,
          itemKey: "merge-conflict:c1",
          kind: "merge-conflict",
          reason: "x",
        },
        home,
      ),
    );

    for (const result of [alias, attention]) {
      expect(result).not.toBeInstanceOf(Response);
      expect(result).not.toHaveProperty("section");
      expect(result.feedback.status).toBe("success");
    }
    expect(alias.feedback.intent).toBe("alias.accept");
    expect(attention.attentionItemKey).toBe("merge-conflict:c1");
  });

  it("keeps a Provider lifecycle result on the provider its path names, not one the form names", async () => {
    mockCreateCatalogRequestApiClient.mockReturnValue({});

    const response = await runProviderDetailAction({
      _intent: "provider-profile.clone",
      providerKey: "scrydex",
      sourceProviderKey: "scrydex",
      sourceProfileVersion: "2026.06.04",
    });
    const location = redirectLocation(response);

    expect(location.pathname).toBe("/catalog/providers/tcgdex");
    expect(location.searchParams.get("commandIntent")).toBe("provider-profile.clone");
    expect(location.searchParams.get("commandStatus")).toBe("error");
    expect(location.searchParams.get("commandResult")).toBe("invalid-intent");
  });
});
