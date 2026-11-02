import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { ApiError as CatalogApiError } from "../../shell-support/api/client";
import { catalogAttentionQueueReadModelFixture } from "../../../features/attention-queue/api/attention-queue-test-fixtures";
import { buildCatalogAliasReviewReadModel } from "../../../features/alias-equivalence/api/alias-review-admin-contracts";

const { mockCreateCatalogRequestApiClient } = vi.hoisted(() => ({
  mockCreateCatalogRequestApiClient: vi.fn(),
}));

vi.mock("../../request-support/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../request-support/api-client")>(
    "../../request-support/api-client",
  );
  return { ...actual, createCatalogRequestApiClient: mockCreateCatalogRequestApiClient };
});

const { loader } = await import("./scope-landing-loader");

const aliasFilter = {
  providerKey: null,
  sourceProfileVersion: null,
  aliasType: null,
  reviewStatuses: [],
  observationId: null,
  targetKind: null,
  targetId: null,
};

function scopeRow(overrides: Record<string, unknown> = {}) {
  return {
    scopeRecordId: "scope_expansion_paldean_fates",
    productDomain: "pokemon",
    scopeKind: "expansion",
    referenceTypeKey: "expansion",
    referenceRecordId: "ref_expansion_paldean_fates",
    referenceRecordKey: "paldean-fates",
    name: "Paldean Fates",
    parentScopeRecordId: null,
    productLineScopeRecordId: null,
    seriesScopeRecordId: null,
    releaseDate: "2024-01-26",
    officialSetCode: "PAF",
    languageEditions: ["en", "ja"],
    lifecycleStatus: "active",
    updatedAt: "2026-07-03T12:00:00.000Z",
    ...overrides,
  };
}

function runLoader(url: string) {
  return loader({
    request: new Request(url),
    params: {},
    context: {},
  } as unknown as LoaderFunctionArgs);
}

describe("Catalog scope-landing route loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the scope record list and forwards product-domain / status / search filters and pagination to the API", async () => {
    const listCatalogScopeRecords = vi.fn().mockResolvedValue({ items: [scopeRow()], total: 1, count: 1 });
    mockCreateCatalogRequestApiClient.mockReturnValue({ listCatalogScopeRecords });

    const routeData = await runLoader(
      "https://admin.example/catalog/scopes?productDomain=pokemon&status=active&search=paldean&page=2",
    );

    expect(routeData.error).toBeNull();
    expect(routeData.readModel.rows).toHaveLength(1);
    expect(routeData.productDomain).toBe("pokemon");

    const query = new URLSearchParams(listCatalogScopeRecords.mock.calls[0]?.[0] ?? "");
    expect(query.get("productDomain")).toBe("pokemon");
    expect(query.get("status")).toBe("active");
    expect(query.get("search")).toBe("paldean");
    expect(query.get("limit")).toBe("50");
    // page 2 (1-based in the URL) → zero-based offset of one page.
    expect(query.get("offset")).toBe("50");
  });

  it("does not send the language edition to the API (it is a client-side facet over the page)", async () => {
    const listCatalogScopeRecords = vi.fn().mockResolvedValue({ items: [scopeRow()], total: 1, count: 1 });
    mockCreateCatalogRequestApiClient.mockReturnValue({ listCatalogScopeRecords });

    await runLoader("https://admin.example/catalog/scopes?language=ja");

    const query = new URLSearchParams(listCatalogScopeRecords.mock.calls[0]?.[0] ?? "");
    expect(query.has("language")).toBe(false);
    expect(query.has("languageEdition")).toBe(false);
  });

  it("degrades to an empty list with a blocked error string when the list fetch fails", async () => {
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listCatalogScopeRecords: vi.fn().mockRejectedValue(new CatalogApiError(503, { error: { code: "boom" } })),
    });

    const routeData = await runLoader("https://admin.example/catalog/scopes");

    expect(routeData.readModel.rows).toEqual([]);
    expect(routeData.readModel.counts.total).toBe(0);
    expect(routeData.error).toBeTruthy();
  });

  it("reads the queue and general aliases once without changing scope pagination", async () => {
    const rows = [
      scopeRow(),
      scopeRow({ scopeRecordId: "scope-2", name: "Base Set" }),
      scopeRow({ scopeRecordId: "scope-3", name: "Jungle" }),
    ];
    const listCatalogScopeRecords = vi.fn().mockResolvedValue({ items: rows, total: 103, count: 3 });
    const queue = catalogAttentionQueueReadModelFixture();
    const aliases = buildCatalogAliasReviewReadModel({
      generatedAt: "2026-07-09T12:00:00.000Z",
      filter: aliasFilter,
      candidateRows: [],
      catalogItemAliasRows: [],
      referenceRecordAliasRows: [],
    });
    const getCatalogAttentionQueueReadModel = vi.fn().mockResolvedValue(queue);
    const getCatalogAliasReviewReadModel = vi.fn().mockResolvedValue(aliases);
    const unusedDaily = Object.fromEntries(
      [
        "listSourceObservationIntegrationScopes",
        "listSourceObservationProviderProfiles",
        "getCatalogIntegrationControlPlaneOverview",
        "listSourceObservations",
        "listCatalogMergeCandidates",
        "getSourceObservationProviderProfileAuthoringModel",
        "listSourceObservationIntegrationOptions",
        "getSourceObservationProviderProfileLifecycleImpact",
        "getCatalogSyncScopeState",
      ].map((name) => [
        name,
        vi.fn(() => {
          throw new Error(`Unused daily API read: ${name}`);
        }),
      ]),
    );
    mockCreateCatalogRequestApiClient.mockReturnValue({
      ...unusedDaily,
      listCatalogScopeRecords,
      getCatalogAttentionQueueReadModel,
      getCatalogAliasReviewReadModel,
    });

    const routeData = await runLoader("https://admin.example/catalog/scopes?page=2");

    expect(listCatalogScopeRecords).toHaveBeenCalledOnce();
    expect(getCatalogAttentionQueueReadModel).toHaveBeenCalledOnce();
    expect(getCatalogAliasReviewReadModel).toHaveBeenCalledOnce();
    expect(routeData.readModel.rows).toHaveLength(3);
    expect(routeData.attentionQueue).toEqual({ status: "ready", readModel: queue });
    expect(routeData.generalAliasReview).toEqual(aliases);
    expect(routeData.generalAliasReviewFailed).toBe(false);
    expect(getCatalogAliasReviewReadModel).toHaveBeenCalledWith("limit=200");
    const query = new URLSearchParams(listCatalogScopeRecords.mock.calls[0]?.[0]);
    expect(query.get("limit")).toBe("50");
    expect(query.get("offset")).toBe("50");
    for (const spy of Object.values(unusedDaily)) expect(spy).not.toHaveBeenCalled();
  });

  it("keeps multiple paginated scopes and valid aliases when the queue transport fails", async () => {
    const rows = [scopeRow(), scopeRow({ scopeRecordId: "scope-2", name: "Base Set" })];
    const listCatalogScopeRecords = vi.fn().mockResolvedValue({ items: rows, total: 102, count: 2 });
    const getCatalogAttentionQueueReadModel = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const aliases = buildCatalogAliasReviewReadModel({
      generatedAt: "2026-07-09T12:00:00.000Z",
      filter: aliasFilter,
      candidateRows: [],
      catalogItemAliasRows: [],
      referenceRecordAliasRows: [],
    });
    const getCatalogAliasReviewReadModel = vi.fn().mockResolvedValue(aliases);
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listCatalogScopeRecords,
      getCatalogAttentionQueueReadModel,
      getCatalogAliasReviewReadModel,
    });
    const data = await runLoader("https://admin.example/catalog/scopes?page=2");
    expect(data.error).toBeNull();
    expect(data.readModel.rows).toHaveLength(2);
    expect(data.attentionQueue.status).toBe("unavailable");
    expect(data.generalAliasReview).toEqual(aliases);
    expect(data.generalAliasReviewFailed).toBe(false);
    expect(listCatalogScopeRecords).toHaveBeenCalledOnce();
    expect(getCatalogAttentionQueueReadModel).toHaveBeenCalledOnce();
    expect(getCatalogAliasReviewReadModel).toHaveBeenCalledOnce();
    const query = new URLSearchParams(listCatalogScopeRecords.mock.calls[0]?.[0]);
    expect(query.get("limit")).toBe("50");
    expect(query.get("offset")).toBe("50");
  });

  it("keeps scopes when the supplementary alias read fails", async () => {
    const listCatalogScopeRecords = vi.fn().mockResolvedValue({ items: [scopeRow()], total: 1, count: 1 });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listCatalogScopeRecords,
      getCatalogAttentionQueueReadModel: vi.fn().mockResolvedValue({ malformed: true }),
      getCatalogAliasReviewReadModel: vi.fn().mockRejectedValue(new CatalogApiError(503, { error: { code: "boom" } })),
    });

    const routeData = await runLoader("https://admin.example/catalog/scopes");

    expect(routeData.readModel.rows).toHaveLength(1);
    expect(routeData.generalAliasReview).toBeNull();
    expect(routeData.generalAliasReviewFailed).toBe(true);
  });

  it("keeps scopes when the supplementary alias read has a transport failure", async () => {
    const listCatalogScopeRecords = vi.fn().mockResolvedValue({ items: [scopeRow()], total: 1, count: 1 });
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listCatalogScopeRecords,
      getCatalogAttentionQueueReadModel: vi.fn().mockResolvedValue({ malformed: true }),
      getCatalogAliasReviewReadModel: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    });

    const routeData = await runLoader("https://admin.example/catalog/scopes");

    expect(routeData.readModel.rows).toHaveLength(1);
    expect(routeData.generalAliasReviewFailed).toBe(true);
  });
});
