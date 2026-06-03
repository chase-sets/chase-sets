import type { JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingContractDiagnostic,
  CatalogProviderMappingSourceContract,
  CatalogProviderProfileFixtureContract,
  CatalogProviderProfileLifecycle,
} from "./provider-integration-mapping-contract";
import {
  catalogProviderRequiredFixtureFlows,
  validateCatalogProviderExecutableMappingContract,
} from "./provider-integration-mapping-contract";

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
  dimensions: readonly CatalogProviderSelectedOptionDimensionMapping[];
  productReferenceRule: Readonly<{
    providerKey: "tcgplayer";
    externalKeyPrefix: "sku:";
    requiredSourceKeys: readonly ("sku" | "condition" | "variant" | "language")[];
    missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence";
  }>;
}>;

export type CatalogProviderSelectedOptionDimensionMapping = Readonly<{
  dimensionKey: string;
  providerValue: Readonly<{
    source: "payload" | "record";
    path: string;
  }>;
  required: boolean;
  unknownPolicy: "review-evidence";
  optionAliases?: readonly CatalogProviderSelectedOptionAliasMapping[];
  valueMappings?: readonly CatalogProviderSelectedOptionValueMapping[];
}>;

export type CatalogProviderSelectedOptionAliasMapping = Readonly<{
  optionKey: string;
  providerValues: readonly string[];
}>;

export type CatalogProviderSelectedOptionValueMapping = Readonly<{
  from: JsonValue;
  value: string;
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

export type CatalogProviderIntegrationProfileCompatibilityMode =
  | "executable-mapping-contract"
  | "transitional-static-profile";

export type CatalogProviderIntegrationProfileRetirementPlan = Readonly<{
  trackingIssue: number;
  removeAfter: "executable-mapping-contract-activated";
  diagnosticText: string;
}>;

export type CatalogProviderIntegrationProfileVersionRecord = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  lifecycle: CatalogProviderProfileLifecycle;
  active: boolean;
  profile: CatalogProviderIntegrationProfile;
  sourceContract: CatalogProviderMappingSourceContract;
  fixtures: CatalogProviderProfileFixtureContract;
  compatibilityMode: CatalogProviderIntegrationProfileCompatibilityMode;
  retirementPlan: CatalogProviderIntegrationProfileRetirementPlan | null;
  executableMappingContract?: CatalogProviderExecutableMappingContract;
}>;

export type CatalogProviderIntegrationProfileVersionDiagnostic = Readonly<{
  code:
    | "provider-key-mismatch"
    | "missing-profile-version"
    | "missing-profile-fixture-flow"
    | "missing-retirement-plan"
    | "missing-executable-mapping-contract"
    | "mapping-contract-mismatch"
    | "mapping-contract-diagnostic";
  path: string;
  diagnosticText: string;
  mappingDiagnostic?: CatalogProviderMappingContractDiagnostic;
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
    dimensions: [
      {
        dimensionKey: "condition",
        providerValue: { source: "record", path: "condition" },
        required: true,
        unknownPolicy: "review-evidence",
        optionAliases: [
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
        optionAliases: [
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
        optionAliases: [{ optionKey: "english", providerValues: ["English", "EN"] }],
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
        optionAliases: [
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
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const catalogProviderIntegrationProfiles = [
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
] as const satisfies readonly CatalogProviderIntegrationProfile[];

export const catalogProviderIntegrationProfileVersions = [
  {
    providerKey: "tcgdex",
    profileKey: "pokemon-tcg",
    profileVersion: "2026.06.02",
    lifecycle: "active",
    active: true,
    profile: tcgdexPokemonTcgProviderProfile,
    sourceContract: {
      owner: "chase-sets/catalog",
      repository: "chase-sets/chase-sets",
      commit: "0bde010",
      documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
      fixtureSetVersion: "transitional-static-profile-v1",
    },
    fixtures: {
      fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex",
      coveredFlows: catalogProviderRequiredFixtureFlows,
      liveProviderCallsAllowed: false,
    },
    compatibilityMode: "transitional-static-profile",
    retirementPlan: {
      trackingIssue: 621,
      removeAfter: "executable-mapping-contract-activated",
      diagnosticText:
        "Retire the static TCGdex profile wrapper after the executable mapping contract drives normalization, reference extraction, and promotion planning.",
    },
  },
  {
    providerKey: "tcgplayer",
    profileKey: "pokemon-tcg-automation-client",
    profileVersion: "2026.06.02",
    lifecycle: "test",
    active: false,
    profile: tcgplayerAutomationClientProviderProfile,
    sourceContract: {
      owner: "todd-skelton",
      repository: "todd-skelton/tcgplayer-automation-app",
      commit: "bf42aa8",
      documentPath: "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
      fixtureSetVersion: "automation-client-contract-v1",
    },
    fixtures: {
      fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-automation",
      coveredFlows: catalogProviderRequiredFixtureFlows,
      liveProviderCallsAllowed: false,
    },
    compatibilityMode: "transitional-static-profile",
    retirementPlan: {
      trackingIssue: 621,
      removeAfter: "executable-mapping-contract-activated",
      diagnosticText:
        "Retire the static TCGplayer automation profile wrapper after the executable mapping contract covers product lines, set names, product details, SKUs, selected Options, and external references.",
    },
  },
] as const satisfies readonly CatalogProviderIntegrationProfileVersionRecord[];

export function listCatalogProviderIntegrationProfiles(): readonly CatalogProviderIntegrationProfile[] {
  return listCatalogProviderIntegrationProfileVersions().map((version) => version.profile);
}

export function getCatalogProviderIntegrationProfile(providerKey: string): CatalogProviderIntegrationProfile | null {
  return getCatalogProviderIntegrationProfileVersion(providerKey)?.profile ?? null;
}

export function listCatalogProviderIntegrationProfileVersions(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  return [...versions].sort((left, right) =>
    left.providerKey === right.providerKey
      ? right.profileVersion.localeCompare(left.profileVersion)
      : left.providerKey.localeCompare(right.providerKey),
  );
}

export function getCatalogProviderIntegrationProfileVersion(
  providerKey: string,
  profileVersion?: string | null,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const normalizedProviderKey = normalizeProviderKey(providerKey);
  const normalizedVersion = profileVersion?.trim() ?? "";
  const candidates = versions.filter((version) => normalizeProviderKey(version.providerKey) === normalizedProviderKey);

  if (normalizedVersion.length > 0) {
    return candidates.find((version) => version.profileVersion === normalizedVersion) ?? null;
  }

  return (
    candidates.find((version) => version.active) ??
    candidates.find((version) => version.lifecycle === "test") ??
    candidates.find((version) => version.lifecycle === "draft") ??
    null
  );
}

export function getActiveCatalogProviderIntegrationProfileVersion(
  providerKey: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const normalizedProviderKey = normalizeProviderKey(providerKey);
  return (
    versions.find(
      (version) =>
        normalizeProviderKey(version.providerKey) === normalizedProviderKey &&
        version.active &&
        version.lifecycle === "active",
    ) ?? null
  );
}

export function validateCatalogProviderIntegrationProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): readonly CatalogProviderIntegrationProfileVersionDiagnostic[] {
  const diagnostics: CatalogProviderIntegrationProfileVersionDiagnostic[] = [];

  if (normalizeProviderKey(version.providerKey) !== normalizeProviderKey(version.profile.providerKey)) {
    diagnostics.push({
      code: "provider-key-mismatch",
      path: "profile.providerKey",
      diagnosticText: "The profile payload provider key must match the version record provider key.",
    });
  }

  if (version.profileVersion.trim().length === 0) {
    diagnostics.push({
      code: "missing-profile-version",
      path: "profileVersion",
      diagnosticText: "Provider profile versions must carry a version for replay and rollback.",
    });
  }

  for (const flow of catalogProviderRequiredFixtureFlows) {
    if (!version.fixtures.coveredFlows.includes(flow)) {
      diagnostics.push({
        code: "missing-profile-fixture-flow",
        path: "fixtures.coveredFlows",
        diagnosticText: `Provider profile fixtures must cover the ${flow} flow before activation.`,
      });
    }
  }

  if (version.compatibilityMode === "transitional-static-profile") {
    if (!version.retirementPlan) {
      diagnostics.push({
        code: "missing-retirement-plan",
        path: "retirementPlan",
        diagnosticText: "Transitional static provider profiles must carry an explicit retirement path.",
      });
    }
    return diagnostics;
  }

  if (!version.executableMappingContract) {
    diagnostics.push({
      code: "missing-executable-mapping-contract",
      path: "executableMappingContract",
      diagnosticText: "Executable profile versions must carry a mapping contract before activation.",
    });
    return diagnostics;
  }

  if (
    normalizeProviderKey(version.executableMappingContract.providerKey) !== normalizeProviderKey(version.providerKey) ||
    version.executableMappingContract.profileKey !== version.profileKey ||
    version.executableMappingContract.profileVersion !== version.profileVersion ||
    version.executableMappingContract.lifecycle !== version.lifecycle
  ) {
    diagnostics.push({
      code: "mapping-contract-mismatch",
      path: "executableMappingContract",
      diagnosticText: "The executable mapping contract identity must match the profile version record.",
    });
  }

  for (const mappingDiagnostic of validateCatalogProviderExecutableMappingContract(version.executableMappingContract)) {
    diagnostics.push({
      code: "mapping-contract-diagnostic",
      path: `executableMappingContract.${mappingDiagnostic.path}`,
      diagnosticText: mappingDiagnostic.diagnosticText,
      mappingDiagnostic,
    });
  }

  return diagnostics;
}

export function activateCatalogProviderIntegrationProfileVersion(
  providerKey: string,
  profileVersion: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  const normalizedProviderKey = normalizeProviderKey(providerKey);
  const target = getCatalogProviderIntegrationProfileVersion(providerKey, profileVersion, versions);
  if (!target) {
    throw new Error(`Catalog provider profile version ${normalizedProviderKey}@${profileVersion} was not found.`);
  }

  const diagnostics = validateCatalogProviderIntegrationProfileVersion({
    ...target,
    lifecycle: "active",
    active: true,
    executableMappingContract: target.executableMappingContract
      ? {
          ...target.executableMappingContract,
          lifecycle: "active",
        }
      : undefined,
  });
  if (diagnostics.length > 0) {
    throw new Error(
      `Catalog provider profile version ${normalizedProviderKey}@${profileVersion} failed activation validation: ${diagnostics
        .map((diagnostic) => diagnostic.diagnosticText)
        .join(" ")}`,
    );
  }

  return versions.map((version) => {
    if (normalizeProviderKey(version.providerKey) !== normalizedProviderKey) {
      return version;
    }
    if (version.profileVersion === profileVersion) {
      return {
        ...version,
        lifecycle: "active",
        active: true,
        executableMappingContract: version.executableMappingContract
          ? {
              ...version.executableMappingContract,
              lifecycle: "active",
            }
          : undefined,
      };
    }
    return version.active
      ? {
          ...version,
          lifecycle: "deprecated",
          active: false,
          executableMappingContract: version.executableMappingContract
            ? {
                ...version.executableMappingContract,
                lifecycle: "deprecated",
              }
            : undefined,
        }
      : version;
  });
}

export function rollbackCatalogProviderIntegrationProfileVersion(
  providerKey: string,
  rollbackToProfileVersion: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  return activateCatalogProviderIntegrationProfileVersion(providerKey, rollbackToProfileVersion, versions);
}

export function metadataObject(entries: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  return entries;
}

function normalizeProviderKey(providerKey: string): string {
  return providerKey.trim().toLowerCase();
}
