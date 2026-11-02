import { describe, expect, it } from "vitest";
import { catalogProviderIntegrationProfileVersions } from "../../source-observations/api/provider-integration-profiles";
import { listProviderScopeDiscoveryTargets } from "./discovery-targets";
import { classifyProviderScopeDiscoveryTarget } from "./scope-observation-matcher";

describe("provider scope discovery targets", () => {
  const targets = listProviderScopeDiscoveryTargets(
    catalogProviderIntegrationProfileVersions,
    classifyProviderScopeDiscoveryTarget,
  );

  it("derives scope-level option queries from active provider profiles", () => {
    const tcgdexTargets = targets.filter((target) => target.providerKey === "tcgdex");

    expect(tcgdexTargets.map((target) => target.queryKind).sort()).toEqual(["expansions", "languages", "series"]);
    expect(tcgdexTargets.every((target) => target.productDomain === "pokemon")).toBe(true);
  });

  it("does not emit TCGplayer runtime option queries after server-side transport retirement", () => {
    const activeVersions = catalogProviderIntegrationProfileVersions.filter(
      (version) => version.providerKey === "tcgplayer" && version.active && version.lifecycle === "active",
    );
    const tcgplayerTargets = targets.filter((target) => target.providerKey === "tcgplayer");
    const setNameTargets = tcgplayerTargets.filter((target) => target.queryKind === "set-names");

    expect(activeVersions).toHaveLength(9);
    expect(setNameTargets).toHaveLength(0);
    expect(tcgplayerTargets).toHaveLength(0);
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

    expect(listProviderScopeDiscoveryTargets(inactiveOnly, classifyProviderScopeDiscoveryTarget)).toHaveLength(0);
  });
});
