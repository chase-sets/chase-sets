import { describe, expect, it } from "vitest";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
} from "../../source-observations/api/provider-integration-profiles";
import {
  catalogScopeProductDomainContracts,
  normalizeCatalogScopeProductDomain,
} from "../../scope-registry/domain/contract";
import { listProviderScopeDiscoveryTargets } from "./discovery-targets";

describe("provider scope discovery targets", () => {
  const targets = listProviderScopeDiscoveryTargets(catalogProviderIntegrationProfileVersions);

  it("derives scope-level option queries from active provider profiles", () => {
    const tcgdexTargets = targets.filter((target) => target.providerKey === "tcgdex");

    expect(tcgdexTargets.map((target) => target.queryKind).sort()).toEqual(["expansions", "languages", "series"]);
    expect(tcgdexTargets.every((target) => target.productDomain === "pokemon")).toBe(true);
  });

  it("derives all nine active TCGplayer set-name cascades from normalized product-domain contracts", () => {
    const activeVersions = catalogProviderIntegrationProfileVersions.filter(
      (version) => version.providerKey === "tcgplayer" && version.active && version.lifecycle === "active",
    );
    const tcgplayerTargets = targets.filter((target) => target.providerKey === "tcgplayer");
    const setNameTargets = tcgplayerTargets.filter((target) => target.queryKind === "set-names");

    expect(activeVersions).toHaveLength(9);
    expect(setNameTargets).toHaveLength(activeVersions.length);
    for (const version of activeVersions) {
      const unitKey = catalogProviderProfileVersionIngestionUnitKey(version);
      const productDomain = normalizeCatalogScopeProductDomain(version.ingestionUnitIdentity?.productDomain);
      expect(productDomain).not.toBeNull();
      expect(setNameTargets.find((target) => target.ingestionUnitKey === unitKey)).toMatchObject({
        productDomain,
        providerScope: "set-name",
        parentScope: "product-line/category",
        parentRequired: true,
        scopeKind: catalogScopeProductDomainContracts[productDomain!].leafReferenceTypeKey,
      });
    }

    expect(setNameTargets.filter((target) => target.productDomain === "pokemon")).toHaveLength(2);
    expect(setNameTargets.filter((target) => target.productDomain === "magic")).toHaveLength(2);
    expect(setNameTargets.filter((target) => target.productDomain === "yugioh")).toHaveLength(1);
    expect(setNameTargets.filter((target) => target.productDomain === "one-piece")).toHaveLength(2);
    expect(setNameTargets.filter((target) => target.productDomain === "lorcana")).toHaveLength(2);
    expect(setNameTargets.filter((target) => target.scopeKind === "expansion")).toHaveLength(2);
    expect(setNameTargets.filter((target) => target.scopeKind === "set")).toHaveLength(7);
  });

  it("never emits card, product, or SKU level queries", () => {
    const queryKinds = new Set(targets.map((target) => target.queryKind));

    expect(queryKinds.has("cards")).toBe(false);
    expect(queryKinds.has("products")).toBe(false);
    expect(queryKinds.has("skus")).toBe(false);
  });

  it("emits each provider-unit query kind exactly once across competing profiles", () => {
    const keys = targets.map(
      (target) => `${target.providerKey}:${target.ingestionUnitKey}:${target.queryKind}:${target.languageCode}`,
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("skips inactive and non-active-lifecycle profile versions", () => {
    const inactiveOnly = catalogProviderIntegrationProfileVersions.map((version) => ({
      ...version,
      active: false,
    }));

    expect(listProviderScopeDiscoveryTargets(inactiveOnly)).toHaveLength(0);
  });
});
