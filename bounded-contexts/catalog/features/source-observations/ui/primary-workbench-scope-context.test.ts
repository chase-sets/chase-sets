import { describe, expect, it } from "vitest";
import {
  importScopeFromScopeContext,
  scopeContextFromFields,
  scopeContextFromFormData,
  scopeContextToIntegrationJobScope,
  scopeContextFromImportScope,
  scopeContextFromProviderScope,
  scopeContextFromSearchParams,
  scopeContextToObservationFilterScope,
  scopeContextToQueryParams,
  scopeDisplayLabel,
} from "./primary-workbench-scope-context";
import { sourceObservationScope } from "./primary-workbench-test-fixtures";

describe("Catalog primary workbench scope context", () => {
  it("round trips distinct provider products without reinterpreting compact sets and clears FormData deselection", () => {
    const identities = ["synthetic-product:A", "synthetic-product:B"].map((productId) => {
      const scope = scopeContextFromFields({ providerKey: "ygojson", languageCode: "en", productId });
      const identity = importScopeFromScopeContext(scope);
      expect(scopeContextFromImportScope(identity, "ygojson").productId).toBeNull();
      expect(
        scopeContextFromSearchParams({
          searchParams: scopeContextToQueryParams(scope),
          providerKey: "ygojson",
          importScope: identity,
          sourceObservationFilters: {},
        }),
      ).toEqual(scope);
      const form = new FormData();
      form.set("productId", productId);
      expect(scopeContextToIntegrationJobScope(scopeContextFromFormData(form, scope)).productId).toBe(productId);
      form.set("productId", "");
      expect(scopeContextFromFormData(form, scope).productId).toBeNull();
      return identity;
    });
    expect(new Set(identities).size).toBe(2);
    expect(scopeContextFromImportScope("en:synthetic-set", "ygojson")).toMatchObject({
      expansionId: "synthetic-set",
      productId: null,
    });
  });
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

  it("keeps name-based set selections out of the language and series scope", () => {
    const scope = scopeContextFromSearchParams({
      searchParams: new URLSearchParams(
        "providerKey=tcgplayer&importScope=en%3A1%3AClassic%20Sixth%20Edition&languageCode=en&productLineId=1&expansionName=Classic%20Sixth%20Edition",
      ),
      providerKey: "tcgplayer",
      importScope: "en:1:Classic Sixth Edition",
      sourceObservationFilters: {},
    });

    expect(scope).toMatchObject({
      providerKey: "tcgplayer",
      languageCode: "en",
      productLineId: "1",
      seriesId: null,
      expansionId: null,
      expansionName: "Classic Sixth Edition",
    });
    expect(scopeContextToObservationFilterScope(scope)).toMatchObject({
      provider: "tcgplayer",
      language: "en",
      productLineId: "1",
      expansionId: "Classic Sixth Edition",
      setId: "Classic Sixth Edition",
    });
  });

  it("keeps compact Lorcana set scopes from becoming product-line filters when structured set ids are present", () => {
    const scope = scopeContextFromSearchParams({
      searchParams: new URLSearchParams("providerKey=lorcanajson&importScope=en%3A1&languageCode=en&expansionId=1"),
      providerKey: "lorcanajson",
      importScope: "en:1",
      sourceObservationFilters: {},
    });

    expect(scope).toMatchObject({
      providerKey: "lorcanajson",
      languageCode: "en",
      productLineId: null,
      seriesId: null,
      expansionId: "1",
    });
    expect(scopeContextToObservationFilterScope(scope)).toMatchObject({
      provider: "lorcanajson",
      language: "en",
      expansionId: "1",
      setId: "1",
    });
    expect(scopeContextToObservationFilterScope(scope)).not.toHaveProperty("productLineId");
  });

  it("treats compact LorcanaJSON import scopes as set selections when matching provider scopes", () => {
    const scope = scopeContextFromImportScope("en:1", "lorcanajson");

    expect(scope).toMatchObject({
      providerKey: "lorcanajson",
      languageCode: "en",
      productLineId: null,
      seriesId: null,
      expansionId: "1",
    });
    expect(scopeContextToObservationFilterScope(scope)).toMatchObject({
      provider: "lorcanajson",
      language: "en",
      expansionId: "1",
      setId: "1",
    });
    expect(scopeContextToObservationFilterScope(scope)).not.toHaveProperty("productLineId");
  });

  it("drops stale legacy importScope parents when an explicit set-name selection differs", () => {
    const scope = scopeContextFromSearchParams({
      searchParams: new URLSearchParams(
        "providerKey=ygojson&importScope=ja%3ASV%3ASV8&expansionName=9baa1b43-8a60-44dd-a144-dbef99c8c7a4",
      ),
      providerKey: "ygojson",
      importScope: "ja:SV:SV8",
      sourceObservationFilters: {},
    });

    expect(scope).toMatchObject({
      providerKey: "ygojson",
      languageCode: null,
      seriesId: null,
      expansionId: null,
      expansionName: "9baa1b43-8a60-44dd-a144-dbef99c8c7a4",
    });
  });

  it("resolves compact two-segment import scopes per provider through the registry-backed scope shape", () => {
    // TCGplayer leads with product-line/category in the provider registry, so the
    // second segment is a product line.
    expect(scopeContextFromImportScope("en:1", "tcgplayer")).toMatchObject({
      providerKey: "tcgplayer",
      languageCode: "en",
      productLineId: "1",
      seriesId: null,
      expansionId: null,
    });

    // The reference-data providers lead with set-name, so the second segment is an
    // expansion — covering every provider that was in the deleted expansion set.
    for (const providerKey of ["lorcanajson", "lorcast", "mtgjson", "scryfall", "scrydex", "ygojson", "ygoprodeck"]) {
      expect(scopeContextFromImportScope("en:SET1", providerKey)).toMatchObject({
        providerKey,
        languageCode: "en",
        productLineId: null,
        seriesId: null,
        expansionId: "SET1",
      });
    }

    // TCGdex carries its own language/series hierarchy, so the second segment is a
    // series (the default shape, no special-casing).
    expect(scopeContextFromImportScope("ja:SV", "tcgdex")).toMatchObject({
      providerKey: "tcgdex",
      languageCode: "ja",
      productLineId: null,
      seriesId: "SV",
      expansionId: null,
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
