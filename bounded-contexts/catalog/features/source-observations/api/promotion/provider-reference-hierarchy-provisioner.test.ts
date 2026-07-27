import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import {
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
} from "../provider-integration-profiles";
import {
  provisionCatalogProviderReferenceHierarchy,
  type CatalogProviderReferenceRecordProvision,
  type CatalogProviderReferenceTypeProvision,
} from "./provider-reference-hierarchy-provisioner";

describe("provisionCatalogProviderReferenceHierarchy", () => {
  it("provisions the TCGdex Pokemon hierarchy from profile rules with existing deterministic ids", async () => {
    const harness = createProvisioningHarness();

    const result = await provisionCatalogProviderReferenceHierarchy({
      profile: tcgdexPokemonTcgProviderProfile,
      payload: tcgdexPayload(),
      provisioner: harness.provisioner,
    });

    expect(result.targetReferenceRecordId).toBe("ref_tcgdex_expansion_swsh3");
    expect(harness.referenceTypes.map((type) => [type.referenceTypeId, type.key])).toEqual([
      [catalogSeedIds.referenceTypes.manufacturer, "manufacturer"],
      [catalogSeedIds.referenceTypes.productLine, "product-line"],
      [catalogSeedIds.referenceTypes.series, "series"],
      [catalogSeedIds.referenceTypes.expansion, "expansion"],
    ]);
    expect(harness.referenceRecords).toEqual([
      expect.objectContaining({
        referenceRecordId: catalogSeedIds.referenceRecords.manufacturers.thePokemonCompanyInternational,
        typeKey: "manufacturer",
        key: "the-pokemon-company-international",
      }),
      expect.objectContaining({
        referenceRecordId: catalogSeedIds.referenceRecords.productLines.pokemonTradingCardGame,
        typeKey: "product-line",
        key: "pokemon-trading-card-game",
      }),
      expect.objectContaining({
        referenceRecordId: "ref_tcgdex_series_swsh",
        typeKey: "series",
        key: "swsh",
        attributes: { "tcgdex-series-id": "swsh" },
      }),
      expect.objectContaining({
        referenceRecordId: "ref_tcgdex_expansion_swsh3",
        typeKey: "expansion",
        key: "swsh3",
        attributes: {
          "tcgdex-set-id": "swsh3",
          "release-date": "2020-08-14",
          abbreviation: "DAA",
          "card-count": 189,
          "parallel-set-card-count": 155,
        },
      }),
    ]);
    expect(harness.referenceRecords[3]?.relationships).toEqual([
      { relationshipType: "part-of", referenceId: "ref_tcgdex_series_swsh" },
    ]);
  });

  it("falls back to the Pokemon product line when TCGdex series evidence is absent", async () => {
    const harness = createProvisioningHarness();

    const result = await provisionCatalogProviderReferenceHierarchy({
      profile: tcgdexPokemonTcgProviderProfile,
      payload: {
        ...tcgdexPayload(),
        seriesId: null,
        seriesName: null,
      },
      provisioner: harness.provisioner,
    });

    expect(result.targetReferenceRecordId).toBe("ref_tcgdex_expansion_swsh3");
    expect(harness.referenceRecords.map((record) => record.ruleKey)).not.toContain("series");
    expect(harness.referenceRecords.at(-1)?.relationships).toEqual([
      {
        relationshipType: "part-of",
        referenceId: catalogSeedIds.referenceRecords.productLines.pokemonTradingCardGame,
      },
    ]);
  });

  it("uses provider ids for reference keys when TCGdex names are localized", async () => {
    const harness = createProvisioningHarness();

    const result = await provisionCatalogProviderReferenceHierarchy({
      profile: tcgdexPokemonTcgProviderProfile,
      payload: {
        ...tcgdexPayload(),
        expansionId: "SV8",
        expansionName: "超電ブレイカー",
        seriesId: "SV",
        seriesName: null,
      },
      provisioner: harness.provisioner,
    });

    expect(result.targetReferenceRecordId).toBe("ref_tcgdex_expansion_sv8");
    expect(harness.referenceRecords.map((record) => record.ruleKey)).not.toContain("series");
    expect(harness.referenceRecords.at(-1)).toMatchObject({
      referenceRecordId: "ref_tcgdex_expansion_sv8",
      typeKey: "expansion",
      key: "sv8",
      name: "超電ブレイカー",
      attributes: { "tcgdex-set-id": "SV8" },
      relationships: [
        {
          relationshipType: "part-of",
          referenceId: catalogSeedIds.referenceRecords.productLines.pokemonTradingCardGame,
        },
      ],
    });
  });

  it("represents TCGplayer product-line and set-name evidence through profile rules", async () => {
    const harness = createProvisioningHarness();

    const result = await provisionCatalogProviderReferenceHierarchy({
      profile: tcgplayerAutomationClientProviderProfile,
      payload: {
        productLineId: 3,
        productLineName: "Pokemon",
        setNameId: 7001,
        setName: "Prismatic Evolutions",
      },
      provisioner: harness.provisioner,
    });

    expect(result.targetReferenceRecordId).toBe("ref_tcgplayer_expansion_7001");
    expect(harness.referenceRecords).toEqual([
      expect.objectContaining({ ruleKey: "manufacturer" }),
      expect.objectContaining({
        ruleKey: "product-line",
        referenceRecordId: "ref_tcgplayer_product-line_3",
        attributes: {
          "official-name": "Pokemon",
          "tcgplayer-product-line-id": 3,
        },
      }),
      expect.objectContaining({
        ruleKey: "set-name",
        referenceRecordId: "ref_tcgplayer_expansion_7001",
        attributes: {
          "tcgplayer-set-name": "Prismatic Evolutions",
          "tcgplayer-set-id": 7001,
        },
        relationships: [{ relationshipType: "part-of", referenceId: "ref_tcgplayer_product-line_3" }],
      }),
    ]);
  });
});

function createProvisioningHarness() {
  const referenceTypes: CatalogProviderReferenceTypeProvision[] = [];
  const referenceRecords: Array<CatalogProviderReferenceRecordProvision & { ruleKey?: string }> = [];

  return {
    referenceTypes,
    referenceRecords,
    provisioner: {
      ensureReferenceType: async (def: CatalogProviderReferenceTypeProvision) => {
        referenceTypes.push(def);
      },
      ensureReferenceRecord: async (def: CatalogProviderReferenceRecordProvision) => {
        const profile = def.referenceRecordId.includes("tcgplayer") ? tcgplayerAutomationClientProviderProfile : null;
        const ruleKey =
          profile?.referenceHierarchyMapping.referenceRecords.find(
            (rule) =>
              rule.recordId.kind === "provider" &&
              `${profile.referenceHierarchyMapping.providerReferenceIdPrefix}_${rule.recordId.typeKey}_` &&
              def.referenceRecordId.startsWith(
                `${profile.referenceHierarchyMapping.providerReferenceIdPrefix}_${rule.recordId.typeKey}_`,
              ),
          )?.ruleKey ??
          tcgdexPokemonTcgProviderProfile.referenceHierarchyMapping.referenceRecords.find((rule) => {
            if (rule.recordId.kind === "static") {
              return rule.recordId.referenceRecordId === def.referenceRecordId;
            }
            return def.referenceRecordId.startsWith(
              `${tcgdexPokemonTcgProviderProfile.referenceHierarchyMapping.providerReferenceIdPrefix}_${rule.recordId.typeKey}_`,
            );
          })?.ruleKey;
        referenceRecords.push({ ...def, ruleKey });
        return def.referenceRecordId;
      },
    },
  };
}

function tcgdexPayload() {
  return {
    expansionId: "swsh3",
    expansionName: "Darkness Ablaze",
    expansionAbbreviation: "DAA",
    expansionCardCount: 189,
    expansionParallelSetCardCount: 155,
    releaseDate: "2020-08-14",
    seriesId: "swsh",
    seriesName: "Sword & Shield",
  };
}
