import { describe, expect, it } from "vitest";
import {
  assertCatalogScopeRecordFixtureMatchesContract,
  catalogScopeLanguageEditionFilter,
  catalogScopeProductDomainContracts,
  catalogScopeProductDomains,
  representativeCatalogScopeRecordFixtures,
} from "./contract";

describe("Catalog scope record contract", () => {
  it("formalizes one product-line, series, and expansion-or-set contract per product domain", () => {
    expect(Object.keys(catalogScopeProductDomainContracts).sort()).toEqual([...catalogScopeProductDomains].sort());

    expect(catalogScopeProductDomainContracts.pokemon).toMatchObject({
      productLineReferenceRecordKey: "pokemon-trading-card-game",
      seriesReferenceTypeKey: "series",
      leafReferenceTypeKey: "expansion",
      selectLeavesByLanguageEdition: true,
    });
    expect(catalogScopeProductDomainContracts.magic.leafReferenceTypeKey).toBe("set");
    expect(catalogScopeProductDomainContracts.yugioh.leafReferenceTypeKey).toBe("set");
    expect(catalogScopeProductDomainContracts["one-piece"].leafReferenceTypeKey).toBe("set");
    expect(catalogScopeProductDomainContracts.lorcana.leafReferenceTypeKey).toBe("set");
    expect(
      Object.values(catalogScopeProductDomainContracts)
        .filter((contract) => contract.selectLeavesByLanguageEdition)
        .map((contract) => contract.productDomain),
    ).toEqual(["pokemon"]);

    for (const contract of Object.values(catalogScopeProductDomainContracts)) {
      expect(contract.requiredLeafAttributeKeys).toEqual(["release-date", "official-set-code", "language-editions"]);
    }
  });

  it("declares English and Japanese discovery for Pokemon and English for every other domain", () => {
    expect(
      Object.fromEntries(
        Object.values(catalogScopeProductDomainContracts).map((contract) => [
          contract.productDomain,
          contract.discoveryLanguageCodes,
        ]),
      ),
    ).toEqual({
      pokemon: ["en", "ja"],
      magic: ["en"],
      yugioh: ["en"],
      "one-piece": ["en"],
      lorcana: ["en"],
    });
  });

  it("filters Scope Records by language edition only where the domain keeps one record per edition", () => {
    expect(catalogScopeLanguageEditionFilter("pokemon", "ja")).toEqual({
      languageCode: "ja",
      includesUnrecorded: false,
    });
    expect(catalogScopeLanguageEditionFilter("pokemon", " EN ")).toEqual({
      languageCode: "en",
      includesUnrecorded: true,
    });
    expect(catalogScopeLanguageEditionFilter("magic", "en")).toBeNull();
  });

  it("keeps one representative canonical scope fixture for every product domain", () => {
    const fixtureDomains = representativeCatalogScopeRecordFixtures.map((fixture) => fixture.productDomain).sort();
    expect(fixtureDomains).toEqual([...catalogScopeProductDomains].sort());

    for (const fixture of representativeCatalogScopeRecordFixtures) {
      expect(() => assertCatalogScopeRecordFixtureMatchesContract(fixture)).not.toThrow();
    }
  });
});
