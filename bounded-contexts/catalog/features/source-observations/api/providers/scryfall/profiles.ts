import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogProviderIntegrationProfile, CatalogProviderOptionQuery } from "../profile-types";

const scryfallMtgOptionQueries = [
  {
    queryKind: "sets",
    queryKeySynonyms: ["set"],
    displayName: "Set",
    scope: "set-name",
    parentScope: null,
    operation: "scryfall-list-sets",
    output: {
      valuePath: "setCode",
      labelPath: "name",
      description: { kind: "path", path: "releasedAt" },
      metadataPaths: {
        setId: "setId",
        setCode: "setCode",
        setType: "setType",
        releasedAt: "releasedAt",
        cardCount: "cardCount",
        digital: "digital",
      },
    },
  },
  {
    queryKind: "cards",
    queryKeySynonyms: ["card"],
    displayName: "Card",
    scope: "product/card",
    parentScope: "set-name",
    operation: "scryfall-list-cards",
    parentValue: {
      required: true,
      valueKind: "set-code",
      diagnosticText: "Scryfall card option queries require a selected set code.",
    },
    output: {
      valuePath: "cardId",
      labelPath: "name",
      parentValuePath: "setCode",
      imageUrlPath: "imageUrl",
      metadataPaths: {
        cardId: "cardId",
        oracleId: "oracleId",
        setCode: "setCode",
        setName: "setName",
        collectorNumber: "collectorNumber",
        rarity: "rarity",
        imageStatus: "imageStatus",
      },
    },
  },
] as const satisfies readonly CatalogProviderOptionQuery[];

export const scryfallMtgCardPrintProviderProfile = {
  providerKey: "scryfall",
  displayName: "Scryfall",
  status: "active",
  capabilities: [
    "provider-option-query",
    "source-observation-import",
    "catalog-item-promotion",
    "external-reference-extraction",
  ],
  supportedScopes: ["set-name", "product/card"],
  languageOptions: ["en"],
  optionQueries: scryfallMtgOptionQueries,
  connector: {
    kind: "scryfall-json",
    baseUrl: "https://api.scryfall.com",
    sourceContractDocument: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
    authentication: {
      scheme: "public-api",
      credentialsRequired: false,
      userAgentRequired: true,
    },
    acceptedEvidence: [
      "scryfall-id",
      "oracle-id",
      "set-code",
      "set-name",
      "collector-number",
      "language",
      "rarity",
      "finish",
      "image-url",
      "tcgplayer-id",
    ],
    excludedEvidence: ["price", "seller", "inventory", "ruling", "legality"],
  },
  normalizedObservationMapping: {
    kind: "magic-card-print",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified Scryfall Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: {
    blueprintKey: "magic-card-print",
    categoryKey: "magic-card-prints",
    fieldKeys: {
      cardNumber: "card-number",
      cardName: "card-name",
      set: "set",
      expansion: "set",
      rarity: "rarity",
      cardVariant: "card-variant",
      cardIllustrator: "card-illustrator",
      releaseYear: "release-year",
    },
  },
  referenceHierarchyMapping: {
    providerReferenceIdPrefix: "ref_scryfall",
    providerAttributes: [
      { typeKey: "set", providerAttributeKey: "scryfall-set-code" },
      { typeKey: "set", providerAttributeKey: "scryfall-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A Magic: The Gathering set or release group.",
        attributeKeys: ["scryfall-set-code", "scryfall-set-name"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "magic-product-line",
        typeKey: "product-line",
        recordId: {
          kind: "static",
          referenceRecordId: catalogSeedIds.referenceRecords.productLines.magicTheGathering,
        },
        key: { kind: "static", value: "magic-the-gathering" },
        name: { kind: "static", value: "Magic: The Gathering" },
        description: { kind: "static", value: "Magic: The Gathering trading card game." },
        attributes: [
          { attributeKey: "official-name", value: { kind: "static", value: "Magic: The Gathering" } },
          { attributeKey: "short-name", value: { kind: "static", value: "Magic" } },
        ],
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["set", "set_name"] },
        key: { kind: "path", path: "set_name" },
        name: { kind: "path", path: "set_name" },
        description: {
          kind: "template",
          template: "{setName} Magic: The Gathering set.",
          values: { setName: { kind: "path", path: "set_name" } },
        },
        requiredPaths: ["set", "set_name"],
        attributes: [
          { attributeKey: "scryfall-set-code", value: { kind: "path", path: "set" } },
          { attributeKey: "scryfall-set-name", value: { kind: "path", path: "set_name" } },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "magic-product-line" }],
      },
    ],
  },
  externalReferenceExtractionRules: {
    referenceTarget: "catalog-item-reference",
    rules: [
      {
        providerKey: "tcgplayer",
        target: "catalog-item-reference",
        externalKeyPrefix: "product:",
        containerKeys: [],
        valueKeys: ["tcgplayer_id"],
        recordIdKeys: ["tcgplayer_id"],
        pricingRootKeys: [],
        pricingScope: "card",
      },
    ],
  },
  duplicatePreventionMapping: {
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
    rules: [
      {
        ruleKey: "exact-external-catalog-item-reference",
        matchKind: "exact-external-catalog-item-reference",
        sourcePath: "externalCatalogItemReferences",
      },
      {
        ruleKey: "source-observation-link",
        matchKind: "source-observation-link",
        providerKeySource: "observation-provider",
        externalKey: "language-prefixed-observation-external-key",
      },
      {
        ruleKey: "magic-card-print-deterministic-fields",
        matchKind: "deterministic-magic-catalog-item-field-match",
        normalizedKind: "magic-card-print",
        referenceRecord: {
          typeKey: "set",
          keyPath: "setName",
          targetFieldKey: "set",
        },
        fieldMatches: [
          { fieldKey: "cardNumber", valuePath: "cardNumber" },
          { fieldKey: "cardName", valuePath: "name", valueTransform: "localized-text" },
        ],
      },
      {
        ruleKey: "future-provider-bridge-review",
        matchKind: "future-provider-bridge-match",
        bridgeReferenceProviderKeys: ["tcgplayer", "mtgjson"],
        candidatePolicy: "review-only",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const scryfallMtgImageEvidenceProviderProfile = {
  ...scryfallMtgCardPrintProviderProfile,
  displayName: "Scryfall Image Evidence",
  capabilities: ["source-observation-import", "external-reference-extraction"],
} as const satisfies CatalogProviderIntegrationProfile;
