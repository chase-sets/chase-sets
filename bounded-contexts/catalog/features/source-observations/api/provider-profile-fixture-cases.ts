import { catalogProviderRequiredFixtureFlows } from "./provider-integration-mapping-contract";
import type { CatalogProviderProfileFixtureCase } from "./provider-profile-contract-harness";

export function catalogProviderProfileFixtureCases(): readonly CatalogProviderProfileFixtureCase[] {
  return [
    ...providerCases("scrydex", {
      normal: {
        expectedObservation: {
          externalKey: "scryfall:0000579f-7b35-4ed3-b44c-db2a538066fe",
          normalizedKind: "provider-product",
          normalizedFields: {
            name: "Fury Sliver",
            productLineName: "Magic: The Gathering",
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
          externalKey: "scryfall:sealed-fixture-0001",
          normalizedKind: "provider-product",
          normalizedFields: {
            name: "Time Spiral Booster Pack",
          },
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:96601" }],
        },
      },
      "unknown-option": {
        expectedObservation: {
          externalKey: "scryfall:unknown-option-fixture-0001",
          normalizedKind: "provider-product",
          normalizedFields: {
            cardNumber: "001-star",
          },
        },
      },
    }),
    ...providerCases("tcgdex", {
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
    }),
    ...providerCases("tcgplayer", {
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
    }),
  ];
}

function providerCases(
  providerKey: string,
  expectations: Partial<Record<string, Partial<CatalogProviderProfileFixtureCase>>>,
): readonly CatalogProviderProfileFixtureCase[] {
  return catalogProviderRequiredFixtureFlows.map((flow) => ({
    providerKey,
    profileVersion: "2026.06.03",
    flow,
    payloadFile: `${flow}.json`,
    expectedStatus: "completed",
    expectedObservation: { normalizedKind: providerKey === "tcgdex" ? "pokemon-card" : "provider-product" },
    ...expectations[flow],
  }));
}
