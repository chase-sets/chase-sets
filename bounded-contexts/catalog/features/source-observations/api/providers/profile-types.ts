import type { JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderIngestionUnitIdentityContract,
  CatalogProviderIngestionUnitProductDomain,
  CatalogProviderMappingContractDiagnostic,
  CatalogProviderMappingSourceContract,
  CatalogProviderProfileFixtureContract,
  CatalogProviderProfileLifecycle,
} from "./provider-integration-mapping-contract";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type { CatalogProviderSourceObservationMappingContract } from "../promotion/provider-source-observation-normalizer";

export type CatalogProviderCapability =
  | "provider-option-query"
  | "source-observation-import"
  | "catalog-item-promotion"
  | "reference-data-promotion"
  | "external-reference-extraction"
  | "alias-candidate-extraction";

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
  queryKeySynonyms?: readonly string[];
  displayName: string;
  scope: CatalogProviderScope;
  parentScope: CatalogProviderScope | null;
  operation: CatalogProviderOptionQueryOperation;
  parentValue?: Readonly<{
    required: boolean;
    valueKind: "language-code" | "series-id" | "product-line-id" | "set-code" | "set-id";
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
  | "mtgjson-list-sets"
  | "mtgjson-list-cards"
  | "lorcanajson-list-sets"
  | "lorcanajson-list-cards"
  | "lorcast-list-sets"
  | "lorcast-list-cards"
  | "scryfall-list-sets"
  | "scryfall-list-cards"
  | "scrydex-list-sets"
  | "scrydex-one-piece-list-sets"
  | "scrydex-one-piece-list-cards"
  | "scrydex-one-piece-list-sealed-products"
  | "scrydex-lorcana-list-sets"
  | "scrydex-lorcana-list-cards"
  | "scrydex-lorcana-list-sealed-products"
  | "ygoprodeck-list-sets"
  | "ygoprodeck-list-cards"
  | "ygojson-list-sets"
  | "ygojson-list-sealed-products"
  | "yaml-yugi-list-sets"
  | "yaml-yugi-list-cards";

export type CatalogProviderOptionQueryOutputMapping = Readonly<{
  valuePath: string;
  labelPath: string;
  description?: CatalogProviderOptionQueryDescriptionMapping;
  parentValuePath?: string;
  imageUrlPath?: string;
  imageUrlCoalescePaths?: readonly string[];
  /** Record path to a typed `ProviderOptionAlias[]` produced by the adapter. */
  aliasesPath?: string;
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

export type ScrydexJsonConnectorProfile = Readonly<{
  kind: "scrydex-json";
  sourceContractDocument: string;
  transportMode: "live-credentialed";
  fixtureEvidence: "required-for-active-profile-validation";
  authentication: Readonly<{
    scheme: "scrydex-api-key";
    credentialsRequired: true;
    teamIdentifierRequired: true;
    retainedCredentialMaterial: "never";
  }>;
  requestPolicy: Readonly<{
    normalImportStrategy: "bulk-first";
    allowedOperations: readonly (
      | "bulk-list-sets"
      | "bulk-list-cards"
      | "bulk-list-sealed-products"
      | "usage-summary"
      | "webhook-freshness"
    )[];
    forbiddenNormalOperations: readonly (
      | "one-call-per-card"
      | "one-call-per-variant"
      | "one-call-per-sealed-product"
    )[];
    selectedFieldsOnly: true;
    highestSafePageSizeRequired: true;
    perRecordFallbackPolicy: "documented-tested-preflighted-operator-visible";
  }>;
  usageSummaryPolicy: Readonly<{
    retention: "redacted-summary-only";
    fields: readonly (
      | "estimated-request-count"
      | "actual-request-count"
      | "page-count"
      | "cache-hit-count"
      | "cache-miss-count"
      | "usage-check-state"
      | "credit-diagnostic"
      | "degraded-diagnostic"
    )[];
  }>;
  acceptedEvidence: readonly (
    | "scrydex-card-id"
    | "scrydex-variant-id"
    | "scrydex-set-id"
    | "scrydex-sealed-product-id"
    | "set-code"
    | "set-name"
    | "card-number"
    | "ink-color"
    | "language"
    | "image-url"
    | "tcgplayer-id"
    | "freshness-diagnostic"
    | "redacted-usage-summary"
  )[];
  excludedEvidence: readonly (
    | "raw-provider-body"
    | "api-key"
    | "team-id"
    | "seller"
    | "inventory"
    | "listing"
    | "order"
    | "message"
    | "unapproved-price-history"
  )[];
}>;

export type ScryfallJsonConnectorProfile = Readonly<{
  kind: "scryfall-json";
  baseUrl: "https://api.scryfall.com";
  sourceContractDocument: string;
  authentication: Readonly<{
    scheme: "public-api";
    credentialsRequired: false;
    userAgentRequired: true;
  }>;
  acceptedEvidence: readonly (
    | "scryfall-id"
    | "oracle-id"
    | "set-code"
    | "set-name"
    | "collector-number"
    | "language"
    | "rarity"
    | "finish"
    | "image-url"
    | "tcgplayer-id"
  )[];
  excludedEvidence: readonly ("price" | "seller" | "inventory" | "ruling" | "legality")[];
}>;

export type MtgjsonJsonConnectorProfile = Readonly<{
  kind: "mtgjson-json";
  baseUrl: "https://mtgjson.com/api/v5";
  sourceContractDocument: string;
  authentication: Readonly<{
    scheme: "public-json";
    credentialsRequired: false;
  }>;
  acceptedEvidence: readonly (
    | "mtgjson-uuid"
    | "set-code"
    | "set-name"
    | "collector-number"
    | "rarity"
    | "layout"
    | "finish"
    | "scryfall-id"
    | "release-date"
    | "card-count"
  )[];
  excludedEvidence: readonly ("price" | "legality" | "ruling" | "deck" | "format")[];
}>;

export type LorcanajsonJsonConnectorProfile = Readonly<{
  kind: "lorcanajson-json";
  baseUrl: "https://lorcanajson.org/files/current/en";
  sourceContractDocument: string;
  authentication: Readonly<{
    scheme: "public-json";
    credentialsRequired: false;
  }>;
  bulkPolicy: Readonly<{
    freshnessDocument: "metadata.json";
    optionDiscoveryDocument: "allCards.json";
    selectedSetDocumentPattern: "sets/setdata.{setCode}.json";
    normalImportStrategy: "bulk-first";
  }>;
  acceptedEvidence: readonly (
    | "lorcanajson-card-id"
    | "set-code"
    | "set-name"
    | "collector-number"
    | "rarity"
    | "ink-color"
    | "card-type"
    | "image-url"
    | "tcgplayer-id"
    | "release-date"
    | "card-count"
  )[];
  excludedEvidence: readonly ("price" | "seller" | "inventory" | "ruling" | "legality" | "unapproved-scrape")[];
}>;

export type LorcastJsonConnectorProfile = Readonly<{
  kind: "lorcast-json";
  baseUrl: "https://api.lorcast.com/v0";
  sourceContractDocument: string;
  authentication: Readonly<{
    scheme: "public-api";
    credentialsRequired: false;
  }>;
  requestPolicy: Readonly<{
    normalImportStrategy: "bulk-set-scoped";
    optionDiscoveryEndpoint: "/sets";
    selectedSetCardsEndpoint: "/sets/{setCode}/cards";
    selectedSetEndpoint: "/sets/{setCode}";
    cacheProviderDataForAtLeastHours: 24;
    recommendedDelayMilliseconds: "50-100";
  }>;
  acceptedEvidence: readonly (
    | "lorcast-card-id"
    | "lorcast-set-id"
    | "set-code"
    | "set-name"
    | "collector-number"
    | "rarity"
    | "ink-color"
    | "card-type"
    | "image-url"
    | "tcgplayer-id"
    | "release-date"
  )[];
  excludedEvidence: readonly ("price" | "seller" | "inventory" | "ruling" | "legality")[];
}>;

export type YgoprodeckJsonConnectorProfile = Readonly<{
  kind: "ygoprodeck-json";
  baseUrl: "https://db.ygoprodeck.com/api/v7";
  sourceContractDocument: string;
  authentication: Readonly<{
    scheme: "public-api";
    credentialsRequired: false;
    userAgentRequired: true;
  }>;
  throttling: Readonly<{
    providerLimit: "20-requests-per-second";
    cacheProviderDataLocally: true;
    cacheImagesLocally: true;
  }>;
  acceptedEvidence: readonly (
    | "ygoprodeck-card-id"
    | "ygoprodeck-passcode"
    | "passcode"
    | "set-code"
    | "set-name"
    | "rarity"
    | "card-type"
    | "frame-type"
    | "race"
    | "attribute"
    | "archetype"
    | "release-date"
    | "card-count"
    | "image-url"
    | "image-evidence-url"
    | "banlist"
  )[];
  excludedEvidence: readonly ("price" | "seller" | "inventory" | "order" | "message" | "image-hotlink")[];
  assetPolicy: Readonly<{
    hotlinkingAllowed: false;
    requiresCatalogAssetStorage: true;
  }>;
}>;

export type YgojsonJsonConnectorProfile = Readonly<{
  kind: "ygojson-json";
  baseUrl: string;
  sourceContractDocument: string;
  authentication: Readonly<{
    scheme: "public-json";
    credentialsRequired: false;
  }>;
  acceptedEvidence: readonly (
    | "card-id"
    | "passcode"
    | "set-code"
    | "set-name"
    | "sealed-product"
    | "pack-content"
    | "pack-odds"
    | "format"
  )[];
  excludedEvidence: readonly ("price" | "seller" | "inventory" | "order" | "message")[];
}>;

export type YamlYugiJsonConnectorProfile = Readonly<{
  kind: "yaml-yugi-json";
  baseUrl: string;
  sourceContractDocument: string;
  authentication: Readonly<{
    scheme: "public-json";
    credentialsRequired: false;
  }>;
  acceptedEvidence: readonly ("card-id" | "passcode" | "set-code" | "set-name" | "format" | "card-text")[];
  excludedEvidence: readonly ("price" | "seller" | "inventory" | "order" | "message")[];
}>;

export type CatalogProviderConnectorProfile =
  | TcgdexJsonConnectorProfile
  | TcgplayerAutomationClientConnectorProfile
  | MtgjsonJsonConnectorProfile
  | LorcanajsonJsonConnectorProfile
  | LorcastJsonConnectorProfile
  | ScryfallJsonConnectorProfile
  | ScrydexScryfallJsonConnectorProfile
  | ScrydexJsonConnectorProfile
  | YgoprodeckJsonConnectorProfile
  | YgojsonJsonConnectorProfile
  | YamlYugiJsonConnectorProfile;

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
  typeKey: "series" | "expansion" | "set" | "product-line" | "manufacturer";
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
  valueSynonyms?: readonly CatalogProviderSelectedOptionValueSynonym[];
  valueMappings?: readonly CatalogProviderSelectedOptionValueMapping[];
}>;

export type CatalogProviderSelectedOptionValueSynonym = Readonly<{
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
  | CatalogProviderExactExternalProductReferenceRule
  | CatalogProviderSourceObservationLinkRule
  | CatalogProviderDeterministicPokemonCardFieldMatchRule
  | CatalogProviderDeterministicMagicCatalogItemFieldMatchRule
  | CatalogProviderDeterministicOnePieceCatalogItemFieldMatchRule
  | CatalogProviderPartialDraftPokemonCardMatchRule
  | CatalogProviderSealedProductMatchRule
  | CatalogProviderBarcodeGtinMatchRule
  | CatalogProviderBridgeProviderMatchRule;

export type CatalogProviderExactExternalCatalogItemReferenceRule = Readonly<{
  ruleKey: string;
  matchKind: "exact-external-catalog-item-reference";
  sourcePath: "externalCatalogItemReferences";
}>;

export type CatalogProviderExactExternalProductReferenceRule = Readonly<{
  ruleKey: string;
  matchKind: "exact-external-product-reference";
  sourcePath: "externalProductReferences";
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

export type CatalogProviderDeterministicMagicCatalogItemFieldMatchRule = Readonly<{
  ruleKey: string;
  matchKind: "deterministic-magic-catalog-item-field-match";
  normalizedKind: "magic-card-print" | "magic-sealed-product";
  referenceRecord: Readonly<{
    typeKey: "set";
    keyPath: "setName";
    targetFieldKey: "set";
  }>;
  fieldMatches: readonly CatalogProviderDuplicatePreventionFieldMatch[];
}>;

export type CatalogProviderDeterministicOnePieceCatalogItemFieldMatchRule = Readonly<{
  ruleKey: string;
  matchKind: "deterministic-one-piece-catalog-item-field-match";
  normalizedKind: "one-piece-card-print" | "one-piece-sealed-product";
  referenceRecord: Readonly<{
    typeKey: "set";
    keyPath: "setName";
    targetFieldKey: "set";
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
  normalizedKind: "provider-product" | "magic-sealed-product" | "yugioh-sealed-product" | "pokemon-sealed-product";
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
    kind:
      | "pokemon-card"
      | "pokemon-sealed-product"
      | "provider-product"
      | "magic-card-print"
      | "magic-set-reference"
      | "magic-sealed-product"
      | "yugioh-card-print"
      | "yugioh-set-reference"
      | "yugioh-sealed-product"
      | "yugioh-pack-reference"
      | "one-piece-card-print"
      | "one-piece-set-reference"
      | "one-piece-sealed-product"
      | "lorcana-card-print"
      | "lorcana-set-reference"
      | "lorcana-sealed-product";
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
      set?: string;
      expansion: string;
      rarity: string;
      cardVariant: string;
      cardIllustrator: string;
      releaseYear: string;
      packCount?: string;
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
  ingestionUnitIdentity?: CatalogProviderIngestionUnitIdentityContract;
  lifecycle: CatalogProviderProfileLifecycle;
  active: boolean;
  profile: CatalogProviderIntegrationProfile;
  sourceContract: CatalogProviderMappingSourceContract;
  fixtures: CatalogProviderProfileFixtureContract;
  retirementPlan: CatalogProviderIntegrationProfileRetirementPlan | null;
  executableMappingContract?: CatalogProviderExecutableMappingContract;
  migrationEvidence?: CatalogProviderIntegrationProfileMigrationEvidence | null;
  authoringAudit?: CatalogProviderIntegrationProfileAuthoringAudit | null;
}>;

export type CatalogProviderProfileVersionSelector = Readonly<{
  profileKey?: string | null;
  ingestionUnitKey?: CatalogIntegrationUnitKey | null;
}>;

export type CatalogProviderIntegrationProfileVersionDiagnostic = Readonly<{
  code:
    | "provider-key-mismatch"
    | "ingestion-unit-identity-mismatch"
    | "missing-profile-version"
    | "missing-profile-fixture-flow"
    | "fixture-live-provider-calls"
    | "missing-retirement-plan"
    | "retired-magic-scrydex-proof-active"
    | "missing-executable-mapping-contract"
    | "mapping-contract-mismatch"
    | "mapping-contract-diagnostic";
  path: string;
  diagnosticText: string;
  mappingDiagnostic?: CatalogProviderMappingContractDiagnostic;
}>;
