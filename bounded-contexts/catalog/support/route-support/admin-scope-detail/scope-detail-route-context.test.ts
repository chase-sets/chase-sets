import { describe, expect, it } from "vitest";
import type { CatalogScopeRecordDetail } from "../../request-support/api-client";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import { scopeDetailCommandHref, scopeDetailWorkbenchRequest } from "./scope-detail-route-context";

function scope(overrides: Partial<CatalogScopeRecordDetail> = {}): CatalogScopeRecordDetail {
  return {
    scopeRecordId: "scope_expansion_paldean_fates",
    productDomain: "pokemon",
    scopeKind: "expansion",
    referenceTypeKey: "expansion",
    referenceRecordId: "ref_expansion_paldean_fates",
    referenceRecordKey: "paldean-fates",
    name: "Paldean Fates",
    parentScopeRecordId: "scope_series_scarlet_violet",
    productLineScopeRecordId: "scope_product_line_pokemon",
    seriesScopeRecordId: "scope_series_scarlet_violet",
    releaseDate: "2024-01-26",
    officialSetCode: "PAF",
    languageEditions: ["en", "ja"],
    lifecycleStatus: "active",
    updatedAt: "2026-07-03T12:00:00.000Z",
    ...overrides,
  };
}

describe("Scope Detail workbench route context", () => {
  it("keys an expansion journey to the canonical Scope Record and preserves route state", () => {
    const request = scopeDetailWorkbenchRequest(
      new Request("https://admin.example/catalog/scopes/scope_expansion_paldean_fates?languageCode=ja&jobId=sync_1", {
        headers: { cookie: "session=test" },
      }),
      scope(),
    );
    const url = new URL(request.url);

    expect(url.pathname).toBe("/catalog/integrations");
    expect(url.searchParams.get("expansionId")).toBe("scope_expansion_paldean_fates");
    expect(url.searchParams.get("scopeRecordId")).toBe("scope_expansion_paldean_fates");
    expect(url.searchParams.get("expansionName")).toBe("Paldean Fates");
    expect(url.searchParams.get("seriesId")).toBe("scope_series_scarlet_violet");
    expect(url.searchParams.get("productLineId")).toBe("scope_product_line_pokemon");
    expect(url.searchParams.get("productLineName")).toBe("pokemon");
    expect(url.searchParams.get("languageCode")).toBe("ja");
    expect(url.searchParams.get("jobId")).toBe("sync_1");
    expect(request.headers.get("cookie")).toBe("session=test");
  });

  it("defaults to the first recorded language edition and maps every Scope Record kind", () => {
    const cases = [
      ["product-line", "productLineId"],
      ["series", "seriesId"],
      ["expansion", "expansionId"],
      ["set", "expansionId"],
    ] as const;

    for (const [scopeKind, queryKey] of cases) {
      const request = scopeDetailWorkbenchRequest(
        new Request("https://admin.example/catalog/scopes/scope_1"),
        scope({ scopeRecordId: "scope_1", scopeKind }),
      );
      const url = new URL(request.url);

      expect(url.searchParams.get(queryKey)).toBe("scope_1");
      expect(url.searchParams.get("languageCode")).toBe("en");
    }
  });

  it("keeps job and promotion checkpoints on Scope Detail", () => {
    const context = {
      ...parseCatalogPrimaryWorkbenchRouteContext(
        "https://admin.example/catalog/integrations?languageCode=en&expansionId=scope_expansion_paldean_fates",
      ),
      jobId: "sync_1",
      promotionPreviewId: "preview_1",
    };

    const href = scopeDetailCommandHref("scope_expansion_paldean_fates", context);
    const url = new URL(href, "https://admin.example");

    expect(url.pathname).toBe("/catalog/scopes/scope_expansion_paldean_fates");
    expect(url.searchParams.get("jobId")).toBe("sync_1");
    expect(url.searchParams.get("promotionPreviewId")).toBe("preview_1");
    expect(url.searchParams.get("expansionId")).toBe("scope_expansion_paldean_fates");
  });
});
