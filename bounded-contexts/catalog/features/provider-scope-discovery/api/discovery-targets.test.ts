import { describe, expect, it } from "vitest";
import { catalogProviderIntegrationProfileVersions } from "../../source-observations/api/provider-integration-profiles";
import { listProviderScopeDiscoveryTargets, type ProviderScopeDiscoveryTarget } from "./discovery-targets";
import { classifyProviderScopeDiscoveryTarget } from "./scope-observation-matcher";

const TCGDEX_UNIT = "tcgdex:pokemon:single-card:source-observation-import";

describe("provider scope discovery targets", () => {
  const targets = listProviderScopeDiscoveryTargets(
    catalogProviderIntegrationProfileVersions,
    classifyProviderScopeDiscoveryTarget,
  );

  it("discovers the TCGdex Pokemon unit in English and Japanese", () => {
    const tcgdexTargets = targets.filter((target) => target.providerKey === "tcgdex");

    expect(tcgdexTargets.map(targetKey)).toEqual([
      `tcgdex:${TCGDEX_UNIT}:languages:en`,
      `tcgdex:${TCGDEX_UNIT}:languages:ja`,
      `tcgdex:${TCGDEX_UNIT}:series:en`,
      `tcgdex:${TCGDEX_UNIT}:series:ja`,
      `tcgdex:${TCGDEX_UNIT}:expansions:en`,
      `tcgdex:${TCGDEX_UNIT}:expansions:ja`,
    ]);
    expect(tcgdexTargets.every((target) => target.productDomain === "pokemon")).toBe(true);
  });

  it("keeps every other unit's English targets and keys", () => {
    expect(targets.filter((target) => target.providerKey !== "tcgdex").map(targetKey)).toEqual([
      "mtgjson:mtgjson:mtg:single-card:reference-data:sets:en",
      "mtgjson:mtgjson:mtg:set:reference-data:sets:en",
      "lorcanajson:lorcanajson:lorcana:single-card:reference-data:sets:en",
      "lorcanajson:lorcanajson:lorcana:set:reference-data:sets:en",
      "lorcast:lorcast:lorcana:single-card:reference-data:sets:en",
      "lorcast:lorcast:lorcana:set:reference-data:sets:en",
      "scryfall:scryfall:mtg:single-card:reference-data:sets:en",
      "scrydex:scrydex:one-piece:single-card:source-observation-import:sets:en",
      "scrydex:scrydex:one-piece:set:reference-data:sets:en",
      "scrydex:scrydex:one-piece:sealed-product:source-observation-import:sets:en",
      "scrydex:scrydex:lorcana:single-card:source-observation-import:sets:en",
      "scrydex:scrydex:lorcana:set:reference-data:sets:en",
      "ygoprodeck:ygoprodeck:yugioh:single-card:reference-data:sets:en",
      "ygojson:ygojson:yugioh:set:reference-data:sets:en",
    ]);
  });

  it("discovers a declared language only where the unit's profile offers it", () => {
    const tcgdex = catalogProviderIntegrationProfileVersions.find(
      (version) => version.providerKey === "tcgdex" && version.active && version.lifecycle === "active",
    )!;
    const languagesFor = (languageOptions: readonly string[]) =>
      new Set(
        listProviderScopeDiscoveryTargets(
          [{ ...tcgdex, profile: { ...tcgdex.profile, languageOptions } }],
          classifyProviderScopeDiscoveryTarget,
        ).map((target) => target.languageCode),
      );

    expect(languagesFor(["en", "fr", "ko"])).toEqual(new Set(["en"]));
    expect(languagesFor([])).toEqual(new Set(["en"]));
    expect(languagesFor(["ja"])).toEqual(new Set(["en", "ja"]));
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

  it("emits each provider-unit query kind exactly once per language across competing profiles", () => {
    const keys = targets.map(targetKey);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("skips inactive and non-active-lifecycle profile versions", () => {
    const inactiveOnly = catalogProviderIntegrationProfileVersions.map((version) => ({
      ...version,
      active: false,
    }));

    expect(listProviderScopeDiscoveryTargets(inactiveOnly, classifyProviderScopeDiscoveryTarget)).toHaveLength(0);
  });

  it("can inventory historical discovery units without making them refresh targets", () => {
    const historical = catalogProviderIntegrationProfileVersions
      .filter((version) => version.active && version.lifecycle === "active")
      .map((version) => ({ ...version, active: false }));
    expect(
      listProviderScopeDiscoveryTargets(historical, classifyProviderScopeDiscoveryTarget, { includeInactive: true }),
    ).toEqual(targets);
  });
});

function targetKey(target: ProviderScopeDiscoveryTarget): string {
  return `${target.providerKey}:${target.ingestionUnitKey}:${target.queryKind}:${target.languageCode}`;
}
