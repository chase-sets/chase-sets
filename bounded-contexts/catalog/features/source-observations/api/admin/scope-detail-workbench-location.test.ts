import { describe, expect, it } from "vitest";
import {
  CATALOG_SCOPE_RECORD_QUERY_KEYS,
  catalogScopeDetailCommandSubmission,
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
    expect(url.searchParams.get("providerKey")).toBe("tcgdex");
  });

  it("carries the provider, unit, import scope and profile selections while the record overrides hierarchy", () => {
    const selection = {
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      productId: "synthetic-product",
    };
    const address = new URL("https://admin.example/catalog/scopes/scope_1");
    for (const [key, value] of Object.entries(selection)) address.searchParams.set(key, value);
    for (const key of CATALOG_SCOPE_RECORD_QUERY_KEYS) address.searchParams.set(key, `submitted-${key}`);

    const series = catalogScopeDetailDailyLocation(
      address,
      scope({ scopeRecordId: "scope_1", scopeKind: "series", name: "Scope 1", productLineScopeRecordId: "pl_1" }),
    );

    for (const [key, value] of Object.entries(selection)) expect(series.searchParams.get(key), key).toBe(value);
    expect(
      Object.fromEntries(CATALOG_SCOPE_RECORD_QUERY_KEYS.map((key) => [key, series.searchParams.get(key)])),
    ).toEqual({
      productLineId: "pl_1",
      productLineName: "pokemon",
      seriesId: "scope_1",
      seriesName: "Scope 1",
      expansionId: null,
      expansionName: null,
    });
  });

  // A set alias or a review filter on a hierarchy level would otherwise take
  // precedence over the record's expansion when the observations are read.
  it("drops hierarchy restated as set aliases or review filters and keeps the other filters", () => {
    const address = new URL(
      "https://admin.example/catalog/scopes/scope_expansion_paldean_fates?" +
        new URLSearchParams({
          setId: "base1",
          setName: "Base Set",
          "filter.expansionId": "base1",
          "filter.setId": "base1",
          "filter.seriesId": "base",
          "filter.productLineId": "3",
          "filter.status": "eligible",
          "filter.search": "pikachu",
          "filter.language": "ja",
        }),
    );

    const url = catalogScopeDetailDailyLocation(address, scope());

    for (const key of [
      "setId",
      "setName",
      "filter.expansionId",
      "filter.setId",
      "filter.seriesId",
      "filter.productLineId",
    ]) {
      expect(url.searchParams.has(key), key).toBe(false);
    }
    expect(url.searchParams.get("expansionId")).toBe("scope_expansion_paldean_fates");
    expect(url.searchParams.get("filter.status")).toBe("eligible");
    expect(url.searchParams.get("filter.search")).toBe("pikachu");
    expect(url.searchParams.get("filter.language")).toBe("ja");
  });

  it("binds a command to the record: conflicting hierarchy or record ids are refused, matching ones kept", () => {
    const location = new URL(
      "https://admin.example/catalog/scopes/scope_expansion_paldean_fates?providerKey=tcgdex&importScope=en:scope_expansion_paldean_fates&expansionId=scope_expansion_paldean_fates",
    );
    const form = (entries: Record<string, string>) => {
      const formData = new FormData();
      for (const [key, value] of Object.entries(entries)) formData.set(key, value);
      return formData;
    };

    const bound = catalogScopeDetailCommandSubmission(
      location,
      form({
        _intent: "scope.import",
        expansionId: "scope_expansion_paldean_fates",
        seriesName: "",
        expansionName: "",
        scopeRecordId: "scope_expansion_paldean_fates",
        importScope: "en:scope_expansion_paldean_fates",
      }),
      scope(),
    );
    expect(bound?.location.pathname).toBe("/catalog/scopes/scope_expansion_paldean_fates");
    expect(bound?.location.searchParams.get("seriesId")).toBe("scope_series_scarlet_violet");
    expect(bound?.location.searchParams.get("importScope")).toBe("en:scope_expansion_paldean_fates");
    expect(Object.fromEntries(bound?.formData ?? [])).toEqual({
      _intent: "scope.import",
      scopeRecordId: "scope_expansion_paldean_fates",
      importScope: "en:scope_expansion_paldean_fates",
    });

    const conflicts: readonly [string, URL, FormData][] = [
      ["form expansion", location, form({ expansionId: "base1" })],
      ["form set alias", location, form({ setId: "base1" })],
      ["form series", location, form({ seriesId: "base" })],
      ["form Scope Record", location, form({ scopeRecordId: "scope_expansion_base_set" })],
      ["form sync reference", location, form({ referenceId: "scope_expansion_base_set" })],
      ["address expansion", new URL(`${location.href}&expansionName=Base%20Set`), form({})],
      ["address filter", new URL(`${location.href}&filter.setId=base1`), form({})],
      ["address Scope Record", new URL(`${location.href}&scopeRecordId=scope_expansion_base_set`), form({})],
    ];
    for (const [name, address, formData] of conflicts) {
      expect(catalogScopeDetailCommandSubmission(address, formData, scope()), name).toBeNull();
    }
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
