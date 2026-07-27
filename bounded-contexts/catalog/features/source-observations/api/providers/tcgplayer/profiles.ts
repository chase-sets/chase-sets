import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogProviderIntegrationProfile } from "../profile-types";
import { tcgdexPokemonTcgProviderProfile } from "../tcgdex/profiles";

export const tcgplayerAutomationClientProviderProfile = {
  providerKey: "tcgplayer",
  displayName: "TCGplayer Pokemon Single Cards",
  status: "active",
  capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
  supportedScopes: ["product-line/category", "set-name", "product", "sku"],
  languageOptions: ["en"],
  optionQueries: [
    {
      queryKind: "product-lines",
      queryKeySynonyms: ["product-line", "categories"],
      displayName: "Product Line",
      scope: "product-line/category",
      parentScope: null,
      operation: "tcgplayer-list-product-lines",
      output: {
        valuePath: "productLineId",
        labelPath: "productLineName",
        description: { kind: "path", path: "productLineUrlName" },
        metadataPaths: {
          productLineId: "productLineId",
          productLineName: "productLineName",
          productLineUrlName: "productLineUrlName",
          isDirect: "isDirect",
        },
      },
    },
    {
      queryKind: "set-names",
      queryKeySynonyms: ["set-name", "sets"],
      displayName: "Set Name",
      scope: "set-name",
      parentScope: "product-line/category",
      operation: "tcgplayer-list-set-names",
      parentValue: {
        required: true,
        valueKind: "product-line-id",
        diagnosticText: "TCGplayer set-name option queries require a productLineId/categoryId parent value.",
      },
      output: {
        valuePath: "cleanSetName",
        labelPath: "name",
        description: { kind: "tcgplayer-set-name" },
        parentValuePath: "$parentValue",
        metadataPaths: {
          productLineId: "$parentValueNumber",
          setNameId: "setNameId",
          categoryId: "categoryId",
          cleanSetName: "cleanSetName",
          urlName: "urlName",
          abbreviation: "abbreviation",
          releaseDate: "releaseDate",
          isSupplemental: "isSupplemental",
          active: "active",
        },
      },
    },
    {
      queryKind: "products",
      displayName: "Product",
      scope: "product",
      parentScope: "set-name",
      operation: "tcgplayer-list-products",
      parentValue: {
        required: true,
        valueKind: "series-id",
        diagnosticText: "TCGplayer product option queries require a set-name parent value.",
      },
      output: {
        valuePath: "productId",
        labelPath: "productName",
        metadataPaths: { productId: "productId", productName: "productName" },
      },
    },
    {
      queryKind: "skus",
      displayName: "SKU",
      scope: "sku",
      parentScope: "product",
      operation: "tcgplayer-list-skus",
      parentValue: {
        required: true,
        valueKind: "series-id",
        diagnosticText: "TCGplayer SKU option queries require a Product parent value.",
      },
      output: {
        valuePath: "sku",
        labelPath: "sku",
        metadataPaths: { sku: "sku" },
      },
    },
  ],
  connector: {
    kind: "tcgplayer-automation-client",
    sourceRepository: {
      owner: "todd-skelton",
      name: "tcgplayer-automation-app",
      commit: "bf42aa8",
    },
    sourceContractDocument: "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
    authentication: {
      scheme: "tcgplayer-production-cookie",
      cookieName: "TCGAuthTicket_Production",
      userAgentRequired: true,
    },
    domains: {
      search: "mp-search-api.tcgplayer.com",
      marketplaceApi: "mpapi.tcgplayer.com",
      infiniteApi: "infinite-api.tcgplayer.com",
      marketplaceGateway: "mpgateway.tcgplayer.com",
    },
    retryStatusCodes: [403, 429, 502, 503, 504],
    throttling: {
      strategy: "domain-adaptive",
      controls: ["request-delay", "cooldown", "max-concurrency", "learned-min-delay"],
    },
    catalogFlow: {
      productLineScope: "product-lines",
      setScope: "catalog-set-names-by-product-line",
      productScope: "product-search-by-set",
      detailScope: "product-detail-with-skus",
      detectsProductSetReclassification: true,
    },
    externalReferencePolicy: {
      catalogItemReferencePrefix: "product:",
      productReferencePrefix: "sku:",
      productConditionIdSource: "sku-product-condition-id",
    },
    catalogBoundary: {
      acceptedEvidence: ["product-id", "sku-id", "product-condition-id", "set-name", "product-line"],
      excludedEvidence: ["listing-price", "sales-history", "order", "message", "seller-inventory"],
    },
  },
  normalizedObservationMapping: {
    kind: "pokemon-card",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified TCGplayer Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: tcgdexPokemonTcgProviderProfile.catalogFieldMapping,
  referenceHierarchyMapping: {
    providerReferenceIdPrefix: "ref_tcgplayer",
    providerAttributes: [
      { typeKey: "series", providerAttributeKey: "tcgplayer-product-line-id" },
      { typeKey: "expansion", providerAttributeKey: "tcgplayer-set-name" },
    ],
    targetRecordRuleKey: "set-name",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.manufacturer,
        typeKey: "manufacturer",
        name: "Manufacturer",
        descriptionText: "A company responsible for publishing or manufacturing catalog products.",
        attributeKeys: ["homepage-url"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "tcgplayer-product-line-id"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.expansion,
        typeKey: "expansion",
        name: "Expansion",
        descriptionText: "A provider catalog set, expansion, or release group.",
        attributeKeys: ["tcgplayer-set-name", "tcgplayer-set-id"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "manufacturer",
        typeKey: "manufacturer",
        recordId: {
          kind: "static",
          referenceRecordId: catalogSeedIds.referenceRecords.manufacturers.thePokemonCompanyInternational,
        },
        key: { kind: "static", value: "the-pokemon-company-international" },
        name: { kind: "static", value: "The Pokemon Company International" },
        description: { kind: "static", value: "Publisher of the English Pokemon Trading Card Game." },
        attributes: [{ attributeKey: "homepage-url", value: { kind: "static", value: "https://www.pokemon.com/us" } }],
      },
      {
        ruleKey: "product-line",
        typeKey: "product-line",
        recordId: {
          kind: "provider",
          typeKey: "product-line",
          providerValuePaths: ["productLineId", "productLineName"],
        },
        key: { kind: "path", path: "productLineName" },
        name: { kind: "path", path: "productLineName" },
        description: {
          kind: "template",
          template: "{productLineName} provider product line.",
          values: { productLineName: { kind: "path", path: "productLineName" } },
        },
        requiredPaths: ["productLineName"],
        attributes: [
          { attributeKey: "official-name", value: { kind: "path", path: "productLineName" } },
          { attributeKey: "tcgplayer-product-line-id", value: { kind: "path", path: "productLineId" }, optional: true },
        ],
        relationships: [{ relationshipType: "published-by", ruleKey: "manufacturer" }],
      },
      {
        ruleKey: "set-name",
        typeKey: "expansion",
        recordId: { kind: "provider", typeKey: "expansion", providerValuePaths: ["setNameId", "setName"] },
        key: { kind: "path", path: "setName" },
        name: { kind: "path", path: "setName" },
        description: {
          kind: "template",
          template: "{setName} provider set.",
          values: { setName: { kind: "path", path: "setName" } },
        },
        requiredPaths: ["setName"],
        attributes: [
          { attributeKey: "tcgplayer-set-name", value: { kind: "path", path: "setName" } },
          { attributeKey: "tcgplayer-set-id", value: { kind: "path", path: "setNameId" }, optional: true },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "product-line" }],
      },
    ],
  },
  selectedOptionMapping: {
    source: "tcgplayer-sku-condition-variant-language",
    dimensions: [
      {
        dimensionKey: "condition",
        providerValue: { source: "record", path: "condition" },
        required: true,
        unknownPolicy: "review-evidence",
        valueSynonyms: [
          { optionKey: "pristine", providerValues: ["Pristine"] },
          { optionKey: "mint", providerValues: ["Mint"] },
          { optionKey: "near-mint", providerValues: ["Near Mint", "Near-Mint", "NM"] },
          { optionKey: "excellent", providerValues: ["Excellent", "Lightly Played", "LP"] },
          { optionKey: "good", providerValues: ["Good", "Moderately Played", "MP"] },
          { optionKey: "poor", providerValues: ["Poor", "Heavily Played", "HP"] },
          { optionKey: "damaged", providerValues: ["Damaged", "DMG"] },
        ],
      },
      {
        dimensionKey: "printing",
        providerValue: { source: "record", path: "variant" },
        required: false,
        unknownPolicy: "review-evidence",
        valueSynonyms: [
          { optionKey: "normal", providerValues: ["Normal", "Standard"] },
          { optionKey: "holofoil", providerValues: ["Holofoil", "Holo", "Foil"] },
          { optionKey: "reverse-holofoil", providerValues: ["Reverse Holofoil", "Reverse Holo", "Reverse"] },
        ],
      },
      {
        dimensionKey: "language",
        providerValue: { source: "record", path: "language" },
        required: false,
        unknownPolicy: "review-evidence",
        valueSynonyms: [{ optionKey: "english", providerValues: ["English", "EN"] }],
      },
      {
        dimensionKey: "product-form",
        providerValue: { source: "payload", path: "sealed" },
        required: true,
        unknownPolicy: "review-evidence",
        valueMappings: [
          { from: true, value: "unopened" },
          { from: false, value: "single" },
        ],
        valueSynonyms: [
          { optionKey: "unopened", providerValues: ["unopened", "sealed"] },
          { optionKey: "raw", providerValues: ["single", "raw"] },
        ],
      },
    ],
    productReferenceRule: {
      providerKey: "tcgplayer",
      externalKeyPrefix: "sku:",
      requiredSourceKeys: ["sku", "condition", "variant", "language"],
      missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
    },
  },
  externalReferenceExtractionRules: {
    referenceTarget: "mixed",
    rules: [
      {
        providerKey: "tcgplayer",
        target: "catalog-item-reference",
        externalKeyPrefix: "product:",
        containerKeys: ["product", "products", "details"],
        valueKeys: ["productId", "productID", "tcgplayerProductId"],
        recordIdKeys: ["productId", "productID", "id"],
        pricingRootKeys: [],
        pricingScope: "card",
      },
      {
        providerKey: "tcgplayer",
        target: "product-reference",
        externalKeyPrefix: "sku:",
        containerKeys: ["skus", "sku", "conditions"],
        valueKeys: ["sku", "skuId", "skuID", "tcgplayerSkuId"],
        recordIdKeys: ["sku", "skuId", "skuID", "id"],
        pricingRootKeys: [],
        pricingScope: "by-variant",
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
        ruleKey: "exact-external-product-reference",
        matchKind: "exact-external-product-reference",
        sourcePath: "externalProductReferences",
      },
      {
        ruleKey: "sealed-product-deterministic-fields",
        matchKind: "sealed-product-match",
        normalizedKind: "provider-product",
        productFormPath: "mergeIdentity.productForm",
        sealedValues: ["sealed", "unopened"],
        fieldMatches: [],
      },
      {
        ruleKey: "barcode-gtin-review",
        matchKind: "barcode-gtin-match",
        barcodePaths: ["barcode", "mergeIdentity.barcode"],
        candidatePolicy: "review-only",
      },
      {
        ruleKey: "future-provider-bridge-review",
        matchKind: "future-provider-bridge-match",
        bridgeReferenceProviderKeys: ["tcgplayer", "cardmarket"],
        candidatePolicy: "review-only",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const tcgplayerPokemonSingleCardProviderProfile = {
  ...tcgplayerAutomationClientProviderProfile,
  displayName: "TCGplayer Pokemon Single Cards",
  status: "active",
  normalizedObservationMapping: {
    kind: "provider-product",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified TCGplayer Pokemon Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const tcgplayerPokemonSealedProductProviderProfile = {
  ...tcgplayerAutomationClientProviderProfile,
  displayName: "TCGplayer Pokemon Sealed Products",
  status: "active",
  capabilities: [
    "provider-option-query",
    "source-observation-import",
    "catalog-item-promotion",
    "external-reference-extraction",
  ],
  normalizedObservationMapping: {
    kind: "pokemon-sealed-product",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified TCGplayer Pokemon Sealed Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: {
    blueprintKey: "pokemon-sealed-product",
    categoryKey: "sealed-products",
    fieldKeys: {
      cardNumber: "card-number",
      cardName: "card-name",
      expansion: "expansion",
      rarity: "rarity",
      cardVariant: "card-variant",
      cardIllustrator: "card-illustrator",
      releaseYear: "release-year",
      packCount: "pack-count",
    },
  },
  referenceHierarchyMapping: tcgplayerAutomationClientProviderProfile.referenceHierarchyMapping,
  selectedOptionMapping: {
    ...tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
    dimensions: [
      {
        dimensionKey: "product-form",
        providerValue: { source: "payload", path: "sealed" },
        required: true,
        unknownPolicy: "review-evidence",
        valueMappings: [{ from: true, value: "unopened" }],
        valueSynonyms: [{ optionKey: "unopened", providerValues: ["unopened", "sealed", "Sealed"] }],
      },
      {
        dimensionKey: "language",
        providerValue: { source: "record", path: "language" },
        required: false,
        unknownPolicy: "review-evidence",
        valueSynonyms: [{ optionKey: "english", providerValues: ["English", "EN"] }],
      },
    ],
  },
  duplicatePreventionMapping: {
    ...tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping,
    rules: tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping.rules.map((rule) => {
      if (rule.ruleKey === "sealed-product-deterministic-fields") {
        return {
          ...rule,
          normalizedKind: "pokemon-sealed-product",
          sealedValues: ["sealed"],
          fieldMatches: [
            { fieldKey: "cardName", valuePath: "name", valueTransform: "localized-text" },
            { fieldKey: "packCount", valuePath: "packCount" },
          ],
        };
      }
      if (rule.ruleKey === "future-provider-bridge-review") {
        return {
          ...rule,
          bridgeReferenceProviderKeys: ["tcgdex", "tcgplayer"],
        };
      }
      return rule;
    }),
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const tcgplayerMtgSingleCardProviderProfile = {
  ...tcgplayerAutomationClientProviderProfile,
  displayName: "TCGplayer Magic Single Cards",
  status: "active",
  normalizedObservationMapping: {
    kind: "provider-product",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified TCGplayer Magic Variant",
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
    providerReferenceIdPrefix: "ref_tcgplayer_mtg",
    providerAttributes: [
      { typeKey: "product-line", providerAttributeKey: "tcgplayer-product-line-id" },
      { typeKey: "set", providerAttributeKey: "tcgplayer-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "tcgplayer-product-line-id"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A Magic: The Gathering set or release group.",
        attributeKeys: ["tcgplayer-set-name", "tcgplayer-set-id"],
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
          { attributeKey: "short-name", value: { kind: "static", value: "MTG" } },
          { attributeKey: "tcgplayer-product-line-id", value: { kind: "path", path: "productLineId" }, optional: true },
        ],
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["setNameId", "setName"] },
        key: { kind: "path", path: "setName" },
        name: { kind: "path", path: "setName" },
        description: {
          kind: "template",
          template: "{setName} Magic: The Gathering set.",
          values: { setName: { kind: "path", path: "setName" } },
        },
        requiredPaths: ["setName"],
        attributes: [
          { attributeKey: "tcgplayer-set-name", value: { kind: "path", path: "setName" } },
          { attributeKey: "tcgplayer-set-id", value: { kind: "path", path: "setNameId" }, optional: true },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "magic-product-line" }],
      },
    ],
  },
  selectedOptionMapping: {
    ...tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
    dimensions: tcgplayerAutomationClientProviderProfile.selectedOptionMapping.dimensions.map((dimension) =>
      dimension.dimensionKey === "printing"
        ? {
            ...dimension,
            valueSynonyms: [
              { optionKey: "normal", providerValues: ["Normal", "Standard", "Nonfoil", "Non-Foil"] },
              { optionKey: "foil", providerValues: ["Foil", "Holofoil"] },
            ],
          }
        : dimension,
    ),
  },
  duplicatePreventionMapping: {
    ...tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping,
    rules: tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping.rules.map((rule) =>
      rule.ruleKey === "future-provider-bridge-review"
        ? {
            ...rule,
            bridgeReferenceProviderKeys: ["scryfall", "mtgjson", "tcgplayer"],
          }
        : rule,
    ),
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const tcgplayerMtgSealedProductProviderProfile = {
  ...tcgplayerAutomationClientProviderProfile,
  displayName: "TCGplayer Magic Sealed Products",
  status: "active",
  capabilities: [
    "provider-option-query",
    "source-observation-import",
    "catalog-item-promotion",
    "external-reference-extraction",
  ],
  normalizedObservationMapping: {
    kind: "magic-sealed-product",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified TCGplayer Magic Sealed Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: {
    blueprintKey: "magic-sealed-product",
    categoryKey: "magic-booster-packs",
    fieldKeys: {
      cardNumber: "card-number",
      cardName: "card-name",
      set: "set",
      expansion: "set",
      rarity: "rarity",
      cardVariant: "card-variant",
      cardIllustrator: "card-illustrator",
      releaseYear: "release-year",
      packCount: "pack-count",
    },
  },
  referenceHierarchyMapping: tcgplayerMtgSingleCardProviderProfile.referenceHierarchyMapping,
  selectedOptionMapping: {
    ...tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
    dimensions: [
      {
        dimensionKey: "product-form",
        providerValue: { source: "payload", path: "sealed" },
        required: true,
        unknownPolicy: "review-evidence",
        valueMappings: [{ from: true, value: "unopened" }],
        valueSynonyms: [{ optionKey: "unopened", providerValues: ["unopened", "sealed", "Sealed"] }],
      },
      {
        dimensionKey: "language",
        providerValue: { source: "record", path: "language" },
        required: false,
        unknownPolicy: "review-evidence",
        valueSynonyms: [{ optionKey: "english", providerValues: ["English", "EN"] }],
      },
    ],
  },
  duplicatePreventionMapping: {
    ...tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping,
    rules: tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping.rules.map((rule) => {
      if (rule.ruleKey === "sealed-product-deterministic-fields") {
        return {
          ...rule,
          normalizedKind: "magic-sealed-product",
          sealedValues: ["sealed"],
          fieldMatches: [
            { fieldKey: "cardName", valuePath: "name", valueTransform: "localized-text" },
            { fieldKey: "packCount", valuePath: "packCount" },
          ],
        };
      }
      if (rule.ruleKey === "future-provider-bridge-review") {
        return {
          ...rule,
          bridgeReferenceProviderKeys: ["scryfall", "mtgjson", "tcgplayer"],
        };
      }
      return rule;
    }),
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const tcgplayerYugiohSingleCardProviderProfile = {
  ...tcgplayerAutomationClientProviderProfile,
  displayName: "TCGplayer Yu-Gi-Oh Single Cards",
  status: "active",
  normalizedObservationMapping: {
    kind: "provider-product",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified TCGplayer Yu-Gi-Oh Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: {
    blueprintKey: "yugioh-card-print",
    categoryKey: "yugioh-card-prints",
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
    providerReferenceIdPrefix: "ref_tcgplayer_yugioh",
    providerAttributes: [
      { typeKey: "product-line", providerAttributeKey: "tcgplayer-product-line-id" },
      { typeKey: "set", providerAttributeKey: "tcgplayer-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "tcgplayer-product-line-id"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A Yu-Gi-Oh release group.",
        attributeKeys: ["tcgplayer-set-name", "tcgplayer-set-id"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "yugioh-product-line",
        typeKey: "product-line",
        recordId: {
          kind: "provider",
          typeKey: "product-line",
          providerValuePaths: ["productLineId", "productLineName"],
        },
        key: { kind: "static", value: "yu-gi-oh" },
        name: { kind: "path", path: "productLineName" },
        description: { kind: "static", value: "Yu-Gi-Oh trading card game." },
        requiredPaths: ["productLineName"],
        attributes: [
          { attributeKey: "official-name", value: { kind: "path", path: "productLineName" } },
          { attributeKey: "short-name", value: { kind: "static", value: "YGO" } },
          { attributeKey: "tcgplayer-product-line-id", value: { kind: "path", path: "productLineId" }, optional: true },
        ],
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["setNameId", "setName"] },
        key: { kind: "path", path: "setName" },
        name: { kind: "path", path: "setName" },
        description: {
          kind: "template",
          template: "{setName} Yu-Gi-Oh set.",
          values: { setName: { kind: "path", path: "setName" } },
        },
        requiredPaths: ["setName"],
        attributes: [
          { attributeKey: "tcgplayer-set-name", value: { kind: "path", path: "setName" } },
          { attributeKey: "tcgplayer-set-id", value: { kind: "path", path: "setNameId" }, optional: true },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "yugioh-product-line" }],
      },
    ],
  },
  selectedOptionMapping: {
    ...tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
    dimensions: tcgplayerAutomationClientProviderProfile.selectedOptionMapping.dimensions.map((dimension) =>
      dimension.dimensionKey === "printing"
        ? {
            ...dimension,
            valueSynonyms: [
              { optionKey: "unlimited", providerValues: ["Unlimited", "Unlimited Edition"] },
              { optionKey: "first-edition", providerValues: ["1st Edition", "First Edition", "1st"] },
              { optionKey: "limited", providerValues: ["Limited", "Limited Edition"] },
              { optionKey: "duel-terminal", providerValues: ["Duel Terminal"] },
            ],
          }
        : dimension,
    ),
  },
  duplicatePreventionMapping: {
    ...tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping,
    rules: tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping.rules.map((rule) =>
      rule.ruleKey === "future-provider-bridge-review"
        ? {
            ...rule,
            bridgeReferenceProviderKeys: ["ygoprodeck", "ygojson", "tcgplayer"],
          }
        : rule,
    ),
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const tcgplayerOnePieceSingleCardProviderProfile = {
  ...tcgplayerAutomationClientProviderProfile,
  displayName: "TCGplayer One Piece Single Cards",
  status: "active",
  normalizedObservationMapping: {
    kind: "provider-product",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified TCGplayer One Piece Variant",
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
      cardVariant: "card-variant",
      cardIllustrator: "publisher",
      releaseYear: "release-year",
    },
  },
  referenceHierarchyMapping: {
    providerReferenceIdPrefix: "ref_tcgplayer_one_piece",
    providerAttributes: [
      { typeKey: "product-line", providerAttributeKey: "tcgplayer-product-line-id" },
      { typeKey: "set", providerAttributeKey: "tcgplayer-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "tcgplayer-product-line-id"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A One Piece Card Game release group.",
        attributeKeys: ["tcgplayer-set-name", "tcgplayer-set-id"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "one-piece-product-line",
        typeKey: "product-line",
        recordId: {
          kind: "provider",
          typeKey: "product-line",
          providerValuePaths: ["productLineId", "productLineName"],
        },
        key: { kind: "static", value: "one-piece-card-game" },
        name: { kind: "path", path: "productLineName" },
        description: { kind: "static", value: "One Piece Card Game trading card game." },
        requiredPaths: ["productLineName"],
        attributes: [
          { attributeKey: "official-name", value: { kind: "path", path: "productLineName" } },
          { attributeKey: "short-name", value: { kind: "static", value: "OPCG" } },
          { attributeKey: "tcgplayer-product-line-id", value: { kind: "path", path: "productLineId" }, optional: true },
        ],
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["setNameId", "setName"] },
        key: { kind: "path", path: "setName" },
        name: { kind: "path", path: "setName" },
        description: {
          kind: "template",
          template: "{setName} One Piece Card Game set.",
          values: { setName: { kind: "path", path: "setName" } },
        },
        requiredPaths: ["setName"],
        attributes: [
          { attributeKey: "tcgplayer-set-name", value: { kind: "path", path: "setName" } },
          { attributeKey: "tcgplayer-set-id", value: { kind: "path", path: "setNameId" }, optional: true },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "one-piece-product-line" }],
      },
    ],
  },
  selectedOptionMapping: {
    ...tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
    dimensions: tcgplayerAutomationClientProviderProfile.selectedOptionMapping.dimensions.map((dimension) =>
      dimension.dimensionKey === "printing"
        ? {
            ...dimension,
            valueSynonyms: [
              { optionKey: "normal", providerValues: ["Normal", "Standard"] },
              { optionKey: "foil", providerValues: ["Foil", "Holofoil"] },
              { optionKey: "parallel", providerValues: ["Parallel", "Parallel Foil"] },
            ],
          }
        : dimension,
    ),
  },
  duplicatePreventionMapping: {
    ...tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping,
    rules: tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping.rules.map((rule) =>
      rule.ruleKey === "future-provider-bridge-review"
        ? {
            ...rule,
            bridgeReferenceProviderKeys: ["scrydex", "tcgplayer"],
          }
        : rule,
    ),
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const tcgplayerOnePieceSealedProductProviderProfile = {
  ...tcgplayerAutomationClientProviderProfile,
  displayName: "TCGplayer One Piece Sealed Products",
  status: "active",
  normalizedObservationMapping: {
    kind: "provider-product",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified TCGplayer One Piece Sealed Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: {
    blueprintKey: "one-piece-sealed-product",
    categoryKey: "one-piece-sealed-products",
    fieldKeys: {
      cardNumber: "sealed-product-number",
      cardName: "sealed-product-name",
      set: "set",
      expansion: "set",
      rarity: "rarity",
      cardVariant: "sealed-product-form",
      cardIllustrator: "publisher",
      releaseYear: "release-year",
    },
  },
  referenceHierarchyMapping: tcgplayerOnePieceSingleCardProviderProfile.referenceHierarchyMapping,
  selectedOptionMapping: {
    ...tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
    dimensions: [
      {
        dimensionKey: "product-form",
        providerValue: { source: "payload", path: "sealed" },
        required: true,
        unknownPolicy: "review-evidence",
        valueMappings: [{ from: true, value: "unopened" }],
        valueSynonyms: [{ optionKey: "unopened", providerValues: ["unopened", "sealed", "Sealed"] }],
      },
      {
        dimensionKey: "language",
        providerValue: { source: "record", path: "language" },
        required: false,
        unknownPolicy: "review-evidence",
        valueSynonyms: [{ optionKey: "english", providerValues: ["English", "EN"] }],
      },
    ],
  },
  duplicatePreventionMapping: {
    ...tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping,
    rules: tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping.rules.map((rule) =>
      rule.ruleKey === "future-provider-bridge-review"
        ? {
            ...rule,
            bridgeReferenceProviderKeys: ["scrydex", "tcgplayer"],
          }
        : rule,
    ),
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const tcgplayerLorcanaSingleCardProviderProfile = {
  ...tcgplayerAutomationClientProviderProfile,
  displayName: "TCGplayer Lorcana Single Cards",
  status: "active",
  normalizedObservationMapping: {
    kind: "provider-product",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified TCGplayer Lorcana Variant",
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
  referenceHierarchyMapping: {
    providerReferenceIdPrefix: "ref_tcgplayer_lorcana",
    providerAttributes: [
      { typeKey: "product-line", providerAttributeKey: "tcgplayer-product-line-id" },
      { typeKey: "set", providerAttributeKey: "tcgplayer-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "tcgplayer-product-line-id"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A Disney Lorcana release group.",
        attributeKeys: ["tcgplayer-set-name", "tcgplayer-set-id"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "lorcana-product-line",
        typeKey: "product-line",
        recordId: {
          kind: "provider",
          typeKey: "product-line",
          providerValuePaths: ["productLineId", "productLineName"],
        },
        key: { kind: "static", value: "disney-lorcana" },
        name: { kind: "path", path: "productLineName" },
        description: { kind: "static", value: "Disney Lorcana trading card game." },
        requiredPaths: ["productLineName"],
        attributes: [
          { attributeKey: "official-name", value: { kind: "path", path: "productLineName" } },
          { attributeKey: "short-name", value: { kind: "static", value: "Lorcana" } },
          { attributeKey: "tcgplayer-product-line-id", value: { kind: "path", path: "productLineId" }, optional: true },
        ],
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["setNameId", "setName"] },
        key: { kind: "path", path: "setName" },
        name: { kind: "path", path: "setName" },
        description: {
          kind: "template",
          template: "{setName} Disney Lorcana set.",
          values: { setName: { kind: "path", path: "setName" } },
        },
        requiredPaths: ["setName"],
        attributes: [
          { attributeKey: "tcgplayer-set-name", value: { kind: "path", path: "setName" } },
          { attributeKey: "tcgplayer-set-id", value: { kind: "path", path: "setNameId" }, optional: true },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "lorcana-product-line" }],
      },
    ],
  },
  selectedOptionMapping: {
    ...tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
    dimensions: tcgplayerAutomationClientProviderProfile.selectedOptionMapping.dimensions.map((dimension) =>
      dimension.dimensionKey === "printing"
        ? {
            ...dimension,
            valueSynonyms: [
              { optionKey: "normal", providerValues: ["Normal", "Standard"] },
              { optionKey: "foil", providerValues: ["Foil", "Cold Foil", "Holofoil"] },
              { optionKey: "enchanted", providerValues: ["Enchanted", "Alternate Art", "Alt Art"] },
            ],
          }
        : dimension,
    ),
  },
  duplicatePreventionMapping: {
    ...tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping,
    rules: tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping.rules.map((rule) =>
      rule.ruleKey === "future-provider-bridge-review"
        ? {
            ...rule,
            bridgeReferenceProviderKeys: ["lorcanajson", "lorcast", "scrydex", "tcgplayer"],
          }
        : rule,
    ),
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const tcgplayerLorcanaSealedProductProviderProfile = {
  ...tcgplayerAutomationClientProviderProfile,
  displayName: "TCGplayer Lorcana Sealed Products",
  status: "active",
  normalizedObservationMapping: {
    kind: "provider-product",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified TCGplayer Lorcana Sealed Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
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
  referenceHierarchyMapping: tcgplayerLorcanaSingleCardProviderProfile.referenceHierarchyMapping,
  selectedOptionMapping: {
    ...tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
    dimensions: [
      {
        dimensionKey: "product-form",
        providerValue: { source: "payload", path: "sealed" },
        required: true,
        unknownPolicy: "review-evidence",
        valueMappings: [{ from: true, value: "unopened" }],
        valueSynonyms: [{ optionKey: "unopened", providerValues: ["unopened", "sealed", "Sealed"] }],
      },
      {
        dimensionKey: "language",
        providerValue: { source: "record", path: "language" },
        required: false,
        unknownPolicy: "review-evidence",
        valueSynonyms: [{ optionKey: "english", providerValues: ["English", "EN"] }],
      },
    ],
  },
  duplicatePreventionMapping: {
    ...tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping,
    rules: tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping.rules.map((rule) =>
      rule.ruleKey === "future-provider-bridge-review"
        ? {
            ...rule,
            bridgeReferenceProviderKeys: ["lorcanajson", "lorcast", "scrydex", "tcgplayer"],
          }
        : rule,
    ),
  },
} as const satisfies CatalogProviderIntegrationProfile;
