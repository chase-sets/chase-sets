import { describe, expect, it } from "vitest";
import { blueprintSeedRequirements } from "../../../blueprints/api/seed";
import { categorySeedRequirements } from "../../../categories/api/seed";
import { fieldSeedRequirements } from "../../../fields/api/seed";
import {
  catalogProviderIntegrationProfileVersions,
  scrydexOnePieceSealedProductProviderProfile,
  type CatalogProviderIntegrationProfile,
} from "../provider-integration-profiles";
import { scrydexOnePieceSealedProductSourceObservationMappingContract } from "../scrydex-one-piece-executable-mapping-contract";
import { catalogProviderSourceMappingFingerprint } from "../promotion/provider-source-observation-normalizer";

const blueprintKeys = new Set(blueprintSeedRequirements.map(({ key }) => key));
const categoryKeys = new Set(categorySeedRequirements.map(({ key }) => key));
const fieldKeys = new Set(fieldSeedRequirements.map(({ key }) => key));

function missingCatalogKeys(profile: CatalogProviderIntegrationProfile): readonly string[] {
  const mapping = profile.catalogFieldMapping;
  return [
    ...(categoryKeys.has(mapping.categoryKey) ? [] : [`${profile.displayName}: category ${mapping.categoryKey}`]),
    ...Object.values(mapping.fieldKeys)
      .filter((key) => !fieldKeys.has(key))
      .map((key) => `${profile.displayName}: field ${key}`),
  ];
}

describe("provider profile Catalog seed-key coverage", () => {
  for (const version of catalogProviderIntegrationProfileVersions) {
    const { profile } = version;
    const name = `${profile.displayName} / ${version.profileKey} / ${version.profileVersion}`;
    if (!blueprintKeys.has(profile.catalogFieldMapping.blueprintKey)) {
      it(`${name}: not promotable through seeded blueprint ${profile.catalogFieldMapping.blueprintKey}`, () => {
        console.info(`${name}: unseeded blueprint ${profile.catalogFieldMapping.blueprintKey}`);
        expect(blueprintKeys.has(profile.catalogFieldMapping.blueprintKey)).toBe(false);
      });
      continue;
    }
    it(`${name}: every mapped category and field key is seeded`, () => {
      expect(missingCatalogKeys(profile)).toEqual([]);
    });
  }

  it("names the pre-fix One Piece sealed missing key", () => {
    const profile = scrydexOnePieceSealedProductProviderProfile;
    expect(
      missingCatalogKeys({
        ...profile,
        catalogFieldMapping: {
          ...profile.catalogFieldMapping,
          fieldKeys: { ...profile.catalogFieldMapping.fieldKeys, cardNumber: "sealed-product-id" },
        },
      }),
    ).toEqual(["Scrydex One Piece Sealed Products: field sealed-product-id"]);
  });

  it("retains the One Piece sealed source mapping fingerprint and version", () => {
    const contract = scrydexOnePieceSealedProductSourceObservationMappingContract;
    expect(contract.profileVersion).toBe("2026.06.22");
    expect(catalogProviderSourceMappingFingerprint(contract)).toBe(
      "7f379be12f1acd3930ee3a8e11a2501f013d53253bfea0d20d6a9ae955c6a715",
    );
  });
});
