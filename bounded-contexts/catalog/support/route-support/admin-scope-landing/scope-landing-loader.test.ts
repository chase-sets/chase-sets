import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { CatalogApiError } from "../../../client";

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
});
