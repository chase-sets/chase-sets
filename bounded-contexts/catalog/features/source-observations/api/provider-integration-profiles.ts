import type { JsonValue } from "@chase-sets/primitives/json";

export type CatalogProviderCapability =
  | "provider-option-query"
  | "source-observation-import"
  | "catalog-item-promotion"
  | "external-reference-extraction";

export type CatalogProviderScope =
  | "language"
  | "series"
  | "expansion"
  | "product/card"
  | "product-line/category"
  | "set-name"
  | "product"
  | "sku";

export type CatalogProviderOptionQuery = Readonly<{
  queryKind: string;
  displayName: string;
  scope: CatalogProviderScope;
  parentScope: CatalogProviderScope | null;
}>;

export type TcgdexJsonConnectorProfile = Readonly<{
  kind: "tcgdex-json";
  baseUrl: string;
  highQualityAssetVariant: string;
  endpoints: Readonly<{
    seriesList: string;
    seriesDetail: string;
    expansionList: string;
    expansionDetail: string;
    productDetail: string;
  }>;
}>;

export type TcgplayerAutomationClientConnectorProfile = Readonly<{
  kind: "tcgplayer-automation-client";
  sourceRepository: Readonly<{
    owner: "todd-skelton";
    name: "tcgplayer-automation-app";
    commit: string;
  }>;
  sourceContractDocument: string;
  authentication: Readonly<{
    scheme: "tcgplayer-production-cookie";
    cookieName: "TCGAuthTicket_Production";
    userAgentRequired: true;
  }>;
  domains: Readonly<{
    search: "mp-search-api.tcgplayer.com";
    marketplaceApi: "mpapi.tcgplayer.com";
    infiniteApi: "infinite-api.tcgplayer.com";
    marketplaceGateway: "mpgateway.tcgplayer.com";
  }>;
  retryStatusCodes: readonly number[];
  throttling: Readonly<{
    strategy: "domain-adaptive";
    controls: readonly ("request-delay" | "cooldown" | "max-concurrency" | "learned-min-delay")[];
  }>;
  catalogFlow: Readonly<{
    productLineScope: "product-lines";
    setScope: "catalog-set-names-by-product-line";
    productScope: "product-search-by-set";
    detailScope: "product-detail-with-skus";
    detectsProductSetReclassification: true;
  }>;
  externalReferencePolicy: Readonly<{
    catalogItemReferencePrefix: "product:";
    productReferencePrefix: "sku:";
    productConditionIdSource: "sku-product-condition-id";
  }>;
  catalogBoundary: Readonly<{
    acceptedEvidence: readonly ("product-id" | "sku-id" | "product-condition-id" | "set-name" | "product-line")[];
    excludedEvidence: readonly ("listing-price" | "sales-history" | "order" | "message" | "seller-inventory")[];
  }>;
}>;

export type CatalogProviderConnectorProfile = TcgdexJsonConnectorProfile | TcgplayerAutomationClientConnectorProfile;

export type CatalogProviderVariantRule = Readonly<{
  variantKey: string;
  sourceKeys: readonly string[];
  displayName: string;
  sortOrder: number;
  parallelSet: boolean;
  pricingKeys?: readonly string[];
}>;

export type CatalogProviderExternalReferenceRule = Readonly<{
  providerKey: string;
  target: "catalog-item-reference" | "product-reference";
  externalKeyPrefix: string;
  containerKeys: readonly string[];
  valueKeys: readonly string[];
  recordIdKeys: readonly string[];
  pricingRootKeys: readonly string[];
  pricingScope: "by-variant" | "card";
}>;

export type CatalogProviderReferenceRecordRule = Readonly<{
  typeKey: "series" | "expansion";
  providerAttributeKey: string;
}>;

export type CatalogProviderSelectedOptionMapping = Readonly<{
  source: "tcgplayer-sku-condition-variant-language";
  dimensions: Readonly<{
    condition: Readonly<{
      sourceKey: "condition";
      dimensionKey: "condition";
      unknownPolicy: "review-evidence";
    }>;
    variant: Readonly<{
      sourceKey: "variant";
      dimensionKey: "printing";
      unknownPolicy: "review-evidence";
    }>;
    language: Readonly<{
      sourceKey: "language";
      dimensionKey: "language";
      unknownPolicy: "review-evidence";
    }>;
    sealedForm: Readonly<{
      sourceKey: "sealed";
      dimensionKey: "product-form";
      sealedOptionKey: "unopened";
      unsealedOptionKey: "single";
      unknownPolicy: "review-evidence";
    }>;
  }>;
  productReferenceRule: Readonly<{
    providerKey: "tcgplayer";
    externalKeyPrefix: "sku:";
    requiredSourceKeys: readonly ("sku" | "condition" | "variant" | "language")[];
    missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence";
  }>;
}>;

export type CatalogProviderIntegrationProfile = Readonly<{
  providerKey: string;
  displayName: string;
  status: "active" | "planned";
  capabilities: readonly CatalogProviderCapability[];
  supportedScopes: readonly CatalogProviderScope[];
  languageOptions: readonly string[];
  optionQueries: readonly CatalogProviderOptionQuery[];
  connector: CatalogProviderConnectorProfile;
  normalizedObservationMapping: Readonly<{
    kind: "pokemon-card";
    variantRules: readonly CatalogProviderVariantRule[];
    unknownVariantLabelPrefix: string;
    duplicateReferenceRule: "drop-repeated-across-variants";
  }>;
  catalogFieldMapping: Readonly<{
    blueprintKey: string;
    categoryKey: string;
    fieldKeys: Readonly<{
      cardNumber: string;
      cardName: string;
      expansion: string;
      rarity: string;
      cardVariant: string;
      cardIllustrator: string;
      releaseYear: string;
    }>;
  }>;
  referenceHierarchyMapping: Readonly<{
    providerReferenceIdPrefix: string;
    providerAttributes: readonly CatalogProviderReferenceRecordRule[];
  }>;
  selectedOptionMapping?: CatalogProviderSelectedOptionMapping;
  externalReferenceExtractionRules: Readonly<{
    referenceTarget: "catalog-item-reference" | "product-reference" | "mixed";
    rules: readonly CatalogProviderExternalReferenceRule[];
  }>;
  ambiguityRules: Readonly<{
    repeatedMarketplaceReference: "skip-reference";
    missingVariantSpecificReference: "leave-unmapped";
  }>;
}>;

export const tcgdexPokemonTcgProviderProfile = {
  providerKey: "tcgdex",
  displayName: "TCGdex",
  status: "active",
  capabilities: [
    "provider-option-query",
    "source-observation-import",
    "catalog-item-promotion",
    "external-reference-extraction",
  ],
  supportedScopes: ["language", "series", "expansion", "product/card"],
  languageOptions: [
    "en",
    "fr",
    "es",
    "it",
    "pt",
    "pt-br",
    "pt-pt",
    "de",
    "nl",
    "pl",
    "ru",
    "ja",
    "ko",
    "zh-tw",
    "id",
    "th",
    "zh-cn",
  ],
  optionQueries: [
    { queryKind: "languages", displayName: "Language", scope: "language", parentScope: null },
    { queryKind: "series", displayName: "Series", scope: "series", parentScope: "language" },
    { queryKind: "expansions", displayName: "Expansion", scope: "expansion", parentScope: "series" },
  ],
  connector: {
    kind: "tcgdex-json",
    baseUrl: "https://api.tcgdex.net/v2",
    highQualityAssetVariant: "high.webp",
    endpoints: {
      seriesList: "/{language}/series",
      seriesDetail: "/{language}/series/{seriesId}",
      expansionList: "/{language}/sets",
      expansionDetail: "/{language}/sets/{expansionId}",
      productDetail: "/{language}/cards/{cardId}",
    },
  },
  normalizedObservationMapping: {
    kind: "pokemon-card",
    variantRules: [
      {
        variantKey: "standard",
        sourceKeys: ["normal", "standard"],
        displayName: "Standard Set",
        sortOrder: 0,
        parallelSet: false,
        pricingKeys: ["normal", "standard"],
      },
      {
        variantKey: "holofoil",
        sourceKeys: ["holo", "holofoil"],
        displayName: "Standard Set Foil",
        sortOrder: 10,
        parallelSet: false,
        pricingKeys: ["holo", "holofoil"],
      },
      {
        variantKey: "1st-edition",
        sourceKeys: ["firstedition", "1stedition", "1st-edition", "first-edition"],
        displayName: "1st Edition",
        sortOrder: 20,
        parallelSet: false,
        pricingKeys: ["1st-edition", "firstEdition"],
      },
      {
        variantKey: "reverse-holo",
        sourceKeys: ["reverse", "reverseholo", "reverseholofoil", "reverse-holo", "reverse-holofoil"],
        displayName: "Parallel Set - Reverse Foil",
        sortOrder: 30,
        parallelSet: true,
        pricingKeys: ["reverse-holofoil", "reverse-holo", "reverse"],
      },
      {
        variantKey: "poke-ball",
        sourceKeys: ["pokeball", "poke-ball"],
        displayName: "Premium Parallel Set - Poke Ball",
        sortOrder: 40,
        parallelSet: true,
        pricingKeys: ["poke-ball", "pokeball"],
      },
      {
        variantKey: "master-ball",
        sourceKeys: ["masterball", "master-ball"],
        displayName: "Premium Parallel Set - Master Ball",
        sortOrder: 50,
        parallelSet: true,
        pricingKeys: ["master-ball", "masterball"],
      },
    ],
    unknownVariantLabelPrefix: "Unclassified Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: {
    blueprintKey: "pokemon-card-single",
    categoryKey: "singles",
    fieldKeys: {
      cardNumber: "card-number",
      cardName: "card-name",
      expansion: "expansion",
      rarity: "rarity",
      cardVariant: "card-variant",
      cardIllustrator: "card-illustrator",
      releaseYear: "release-year",
    },
  },
  referenceHierarchyMapping: {
    providerReferenceIdPrefix: "ref_tcgdex",
    providerAttributes: [
      { typeKey: "series", providerAttributeKey: "tcgdex-series-id" },
      { typeKey: "expansion", providerAttributeKey: "tcgdex-set-id" },
    ],
  },
  externalReferenceExtractionRules: {
    referenceTarget: "mixed",
    rules: [
      {
        providerKey: "tcgplayer",
        target: "catalog-item-reference",
        externalKeyPrefix: "product:",
        containerKeys: ["ids", "marketplaceIds", "marketplaces", "markets", "pricing", "prices"],
        valueKeys: [
          "tcgplayer",
          "tcgPlayer",
          "tcgplayerId",
          "tcgPlayerId",
          "tcgplayerProductId",
          "tcgPlayerProductId",
          "tcgplayer_product_id",
        ],
        recordIdKeys: [
          "productId",
          "productID",
          "id",
          "tcgplayerId",
          "tcgPlayerId",
          "tcgplayerProductId",
          "tcgPlayerProductId",
        ],
        pricingRootKeys: ["tcgplayer", "tcgPlayer"],
        pricingScope: "by-variant",
      },
      {
        providerKey: "cardmarket",
        target: "catalog-item-reference",
        externalKeyPrefix: "product:",
        containerKeys: ["ids", "marketplaceIds", "marketplaces", "markets", "pricing", "prices"],
        valueKeys: [
          "cardmarket",
          "cardMarket",
          "cardmarketId",
          "cardMarketId",
          "cardmarketProductId",
          "cardMarketProductId",
          "idProduct",
          "id_product",
        ],
        recordIdKeys: [
          "idProduct",
          "productId",
          "productID",
          "id",
          "cardmarketId",
          "cardMarketId",
          "cardmarketProductId",
        ],
        pricingRootKeys: ["cardmarket", "cardMarket"],
        pricingScope: "card",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const tcgplayerAutomationClientProviderProfile = {
  providerKey: "tcgplayer",
  displayName: "TCGplayer",
  status: "planned",
  capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
  supportedScopes: ["product-line/category", "set-name", "product", "sku"],
  languageOptions: ["en"],
  optionQueries: [
    { queryKind: "product-lines", displayName: "Product Line", scope: "product-line/category", parentScope: null },
    { queryKind: "set-names", displayName: "Set Name", scope: "set-name", parentScope: "product-line/category" },
    { queryKind: "products", displayName: "Product", scope: "product", parentScope: "set-name" },
    { queryKind: "skus", displayName: "SKU", scope: "sku", parentScope: "product" },
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
  },
  selectedOptionMapping: {
    source: "tcgplayer-sku-condition-variant-language",
    dimensions: {
      condition: {
        sourceKey: "condition",
        dimensionKey: "condition",
        unknownPolicy: "review-evidence",
      },
      variant: {
        sourceKey: "variant",
        dimensionKey: "printing",
        unknownPolicy: "review-evidence",
      },
      language: {
        sourceKey: "language",
        dimensionKey: "language",
        unknownPolicy: "review-evidence",
      },
      sealedForm: {
        sourceKey: "sealed",
        dimensionKey: "product-form",
        sealedOptionKey: "unopened",
        unsealedOptionKey: "single",
        unknownPolicy: "review-evidence",
      },
    },
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
        valueKeys: ["skuId", "skuID", "tcgplayerSkuId"],
        recordIdKeys: ["skuId", "skuID", "id"],
        pricingRootKeys: [],
        pricingScope: "by-variant",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const catalogProviderIntegrationProfiles = [
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
] as const satisfies readonly CatalogProviderIntegrationProfile[];

export function listCatalogProviderIntegrationProfiles(): readonly CatalogProviderIntegrationProfile[] {
  return catalogProviderIntegrationProfiles;
}

export function getCatalogProviderIntegrationProfile(providerKey: string): CatalogProviderIntegrationProfile | null {
  const normalized = providerKey.trim().toLowerCase();
  return catalogProviderIntegrationProfiles.find((profile) => profile.providerKey === normalized) ?? null;
}

export function metadataObject(entries: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  return entries;
}
