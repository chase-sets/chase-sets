import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";

import {
  ygoprodeckCentralTypeAdditions,
  ygoprodeckYugiohCardReferenceProviderProfile,
  ygoprodeckYugiohCardReferenceSourceObservationMappingContract,
  ygoprodeckYugiohSetReferenceProviderProfile,
  ygoprodeckYugiohSetReferenceSourceObservationMappingContract,
} from "../../ygoprodeck-executable-mapping-contract";

describe("YGOPRODeck executable mapping contract", () => {
  it("exports Yu-Gi-Oh card and set contract identities for the generic importer surface", () => {
    expect(ygoprodeckYugiohCardReferenceSourceObservationMappingContract).toMatchObject({
      providerKey: "ygoprodeck",
      profileKey: "yugioh-card-print-reference-data",
      profileVersion: "2026.10.18",
      ingestionUnitIdentity: {
        unitKey: "ygoprodeck:yugioh:single-card:reference-data",
        productDomain: "yugioh",
        productForm: "single-card",
        ingestionPurpose: "reference-data",
      },
      normalizedObservation: {
        outputKind: "yugioh-card-print",
      },
      fixtures: {
        fixtureRoot:
          "bounded-contexts/catalog/features/source-observations/api/__fixtures__/ygoprodeck-yugioh-card-print",
        liveProviderCallsAllowed: false,
      },
    });
    expect(ygoprodeckYugiohSetReferenceSourceObservationMappingContract).toMatchObject({
      providerKey: "ygoprodeck",
      profileKey: "yugioh-set-reference-data",
      ingestionUnitIdentity: {
        unitKey: "ygoprodeck:yugioh:set:reference-data",
        productDomain: "yugioh",
        productForm: "set",
        ingestionPurpose: "reference-data",
      },
      normalizedObservation: {
        outputKind: "yugioh-set-reference",
      },
    });
  });

  it("declares profile-driven set and card option queries without image hotlink outputs", () => {
    expect(ygoprodeckYugiohCardReferenceProviderProfile).toMatchObject({
      providerKey: "ygoprodeck",
      capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
      supportedScopes: ["set-name", "product/card"],
      optionQueries: [
        expect.objectContaining({ queryKind: "sets", operation: "ygoprodeck-list-sets" }),
        expect.objectContaining({ queryKind: "cards", operation: "ygoprodeck-list-cards" }),
      ],
      connector: {
        kind: "ygoprodeck-json",
        throttling: {
          providerLimit: "20-requests-per-second",
          cacheProviderDataLocally: true,
          cacheImagesLocally: true,
        },
        excludedEvidence: ["price", "seller", "inventory", "image-hotlink"],
      },
    });
    expect(ygoprodeckYugiohCardReferenceProviderProfile.optionQueries[1]?.output).not.toHaveProperty("imageUrlPath");
    expect(ygoprodeckYugiohSetReferenceProviderProfile).toMatchObject({
      providerKey: "ygoprodeck",
      displayName: "YGOPRODeck Set Reference",
      capabilities: ["source-observation-import", "reference-data-promotion"],
      normalizedObservationMapping: { kind: "yugioh-set-reference" },
      optionQueries: [],
    });
  });

  it("keeps price fields and provider image URLs out of normalized facts and hash material", () => {
    const mappedCatalogMaterial = JSON.stringify([
      ygoprodeckYugiohCardReferenceSourceObservationMappingContract.normalizedObservation,
      ygoprodeckYugiohSetReferenceSourceObservationMappingContract.normalizedObservation,
    ]);

    expect(mappedCatalogMaterial).not.toMatch(/card_prices|set_price|tcgplayer_price|cardmarket_price/i);
    expect(mappedCatalogMaterial).not.toMatch(/image_url|image_url_small|image_url_cropped/i);
    expect(mappedCatalogMaterial).toMatch(/imageEvidenceCount/);
  });

  it("resolves every Yu-Gi-Oh product-line rule to the seeded canonical record", () => {
    for (const profile of [ygoprodeckYugiohCardReferenceProviderProfile, ygoprodeckYugiohSetReferenceProviderProfile]) {
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

  it("documents the exact central type additions needed before active registry/profile wiring", () => {
    expect(ygoprodeckCentralTypeAdditions).toEqual({
      productDomain: "Add 'yugioh' to CatalogProviderIngestionUnitProductDomain.",
      normalizedObservation:
        "Add 'yugioh-card-print' and 'yugioh-set-reference' to CatalogProviderNormalizedObservationContract.outputKind and CatalogProviderIntegrationProfile.normalizedObservationMapping.kind.",
      optionQueryOperation:
        "Add 'ygoprodeck-list-sets' and 'ygoprodeck-list-cards' to CatalogProviderOptionQueryOperation and route them through ProviderAdapter.listOptions transports.",
      duplicatePrevention:
        "Add a Yu-Gi-Oh deterministic duplicate-prevention rule or reuse a generic collectible-card field-match rule before promotion activation.",
    });
  });
});
