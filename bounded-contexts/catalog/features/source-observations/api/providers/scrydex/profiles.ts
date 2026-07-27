import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type {
  CatalogProviderIntegrationProfile,
  CatalogProviderOptionQuery,
  ScrydexJsonConnectorProfile,
} from "../profile-types";

export const scrydexConnectorProfile = {
  kind: "scrydex-json",
  sourceContractDocument: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
  transportMode: "live-credentialed",
  fixtureEvidence: "required-for-active-profile-validation",
  authentication: {
    scheme: "scrydex-api-key",
    credentialsRequired: true,
    teamIdentifierRequired: true,
    retainedCredentialMaterial: "never",
  },
  requestPolicy: {
    normalImportStrategy: "bulk-first",
    allowedOperations: [
      "bulk-list-sets",
      "bulk-list-cards",
      "bulk-list-sealed-products",
      "usage-summary",
      "webhook-freshness",
    ],
    forbiddenNormalOperations: ["one-call-per-card", "one-call-per-variant", "one-call-per-sealed-product"],
    selectedFieldsOnly: true,
    highestSafePageSizeRequired: true,
    perRecordFallbackPolicy: "documented-tested-preflighted-operator-visible",
  },
  usageSummaryPolicy: {
    retention: "redacted-summary-only",
    fields: [
      "estimated-request-count",
      "actual-request-count",
      "page-count",
      "cache-hit-count",
      "cache-miss-count",
      "usage-check-state",
      "credit-diagnostic",
      "degraded-diagnostic",
    ],
  },
  acceptedEvidence: [
    "scrydex-card-id",
    "scrydex-variant-id",
    "scrydex-set-id",
    "scrydex-sealed-product-id",
    "set-code",
    "set-name",
    "card-number",
    "ink-color",
    "language",
    "image-url",
    "tcgplayer-id",
    "freshness-diagnostic",
    "redacted-usage-summary",
  ],
  excludedEvidence: [
    "raw-provider-body",
    "api-key",
    "team-id",
    "seller",
    "inventory",
    "listing",
    "order",
    "message",
    "unapproved-price-history",
  ],
} as const satisfies ScrydexJsonConnectorProfile;

export const scrydexOnePieceConnectorProfile = scrydexConnectorProfile;

const scrydexOnePieceOptionQueries = [
  {
    queryKind: "sets",
    queryKeySynonyms: ["set"],
    displayName: "Set",
    scope: "set-name",
    parentScope: null,
    operation: "scrydex-one-piece-list-sets",
    output: {
      valuePath: "expansionId",
      labelPath: "name",
      description: { kind: "path", path: "releaseDate" },
      metadataPaths: {
        expansionId: "expansionId",
        code: "code",
        releaseDate: "releaseDate",
        total: "total",
        language: "language",
        languageCode: "languageCode",
      },
    },
  },
  {
    queryKind: "cards",
    queryKeySynonyms: ["card"],
    displayName: "Card",
    scope: "product/card",
    parentScope: "set-name",
    operation: "scrydex-one-piece-list-cards",
    parentValue: {
      required: true,
      valueKind: "set-id",
      diagnosticText: "Scrydex One Piece card option queries require a selected set.",
    },
    output: {
      valuePath: "cardId",
      labelPath: "name",
      parentValuePath: "expansionId",
      metadataPaths: {
        cardId: "cardId",
        expansionId: "expansionId",
        number: "number",
        printedNumber: "printedNumber",
        rarity: "rarity",
        rarityCode: "rarityCode",
        type: "type",
        language: "language",
        languageCode: "languageCode",
      },
    },
  },
  {
    queryKind: "sealed-products",
    queryKeySynonyms: ["sealed-product", "products", "product"],
    displayName: "Sealed Product",
    scope: "product",
    parentScope: "set-name",
    operation: "scrydex-one-piece-list-sealed-products",
    parentValue: {
      required: true,
      valueKind: "set-id",
      diagnosticText: "Scrydex One Piece sealed-product option queries require a selected set.",
    },
    output: {
      valuePath: "sealedProductId",
      labelPath: "name",
      parentValuePath: "expansionId",
      metadataPaths: {
        sealedProductId: "sealedProductId",
        expansionId: "expansionId",
        type: "type",
        language: "language",
        languageCode: "languageCode",
      },
    },
  },
] as const satisfies readonly CatalogProviderOptionQuery[];

export const scrydexOnePieceCardPrintProviderProfile = {
  providerKey: "scrydex",
  displayName: "Scrydex One Piece Cards",
  status: "active",
  capabilities: [
    "provider-option-query",
    "source-observation-import",
    "catalog-item-promotion",
    "external-reference-extraction",
  ],
  supportedScopes: ["set-name", "product/card"],
  languageOptions: ["en"],
  optionQueries: [scrydexOnePieceOptionQueries[0], scrydexOnePieceOptionQueries[1]],
  connector: scrydexOnePieceConnectorProfile,
  normalizedObservationMapping: {
    kind: "one-piece-card-print",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified Scrydex One Piece Card Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: {
    blueprintKey: "one-piece-card-print",
    categoryKey: "one-piece-card-prints",
    fieldKeys: {
      cardNumber: "card-number",
      cardName: "card-name",
      set: "set",
      expansion: "set",
      rarity: "rarity",
      cardVariant: "card-type",
      cardIllustrator: "publisher",
      releaseYear: "release-year",
    },
  },
  referenceHierarchyMapping: scrydexOnePieceReferenceHierarchyMapping({
    setIdPath: "card.expansion.id",
    setNamePath: "card.expansion.name",
    setCodePath: "card.expansion.code",
    setReleaseDatePath: "card.expansion.release_date",
  }),
  externalReferenceExtractionRules: { referenceTarget: "catalog-item-reference", rules: [] },
  duplicatePreventionMapping: scrydexOnePieceDuplicatePreventionMapping(),
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const scrydexOnePieceSetReferenceProviderProfile = {
  ...scrydexOnePieceCardPrintProviderProfile,
  displayName: "Scrydex One Piece Set Reference",
  capabilities: ["provider-option-query", "source-observation-import", "reference-data-promotion"],
  supportedScopes: ["set-name"],
  optionQueries: [scrydexOnePieceOptionQueries[0]],
  normalizedObservationMapping: {
    ...scrydexOnePieceCardPrintProviderProfile.normalizedObservationMapping,
    kind: "one-piece-set-reference",
    unknownVariantLabelPrefix: "Unclassified Scrydex One Piece Set Variant",
  },
  catalogFieldMapping: {
    blueprintKey: "one-piece-set-reference",
    categoryKey: "one-piece-sets",
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
  referenceHierarchyMapping: scrydexOnePieceReferenceHierarchyMapping({
    setIdPath: "expansion.id",
    setNamePath: "expansion.name",
    setCodePath: "expansion.code",
    setReleaseDatePath: "expansion.release_date",
  }),
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

export const scrydexOnePieceSealedProductProviderProfile = {
  ...scrydexOnePieceCardPrintProviderProfile,
  displayName: "Scrydex One Piece Sealed Products",
  supportedScopes: ["set-name", "product"],
  optionQueries: [scrydexOnePieceOptionQueries[0], scrydexOnePieceOptionQueries[2]],
  normalizedObservationMapping: {
    ...scrydexOnePieceCardPrintProviderProfile.normalizedObservationMapping,
    kind: "one-piece-sealed-product",
    unknownVariantLabelPrefix: "Unclassified Scrydex One Piece Sealed Product Variant",
  },
  catalogFieldMapping: {
    blueprintKey: "one-piece-sealed-product",
    categoryKey: "one-piece-sealed-products",
    fieldKeys: {
      cardNumber: "sealed-product-id",
      cardName: "sealed-product-name",
      set: "set",
      expansion: "set",
      rarity: "product-kind",
      cardVariant: "sealed-product-form",
      cardIllustrator: "publisher",
      releaseYear: "release-year",
      packCount: "pack-count",
    },
  },
  referenceHierarchyMapping: scrydexOnePieceReferenceHierarchyMapping({
    setIdPath: "sealedProduct.expansion.id",
    setNamePath: "sealedProduct.expansion.name",
    setCodePath: "sealedProduct.expansion.code",
    setReleaseDatePath: "sealedProduct.expansion.release_date",
  }),
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
        ruleKey: "one-piece-sealed-product-deterministic-fields",
        matchKind: "deterministic-one-piece-catalog-item-field-match",
        normalizedKind: "one-piece-sealed-product",
        referenceRecord: {
          typeKey: "set",
          keyPath: "setName",
          targetFieldKey: "set",
        },
        fieldMatches: [
          { fieldKey: "cardName", valuePath: "name", valueTransform: "localized-text" },
          { fieldKey: "cardVariant", valuePath: "sealedProductForm" },
        ],
      },
      {
        ruleKey: "future-provider-bridge-review",
        matchKind: "future-provider-bridge-match",
        bridgeReferenceProviderKeys: ["tcgplayer"],
        candidatePolicy: "review-only",
      },
    ],
  },
} as const satisfies CatalogProviderIntegrationProfile;

const scrydexLorcanaOptionQueries = [
  {
    queryKind: "sets",
    queryKeySynonyms: ["set"],
    displayName: "Set",
    scope: "set-name",
    parentScope: null,
    operation: "scrydex-lorcana-list-sets",
    output: {
      valuePath: "expansionId",
      labelPath: "name",
      description: { kind: "path", path: "releaseDate" },
      metadataPaths: {
        expansionId: "expansionId",
        code: "code",
        releaseDate: "releaseDate",
        total: "total",
        language: "language",
        languageCode: "languageCode",
      },
    },
  },
  {
    queryKind: "cards",
    queryKeySynonyms: ["card"],
    displayName: "Card",
    scope: "product/card",
    parentScope: "set-name",
    operation: "scrydex-lorcana-list-cards",
    parentValue: {
      required: true,
      valueKind: "set-id",
      diagnosticText: "Scrydex Lorcana card option queries require a selected set.",
    },
    output: {
      valuePath: "cardId",
      labelPath: "name",
      parentValuePath: "expansionId",
      metadataPaths: {
        cardId: "cardId",
        expansionId: "expansionId",
        number: "number",
        printedNumber: "printedNumber",
        rarity: "rarity",
        rarityCode: "rarityCode",
        type: "type",
        inkColor: "inkColor",
        tcgplayerProductId: "tcgplayerProductId",
        language: "language",
        languageCode: "languageCode",
      },
    },
  },
  {
    queryKind: "sealed-products",
    queryKeySynonyms: ["sealed-product", "products", "product"],
    displayName: "Sealed Product",
    scope: "product",
    parentScope: "set-name",
    operation: "scrydex-lorcana-list-sealed-products",
    parentValue: {
      required: true,
      valueKind: "set-id",
      diagnosticText: "Scrydex Lorcana sealed-product option queries require a selected set.",
    },
    output: {
      valuePath: "sealedProductId",
      labelPath: "name",
      parentValuePath: "expansionId",
      metadataPaths: {
        sealedProductId: "sealedProductId",
        expansionId: "expansionId",
        type: "type",
        language: "language",
        languageCode: "languageCode",
      },
    },
  },
] as const satisfies readonly CatalogProviderOptionQuery[];

export const scrydexLorcanaCardPrintProviderProfile = {
  providerKey: "scrydex",
  displayName: "Scrydex Lorcana Cards",
  status: "active",
  capabilities: [
    "provider-option-query",
    "source-observation-import",
    "catalog-item-promotion",
    "external-reference-extraction",
  ],
  supportedScopes: ["set-name", "product/card"],
  languageOptions: ["en"],
  optionQueries: [scrydexLorcanaOptionQueries[0], scrydexLorcanaOptionQueries[1]],
  connector: scrydexConnectorProfile,
  normalizedObservationMapping: {
    kind: "lorcana-card-print",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified Scrydex Lorcana Card Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: {
    blueprintKey: "lorcana-card-print",
    categoryKey: "lorcana-card-prints",
    fieldKeys: {
      cardNumber: "card-number",
      cardName: "card-name",
      set: "set",
      expansion: "set",
      rarity: "rarity",
      cardVariant: "card-type",
      cardIllustrator: "publisher",
      releaseYear: "release-year",
    },
  },
  referenceHierarchyMapping: scrydexLorcanaReferenceHierarchyMapping({
    setIdPath: "card.expansion.id",
    setNamePath: "card.expansion.name",
    setCodePath: "card.expansion.code",
    setReleaseDatePath: "card.expansion.release_date",
  }),
  externalReferenceExtractionRules: {
    referenceTarget: "catalog-item-reference",
    rules: [
      {
        providerKey: "tcgplayer",
        target: "catalog-item-reference",
        externalKeyPrefix: "product:",
        containerKeys: [],
        valueKeys: ["tcgplayerProductId", "card.tcgplayer_id"],
        recordIdKeys: ["tcgplayerProductId", "card.tcgplayer_id"],
        pricingRootKeys: [],
        pricingScope: "card",
      },
    ],
  },
  duplicatePreventionMapping: scrydexLorcanaDuplicatePreventionMapping({
    bridgeReferenceProviderKeys: ["lorcanajson", "lorcast", "tcgplayer"],
  }),
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const scrydexLorcanaSetReferenceProviderProfile = {
  ...scrydexLorcanaCardPrintProviderProfile,
  displayName: "Scrydex Lorcana Set Reference",
  capabilities: ["provider-option-query", "source-observation-import", "reference-data-promotion"],
  supportedScopes: ["set-name"],
  optionQueries: [scrydexLorcanaOptionQueries[0]],
  normalizedObservationMapping: {
    ...scrydexLorcanaCardPrintProviderProfile.normalizedObservationMapping,
    kind: "lorcana-set-reference",
    unknownVariantLabelPrefix: "Unclassified Scrydex Lorcana Set Variant",
  },
  catalogFieldMapping: {
    blueprintKey: "lorcana-set-reference",
    categoryKey: "lorcana-sets",
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
  referenceHierarchyMapping: scrydexLorcanaReferenceHierarchyMapping({
    setIdPath: "expansion.id",
    setNamePath: "expansion.name",
    setCodePath: "expansion.code",
    setReleaseDatePath: "expansion.release_date",
  }),
  externalReferenceExtractionRules: { referenceTarget: "catalog-item-reference", rules: [] },
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

export const scrydexLorcanaSealedProductProviderProfile = {
  ...scrydexLorcanaCardPrintProviderProfile,
  displayName: "Scrydex Lorcana Sealed Products",
  supportedScopes: ["set-name", "product"],
  optionQueries: [scrydexLorcanaOptionQueries[0], scrydexLorcanaOptionQueries[2]],
  normalizedObservationMapping: {
    ...scrydexLorcanaCardPrintProviderProfile.normalizedObservationMapping,
    kind: "lorcana-sealed-product",
    unknownVariantLabelPrefix: "Unclassified Scrydex Lorcana Sealed Product Variant",
  },
  catalogFieldMapping: {
    blueprintKey: "lorcana-sealed-product",
    categoryKey: "lorcana-sealed-products",
    fieldKeys: {
      cardNumber: "sealed-product-number",
      cardName: "sealed-product-name",
      set: "set",
      expansion: "set",
      rarity: "product-kind",
      cardVariant: "sealed-product-form",
      cardIllustrator: "publisher",
      releaseYear: "release-year",
      packCount: "pack-count",
    },
  },
  referenceHierarchyMapping: scrydexLorcanaReferenceHierarchyMapping({
    setIdPath: "sealedProduct.expansion.id",
    setNamePath: "sealedProduct.expansion.name",
    setCodePath: "sealedProduct.expansion.code",
    setReleaseDatePath: "sealedProduct.expansion.release_date",
  }),
  externalReferenceExtractionRules: { referenceTarget: "catalog-item-reference", rules: [] },
  duplicatePreventionMapping: scrydexLorcanaDuplicatePreventionMapping({
    bridgeReferenceProviderKeys: ["tcgplayer"],
  }),
} as const satisfies CatalogProviderIntegrationProfile;

function scrydexOnePieceReferenceHierarchyMapping(
  input: Readonly<{
    setIdPath: string;
    setNamePath: string;
    setCodePath: string;
    setReleaseDatePath: string;
  }>,
): CatalogProviderIntegrationProfile["referenceHierarchyMapping"] {
  return {
    providerReferenceIdPrefix: "ref_scrydex_one_piece",
    providerAttributes: [
      { typeKey: "set", providerAttributeKey: "scrydex-one-piece-set-id" },
      { typeKey: "set", providerAttributeKey: "scrydex-one-piece-set-code" },
      { typeKey: "set", providerAttributeKey: "scrydex-one-piece-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "publisher"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A One Piece Card Game release group.",
        attributeKeys: [
          "scrydex-one-piece-set-id",
          "scrydex-one-piece-set-code",
          "scrydex-one-piece-set-name",
          "release-date",
        ],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "one-piece-product-line",
        typeKey: "product-line",
        recordId: { kind: "static", referenceRecordId: "ref_scrydex_one_piece_product_line" },
        key: { kind: "static", value: "one-piece-card-game" },
        name: { kind: "static", value: "One Piece Card Game" },
        description: { kind: "static", value: "One Piece Card Game trading card game." },
        attributes: [
          { attributeKey: "official-name", value: { kind: "static", value: "One Piece Card Game" } },
          { attributeKey: "short-name", value: { kind: "static", value: "OPCG" } },
          { attributeKey: "publisher", value: { kind: "static", value: "Bandai" } },
        ],
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: [input.setIdPath, input.setCodePath] },
        key: { kind: "path", path: input.setIdPath },
        name: { kind: "path", path: input.setNamePath },
        description: {
          kind: "template",
          template: "{setName} One Piece Card Game set.",
          values: { setName: { kind: "path", path: input.setNamePath } },
        },
        requiredPaths: [input.setIdPath, input.setNamePath],
        attributes: [
          { attributeKey: "scrydex-one-piece-set-id", value: { kind: "path", path: input.setIdPath } },
          {
            attributeKey: "scrydex-one-piece-set-code",
            value: { kind: "path", path: input.setCodePath },
            optional: true,
          },
          { attributeKey: "scrydex-one-piece-set-name", value: { kind: "path", path: input.setNamePath } },
          { attributeKey: "release-date", value: { kind: "path", path: input.setReleaseDatePath }, optional: true },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "one-piece-product-line" }],
      },
    ],
  };
}

function scrydexOnePieceDuplicatePreventionMapping(): CatalogProviderIntegrationProfile["duplicatePreventionMapping"] {
  return {
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
        ruleKey: "one-piece-card-print-deterministic-fields",
        matchKind: "deterministic-one-piece-catalog-item-field-match",
        normalizedKind: "one-piece-card-print",
        referenceRecord: {
          typeKey: "set",
          keyPath: "setName",
          targetFieldKey: "set",
        },
        fieldMatches: [
          { fieldKey: "cardNumber", valuePath: "cardNumber" },
          { fieldKey: "cardName", valuePath: "name", valueTransform: "localized-text" },
          { fieldKey: "cardVariant", valuePath: "cardType" },
        ],
      },
      {
        ruleKey: "future-provider-bridge-review",
        matchKind: "future-provider-bridge-match",
        bridgeReferenceProviderKeys: ["tcgplayer"],
        candidatePolicy: "review-only",
      },
    ],
  };
}

function scrydexLorcanaReferenceHierarchyMapping(
  input: Readonly<{
    setIdPath: string;
    setNamePath: string;
    setCodePath: string;
    setReleaseDatePath: string;
  }>,
): CatalogProviderIntegrationProfile["referenceHierarchyMapping"] {
  return {
    providerReferenceIdPrefix: "ref_scrydex_lorcana",
    providerAttributes: [
      { typeKey: "set", providerAttributeKey: "scrydex-lorcana-set-id" },
      { typeKey: "set", providerAttributeKey: "scrydex-lorcana-set-code" },
      { typeKey: "set", providerAttributeKey: "scrydex-lorcana-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "publisher"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A Disney Lorcana release group.",
        attributeKeys: [
          "scrydex-lorcana-set-id",
          "scrydex-lorcana-set-code",
          "scrydex-lorcana-set-name",
          "release-date",
        ],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "lorcana-product-line",
        typeKey: "product-line",
        recordId: { kind: "static", referenceRecordId: "ref_scrydex_lorcana_product_line" },
        key: { kind: "static", value: "disney-lorcana" },
        name: { kind: "static", value: "Disney Lorcana" },
        description: { kind: "static", value: "Disney Lorcana trading card game." },
        attributes: [
          { attributeKey: "official-name", value: { kind: "static", value: "Disney Lorcana" } },
          { attributeKey: "short-name", value: { kind: "static", value: "Lorcana" } },
          { attributeKey: "publisher", value: { kind: "static", value: "Ravensburger" } },
        ],
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: [input.setIdPath, input.setCodePath] },
        key: { kind: "path", path: input.setIdPath },
        name: { kind: "path", path: input.setNamePath },
        description: {
          kind: "template",
          template: "{setName} Disney Lorcana set.",
          values: { setName: { kind: "path", path: input.setNamePath } },
        },
        requiredPaths: [input.setIdPath, input.setNamePath],
        attributes: [
          { attributeKey: "scrydex-lorcana-set-id", value: { kind: "path", path: input.setIdPath } },
          {
            attributeKey: "scrydex-lorcana-set-code",
            value: { kind: "path", path: input.setCodePath },
            optional: true,
          },
          { attributeKey: "scrydex-lorcana-set-name", value: { kind: "path", path: input.setNamePath } },
          { attributeKey: "release-date", value: { kind: "path", path: input.setReleaseDatePath }, optional: true },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "lorcana-product-line" }],
      },
    ],
  };
}

function scrydexLorcanaDuplicatePreventionMapping(input: {
  bridgeReferenceProviderKeys: readonly string[];
}): CatalogProviderIntegrationProfile["duplicatePreventionMapping"] {
  return {
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
        ruleKey: "future-provider-bridge-review",
        matchKind: "future-provider-bridge-match",
        bridgeReferenceProviderKeys: input.bridgeReferenceProviderKeys,
        candidatePolicy: "review-only",
      },
    ],
  };
}

export const scrydexScryfallCardProviderProfile = {
  providerKey: "scrydex",
  displayName: "Scrydex",
  status: "planned",
  capabilities: ["source-observation-import", "catalog-item-promotion", "external-reference-extraction"],
  supportedScopes: ["product/card"],
  languageOptions: ["en"],
  optionQueries: [],
  connector: {
    kind: "scrydex-scryfall-json",
    sourceContractDocument: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
    fixtureBackedOnly: true,
    acceptedEvidence: [
      "scryfall-id",
      "set-code",
      "set-name",
      "collector-number",
      "language",
      "image-url",
      "tcgplayer-id",
    ],
    excludedEvidence: ["price", "seller", "inventory", "ruling", "legality"],
  },
  normalizedObservationMapping: {
    kind: "magic-card-print",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified Scrydex Variant",
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
    providerReferenceIdPrefix: "ref_scrydex",
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
        bridgeReferenceProviderKeys: ["tcgplayer"],
        candidatePolicy: "review-only",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;
