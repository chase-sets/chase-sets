import type { JsonValue } from "@chase-sets/primitives/json";
import { catalogSeedIds } from "../../../support/seed-support/ids";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingContractDiagnostic,
  CatalogProviderMappingSourceContract,
  CatalogProviderProfileFixtureContract,
  CatalogProviderProfileLifecycle,
} from "./provider-integration-mapping-contract";
import { validateCatalogProviderExecutableMappingContract } from "./provider-integration-mapping-contract";
import { evaluateCatalogIntegrationFixtureCoverageFromProfileVersion } from "./catalog-integration-fixture-lifecycle";
import type { CatalogProviderSourceObservationMappingContract } from "./provider-source-observation-normalizer";
import { scrydexScryfallCardSourceObservationMappingContract } from "./scrydex-executable-mapping-contract";
import { tcgplayerProviderProductSourceObservationMappingContract } from "./tcgplayer-executable-mapping-contract";
import { tcgdexPokemonCardSourceObservationMappingContract } from "./tcgdex-executable-mapping-contract";

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
  aliases?: readonly string[];
  displayName: string;
  scope: CatalogProviderScope;
  parentScope: CatalogProviderScope | null;
  operation: CatalogProviderOptionQueryOperation;
  parentValue?: Readonly<{
    required: boolean;
    valueKind: "language-code" | "series-id" | "product-line-id";
    diagnosticText: string;
  }>;
  output: CatalogProviderOptionQueryOutputMapping;
}>;

export type CatalogProviderOptionQueryOperation =
  | "catalog-provider-profiles"
  | "tcgdex-list-languages"
  | "tcgdex-list-series"
  | "tcgdex-list-expansions"
  | "tcgplayer-list-product-lines"
  | "tcgplayer-list-set-names"
  | "tcgplayer-list-products"
  | "tcgplayer-list-skus"
  | "scrydex-list-sets";

export type CatalogProviderOptionQueryOutputMapping = Readonly<{
  valuePath: string;
  labelPath: string;
  description?: CatalogProviderOptionQueryDescriptionMapping;
  parentValuePath?: string;
  imageUrlPath?: string;
  imageUrlCoalescePaths?: readonly string[];
  metadataPaths: Readonly<Record<string, string>>;
}>;

export type CatalogProviderOptionQueryDescriptionMapping =
  | Readonly<{ kind: "path"; path: string }>
  | Readonly<{ kind: "tcgdex-expansion-card-count" }>
  | Readonly<{ kind: "tcgplayer-set-name" }>;

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

export type ScrydexScryfallJsonConnectorProfile = Readonly<{
  kind: "scrydex-scryfall-json";
  sourceContractDocument: string;
  fixtureBackedOnly: true;
  acceptedEvidence: readonly (
    | "scryfall-id"
    | "set-code"
    | "set-name"
    | "collector-number"
    | "language"
    | "image-url"
    | "tcgplayer-id"
  )[];
  excludedEvidence: readonly ("price" | "seller" | "inventory" | "ruling" | "legality")[];
}>;

export type CatalogProviderConnectorProfile =
  | TcgdexJsonConnectorProfile
  | TcgplayerAutomationClientConnectorProfile
  | ScrydexScryfallJsonConnectorProfile;

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

export type CatalogProviderReferenceHierarchyTypeRule = Readonly<{
  referenceTypeId: string;
  typeKey: string;
  name: string;
  descriptionText: string;
  attributeKeys: readonly string[];
}>;

export type CatalogProviderReferenceHierarchyRecordRule = Readonly<{
  ruleKey: string;
  typeKey: string;
  recordId: CatalogProviderReferenceHierarchyRecordIdRule;
  key: CatalogProviderReferenceHierarchyValueRule;
  name: CatalogProviderReferenceHierarchyValueRule;
  description: CatalogProviderReferenceHierarchyValueRule;
  attributes?: readonly CatalogProviderReferenceHierarchyAttributeRule[];
  relationships?: readonly CatalogProviderReferenceHierarchyRelationshipRule[];
  requiredPaths?: readonly string[];
}>;

export type CatalogProviderReferenceHierarchyRecordIdRule =
  | Readonly<{ kind: "static"; referenceRecordId: string }>
  | Readonly<{ kind: "provider"; typeKey: string; providerValuePaths: readonly string[] }>;

export type CatalogProviderReferenceHierarchyValueRule =
  | Readonly<{ kind: "static"; value: string }>
  | Readonly<{ kind: "path"; path: string }>
  | Readonly<{
      kind: "template";
      template: string;
      values: Readonly<Record<string, CatalogProviderReferenceHierarchyValueRule>>;
    }>;

export type CatalogProviderReferenceHierarchyAttributeRule = Readonly<{
  attributeKey: string;
  value: CatalogProviderReferenceHierarchyValueRule;
  optional?: boolean;
}>;

export type CatalogProviderReferenceHierarchyRelationshipRule = Readonly<{
  relationshipType: string;
  ruleKey: string;
  fallbackRuleKey?: string;
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

export type CatalogProviderDuplicatePreventionMapping = Readonly<{
  ambiguousCandidatePolicy: "block-promotion" | "review-only";
  replayPolicy: "same-profile-version" | "operator-reapply-active-version";
  rules: readonly CatalogProviderDuplicatePreventionIdentityRule[];
}>;

export type CatalogProviderDuplicatePreventionIdentityRule =
  | CatalogProviderExactExternalCatalogItemReferenceRule
  | CatalogProviderSourceObservationLinkRule
  | CatalogProviderDeterministicPokemonCardFieldMatchRule
  | CatalogProviderPartialDraftPokemonCardMatchRule
  | CatalogProviderSealedProductMatchRule
  | CatalogProviderBarcodeGtinMatchRule
  | CatalogProviderBridgeProviderMatchRule;

export type CatalogProviderExactExternalCatalogItemReferenceRule = Readonly<{
  ruleKey: string;
  matchKind: "exact-external-catalog-item-reference";
  sourcePath: "externalCatalogItemReferences";
}>;

export type CatalogProviderSourceObservationLinkRule = Readonly<{
  ruleKey: string;
  matchKind: "source-observation-link";
  providerKeySource: "observation-provider";
  externalKey: "language-prefixed-observation-external-key";
}>;

export type CatalogProviderDeterministicPokemonCardFieldMatchRule = Readonly<{
  ruleKey: string;
  matchKind: "deterministic-pokemon-card-field-match";
  normalizedKind: "pokemon-card";
  referenceRecord: Readonly<{
    typeKey: "expansion";
    keyPath: "expansionName";
    targetFieldKey: "expansion";
  }>;
  fieldMatches: readonly CatalogProviderDuplicatePreventionFieldMatch[];
}>;

export type CatalogProviderPartialDraftPokemonCardMatchRule = Readonly<{
  ruleKey: string;
  matchKind: "partial-draft-pokemon-card-field-match";
  normalizedKind: "pokemon-card";
  requireDraftStatus: true;
  requireNoExternalProductReference: true;
  requiredTags: readonly CatalogProviderDuplicatePreventionTagRule[];
  fieldMatches: readonly CatalogProviderDuplicatePreventionFieldMatch[];
}>;

export type CatalogProviderSealedProductMatchRule = Readonly<{
  ruleKey: string;
  matchKind: "sealed-product-match";
  normalizedKind: "provider-product";
  productFormPath: "mergeIdentity.productForm";
  sealedValues: readonly string[];
  fieldMatches: readonly CatalogProviderDuplicatePreventionFieldMatch[];
}>;

export type CatalogProviderBarcodeGtinMatchRule = Readonly<{
  ruleKey: string;
  matchKind: "barcode-gtin-match";
  barcodePaths: readonly ("barcode" | "mergeIdentity.barcode")[];
  candidatePolicy: "review-only";
}>;

export type CatalogProviderBridgeProviderMatchRule = Readonly<{
  ruleKey: string;
  matchKind: "future-provider-bridge-match";
  bridgeReferenceProviderKeys: readonly string[];
  candidatePolicy: "review-only";
}>;

export type CatalogProviderDuplicatePreventionFieldMatch = Readonly<{
  fieldKey: keyof CatalogProviderIntegrationProfile["catalogFieldMapping"]["fieldKeys"];
  valuePath: string;
  valueTransform?: "localized-text";
}>;

export type CatalogProviderDuplicatePreventionTagRule = Readonly<{
  kind: "static" | "profile-provider-key" | "template";
  value?: string;
  template?: string;
  values?: Readonly<Record<string, string>>;
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
    kind: "pokemon-card" | "provider-product";
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
    targetRecordRuleKey: string;
    referenceTypes: readonly CatalogProviderReferenceHierarchyTypeRule[];
    referenceRecords: readonly CatalogProviderReferenceHierarchyRecordRule[];
  }>;
  selectedOptionMapping?: CatalogProviderSelectedOptionMapping;
  externalReferenceExtractionRules: Readonly<{
    referenceTarget: "catalog-item-reference" | "product-reference" | "mixed";
    rules: readonly CatalogProviderExternalReferenceRule[];
  }>;
  duplicatePreventionMapping: CatalogProviderDuplicatePreventionMapping;
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

export type CatalogProviderIntegrationProfileMigrationEvidence = Readonly<{
  evidenceText: string;
  mappingFingerprintBefore?: string | null;
  mappingFingerprintAfter?: string | null;
  fixtureRunId?: string | null;
  recordedAt: string;
  recordedByUserId?: string | null;
  recordedForAccountId?: string | null;
}>;

export type CatalogProviderIntegrationProfileAuthoringAudit = Readonly<{
  createdAt?: string | null;
  createdByUserId?: string | null;
  createdForAccountId?: string | null;
  updatedAt?: string | null;
  updatedByUserId?: string | null;
  updatedForAccountId?: string | null;
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
  migrationEvidence?: CatalogProviderIntegrationProfileMigrationEvidence | null;
  authoringAudit?: CatalogProviderIntegrationProfileAuthoringAudit | null;
}>;

export type CatalogProviderIntegrationProfileVersionDiagnostic = Readonly<{
  code:
    | "provider-key-mismatch"
    | "missing-profile-version"
    | "missing-profile-fixture-flow"
    | "fixture-live-provider-calls"
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
    {
      queryKind: "languages",
      aliases: ["language"],
      displayName: "Language",
      scope: "language",
      parentScope: null,
      operation: "tcgdex-list-languages",
      output: {
        valuePath: "languageCode",
        labelPath: "languageCode",
        metadataPaths: { languageCode: "languageCode" },
      },
    },
    {
      queryKind: "series",
      displayName: "Series",
      scope: "series",
      parentScope: "language",
      operation: "tcgdex-list-series",
      parentValue: {
        required: false,
        valueKind: "language-code",
        diagnosticText: "TCGdex series option queries use the selected language.",
      },
      output: {
        valuePath: "seriesId",
        labelPath: "name",
        parentValuePath: "$languageCode",
        imageUrlPath: "logoUrl",
        metadataPaths: {
          languageCode: "$languageCode",
          seriesId: "seriesId",
          logoUrl: "logoUrl",
        },
      },
    },
    {
      queryKind: "expansions",
      aliases: ["expansion"],
      displayName: "Expansion",
      scope: "expansion",
      parentScope: "series",
      operation: "tcgdex-list-expansions",
      parentValue: {
        required: false,
        valueKind: "series-id",
        diagnosticText: "TCGdex expansion option queries may use a Series parent value.",
      },
      output: {
        valuePath: "expansionId",
        labelPath: "name",
        description: { kind: "tcgdex-expansion-card-count" },
        parentValuePath: "seriesId",
        imageUrlCoalescePaths: ["symbolUrl", "logoUrl"],
        metadataPaths: {
          languageCode: "$languageCode",
          expansionId: "expansionId",
          seriesId: "seriesId",
          seriesName: "seriesName",
          logoUrl: "logoUrl",
          symbolUrl: "symbolUrl",
          cardCount: "cardCount",
          officialCardCount: "officialCardCount",
        },
      },
    },
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
    targetRecordRuleKey: "expansion",
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
        attributeKeys: ["official-name", "short-name"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.series,
        typeKey: "series",
        name: "Series",
        descriptionText: "An official Pokemon TCG series that groups expansions.",
        attributeKeys: ["tcgdex-series-id"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.expansion,
        typeKey: "expansion",
        name: "Expansion",
        descriptionText: "An official Pokemon TCG card expansion.",
        attributeKeys: [
          "abbreviation",
          "card-count",
          "parallel-set-card-count",
          "printed-card-count",
          "release-date",
          "tcgdex-set-id",
        ],
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
          kind: "static",
          referenceRecordId: catalogSeedIds.referenceRecords.productLines.pokemonTradingCardGame,
        },
        key: { kind: "static", value: "pokemon-trading-card-game" },
        name: { kind: "static", value: "Pokemon Trading Card Game" },
        description: { kind: "static", value: "The Pokemon Trading Card Game product line." },
        attributes: [
          { attributeKey: "official-name", value: { kind: "static", value: "Pokemon Trading Card Game" } },
          { attributeKey: "short-name", value: { kind: "static", value: "Pokemon TCG" } },
        ],
        relationships: [{ relationshipType: "published-by", ruleKey: "manufacturer" }],
      },
      {
        ruleKey: "series",
        typeKey: "series",
        recordId: { kind: "provider", typeKey: "series", providerValuePaths: ["seriesId", "seriesName"] },
        key: { kind: "path", path: "seriesName" },
        name: { kind: "path", path: "seriesName" },
        description: {
          kind: "template",
          template: "{seriesName} Pokemon TCG series.",
          values: { seriesName: { kind: "path", path: "seriesName" } },
        },
        requiredPaths: ["seriesName"],
        attributes: [{ attributeKey: "tcgdex-series-id", value: { kind: "path", path: "seriesId" }, optional: true }],
        relationships: [{ relationshipType: "part-of", ruleKey: "product-line" }],
      },
      {
        ruleKey: "expansion",
        typeKey: "expansion",
        recordId: { kind: "provider", typeKey: "expansion", providerValuePaths: ["expansionId"] },
        key: { kind: "path", path: "expansionName" },
        name: { kind: "path", path: "expansionName" },
        description: {
          kind: "template",
          template: "{expansionName} Pokemon TCG expansion.",
          values: { expansionName: { kind: "path", path: "expansionName" } },
        },
        requiredPaths: ["expansionId", "expansionName"],
        attributes: [
          { attributeKey: "tcgdex-set-id", value: { kind: "path", path: "expansionId" } },
          { attributeKey: "release-date", value: { kind: "path", path: "releaseDate" }, optional: true },
          { attributeKey: "abbreviation", value: { kind: "path", path: "expansionAbbreviation" }, optional: true },
          { attributeKey: "card-count", value: { kind: "path", path: "expansionCardCount" }, optional: true },
          {
            attributeKey: "parallel-set-card-count",
            value: { kind: "path", path: "expansionParallelSetCardCount" },
            optional: true,
          },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "series", fallbackRuleKey: "product-line" }],
      },
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
        ruleKey: "pokemon-card-deterministic-fields",
        matchKind: "deterministic-pokemon-card-field-match",
        normalizedKind: "pokemon-card",
        referenceRecord: {
          typeKey: "expansion",
          keyPath: "expansionName",
          targetFieldKey: "expansion",
        },
        fieldMatches: [
          { fieldKey: "cardNumber", valuePath: "cardNumber" },
          { fieldKey: "cardName", valuePath: "name", valueTransform: "localized-text" },
          { fieldKey: "cardVariant", valuePath: "cardVariantLabel" },
        ],
      },
      {
        ruleKey: "pokemon-card-partial-draft-retry",
        matchKind: "partial-draft-pokemon-card-field-match",
        normalizedKind: "pokemon-card",
        requireDraftStatus: true,
        requireNoExternalProductReference: true,
        requiredTags: [
          { kind: "profile-provider-key" },
          { kind: "template", template: "expansion:{expansionId}", values: { expansionId: "expansionId" } },
          { kind: "template", template: "variant:{cardVariantKey}", values: { cardVariantKey: "cardVariantKey" } },
        ],
        fieldMatches: [
          { fieldKey: "cardNumber", valuePath: "cardNumber" },
          { fieldKey: "cardName", valuePath: "name", valueTransform: "localized-text" },
          { fieldKey: "cardVariant", valuePath: "cardVariantLabel" },
        ],
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
    {
      queryKind: "product-lines",
      aliases: ["product-line", "categories"],
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
      aliases: ["set-name", "sets"],
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

export const scrydexScryfallCardProviderProfile = {
  providerKey: "scrydex",
  displayName: "Scrydex",
  status: "planned",
  capabilities: ["source-observation-import", "external-reference-extraction"],
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
    kind: "provider-product",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified Scrydex Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: tcgdexPokemonTcgProviderProfile.catalogFieldMapping,
  referenceHierarchyMapping: {
    providerReferenceIdPrefix: "ref_scrydex",
    providerAttributes: [
      { typeKey: "expansion", providerAttributeKey: "scrydex-set-code" },
      { typeKey: "expansion", providerAttributeKey: "scrydex-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.expansion,
        typeKey: "expansion",
        name: "Expansion",
        descriptionText: "A provider catalog set, expansion, or release group.",
        attributeKeys: ["scrydex-set-code", "scrydex-set-name"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "set",
        typeKey: "expansion",
        recordId: { kind: "provider", typeKey: "expansion", providerValuePaths: ["set", "set_name"] },
        key: { kind: "path", path: "set_name" },
        name: { kind: "path", path: "set_name" },
        description: {
          kind: "template",
          template: "{setName} Magic: The Gathering set.",
          values: { setName: { kind: "path", path: "set_name" } },
        },
        requiredPaths: ["set", "set_name"],
        attributes: [
          { attributeKey: "scrydex-set-code", value: { kind: "path", path: "set" } },
          { attributeKey: "scrydex-set-name", value: { kind: "path", path: "set_name" } },
        ],
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

export const catalogProviderIntegrationProfiles = [
  scrydexScryfallCardProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
] as const satisfies readonly CatalogProviderIntegrationProfile[];

export const catalogProviderIntegrationProfileVersions = [
  {
    providerKey: "scrydex",
    profileKey: "scryfall-card-fixture",
    profileVersion: "2026.06.03",
    lifecycle: "test",
    active: false,
    profile: scrydexScryfallCardProviderProfile,
    sourceContract: scrydexScryfallCardSourceObservationMappingContract.sourceContract,
    fixtures: scrydexScryfallCardSourceObservationMappingContract.fixtures,
    compatibilityMode: "executable-mapping-contract",
    retirementPlan: null,
    executableMappingContract: scrydexScryfallCardSourceObservationMappingContract,
  },
  {
    providerKey: "tcgdex",
    profileKey: "pokemon-tcg",
    profileVersion: "2026.06.03",
    lifecycle: "active",
    active: true,
    profile: tcgdexPokemonTcgProviderProfile,
    sourceContract: tcgdexPokemonCardSourceObservationMappingContract.sourceContract,
    fixtures: tcgdexPokemonCardSourceObservationMappingContract.fixtures,
    compatibilityMode: "executable-mapping-contract",
    retirementPlan: null,
    executableMappingContract: tcgdexPokemonCardSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "pokemon-tcg-automation-client",
    profileVersion: "2026.06.03",
    lifecycle: "test",
    active: false,
    profile: tcgplayerAutomationClientProviderProfile,
    sourceContract: tcgplayerProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerProviderProductSourceObservationMappingContract.fixtures,
    compatibilityMode: "executable-mapping-contract",
    retirementPlan: null,
    executableMappingContract: tcgplayerProviderProductSourceObservationMappingContract,
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

export function getActiveCatalogProviderSourceObservationMappingContract(
  providerKey: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderSourceObservationMappingContract | null {
  const contract = getActiveCatalogProviderIntegrationProfileVersion(providerKey, versions)?.executableMappingContract;
  if (!contract?.sourceObservation) {
    return null;
  }

  return contract as CatalogProviderSourceObservationMappingContract;
}

export function requireActiveCatalogProviderSourceObservationMappingContract(
  providerKey: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderSourceObservationMappingContract {
  const contract = getActiveCatalogProviderSourceObservationMappingContract(providerKey, versions);
  if (!contract) {
    throw new Error(`Catalog provider '${providerKey}' does not have an active Source Observation mapping contract.`);
  }

  return contract;
}

export function getCatalogProviderSourceObservationMappingContract(
  providerKey: string,
  profileVersion?: string | null,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderSourceObservationMappingContract | null {
  const contract = getCatalogProviderIntegrationProfileVersion(
    providerKey,
    profileVersion,
    versions,
  )?.executableMappingContract;
  if (!contract?.sourceObservation) {
    return null;
  }

  return contract as CatalogProviderSourceObservationMappingContract;
}

export function requireCatalogProviderSourceObservationMappingContract(
  providerKey: string,
  profileVersion?: string | null,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderSourceObservationMappingContract {
  const contract = getCatalogProviderSourceObservationMappingContract(providerKey, profileVersion, versions);
  if (!contract) {
    throw new Error(`Catalog provider '${providerKey}' does not have a Source Observation mapping contract.`);
  }

  return contract;
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

  for (const fixtureDiagnostic of evaluateCatalogIntegrationFixtureCoverageFromProfileVersion({ version })) {
    if (fixtureDiagnostic.code === "fixture-missing-flow") {
      diagnostics.push({
        code: "missing-profile-fixture-flow",
        path: fixtureDiagnostic.path,
        diagnosticText: fixtureDiagnostic.diagnosticText,
      });
    }
    if (fixtureDiagnostic.code === "fixture-live-provider-calls") {
      diagnostics.push({
        code: "fixture-live-provider-calls",
        path: fixtureDiagnostic.path,
        diagnosticText: fixtureDiagnostic.diagnosticText,
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
