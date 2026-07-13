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
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: [
            "normalizedObservation.fields.name.selector.path",
            "normalizedObservation.fields.mergeIdentity.selector.fields.printedProductName.selector.path",
            "normalizedObservation.hashMaterial.0.selector.fields.name.selector.path",
            "normalizedObservation.fields.name",
          ],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "card:13fd9d47-9aa7-5f7c-8f47-fury-sliver",
            normalizedKind: "magic-card-print",
            normalizedFields: {
              name: "Fury Sliver",
              setCode: "tsp",
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
          expectedDuplicatePrevention: mtgjsonBridgeDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: mtgjsonBridgeDuplicatePrevention(),
        },
        replay: {
          expectedDuplicatePrevention: mtgjsonBridgeDuplicatePrevention(),
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "card:mtgjson-tsp-booster-pack-reference",
            normalizedKind: "magic-card-print",
            normalizedFields: {
              name: "Time Spiral Booster Pack",
              setCode: "tsp",
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
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: [
            "normalizedObservation.fields.name.selector.path",
            "normalizedObservation.fields.setName.selector.path",
            "normalizedObservation.hashMaterial.0.selector.fields.name.selector.path",
            "normalizedObservation.fields.name",
            "normalizedObservation.fields.setName",
          ],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "set:TSP",
            normalizedKind: "magic-set-reference",
            normalizedFields: {
              name: "Time Spiral",
              setCode: "tsp",
              setName: "Time Spiral",
              productLineName: "Magic: The Gathering",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
          ],
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: {
            ambiguousCandidatePolicy: "block-promotion",
            replayPolicy: "same-profile-version",
            exactExternalCatalogItemReferencesFirst: false,
            rulePolicies: [{ ruleKey: "source-observation-link", candidatePolicy: "review-only" }],
          },
        },
        ambiguous: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: {
            ambiguousCandidatePolicy: "block-promotion",
            replayPolicy: "same-profile-version",
            rulePolicies: [{ ruleKey: "source-observation-link", candidatePolicy: "review-only" }],
          },
        },
        replay: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: {
            ambiguousCandidatePolicy: "block-promotion",
            replayPolicy: "same-profile-version",
            rulePolicies: [{ ruleKey: "source-observation-link", candidatePolicy: "review-only" }],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "set:TSPX",
            normalizedKind: "magic-set-reference",
            normalizedFields: {
              name: "Time Spiral Unknown Option",
              setCode: "tspx",
            },
          },
        },
      },
    ),
    ...providerCases(
      "lorcanajson",
      {
        profileKey: "lorcana-card-reference-data",
        ingestionUnitKey: "lorcanajson:lorcana:single-card:reference-data",
        profileVersion: "2026.06.23",
      },
      {
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: [
            "normalizedObservation.fields.name.selector.path",
            "normalizedObservation.fields.mergeIdentity.selector.path",
            "normalizedObservation.hashMaterial.0.selector.path",
            "normalizedObservation.fields.name",
          ],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "card:1-041",
            normalizedKind: "lorcana-card-print",
            normalizedFields: {
              name: "Elsa - Snow Queen",
              setId: "1",
              setCode: "1",
              setName: "The First Chapter",
              tcg: "lorcana",
              productLineName: "Disney Lorcana",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005010" }],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
          ],
          expectedDuplicatePrevention: lorcanajsonBridgeDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: lorcanajsonBridgeDuplicatePrevention(),
        },
        replay: {
          expectedDuplicatePrevention: lorcanajsonBridgeDuplicatePrevention(),
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "card:lorcanajson-first-chapter-booster-pack-reference",
            normalizedKind: "lorcana-card-print",
            normalizedFields: {
              name: "The First Chapter Booster Pack",
              setId: "1",
              setCode: "1",
            },
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "card:lorcanajson-first-chapter-unknown-option-reference",
            normalizedKind: "lorcana-card-print",
            normalizedFields: {
              cardNumber: "204-star",
              rarity: "enchanted-unclassified",
            },
          },
        },
      },
    ),
    ...providerCases(
      "lorcanajson",
      {
        profileKey: "lorcana-set-reference-data",
        ingestionUnitKey: "lorcanajson:lorcana:set:reference-data",
        profileVersion: "2026.06.23",
      },
      {
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: [
            "normalizedObservation.fields.name.selector.path",
            "normalizedObservation.fields.setName.selector.path",
            "normalizedObservation.fields.expansionName.selector.path",
            "normalizedObservation.hashMaterial.0.selector.path",
            "normalizedObservation.fields.name",
            "normalizedObservation.fields.setName",
          ],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "set:1",
            normalizedKind: "lorcana-set-reference",
            normalizedFields: {
              name: "The First Chapter",
              setId: "1",
              setCode: "1",
              setName: "The First Chapter",
              productLineName: "Disney Lorcana",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
          ],
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: {
            ambiguousCandidatePolicy: "block-promotion",
            replayPolicy: "same-profile-version",
            exactExternalCatalogItemReferencesFirst: false,
            rulePolicies: [{ ruleKey: "source-observation-link", candidatePolicy: "review-only" }],
          },
        },
        ambiguous: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: {
            ambiguousCandidatePolicy: "block-promotion",
            replayPolicy: "same-profile-version",
            exactExternalCatalogItemReferencesFirst: false,
            rulePolicies: [{ ruleKey: "source-observation-link", candidatePolicy: "review-only" }],
          },
        },
        replay: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: {
            ambiguousCandidatePolicy: "block-promotion",
            replayPolicy: "same-profile-version",
            exactExternalCatalogItemReferencesFirst: false,
            rulePolicies: [{ ruleKey: "source-observation-link", candidatePolicy: "review-only" }],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "set:1X",
            normalizedKind: "lorcana-set-reference",
            normalizedFields: {
              name: "The First Chapter Unknown Option",
              setCode: "1x",
            },
          },
        },
      },
    ),
    ...providerCases(
      "lorcast",
      {
        profileKey: "lorcana-card-reference-data",
        ingestionUnitKey: "lorcast:lorcana:single-card:reference-data",
        profileVersion: "2026.06.23",
      },
      {
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: [
            "normalizedObservation.fields.name.selector.path",
            "normalizedObservation.fields.mergeIdentity.selector.path",
            "normalizedObservation.hashMaterial.0.selector.path",
            "normalizedObservation.fields.name",
          ],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "card:crd_elsa_snow_queen_1_041",
            normalizedKind: "lorcana-card-print",
            normalizedFields: {
              name: "Elsa - Snow Queen",
              setId: "set_7ecb0e0c71af496a9e0110e23824e0a5",
              setCode: "1",
              setName: "The First Chapter",
              tcg: "lorcana",
              productLineName: "Disney Lorcana",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005010" }],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
          ],
          expectedDuplicatePrevention: lorcastBridgeDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: lorcastBridgeDuplicatePrevention(),
        },
        replay: {
          expectedDuplicatePrevention: lorcastBridgeDuplicatePrevention(),
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "card:lorcast-first-chapter-booster-pack-reference",
            normalizedKind: "lorcana-card-print",
            normalizedFields: {
              name: "The First Chapter Booster Pack",
              setId: "set_7ecb0e0c71af496a9e0110e23824e0a5",
              setCode: "1",
            },
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "card:lorcast-first-chapter-unknown-option-reference",
            normalizedKind: "lorcana-card-print",
            normalizedFields: {
              cardNumber: "204-star",
              rarity: "enchanted-unclassified",
            },
          },
        },
      },
    ),
    ...providerCases(
      "lorcast",
      {
        profileKey: "lorcana-set-reference-data",
        ingestionUnitKey: "lorcast:lorcana:set:reference-data",
        profileVersion: "2026.06.23",
      },
      {
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: [
            "normalizedObservation.fields.name.selector.path",
            "normalizedObservation.fields.setName.selector.path",
            "normalizedObservation.fields.expansionName.selector.path",
            "normalizedObservation.hashMaterial.0.selector.path",
            "normalizedObservation.fields.name",
            "normalizedObservation.fields.setName",
          ],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "set:set_7ecb0e0c71af496a9e0110e23824e0a5",
            normalizedKind: "lorcana-set-reference",
            normalizedFields: {
              name: "The First Chapter",
              setId: "set_7ecb0e0c71af496a9e0110e23824e0a5",
              setCode: "1",
              setName: "The First Chapter",
              productLineName: "Disney Lorcana",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
          ],
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: {
            ambiguousCandidatePolicy: "block-promotion",
            replayPolicy: "same-profile-version",
            exactExternalCatalogItemReferencesFirst: false,
            rulePolicies: [{ ruleKey: "source-observation-link", candidatePolicy: "review-only" }],
          },
        },
        ambiguous: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: {
            ambiguousCandidatePolicy: "block-promotion",
            replayPolicy: "same-profile-version",
            exactExternalCatalogItemReferencesFirst: false,
            rulePolicies: [{ ruleKey: "source-observation-link", candidatePolicy: "review-only" }],
          },
        },
        replay: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: {
            ambiguousCandidatePolicy: "block-promotion",
            replayPolicy: "same-profile-version",
            exactExternalCatalogItemReferencesFirst: false,
            rulePolicies: [{ ruleKey: "source-observation-link", candidatePolicy: "review-only" }],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "set:1X",
            normalizedKind: "lorcana-set-reference",
            normalizedFields: {
              name: "The First Chapter Unknown Option",
              setCode: "1x",
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
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: [
            "normalizedObservation.fields.name.selector",
            "normalizedObservation.fields.mergeIdentity.selector.fields.printedProductName.selector.path",
            "normalizedObservation.hashMaterial.0.selector.fields.name.selector.path",
            "normalizedObservation.fields.name",
          ],
          expectedObservation: undefined,
        },
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
          expectedPromotionCommands: [
            "CreateCatalogItem",
            "SetCatalogItemFieldValue",
            "LinkExternalCatalogItemReference",
          ],
          expectedPromotionInputPaths: [
            "CreateCatalogItem.title",
            "SetCatalogItemFieldValue.fieldKey",
            "SetCatalogItemFieldValue.value",
            "LinkExternalCatalogItemReference.externalKey",
          ],
          expectedDuplicatePrevention: scryfallBridgeDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: scryfallBridgeDuplicatePrevention(),
        },
        changed: {
          expectedPromotionInputPaths: ["SetCatalogItemFieldValue.value"],
        },
        replay: {
          expectedDuplicatePrevention: scryfallBridgeDuplicatePrevention(),
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
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: [
            "normalizedObservation.fields.name.selector",
            "normalizedObservation.fields.mergeIdentity.selector.fields.printedProductName.selector.path",
            "normalizedObservation.hashMaterial.0.selector.fields.name.selector.path",
            "normalizedObservation.fields.name",
          ],
          expectedObservation: undefined,
        },
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
          expectedPromotionCommands: [
            "CreateCatalogItem",
            "SetCatalogItemFieldValue",
            "LinkExternalCatalogItemReference",
          ],
          expectedPromotionInputPaths: [
            "CreateCatalogItem.title",
            "SetCatalogItemFieldValue.fieldKey",
            "SetCatalogItemFieldValue.value",
            "LinkExternalCatalogItemReference.externalKey",
          ],
          expectedDuplicatePrevention: scryfallBridgeDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: scryfallBridgeDuplicatePrevention(),
        },
        changed: {
          expectedPromotionInputPaths: ["SetCatalogItemFieldValue.value"],
        },
        replay: {
          expectedDuplicatePrevention: scryfallBridgeDuplicatePrevention(),
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
              cardNumber: "1",
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
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: ["sourceObservation.externalKey.selector.path", "sourceObservation.externalKey"],
          expectedObservation: undefined,
        },
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
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        replay: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
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
        profileKey: "mtg-sealed-product-sku",
        ingestionUnitKey: "tcgplayer:mtg:sealed-product:source-observation-import",
        profileVersion: "2026.06.19",
      },
      {
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: [
            "normalizedObservation.fields.packCount.selector.path",
            "normalizedObservation.fields.packCount",
          ],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "96601",
            normalizedKind: "magic-sealed-product",
            normalizedFields: {
              name: "Time Spiral Booster Pack",
              setCode: "tsp",
              setName: "Time Spiral",
              sealedProductForm: "booster-pack",
              packCount: 1,
              tcg: "magic",
              productLineName: "Magic: The Gathering",
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
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
          expectedPromotionCommands: [
            "CreateCatalogItem",
            "AssignBlueprintToCatalogItem",
            "SetCatalogItemFieldValue",
            "AssignCatalogItemToCategory",
            "LinkExternalCatalogItemReference",
          ],
          expectedPromotionInputPaths: [
            "CreateCatalogItem.title",
            "AssignBlueprintToCatalogItem.blueprintKey",
            "SetCatalogItemFieldValue.fieldKey",
            "SetCatalogItemFieldValue.value",
            "AssignCatalogItemToCategory.categoryKey",
            "LinkExternalCatalogItemReference.references",
          ],
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        changed: {
          expectedPromotionInputPaths: [
            "CreateCatalogItem.title",
            "AssignBlueprintToCatalogItem.blueprintKey",
            "SetCatalogItemFieldValue.value",
            "LinkExternalCatalogItemReference.references",
          ],
        },
        replay: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "96601-sealed",
            normalizedKind: "magic-sealed-product",
            normalizedFields: {
              name: "Time Spiral Booster Pack",
              sealedProductForm: "booster-pack",
              packCount: 1,
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
            externalKey: "96601-unknown-option",
            normalizedKind: "magic-sealed-product",
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:50096604",
                selectedOptions: [{ dimensionKey: "language", optionKey: null, providerValue: "Phyrexian" }],
              },
            ],
          },
        },
      },
    ),
    ...providerCases(
      "tcgplayer",
      {
        profileKey: "pokemon-single-card-product-sku",
        ingestionUnitKey: "tcgplayer:pokemon:single-card:source-observation-import",
        profileVersion: "2026.06.05",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "493958",
            normalizedKind: "provider-product",
            normalizedFields: {
              name: "Sprigatito",
              productForm: "single",
              "mergeIdentity.tcg": "pokemon",
              "mergeIdentity.productLineName": "Pokemon",
              "mergeIdentity.setName": "Scarlet & Violet",
              "mergeIdentity.printedProductName": "Sprigatito",
              "mergeIdentity.collectorNumber": "001/198",
              "mergeIdentity.languageCode": "en",
              "mergeIdentity.productForm": "single",
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
    ...providerCases(
      "tcgplayer",
      {
        profileKey: "pokemon-sealed-product-sku",
        ingestionUnitKey: "tcgplayer:pokemon:sealed-product:source-observation-import",
        profileVersion: "2026.07.13",
      },
      {
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: [
            "normalizedObservation.fields.packCount.selector.path",
            "normalizedObservation.fields.packCount",
          ],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "497105",
            normalizedKind: "pokemon-sealed-product",
            normalizedFields: {
              name: "Scarlet & Violet Elite Trainer Box",
              setCode: "svi",
              setName: "Scarlet & Violet",
              sealedProductForm: "elite-trainer-box",
              packCount: 9,
              tcg: "pokemon",
              productLineName: "Pokemon",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:497105" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:15501001",
                selectedOptions: [{ dimensionKey: "product-form", optionKey: "unopened", providerValue: "Sealed" }],
              },
            ],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
          expectedPromotionCommands: [
            "CreateCatalogItem",
            "AssignBlueprintToCatalogItem",
            "SetCatalogItemFieldValue",
            "AssignCatalogItemToCategory",
            "LinkExternalCatalogItemReference",
          ],
          expectedPromotionInputPaths: [
            "CreateCatalogItem.title",
            "AssignBlueprintToCatalogItem.blueprintKey",
            "SetCatalogItemFieldValue.fieldKey",
            "SetCatalogItemFieldValue.value",
            "AssignCatalogItemToCategory.categoryKey",
            "LinkExternalCatalogItemReference.references",
          ],
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        changed: {
          expectedPromotionInputPaths: [
            "CreateCatalogItem.title",
            "AssignBlueprintToCatalogItem.blueprintKey",
            "SetCatalogItemFieldValue.value",
            "LinkExternalCatalogItemReference.references",
          ],
        },
        replay: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "497105-sealed",
            normalizedKind: "pokemon-sealed-product",
            normalizedFields: {
              name: "Scarlet & Violet Elite Trainer Box",
              sealedProductForm: "elite-trainer-box",
              packCount: 9,
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:497105" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:15501001",
                selectedOptions: [{ dimensionKey: "product-form", optionKey: "unopened", providerValue: "Sealed" }],
              },
            ],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "497105-unknown-option",
            normalizedKind: "pokemon-sealed-product",
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:15501004",
                selectedOptions: [{ dimensionKey: "language", optionKey: null, providerValue: "Japanese" }],
              },
            ],
          },
        },
      },
    ),
    ...providerCases(
      "ygoprodeck",
      {
        profileKey: "yugioh-card-print-reference-data",
        ingestionUnitKey: "ygoprodeck:yugioh:single-card:reference-data",
        profileVersion: "2026.06.21",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "card:46986414:SDY-006",
            normalizedKind: "yugioh-card-print",
            normalizedFields: {
              name: "Dark Magician",
              passcode: 46986414,
              setName: "Starter Deck: Yugi",
              setCode: "sdy-006",
              rarity: "Ultra Rare",
              tcg: "yugioh",
              productLineName: "Yu-Gi-Oh!",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: yugiohBridgeDuplicatePrevention(),
        },
        replay: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: yugiohBridgeDuplicatePrevention(),
        },
      },
    ),
    ...providerCases(
      "ygoprodeck",
      {
        profileKey: "yugioh-set-reference-data",
        ingestionUnitKey: "ygoprodeck:yugioh:set:reference-data",
        profileVersion: "2026.06.21",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "set:SDY",
            normalizedKind: "yugioh-set-reference",
            normalizedFields: {
              name: "Starter Deck: Yugi",
              setName: "Starter Deck: Yugi",
              setCode: "sdy",
              releaseDate: "2002-03-29",
              cardCount: 50,
              tcg: "yugioh",
              productLineName: "Yu-Gi-Oh!",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
          ],
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: yugiohSetReferenceDuplicatePrevention(),
        },
        replay: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: yugiohSetReferenceDuplicatePrevention(),
        },
      },
    ),
    ...providerCases(
      "ygojson",
      {
        profileKey: "yugioh-set-reference-data",
        ingestionUnitKey: "ygojson:yugioh:set:reference-data",
        profileVersion: "2026.06.21",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "set:11111111-1111-4111-8111-111111111111",
            normalizedKind: "yugioh-set-reference",
            normalizedFields: {
              name: "Legend of Blue Eyes White Dragon",
              ygojsonId: "11111111-1111-4111-8111-111111111111",
              releaseDate: "2002-03-08",
              tcg: "yugioh",
              productLineName: "Yu-Gi-Oh!",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
          ],
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: ygojsonSetReferenceDuplicatePrevention(),
        },
        replay: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: ygojsonSetReferenceDuplicatePrevention(),
        },
      },
    ),
    ...providerCases(
      "ygojson",
      {
        profileKey: "yugioh-sealed-product-reference-data",
        ingestionUnitKey: "ygojson:yugioh:sealed-product:reference-data",
        profileVersion: "2026.06.21",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "sealed-product:22222222-2222-4222-8222-222222222222",
            normalizedKind: "yugioh-sealed-product",
            normalizedFields: {
              name: "Legend of Blue Eyes White Dragon Booster Box",
              ygojsonId: "22222222-2222-4222-8222-222222222222",
              releaseDate: "2002-03-08",
              tcg: "yugioh",
              productLineName: "Yu-Gi-Oh!",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: yugiohSealedProductDuplicatePrevention(),
        },
        replay: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: yugiohSealedProductDuplicatePrevention(),
        },
      },
    ),
    ...providerCases(
      "tcgplayer",
      {
        profileKey: "yugioh-single-card-product-sku",
        ingestionUnitKey: "tcgplayer:yugioh:single-card:source-observation-import",
        profileVersion: "2026.06.20",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "17851",
            normalizedKind: "provider-product",
            normalizedFields: {
              name: "Dark Magician",
              cardNumber: "SDY-006",
              productForm: "single",
              productLineName: "Yu-Gi-Oh!",
              tcg: "yugioh",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:17851" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:60017851",
                selectedOptions: [
                  { dimensionKey: "condition", optionKey: "near-mint", providerValue: "Near Mint" },
                  { dimensionKey: "printing", optionKey: "unlimited", providerValue: "Unlimited" },
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
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        replay: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
      },
    ),
    ...providerCases(
      "tcgplayer",
      {
        profileKey: "one-piece-single-card-product-sku",
        ingestionUnitKey: "tcgplayer:one-piece:single-card:source-observation-import",
        profileVersion: "2026.06.22",
      },
      {
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: ["sourceObservation.externalKey.selector.path", "sourceObservation.externalKey"],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "987650",
            normalizedKind: "provider-product",
            normalizedFields: {
              name: "Monkey.D.Luffy",
              cardNumber: "OP01-001",
              productForm: "single",
              productLineName: "One Piece Card Game",
              tcg: "one-piece",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:987650" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:900987650",
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
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        replay: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "987660",
            normalizedKind: "provider-product",
            normalizedFields: {
              name: "Romance Dawn Booster Box",
              productForm: "sealed",
              productLineName: "One Piece Card Game",
              tcg: "one-piece",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:987660" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:900987660",
                selectedOptions: [{ dimensionKey: "product-form", optionKey: "unopened", providerValue: "Sealed" }],
              },
            ],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "987650-unknown-option",
            normalizedKind: "provider-product",
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:900987652",
                selectedOptions: [{ dimensionKey: "printing", optionKey: null, providerValue: "Manga Rare" }],
              },
            ],
          },
        },
      },
    ),
    ...providerCases(
      "tcgplayer",
      {
        profileKey: "one-piece-sealed-product-sku",
        ingestionUnitKey: "tcgplayer:one-piece:sealed-product:source-observation-import",
        profileVersion: "2026.06.23",
      },
      {
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: ["sourceObservation.externalKey.selector.path", "sourceObservation.externalKey"],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "987660",
            normalizedKind: "provider-product",
            normalizedFields: {
              name: "Romance Dawn Booster Box",
              productForm: "sealed",
              productLineName: "One Piece Card Game",
              tcg: "one-piece",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:987660" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:900987660",
                selectedOptions: [{ dimensionKey: "product-form", optionKey: "unopened", providerValue: "Sealed" }],
              },
            ],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        replay: {
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "987660",
            normalizedKind: "provider-product",
            normalizedFields: {
              name: "Romance Dawn Booster Box",
              productForm: "sealed",
              productLineName: "One Piece Card Game",
              tcg: "one-piece",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:987660" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:900987660",
                selectedOptions: [{ dimensionKey: "product-form", optionKey: "unopened", providerValue: "Sealed" }],
              },
            ],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "987660-unknown-option",
            normalizedKind: "provider-product",
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:900987660",
                selectedOptions: [{ dimensionKey: "language", optionKey: null, providerValue: "Pirate Glyph" }],
              },
            ],
          },
        },
      },
    ),
    ...providerCases(
      "scrydex",
      {
        profileKey: "one-piece-card-print-source-observation",
        ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
        profileVersion: "2026.06.22",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "card:op01-001",
            normalizedKind: "one-piece-card-print",
            normalizedFields: {
              name: "Monkey.D.Luffy",
              cardNumber: "OP01-001",
              setId: "op-01",
              setName: "Romance Dawn",
              tcg: "one-piece",
              productLineName: "One Piece Card Game",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
        },
      },
    ),
    ...providerCases(
      "scrydex",
      {
        profileKey: "one-piece-set-reference-data",
        ingestionUnitKey: "scrydex:one-piece:set:reference-data",
        profileVersion: "2026.06.22",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "set:op-01",
            normalizedKind: "one-piece-set-reference",
            normalizedFields: {
              name: "Romance Dawn",
              setId: "op-01",
              setCode: "op-01",
              setName: "Romance Dawn",
              cardCount: 121,
              tcg: "one-piece",
              productLineName: "One Piece Card Game",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
          ],
        },
      },
    ),
    ...providerCases(
      "scrydex",
      {
        profileKey: "one-piece-sealed-product-source-observation",
        ingestionUnitKey: "scrydex:one-piece:sealed-product:source-observation-import",
        profileVersion: "2026.06.22",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "sealed:op01-booster-box",
            normalizedKind: "one-piece-sealed-product",
            normalizedFields: {
              name: "Romance Dawn Booster Box",
              setId: "op-01",
              setName: "Romance Dawn",
              sealedProductForm: "sealed-product",
              tcg: "one-piece",
              productLineName: "One Piece Card Game",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
        },
      },
    ),
    ...providerCases(
      "scrydex",
      {
        profileKey: "lorcana-card-print-source-observation",
        ingestionUnitKey: "scrydex:lorcana:single-card:source-observation-import",
        profileVersion: "2026.06.23",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "card:tfc-041",
            normalizedKind: "lorcana-card-print",
            normalizedFields: {
              name: "Elsa - Snow Queen",
              cardNumber: "41/204",
              setId: "1",
              setName: "The First Chapter",
              tcg: "lorcana",
              productLineName: "Disney Lorcana",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005010" }],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
        },
      },
    ),
    ...providerCases(
      "scrydex",
      {
        profileKey: "lorcana-set-reference-data",
        ingestionUnitKey: "scrydex:lorcana:set:reference-data",
        profileVersion: "2026.06.23",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "set:1",
            normalizedKind: "lorcana-set-reference",
            normalizedFields: {
              name: "The First Chapter",
              setId: "1",
              setCode: "tfc",
              setName: "The First Chapter",
              cardCount: 204,
              tcg: "lorcana",
              productLineName: "Disney Lorcana",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
          ],
        },
      },
    ),
    ...providerCases(
      "scrydex",
      {
        profileKey: "lorcana-sealed-product-source-observation",
        ingestionUnitKey: "scrydex:lorcana:sealed-product:source-observation-import",
        profileVersion: "2026.06.23",
      },
      {
        normal: {
          expectedObservation: {
            externalKey: "sealed:tfc-booster-box",
            normalizedKind: "lorcana-sealed-product",
            normalizedFields: {
              name: "The First Chapter Booster Box",
              setId: "1",
              setName: "The First Chapter",
              sealedProductForm: "sealed-product",
              tcg: "lorcana",
              productLineName: "Disney Lorcana",
            },
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
        },
      },
    ),
    ...providerCases(
      "tcgplayer",
      {
        profileKey: "lorcana-single-card-product-sku",
        ingestionUnitKey: "tcgplayer:lorcana:single-card:source-observation-import",
        profileVersion: "2026.06.23",
      },
      {
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: ["sourceObservation.externalKey.selector.path", "sourceObservation.externalKey"],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "1005010",
            normalizedKind: "provider-product",
            normalizedFields: {
              name: "Elsa - Snow Queen",
              productForm: "single",
              productLineName: "Disney Lorcana",
              tcg: "lorcana",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005010" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:9001005010",
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
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        replay: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "1005020",
            normalizedKind: "provider-product",
            normalizedFields: {
              productForm: "sealed",
              name: "The First Chapter Booster Box",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005020" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:9001005020",
                selectedOptions: [{ dimensionKey: "product-form", optionKey: "unopened", providerValue: "Sealed" }],
              },
            ],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "1005010-unknown-option",
            normalizedKind: "provider-product",
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:9001005012",
                selectedOptions: [{ dimensionKey: "printing", optionKey: null, providerValue: "Cold Foil" }],
              },
            ],
          },
        },
      },
    ),
    ...providerCases(
      "tcgplayer",
      {
        profileKey: "lorcana-sealed-product-sku",
        ingestionUnitKey: "tcgplayer:lorcana:sealed-product:source-observation-import",
        profileVersion: "2026.06.23",
      },
      {
        partial: {
          expectedStatus: "blocked",
          expectedDiagnosticPaths: ["sourceObservation.externalKey.selector.path", "sourceObservation.externalKey"],
          expectedObservation: undefined,
        },
        normal: {
          expectedObservation: {
            externalKey: "1005020",
            normalizedKind: "provider-product",
            normalizedFields: {
              productForm: "sealed",
              name: "The First Chapter Booster Box",
              productLineName: "Disney Lorcana",
              tcg: "lorcana",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005020" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:9001005020",
                selectedOptions: [{ dimensionKey: "product-form", optionKey: "unopened", providerValue: "Sealed" }],
              },
            ],
          },
          expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
          expectedMergeEvidencePaths: [
            "duplicatePrevention.mergeCandidateEvidence.0",
            "duplicatePrevention.mergeCandidateEvidence.1",
            "duplicatePrevention.mergeCandidateEvidence.2",
          ],
          forbiddenPromotionCommands: catalogItemPromotionCommands(),
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        ambiguous: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        replay: {
          expectedDuplicatePrevention: tcgplayerDuplicatePrevention(),
        },
        "sealed-product": {
          expectedObservation: {
            externalKey: "1005020-sealed",
            normalizedKind: "provider-product",
            normalizedFields: {
              productForm: "sealed",
              name: "The First Chapter Booster Box",
            },
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005020" }],
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:9001005020",
                selectedOptions: [{ dimensionKey: "product-form", optionKey: "unopened", providerValue: "Sealed" }],
              },
            ],
          },
        },
        "unknown-option": {
          expectedObservation: {
            externalKey: "1005020-unknown-option",
            normalizedKind: "provider-product",
            externalProductReferences: [
              {
                providerKey: "tcgplayer",
                externalKey: "sku:9001005022",
                selectedOptions: [{ dimensionKey: "language", optionKey: null, providerValue: "Inklands" }],
              },
            ],
          },
        },
      },
    ),
  ];
}

function mtgjsonBridgeDuplicatePrevention(): CatalogProviderProfileFixtureCase["expectedDuplicatePrevention"] {
  return {
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
    exactExternalCatalogItemReferencesFirst: true,
    rulePolicies: [
      { ruleKey: "exact-scryfall-bridge-reference", candidatePolicy: "reuse" },
      { ruleKey: "future-provider-bridge-review", candidatePolicy: "review-only" },
    ],
  };
}

function scryfallBridgeDuplicatePrevention(): CatalogProviderProfileFixtureCase["expectedDuplicatePrevention"] {
  return {
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
    exactExternalCatalogItemReferencesFirst: true,
    rulePolicies: [
      { ruleKey: "exact-external-catalog-item-reference", candidatePolicy: "reuse" },
      { ruleKey: "future-provider-bridge-review", candidatePolicy: "review-only" },
    ],
  };
}

function lorcanajsonBridgeDuplicatePrevention(): CatalogProviderProfileFixtureCase["expectedDuplicatePrevention"] {
  return {
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
    exactExternalCatalogItemReferencesFirst: true,
    rulePolicies: [
      { ruleKey: "exact-external-catalog-item-reference", candidatePolicy: "reuse" },
      { ruleKey: "source-observation-link", candidatePolicy: "review-only" },
      { ruleKey: "lorcana-card-print-deterministic-fields", candidatePolicy: "review-only" },
      { ruleKey: "future-provider-bridge-review", candidatePolicy: "review-only" },
    ],
  };
}

function lorcastBridgeDuplicatePrevention(): CatalogProviderProfileFixtureCase["expectedDuplicatePrevention"] {
  return {
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
    exactExternalCatalogItemReferencesFirst: true,
    rulePolicies: [
      { ruleKey: "exact-external-catalog-item-reference", candidatePolicy: "reuse" },
      { ruleKey: "source-observation-link", candidatePolicy: "review-only" },
      { ruleKey: "lorcana-card-print-deterministic-fields", candidatePolicy: "review-only" },
      { ruleKey: "future-provider-bridge-review", candidatePolicy: "review-only" },
    ],
  };
}

function tcgplayerDuplicatePrevention(): CatalogProviderProfileFixtureCase["expectedDuplicatePrevention"] {
  return {
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
    exactExternalCatalogItemReferencesFirst: true,
    rulePolicies: [
      { ruleKey: "exact-external-catalog-item-reference", candidatePolicy: "reuse" },
      { ruleKey: "exact-external-product-reference", candidatePolicy: "reuse" },
      { ruleKey: "future-provider-bridge-review", candidatePolicy: "review-only" },
    ],
  };
}

function yugiohBridgeDuplicatePrevention(): CatalogProviderProfileFixtureCase["expectedDuplicatePrevention"] {
  return {
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
    exactExternalCatalogItemReferencesFirst: false,
    rulePolicies: [
      { ruleKey: "source-observation-link", candidatePolicy: "review-only" },
      { ruleKey: "future-provider-bridge-review", candidatePolicy: "review-only" },
    ],
  };
}

function yugiohSetReferenceDuplicatePrevention(): CatalogProviderProfileFixtureCase["expectedDuplicatePrevention"] {
  return {
    ambiguousCandidatePolicy: "review-only",
    replayPolicy: "same-profile-version",
    exactExternalCatalogItemReferencesFirst: false,
    rulePolicies: [{ ruleKey: "source-observation-link", candidatePolicy: "review-only" }],
  };
}

function ygojsonSetReferenceDuplicatePrevention(): CatalogProviderProfileFixtureCase["expectedDuplicatePrevention"] {
  return {
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
    exactExternalCatalogItemReferencesFirst: false,
    rulePolicies: [{ ruleKey: "source-observation-link", candidatePolicy: "review-only" }],
  };
}

function yugiohSealedProductDuplicatePrevention(): CatalogProviderProfileFixtureCase["expectedDuplicatePrevention"] {
  return {
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
    exactExternalCatalogItemReferencesFirst: false,
    rulePolicies: [
      { ruleKey: "source-observation-link", candidatePolicy: "review-only" },
      { ruleKey: "sealed-product-name-and-box-content-review", candidatePolicy: "review-only" },
    ],
  };
}

function catalogItemPromotionCommands(): readonly string[] {
  return [
    "CreateCatalogItem",
    "RefreshCatalogItem",
    "ReviseCatalogItemMetadata",
    "AssignBlueprintToCatalogItem",
    "AssignCatalogItemToCategory",
    "SetCatalogItemFieldValue",
    "SetCatalogItemTags",
    "SetCatalogItemImageUrls",
    "SetCatalogItemProductAssetSets",
    "LinkExternalCatalogItemReference",
    "LinkExternalProductReference",
  ];
}

function defaultExpectedNormalizedKind(providerKey: string, ingestionUnitKey: string | undefined): string {
  if (providerKey === "tcgdex") {
    return "pokemon-card";
  }
  const byIngestionUnitKey: Record<string, string> = {
    "scrydex:one-piece:set:reference-data": "one-piece-set-reference",
    "scrydex:one-piece:sealed-product:source-observation-import": "one-piece-sealed-product",
    "scrydex:one-piece:single-card:source-observation-import": "one-piece-card-print",
    "ygoprodeck:yugioh:set:reference-data": "yugioh-set-reference",
    "ygojson:yugioh:set:reference-data": "yugioh-set-reference",
    "yaml-yugi:yugioh:set:reference-data": "yugioh-set-reference",
    "ygojson:yugioh:sealed-product:reference-data": "yugioh-sealed-product",
    "ygojson:yugioh:pack:reference-data": "yugioh-pack-reference",
    "mtgjson:mtg:set:reference-data": "magic-set-reference",
    "scrydex:lorcana:set:reference-data": "lorcana-set-reference",
    "scrydex:lorcana:sealed-product:source-observation-import": "lorcana-sealed-product",
    "scrydex:lorcana:single-card:source-observation-import": "lorcana-card-print",
    "lorcanajson:lorcana:set:reference-data": "lorcana-set-reference",
    "lorcanajson:lorcana:single-card:reference-data": "lorcana-card-print",
    "lorcast:lorcana:set:reference-data": "lorcana-set-reference",
    "lorcast:lorcana:single-card:reference-data": "lorcana-card-print",
    "tcgplayer:mtg:sealed-product:source-observation-import": "magic-sealed-product",
    "tcgplayer:pokemon:sealed-product:source-observation-import": "pokemon-sealed-product",
  };
  if (ingestionUnitKey && ingestionUnitKey in byIngestionUnitKey) {
    return byIngestionUnitKey[ingestionUnitKey];
  }
  if (
    ingestionUnitKey?.startsWith("ygoprodeck:yugioh:") ||
    ingestionUnitKey?.startsWith("ygojson:yugioh:") ||
    ingestionUnitKey?.startsWith("yaml-yugi:yugioh:")
  ) {
    return "yugioh-card-print";
  }
  if (providerKey === "mtgjson" || providerKey === "scryfall") {
    return "magic-card-print";
  }
  return "provider-product";
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
      normalizedKind: defaultExpectedNormalizedKind(providerKey, identity.ingestionUnitKey),
    },
    ...expectations[flow],
  }));
}
