import { catalogProviderRequiredFixtureFlows } from "./provider-integration-mapping-contract";
import type { CatalogProviderProfileFixtureCase } from "./provider-profile-contract-harness";

export function catalogProviderProfileFixtureCases(): readonly CatalogProviderProfileFixtureCase[] {
  return [
    ...providerCases(
      "mtgjson",
      {
        profileKey: "mtg-card-reference-data",
        ingestionUnitKey: "mtgjson:mtg:single-card:reference-data",
        profileVersion: "2026.06.19",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "card:13fd9d47-9aa7-5f7c-8f47-fury-sliver",
            normalizedKind: "magic-card-print",
            normalizedFields: {
              name: "Fury Sliver",
              setCode: "TSP",
              setName: "Time Spiral",
            },
            externalCatalogItemReferences: [
              { providerKey: "scryfall", externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe" },
            ],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "card:mtgjson-tsp-booster-pack-reference",
            normalizedKind: "magic-card-print",
            normalizedFields: {
              name: "Time Spiral Booster Pack",
              setCode: "TSP",
            },
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "card:mtgjson-tsp-unknown-option-reference",
            normalizedKind: "magic-card-print",
            normalizedFields: {
              cardNumber: "001-star",
              rarity: "mythic-unclassified",
            },
          },
        },
      },
    ),
    ...providerCases(
      "mtgjson",
      {
        profileKey: "mtg-set-reference-data",
        ingestionUnitKey: "mtgjson:mtg:set:reference-data",
        profileVersion: "2026.06.19",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "set:TSP",
            normalizedKind: "magic-set-reference",
            normalizedFields: {
              name: "Time Spiral",
              setCode: "TSP",
              setName: "Time Spiral",
              productLineName: "Magic: The Gathering",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
          ],
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "set:TSPX",
            normalizedKind: "magic-set-reference",
            normalizedFields: {
              name: "Time Spiral Unknown Option",
              setCode: "TSPX",
            },
          },
        },
      },
    ),
    ...providerCases(
      "scryfall",
      {
        profileKey: "mtg-card-print-reference-data",
        ingestionUnitKey: "scryfall:mtg:single-card:reference-data",
        profileVersion: "2026.06.19",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe",
            normalizedKind: "magic-card-print",
            normalizedFields: {
              name: "Fury Sliver",
              setCode: "tsp",
              setName: "Time Spiral",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "card:sealed-fixture-0001",
            normalizedKind: "magic-card-print",
            normalizedFields: {
              name: "Time Spiral Booster Pack",
              setCode: "tsp",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:96601" }],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "card:unknown-option-fixture-0001",
            normalizedKind: "magic-card-print",
            normalizedFields: {
              cardNumber: "001-star",
            },
          },
        },
      },
    ),
    ...providerCases(
      "scryfall",
      {
        profileKey: "mtg-card-image-evidence",
        ingestionUnitKey: "scryfall:mtg:single-card:image-evidence",
        profileVersion: "2026.06.19",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "image:0000579f-7b35-4ed3-b44c-db2a538066fe",
            normalizedKind: "magic-card-print",
            normalizedFields: {
              name: "Fury Sliver",
              setCode: "tsp",
              setName: "Time Spiral",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "image:sealed-fixture-0001",
            normalizedKind: "magic-card-print",
            normalizedFields: {
              name: "Time Spiral Booster Pack",
              setCode: "tsp",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:96601" }],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "image:unknown-option-fixture-0001",
            normalizedKind: "magic-card-print",
            normalizedFields: {
              cardNumber: "001-star",
            },
          },
        },
      },
    ),
    ...providerCases(
      "tcgdex",
      {},
      {
        normal: {
          expectedObservation: {
            externalKey: "en:sv01-001",
            normalizedKind: "pokemon-card",
            normalizedFields: {
              name: "Sprigatito",
              cardNumber: "001",
              cardVariantKey: "standard",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:493958" }],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
          ],
          expectedPromotionCommands: [
            "CreateCatalogItem",
            "AssignBlueprintToCatalogItem",
            "SetCatalogItemFieldValue",
            "AssignCatalogItemToCategory",
            "LinkExternalCatalogItemReference",
          ],
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "en:sv01-etb-sealed",
            normalizedKind: "pokemon-card",
            normalizedFields: {
              category: "Sealed",
              cardVariantKey: "sealed",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:497105" }],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "en:sv01-001-unknown-option",
            normalizedKind: "pokemon-card",
            normalizedFields: {
              cardVariantKey: "provider-new-foil",
            },
          },
        },
      },
    ),
    ...providerCases(
      "tcgplayer",
      {
        profileKey: "mtg-single-card-product-sku",
        ingestionUnitKey: "tcgplayer:mtg:single-card:source-observation-import",
        profileVersion: "2026.06.19",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "14240",
            normalizedKind: "provider-product",
            normalizedFields: {
              name: "Fury Sliver",
              productForm: "single",
              productLineName: "Magic",
              tcg: "magic",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:50014240",
                selectedOptions: [
                  { dimensionKey: "condition", optionKey: "near-mint", providerValue: "Near Mint" },
                  { dimensionKey: "printing", optionKey: "normal", providerValue: "Normal" },
                  { dimensionKey: "language", optionKey: "english", providerValue: "English" },
                ],
              },
            ],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "96601",
            normalizedKind: "provider-product",
            normalizedFields: {
              productForm: "sealed",
              name: "Time Spiral Booster Pack",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:96601" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:50096601",
                selectedOptions: [{ dimensionKey: "product-form", optionKey: "unopened", providerValue: "Sealed" }],
              },
            ],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "14240-unknown-option",
            normalizedKind: "provider-product",
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:50014242",
                selectedOptions: [{ dimensionKey: "printing", optionKey: null, providerValue: "Surge Foil" }],
              },
            ],
          },
        },
      },
    ),
    ...providerCases(
      "tcgplayer",
      {
        profileKey: "pokemon-tcg-automation-client",
        ingestionUnitKey: "tcgplayer:pokemon:single-card:source-observation-import",
        profileVersion: "2026.06.03",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "493958",
            normalizedKind: "provider-product",
            normalizedFields: {
              name: "Sprigatito",
              productForm: "single",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:493958" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:15500001",
                selectedOptions: [
                  { dimensionKey: "condition", optionKey: "near-mint", providerValue: "Near Mint" },
                  { dimensionKey: "printing", optionKey: "normal", providerValue: "Normal" },
                  { dimensionKey: "language", optionKey: "en", providerValue: "English" },
                ],
              },
            ],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "497105",
            normalizedKind: "provider-product",
            normalizedFields: {
              productForm: "sealed",
              name: "Scarlet & Violet Elite Trainer Box",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:497105" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:15501001",
                selectedOptions: [{ dimensionKey: "product-form", optionKey: "sealed", providerValue: "Sealed" }],
              },
            ],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "493958-unknown-option",
            normalizedKind: "provider-product",
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:15500003",
                selectedOptions: [{ dimensionKey: "printing", optionKey: null, providerValue: "Confetti Galaxy Foil" }],
              },
            ],
          },
        },
      },
    ),
  ];
}

function providerCases(
  providerKey: string,
  identity: Readonly<{
    profileKey?: string;
    ingestionUnitKey?: string;
    profileVersion?: string;
  }>,
  expectations: Partial<Record<string, Partial<CatalogProviderProfileFixtureCase>>>,
): readonly CatalogProviderProfileFixtureCase[] {
  return catalogProviderRequiredFixtureFlows.map((flow) => ({
    providerKey,
    profileKey: identity.profileKey,
    ingestionUnitKey: identity.ingestionUnitKey,
    profileVersion: identity.profileVersion ?? "2026.06.03",
    flow,
    payloadFile: `${flow}.json`,
    expectedStatus: "completed",
    expectedObservation: {
      normalizedKind:
        providerKey === "tcgdex"
          ? "pokemon-card"
          : identity.ingestionUnitKey === "mtgjson:mtg:set:reference-data"
            ? "magic-set-reference"
            : providerKey === "mtgjson"
              ? "magic-card-print"
              : providerKey === "scryfall"
                ? "magic-card-print"
                : "provider-product",
    },
    ...expectations[flow],
  }));
}
