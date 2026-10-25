import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { requireCatalogProviderSourceObservation } from "../../promotion/provider-source-observation-normalizer";
import { catalogSeedIds } from "@chase-sets/catalog-seed";

import {
  validateCatalogProviderExecutableMappingContract,
  type CatalogProviderExecutableMappingContract,
} from "../provider-integration-mapping-contract";
import {
  ygojsonYugiohMappingContractCentralTypeAdditions,
  ygojsonYugiohProviderGovernance,
  ygojsonYugiohReferenceDataMappingContracts,
  ygojsonYugiohSealedProductReferenceProviderProfile,
  ygojsonYugiohSealedProductReferenceSourceObservationMappingContract,
  ygojsonYugiohSetReferenceProviderProfile,
  ygojsonYugiohSetReferenceSourceObservationMappingContract,
} from "../../ygojson-executable-mapping-contract";

describe("YGOJSON executable mapping contracts", () => {
  it("exports Yu-Gi-Oh set and sealed-product reference profiles with central type additions isolated", () => {
    expect(ygojsonYugiohMappingContractCentralTypeAdditions).toEqual({
      productDomain: "yugioh",
      normalizedOutputKinds: ["yugioh-set-reference", "yugioh-sealed-product"],
    });
    expect(
      ygojsonYugiohReferenceDataMappingContracts.map((contract) => contract.ingestionUnitIdentity.unitKey),
    ).toEqual(["ygojson:yugioh:set:reference-data", "ygojson:yugioh:sealed-product:reference-data"]);
    expect(ygojsonYugiohSetReferenceSourceObservationMappingContract.normalizedObservation.outputKind).toBe(
      "yugioh-set-reference",
    );
    expect(ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.normalizedObservation.outputKind).toBe(
      "yugioh-sealed-product",
    );
    expect(
      ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.normalizedObservation.fields
        .productContentsEvidence,
    ).toMatchObject({
      selector: {
        kind: "path",
        path: "sealedProduct.contents",
        required: false,
        nullPolicy: "omit",
      },
      owner: "catalog-merge-evidence",
      uses: expect.arrayContaining(["normalized-observation", "hash-material"]),
      redaction: "none",
    });
    expect(ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.profileVersion).toBe("2026.10.18");
    expect(ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.promotionCommandPlan.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commandName: "CreateCatalogItem" }),
        expect.objectContaining({ commandName: "SetCatalogItemImageUrls" }),
        expect.objectContaining({ commandName: "LinkExternalCatalogItemReference" }),
        expect.objectContaining({ commandName: "LinkExternalProductReference" }),
      ]),
    );
  });

  it("keeps provider governance and price/vendor exclusions explicit", () => {
    expect(ygojsonYugiohProviderGovernance).toMatchObject({
      sourceRepository: "iconmaster5326/YGOJSON",
      sourceLicense: "MIT",
      upstreamSources: expect.arrayContaining(["YAML Yugi", "Yugipedia"]),
    });
    expect(ygojsonYugiohProviderGovernance.yamlYugiBoundary).toContain("must not copy YAML Yugi AGPL pipeline code");
    expect(JSON.stringify(ygojsonYugiohReferenceDataMappingContracts)).not.toMatch(/price|vendor|marketplace/i);
    for (const contract of ygojsonYugiohReferenceDataMappingContracts) {
      expect(contract.nonGoals).toContain("no-pricing-facts-as-catalog-truth");
    }
    expect(ygojsonYugiohSetReferenceSourceObservationMappingContract.promotionCommandPlan.commands).toEqual([]);
  });

  it("passes current executable mapping validation when cast through the pending central unions", () => {
    for (const contract of ygojsonYugiohReferenceDataMappingContracts) {
      expect(
        validateCatalogProviderExecutableMappingContract(
          contract as unknown as CatalogProviderExecutableMappingContract,
        ),
      ).toEqual([]);
    }
  });

  it("maps the Beginner's Edition 2 fixture to its canonical UUID setId", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../__fixtures__/ygojson-yugioh-set-reference-data/beginners-edition-2.json", import.meta.url),
        "utf8",
      ),
    );
    const observation = requireCatalogProviderSourceObservation({
      contract: ygojsonYugiohSetReferenceSourceObservationMappingContract,
      payload: fixture,
      observedAt: "2026-10-25T00:00:00.000Z",
    });
    expect(observation.normalized).toMatchObject({
      kind: "yugioh-set-reference",
      setId: fixture.set.id,
      ygojsonId: fixture.set.id,
      setName: fixture.set.name.en,
      name: fixture.set.name.en,
      tcg: "yugioh",
      productLineName: "Yu-Gi-Oh!",
      localeEvidence: fixture.set.locales,
      cardPrintEvidence: fixture.set.contents,
    });
    expect(observation.sourceProfileVersion).toBe("2026.10.25");
    expect(observation.sourceMappingFingerprint).not.toBe(
      "754b8ff5de8b49a882706563262ecd2dd222c12ca6d68449b2ea5356332a1f9f",
    );
  });

  it("resolves every Yu-Gi-Oh product-line rule to the seeded canonical record", () => {
    for (const profile of [
      ygojsonYugiohSetReferenceProviderProfile,
      ygojsonYugiohSealedProductReferenceProviderProfile,
    ]) {
      const productLineRule = profile.referenceHierarchyMapping.referenceRecords.find(
        (rule) => rule.ruleKey === "yugioh-product-line",
      );
      expect(productLineRule).toMatchObject({
        typeKey: "product-line",
        recordId: {
          kind: "static",
          referenceRecordId: catalogSeedIds.referenceRecords.productLines.yuGiOhOfficialCardGame,
        },
        key: { kind: "static", value: "yu-gi-oh-official-card-game" },
      });
      expect(productLineRule?.recordId.kind).not.toBe("provider");
      expect(productLineRule?.key).not.toMatchObject({ value: "yu-gi-oh" });
    }
  });
});
