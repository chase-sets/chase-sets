import { describe, expect, it } from "vitest";
import { catalogItemsBySourceProviderHref, sourceObservationsForProviderHref } from "./catalog-item-provenance-links";

describe("catalogItemsBySourceProviderHref", () => {
  it("filters the Catalog Items list by source provider inside the Catalog admin prefix", () => {
    expect(catalogItemsBySourceProviderHref("tcgdex")).toBe("/catalog/catalog-items?source=tcgdex");
  });

  it("trims surrounding whitespace before building the filter", () => {
    expect(catalogItemsBySourceProviderHref("  tcgplayer  ")).toBe("/catalog/catalog-items?source=tcgplayer");
  });

  it("falls back to the unfiltered list when no provider is selected", () => {
    expect(catalogItemsBySourceProviderHref(null)).toBe("/catalog/catalog-items");
    expect(catalogItemsBySourceProviderHref("")).toBe("/catalog/catalog-items");
    expect(catalogItemsBySourceProviderHref("   ")).toBe("/catalog/catalog-items");
  });
});

describe("sourceObservationsForProviderHref", () => {
  it("links back to the daily integrations flow scoped to the originating provider", () => {
    expect(sourceObservationsForProviderHref("tcgdex")).toBe("/catalog/integrations?providerKey=tcgdex");
  });

  it("falls back to the daily integrations route when the provider is missing", () => {
    expect(sourceObservationsForProviderHref(null)).toBe("/catalog/integrations");
    expect(sourceObservationsForProviderHref("")).toBe("/catalog/integrations");
  });
});
