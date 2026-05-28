import type { JsonValue } from "@chase-sets/primitives/json";

export type CatalogProviderCapability =
  | "provider-option-query"
  | "source-observation-import"
  | "catalog-item-promotion"
  | "external-reference-extraction";

export type CatalogProviderScope = "language" | "series" | "expansion" | "product/card";

export type CatalogProviderOptionQuery = Readonly<{
  queryKind: string;
  displayName: string;
  scope: CatalogProviderScope;
  parentScope: CatalogProviderScope | null;
}>;

export type CatalogProviderConnectorProfile = Readonly<{
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

export type CatalogProviderIntegrationProfile = Readonly<{
  providerKey: string;
  displayName: string;
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
  externalReferenceExtractionRules: Readonly<{
    referenceTarget: "catalog-item-reference";
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
    referenceTarget: "catalog-item-reference",
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

export const catalogProviderIntegrationProfiles = [
  tcgdexPokemonTcgProviderProfile,
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
