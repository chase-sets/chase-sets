import { describe, expect, it } from "vitest";
import {
  assertCatalogScopeRecordFixtureMatchesContract,
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
    });
    expect(catalogScopeProductDomainContracts.magic.leafReferenceTypeKey).toBe("set");
    expect(catalogScopeProductDomainContracts.yugioh.leafReferenceTypeKey).toBe("set");
    expect(catalogScopeProductDomainContracts["one-piece"].leafReferenceTypeKey).toBe("set");
    expect(catalogScopeProductDomainContracts.lorcana.leafReferenceTypeKey).toBe("set");

    for (const contract of Object.values(catalogScopeProductDomainContracts)) {
      expect(contract.requiredLeafAttributeKeys).toEqual(["release-date", "official-set-code", "language-editions"]);
    }
  });

  it("keeps one representative canonical scope fixture for every product domain", () => {
    const fixtureDomains = representativeCatalogScopeRecordFixtures.map((fixture) => fixture.productDomain).sort();
    expect(fixtureDomains).toEqual([...catalogScopeProductDomains].sort());

    for (const fixture of representativeCatalogScopeRecordFixtures) {
      expect(() => assertCatalogScopeRecordFixtureMatchesContract(fixture)).not.toThrow();
    }
  });
});
