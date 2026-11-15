import { describe, expect, it } from "vitest";
import {
  catalogScopeDetailDailyLocation,
  catalogScopeRecordIdFromPath,
  type CatalogScopeDetailWorkbenchScope,
} from "./scope-detail-workbench-location";

function scope(overrides: Partial<CatalogScopeDetailWorkbenchScope> = {}): CatalogScopeDetailWorkbenchScope {
  return {
    scopeRecordId: "scope_expansion_paldean_fates",
    productDomain: "pokemon",
    scopeKind: "expansion",
    name: "Paldean Fates",
    productLineScopeRecordId: "scope_product_line_pokemon",
    seriesScopeRecordId: "scope_series_scarlet_violet",
    languageEditions: ["en", "ja"],
    ...overrides,
  };
}

describe("Scope Detail daily workbench location", () => {
  it("names the Scope Record a Scope Detail path names, and nothing for another path", () => {
    expect(catalogScopeRecordIdFromPath("/catalog/scopes/scope_1")).toBe("scope_1");
    expect(catalogScopeRecordIdFromPath("/catalog/scopes/scope%201/")).toBe("scope 1");
    for (const pathname of ["/catalog/scopes", "/catalog/scopes/", "/catalog/scopes/a/b", "/catalog/integrations"]) {
      expect(catalogScopeRecordIdFromPath(pathname), pathname).toBeNull();
    }
    expect(catalogScopeRecordIdFromPath("/catalog/scopes/%E0%A4%A")).toBeNull();
  });

  it("keys an expansion journey to the canonical Scope Record and keeps the address's other state", () => {
    const url = catalogScopeDetailDailyLocation(
      new URL(
        "https://admin.example/catalog/scopes/scope_expansion_paldean_fates?languageCode=ja&jobId=sync_1&expansionId=other&providerKey=tcgdex",
      ),
      scope(),
    );

    expect(url.pathname).toBe("/catalog/integrations");
    expect(url.searchParams.get("expansionId")).toBe("scope_expansion_paldean_fates");
    expect(url.searchParams.get("scopeRecordId")).toBe("scope_expansion_paldean_fates");
    expect(url.searchParams.get("expansionName")).toBe("Paldean Fates");
    expect(url.searchParams.get("seriesId")).toBe("scope_series_scarlet_violet");
    expect(url.searchParams.get("productLineId")).toBe("scope_product_line_pokemon");
    expect(url.searchParams.get("productLineName")).toBe("pokemon");
    expect(url.searchParams.get("languageCode")).toBe("ja");
    expect(url.searchParams.get("jobId")).toBe("sync_1");
    expect(url.searchParams.has("providerKey")).toBe(false);
  });

  it("defaults to the first recorded language edition and maps every Scope Record kind", () => {
    const cases = [
      ["product-line", { productLineId: "scope_1", productLineName: "Scope 1" }],
      ["series", { productLineId: "pl_1", seriesId: "scope_1", seriesName: "Scope 1" }],
      ["expansion", { productLineId: "pl_1", seriesId: "se_1", expansionId: "scope_1", expansionName: "Scope 1" }],
      ["set", { productLineId: "pl_1", seriesId: "se_1", expansionId: "scope_1", expansionName: "Scope 1" }],
    ] as const;

    for (const [scopeKind, expected] of cases) {
      const url = catalogScopeDetailDailyLocation(
        new URL("https://admin.example/catalog/scopes/scope_1"),
        scope({
          scopeRecordId: "scope_1",
          scopeKind,
          name: "Scope 1",
          productLineScopeRecordId: "pl_1",
          seriesScopeRecordId: "se_1",
        }),
      );

      for (const [key, value] of Object.entries(expected)) {
        expect(url.searchParams.get(key), `${scopeKind} ${key}`).toBe(value);
      }
      expect(url.searchParams.get("languageCode"), scopeKind).toBe("en");
    }
  });
});
