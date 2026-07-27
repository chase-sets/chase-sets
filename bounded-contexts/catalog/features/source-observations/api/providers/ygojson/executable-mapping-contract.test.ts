import { describe, expect, it } from "vitest";

import {
  validateCatalogProviderExecutableMappingContract,
  type CatalogProviderExecutableMappingContract,
} from "../provider-integration-mapping-contract";
import {
  ygojsonYugiohMappingContractCentralTypeAdditions,
  ygojsonYugiohProviderGovernance,
  ygojsonYugiohReferenceDataMappingContracts,
  ygojsonYugiohSealedProductReferenceSourceObservationMappingContract,
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
    expect(ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.profileVersion).toBe("2026.07.14");
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
});
