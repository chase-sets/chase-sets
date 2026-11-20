import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { ApiError as CatalogApiError } from "../../shell-support/api/client";
import type { CatalogScopeJourneyResponse } from "../../../features/scope-registry/ui/contracts";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../../features/source-observations/ui/primary-workbench-read-model";
import {
  controlPlaneOverview,
  sourceObservationScope,
} from "../../../features/source-observations/ui/primary-workbench-test-fixtures";

const { mockCreateCatalogRequestApiClient, mockResolveActorFromAuthApi, mockLoadDailySurfaceForRequest } = vi.hoisted(
  () => ({
    mockCreateCatalogRequestApiClient: vi.fn(),
    mockResolveActorFromAuthApi: vi.fn(),
    mockLoadDailySurfaceForRequest: vi.fn(),
  }),
);

vi.mock("../../request-support/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../request-support/api-client")>(
    "../../request-support/api-client",
  );
  return { ...actual, createCatalogRequestApiClient: mockCreateCatalogRequestApiClient };
});

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  resolveActorFromAuthApi: mockResolveActorFromAuthApi,
}));

vi.mock("../admin-integrations/integrations-loader-support", () => ({
  loadDailySurfaceForRequest: mockLoadDailySurfaceForRequest,
}));

const { loader } = await import("./scope-detail-loader");

function paldeanFatesScope() {
  return {
    scopeRecordId: "scope_expansion_paldean_fates",
    productDomain: "pokemon",
    scopeKind: "expansion",
    referenceTypeKey: "expansion",
    referenceRecordId: "ref_expansion_paldean_fates",
    referenceRecordKey: "paldean-fates",
    name: "Paldean Fates",
    parentScopeRecordId: "ref_series_scarlet_violet",
    productLineScopeRecordId: "ref_product_line_pokemon",
    seriesScopeRecordId: "ref_series_scarlet_violet",
    releaseDate: "2024-01-26",
    officialSetCode: "PAF",
    languageEditions: ["en", "ja"],
    lifecycleStatus: "active",
    updatedAt: "2026-07-03T12:00:00.000Z",
  };
}

// The scope as `GET /scope-records/:id/journey` returns it: a single-edition journey unless overridden.
function journeyOf(
  scope: ReturnType<typeof paldeanFatesScope>,
  overrides: Partial<CatalogScopeJourneyResponse> = {},
): CatalogScopeJourneyResponse {
  const detail = { ...scope, promotionReadiness: "live", syncFreshness: "fresh" } as const;
  return {
    generatedAt: "2026-07-14T12:00:00.000Z",
    scope: detail,
    languageEditions: null,
    languageEditionReviewFailed: false,
    overview: {
      scopeRecordId: scope.scopeRecordId,
      condition: "ready",
      stages: [],
      editionCount: scope.languageEditions.length,
      linkedEditionCount: scope.languageEditions.length,
      pendingCandidateCount: 0,
      promotionReadiness: "live",
      syncFreshness: "fresh",
    },
    ...overrides,
  };
}

function runLoader(request: Request, id = "scope_expansion_paldean_fates") {
  return loader({ request, params: { id }, context: {} } as unknown as LoaderFunctionArgs);
}

describe("Catalog scope-detail route loader", () => {
  it.each(["absent", "ready", "blocked"] as const)(
    "preserves %s journey health provenance without another read",
    async (state) => {
      mockCreateCatalogRequestApiClient.mockReturnValue({
        getCatalogScopeJourney: vi.fn().mockResolvedValue(journeyOf({ ...paldeanFatesScope(), languageEditions: ["en"] })),
        getScopeCoverageMatrix: vi.fn().mockResolvedValue(null),
      });
      const request = new Request(
        "https://admin.example/catalog/scopes/scope_expansion_paldean_fates?scopeRecordId=scope_expansion_paldean_fates&providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      );
      const overview = controlPlaneOverview({ generatedAt: "2020-01-01T00:00:00.000Z" });
      const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
        requestUrl: request.url,
        scopes: { items: [sourceObservationScope()], count: 1, total: 1 },
        profileReviews: { items: [], count: 0, total: 0 },
        controlPlaneOverview:
          state === "absent"
            ? null
            : {
                ...overview,
                readiness: {
                  ...overview.readiness,
                  units: overview.readiness.units.map((unit) => ({ ...unit, semanticReadiness: state })),
                },
              },
        canManageCatalog: false,
      });
      const journey = { readModel, requestUrl: request.url };
      mockLoadDailySurfaceForRequest.mockResolvedValue(journey);
      const result = await runLoader(request);
      expect(result.journey).toBe(journey);
      expect(mockLoadDailySurfaceForRequest).toHaveBeenCalledExactlyOnceWith(request);
      expect(result.journey.readModel.healthTriage.freshness).toBe(state === "absent" ? "partial" : "fresh");
      if (state === "absent") {
        expect(result.journey.readModel.healthTriage).toMatchObject({
          status: "unavailable",
          units: [],
          providers: [],
        });
      } else {
        expect(result.journey.readModel.healthTriage.generatedAt).toBe("2020-01-01T00:00:00.000Z");
        expect(result.journey.readModel.healthTriage.units[0]?.status).toBe(state);
      }
    },
  );
  it("preserves typed evidence demand and the review window in the one journey request", async () => {
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogScopeJourney: vi.fn().mockResolvedValue(journeyOf(paldeanFatesScope())),
    });
    const request = new Request(
      "https://admin.example/catalog/scopes/scope_expansion_paldean_fates?evidenceRef=candidate/cand-1&reviewOffset=25",
    );
    await runLoader(request);
    expect(mockLoadDailySurfaceForRequest).toHaveBeenCalledExactlyOnceWith(request);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveActorFromAuthApi.mockResolvedValue({ permissions: ["catalog.view", "catalog.manage"] });
    mockLoadDailySurfaceForRequest.mockResolvedValue({ readModel: { routeContext: {} }, requestUrl: "scope" });
  });

  it("reads the scope with its language editions and journey from the Catalog API in one read", async () => {
    const scopeJourney = journeyOf(paldeanFatesScope(), {
      languageEditions: {
        scopeRecordId: "scope_expansion_paldean_fates",
        referenceRecordId: "ref_expansion_paldean_fates",
        editions: [
          {
            languageCode: "en",
            isCanonical: true,
            linkState: "linked",
            acceptedAliasCount: 0,
            pendingCandidates: [],
            acceptedCandidates: [],
          },
        ],
      },
    });
    const getCatalogScopeJourney = vi.fn().mockResolvedValue(scopeJourney);
    const getScopeCoverageMatrix = vi.fn().mockResolvedValue({
      scopeRecordId: "scope_expansion_paldean_fates",
      scopeName: "Paldean Fates",
      providers: [],
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ getCatalogScopeJourney, getScopeCoverageMatrix });

    const routeData = await runLoader(
      new Request("https://admin.example/catalog/scopes/scope_expansion_paldean_fates"),
    );

    expect(getCatalogScopeJourney).toHaveBeenCalledExactlyOnceWith("scope_expansion_paldean_fates");
    expect(routeData.scope.name).toBe("Paldean Fates");
    expect(routeData.canManageAliases).toBe(true);
    expect(routeData.languageEditions).toBe(scopeJourney.languageEditions);
    expect(routeData.journeyOverview).toBe(scopeJourney.overview);
    expect(getScopeCoverageMatrix).toHaveBeenCalledWith("scope_expansion_paldean_fates");
    expect(routeData.coverageMatrix?.scopeName).toBe("Paldean Fates");
  });

  it("shows a failed alias review as the journey the Catalog API reported", async () => {
    const overview = { ...journeyOf(paldeanFatesScope()).overview, condition: "partial-failure" as const };
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogScopeJourney: vi
        .fn()
        .mockResolvedValue(journeyOf(paldeanFatesScope(), { languageEditionReviewFailed: true, overview })),
    });

    const routeData = await runLoader(
      new Request("https://admin.example/catalog/scopes/scope_expansion_paldean_fates"),
    );

    expect(routeData.scope.name).toBe("Paldean Fates");
    expect(routeData.journeyOverview.condition).toBe("partial-failure");
  });

  // https://github.com/chase-sets/chase-sets/issues/11131: the Catalog API derives the working set from the
  // Scope Record, so the journey is read for this page's own address, not a rewritten daily workbench one.
  it("reads the journey for the page's own address", async () => {
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogScopeJourney: vi.fn().mockResolvedValue(journeyOf({ ...paldeanFatesScope(), languageEditions: ["en"] })),
      getScopeCoverageMatrix: vi.fn().mockResolvedValue(null),
    });
    const request = new Request(
      "https://admin.example/catalog/scopes/scope_expansion_paldean_fates?languageCode=ja&jobId=sync_1",
      { headers: { cookie: "session=test" } },
    );

    await runLoader(request);

    expect(mockLoadDailySurfaceForRequest).toHaveBeenCalledTimes(1);
    expect(mockLoadDailySurfaceForRequest.mock.calls[0]?.[0]).toBe(request);
  });

  it("reloads failed scope jobs separately while following only the completed-jobs cursor", async () => {
    const failedJob = {
      jobId: "job_failed",
      status: "failed",
      progress: { completed: 0, total: 1 },
      errorMessage: "Missing work units.",
    };
    const listFailedCatalogMergeCandidateBulkJobs = vi.fn().mockResolvedValue({ items: [failedJob] });
    const listCatalogMergeCandidateBulkJobs = vi.fn(async (input: { status: string }) =>
      input.status === "completed"
        ? { items: [{ jobId: "job_completed" }], cursor: "cursor_older" }
        : { items: [{ jobId: "job_running" }] },
    );
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogScopeJourney: vi.fn().mockResolvedValue(journeyOf({ ...paldeanFatesScope(), languageEditions: ["en"] })),
      listCatalogMergeCandidateBulkJobs,
      listFailedCatalogMergeCandidateBulkJobs,
    });

    const routeData = await runLoader(
      new Request(
        "https://admin.example/catalog/scopes/scope_expansion_paldean_fates?candidateJobsCursor=cursor_page_2",
      ),
    );

    expect(listCatalogMergeCandidateBulkJobs).toHaveBeenCalledWith({
      scopeRecordId: "scope_expansion_paldean_fates",
      status: "active",
    });
    expect(listCatalogMergeCandidateBulkJobs).toHaveBeenCalledWith({
      scopeRecordId: "scope_expansion_paldean_fates",
      status: "completed",
      cursor: "cursor_page_2",
    });
    expect(routeData.candidateReviewJobsCursor).toBe("cursor_page_2");
    expect(listFailedCatalogMergeCandidateBulkJobs).toHaveBeenCalledWith("scope_expansion_paldean_fates");
    expect(routeData.candidateReviewJobs).toEqual({
      active: [{ jobId: "job_running" }],
      failedJobs: [failedJob],
      completed: { items: [{ jobId: "job_completed" }], cursor: "cursor_older" },
      failed: false,
    });
  });

  it("degrades the candidate review jobs panel instead of failing the scope page", async () => {
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogScopeJourney: vi.fn().mockResolvedValue(journeyOf({ ...paldeanFatesScope(), languageEditions: ["en"] })),
      listCatalogMergeCandidateBulkJobs: vi.fn().mockRejectedValue(new CatalogApiError(400, { error: "bad cursor" })),
    });

    const routeData = await runLoader(
      new Request("https://admin.example/catalog/scopes/scope_expansion_paldean_fates?candidateJobsCursor=garbage"),
    );

    expect(routeData.scope.name).toBe("Paldean Fates");
    expect(routeData.candidateReviewJobs).toEqual({
      active: [],
      failedJobs: [],
      completed: { items: [] },
      failed: true,
    });
  });

  it("resolves canManageAliases to false when the actor lacks catalog.manage", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ permissions: ["catalog.view"] });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogScopeJourney: vi.fn().mockResolvedValue(journeyOf({ ...paldeanFatesScope(), languageEditions: ["en"] })),
    });

    const routeData = await runLoader(
      new Request("https://admin.example/catalog/scopes/scope_expansion_paldean_fates"),
    );

    expect(routeData.canManageAliases).toBe(false);
  });
});
