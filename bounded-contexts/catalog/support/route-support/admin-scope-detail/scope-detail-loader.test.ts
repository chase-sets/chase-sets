import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { CatalogApiError } from "../../../client";

const { mockCreateCatalogRequestApiClient, mockResolveActorFromAuthApi } = vi.hoisted(() => ({
  mockCreateCatalogRequestApiClient: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
}));

vi.mock("../../request-support/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../request-support/api-client")>(
    "../../request-support/api-client",
  );
  return { ...actual, createCatalogRequestApiClient: mockCreateCatalogRequestApiClient };
});

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  resolveActorFromAuthApi: mockResolveActorFromAuthApi,
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

function runLoader(request: Request, id = "scope_expansion_paldean_fates") {
  return loader({ request, params: { id }, context: {} } as unknown as LoaderFunctionArgs);
}

describe("Catalog scope-detail route loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveActorFromAuthApi.mockResolvedValue({ permissions: ["catalog.view", "catalog.manage"] });
  });

  it("loads the scope record and the alias review scoped to its reference record for a multi-edition scope", async () => {
    const getCatalogAliasReviewReadModel = vi.fn().mockResolvedValue({
      schemaVersion: "catalog-alias-review-v1",
      generatedAt: "2026-06-16T00:00:00.000Z",
      filter: {
        providerKey: null,
        sourceProfileVersion: null,
        aliasType: null,
        reviewStatuses: [],
        observationId: null,
        targetKind: "reference-record",
        targetId: "ref_expansion_paldean_fates",
      },
      counts: {
        total: 0,
        pending: 0,
        accepted: 0,
        autoAccepted: 0,
        rejected: 0,
        revoked: 0,
        needsReview: 0,
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
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogScopeRecord: vi.fn().mockResolvedValue(paldeanFatesScope()),
      getCatalogAliasReviewReadModel,
    });

    const routeData = await runLoader(
      new Request("https://admin.example/catalog/scopes/scope_expansion_paldean_fates"),
    );

    expect(routeData.scope.name).toBe("Paldean Fates");
    expect(routeData.canManageAliases).toBe(true);
    expect(routeData.languageEditionAliasReviewFailed).toBe(false);
    expect(getCatalogAliasReviewReadModel).toHaveBeenCalledTimes(1);
    const query = new URLSearchParams(getCatalogAliasReviewReadModel.mock.calls[0]?.[0] ?? "");
    expect(query.get("targetKind")).toBe("reference-record");
    expect(query.get("targetId")).toBe("ref_expansion_paldean_fates");
  });

  it("skips the alias-review fetch for a single-edition scope", async () => {
    const getCatalogAliasReviewReadModel = vi.fn();
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogScopeRecord: vi.fn().mockResolvedValue({ ...paldeanFatesScope(), languageEditions: ["en"] }),
      getCatalogAliasReviewReadModel,
    });

    const routeData = await runLoader(
      new Request("https://admin.example/catalog/scopes/scope_expansion_paldean_fates"),
    );

    expect(getCatalogAliasReviewReadModel).not.toHaveBeenCalled();
    expect(routeData.languageEditionAliasReview.candidates).toEqual([]);
  });

  it("degrades to an empty alias review read model when the supplementary fetch fails transiently", async () => {
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogScopeRecord: vi.fn().mockResolvedValue(paldeanFatesScope()),
      getCatalogAliasReviewReadModel: vi.fn().mockRejectedValue(new CatalogApiError(503, { error: { code: "boom" } })),
    });

    const routeData = await runLoader(
      new Request("https://admin.example/catalog/scopes/scope_expansion_paldean_fates"),
    );

    expect(routeData.scope.name).toBe("Paldean Fates");
    expect(routeData.languageEditionAliasReview.candidates).toEqual([]);
    expect(routeData.languageEditionAliasReviewFailed).toBe(true);
  });

  it("resolves canManageAliases to false when the actor lacks catalog.manage", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ permissions: ["catalog.view"] });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      getCatalogScopeRecord: vi.fn().mockResolvedValue({ ...paldeanFatesScope(), languageEditions: ["en"] }),
      getCatalogAliasReviewReadModel: vi.fn(),
    });

    const routeData = await runLoader(
      new Request("https://admin.example/catalog/scopes/scope_expansion_paldean_fates"),
    );

    expect(routeData.canManageAliases).toBe(false);
  });
});
