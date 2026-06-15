import { describe, expect, it } from "vitest";
import {
  scopeContextFromImportScope,
  scopeContextFromProviderScope,
  scopeContextFromSearchParams,
  scopeContextToQueryParams,
  scopeDisplayLabel,
} from "./primary-workbench-scope-context";
import { sourceObservationScope } from "./primary-workbench-test-fixtures";

describe("Catalog primary workbench scope context", () => {
  it("interprets legacy TCGdex native language-series-expansion scopes as structured fields", () => {
    const scope = scopeContextFromImportScope("ja:SV:SV8", "tcgdex");

    expect(scope).toMatchObject({
      providerKey: "tcgdex",
      languageCode: "ja",
      productLineId: null,
      seriesId: "SV",
      expansionId: "SV8",
    });
    expect(Object.fromEntries(scopeContextToQueryParams(scope))).toMatchObject({
      providerKey: "tcgdex",
      languageCode: "ja",
      seriesId: "SV",
      expansionId: "SV8",
    });
  });

  it("treats one- and two-segment TCGdex scopes as all-language and all-series selections", () => {
    expect(scopeContextFromImportScope("ja", "tcgdex")).toMatchObject({
      providerKey: "tcgdex",
      languageCode: "ja",
      seriesId: null,
      expansionId: null,
    });
    expect(scopeContextFromImportScope("ja:SV", "tcgdex")).toMatchObject({
      providerKey: "tcgdex",
      languageCode: "ja",
      seriesId: "SV",
      expansionId: null,
    });
  });

  it("uses explicit structured params for all-series selections without legacy ambiguity", () => {
    const scope = scopeContextFromSearchParams({
      searchParams: new URLSearchParams("providerKey=tcgdex&languageCode=ja&seriesId=SV"),
      providerKey: "tcgdex",
      importScope: null,
      sourceObservationFilters: {},
    });

    expect(scope).toMatchObject({
      providerKey: "tcgdex",
      languageCode: "ja",
      seriesId: "SV",
      expansionId: null,
    });
    expect(Object.fromEntries(scopeContextToQueryParams(scope))).toMatchObject({
      providerKey: "tcgdex",
      languageCode: "ja",
      seriesId: "SV",
    });
  });

  it("uses structured names for display labels instead of parsing raw importScope text", () => {
    const scope = scopeContextFromProviderScope(
      sourceObservationScope({
        language_code: "ja",
        product_line_id: "",
        product_line_name: "",
        series_id: "sv",
        series_name: "Scarlet & Violet",
        expansion_id: "sv8",
        expansion_name: "Super Electric Breaker",
      }),
    );

    expect(scopeDisplayLabel(scope)).toBe("tcgdex / ja / Scarlet & Violet / Super Electric Breaker");
  });
});
