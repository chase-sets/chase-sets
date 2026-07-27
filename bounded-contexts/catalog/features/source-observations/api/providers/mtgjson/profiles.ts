import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogProviderIntegrationProfile, CatalogProviderOptionQuery } from "../profile-types";

const mtgjsonMtgSetOptionQuery = {
  queryKind: "sets",
  queryKeySynonyms: ["set"],
  displayName: "Set",
  scope: "set-name",
  parentScope: null,
  operation: "mtgjson-list-sets",
  output: {
    valuePath: "setCode",
    labelPath: "name",
    description: { kind: "path", path: "releaseDate" },
    metadataPaths: {
      setCode: "setCode",
      releaseDate: "releaseDate",
      totalSetSize: "totalSetSize",
      type: "type",
      mtgjsonVersion: "mtgjsonVersion",
    },
  },
} as const satisfies CatalogProviderOptionQuery;

const mtgjsonMtgCardOptionQuery = {
  queryKind: "cards",
  queryKeySynonyms: ["card"],
  displayName: "Card",
  scope: "product/card",
  parentScope: "set-name",
  operation: "mtgjson-list-cards",
  parentValue: {
    required: true,
    valueKind: "set-code",
    diagnosticText: "MTGJSON card option queries require a selected set code.",
  },
  output: {
    valuePath: "cardId",
    labelPath: "name",
    parentValuePath: "setCode",
    metadataPaths: {
      cardId: "cardId",
      setCode: "setCode",
      setName: "setName",
      collectorNumber: "collectorNumber",
      rarity: "rarity",
      layout: "layout",
      scryfallId: "scryfallId",
    },
  },
} as const satisfies CatalogProviderOptionQuery;

const mtgjsonMtgOptionQueries = [
  mtgjsonMtgSetOptionQuery,
  mtgjsonMtgCardOptionQuery,
] as const satisfies readonly CatalogProviderOptionQuery[];

export const mtgjsonMtgCardReferenceProviderProfile = {
  providerKey: "mtgjson",
  displayName: "MTGJSON",
  status: "active",
  capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
  supportedScopes: ["set-name", "product/card"],
  languageOptions: ["en"],
  optionQueries: mtgjsonMtgOptionQueries,
  connector: {
    kind: "mtgjson-json",
    baseUrl: "https://mtgjson.com/api/v5",
    sourceContractDocument: "bounded-contexts/catalog/docs/catalog-integration-production-signoff.md#magic",
    authentication: {
      scheme: "public-json",
      credentialsRequired: false,
    },
    acceptedEvidence: [
      "mtgjson-uuid",
      "set-code",
      "set-name",
      "collector-number",
      "rarity",
      "layout",
      "finish",
      "scryfall-id",
      "release-date",
      "card-count",
    ],
    excludedEvidence: ["price", "legality", "ruling", "deck", "format"],
  },
  normalizedObservationMapping: {
    kind: "magic-card-print",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified MTGJSON Variant",
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
    providerReferenceIdPrefix: "ref_mtgjson",
    providerAttributes: [
      { typeKey: "set", providerAttributeKey: "mtgjson-set-code" },
      { typeKey: "set", providerAttributeKey: "mtgjson-set-name" },
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
        attributeKeys: ["mtgjson-set-code", "mtgjson-set-name"],
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
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["set.code", "set.name"] },
        key: { kind: "path", path: "set.code" },
        name: { kind: "path", path: "set.name" },
        description: {
          kind: "template",
          template: "{setName} Magic: The Gathering set.",
          values: { setName: { kind: "path", path: "set.name" } },
        },
        requiredPaths: ["set.code", "set.name"],
        attributes: [
          { attributeKey: "mtgjson-set-code", value: { kind: "path", path: "set.code" } },
          { attributeKey: "mtgjson-set-name", value: { kind: "path", path: "set.name" } },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "magic-product-line" }],
      },
    ],
  },
  externalReferenceExtractionRules: {
    referenceTarget: "catalog-item-reference",
    rules: [
      {
        providerKey: "scryfall",
        target: "catalog-item-reference",
        externalKeyPrefix: "card:",
        containerKeys: [],
        valueKeys: ["identifiers.scryfallId"],
        recordIdKeys: ["identifiers.scryfallId"],
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
        ruleKey: "scryfall-bridge-review",
        matchKind: "future-provider-bridge-match",
        bridgeReferenceProviderKeys: ["scryfall", "tcgplayer"],
        candidatePolicy: "review-only",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const mtgjsonMtgSetReferenceProviderProfile = {
  ...mtgjsonMtgCardReferenceProviderProfile,
  displayName: "MTGJSON Set Reference",
  capabilities: ["provider-option-query", "source-observation-import", "reference-data-promotion"],
  supportedScopes: ["set-name"],
  optionQueries: [mtgjsonMtgSetOptionQuery],
  normalizedObservationMapping: {
    ...mtgjsonMtgCardReferenceProviderProfile.normalizedObservationMapping,
    kind: "magic-set-reference",
    unknownVariantLabelPrefix: "Unclassified MTGJSON Set Variant",
  },
  catalogFieldMapping: {
    blueprintKey: "magic-set-reference",
    categoryKey: "magic-sets",
    fieldKeys: {
      cardNumber: "set-code",
      cardName: "set-name",
      set: "set",
      expansion: "set",
      rarity: "set-type",
      cardVariant: "set-type",
      cardIllustrator: "publisher",
      releaseYear: "release-year",
    },
  },
  externalReferenceExtractionRules: {
    referenceTarget: "catalog-item-reference",
    rules: [],
  },
  duplicatePreventionMapping: {
    ambiguousCandidatePolicy: "review-only",
    replayPolicy: "same-profile-version",
    rules: [
      {
        ruleKey: "source-observation-link",
        matchKind: "source-observation-link",
        providerKeySource: "observation-provider",
        externalKey: "language-prefixed-observation-external-key",
      },
    ],
  },
} as const satisfies CatalogProviderIntegrationProfile;
