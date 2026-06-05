import { describe, expect, it } from "vitest";

import { defineCatalogIntegrationUnitKey, parseCatalogIntegrationUnitKey } from "./integration-unit";

describe("Catalog integration unit identity", () => {
  it("defines keys from provider, product domain, product form, and optional purpose", () => {
    expect(
      defineCatalogIntegrationUnitKey({
        providerKey: "reference-cards",
        productDomain: "pokemon",
        productForm: "single-card",
        ingestionPurpose: "source-observation-proof",
      }),
    ).toBe("reference-cards:pokemon:single-card:source-observation-proof");
  });

  it("parses provider, product domain, product form, and purpose from keys", () => {
    expect(parseCatalogIntegrationUnitKey("tcgplayer:mtg:sealed-product")).toEqual({
      providerKey: "tcgplayer",
      productDomain: "mtg",
      productForm: "sealed-product",
    });
    expect(parseCatalogIntegrationUnitKey("tcgplayer:pokemon:single-card:catalog-import")).toEqual({
      providerKey: "tcgplayer",
      productDomain: "pokemon",
      productForm: "single-card",
      ingestionPurpose: "catalog-import",
    });
  });

  it("rejects raw or graded as a separate unit segment unless modeled as a product form or purpose explicitly", () => {
    expect(() => parseCatalogIntegrationUnitKey("tcgplayer:pokemon:single-card:graded:catalog-import")).toThrow(
      "must have 3 or 4 segments",
    );
  });

  it("rejects unsafe or ambiguous segments", () => {
    expect(() =>
      defineCatalogIntegrationUnitKey({
        providerKey: "TCGplayer",
        productDomain: "pokemon",
        productForm: "single-card",
      }),
    ).toThrow("Invalid Catalog integration unit segment 'TCGplayer'.");
  });
});
