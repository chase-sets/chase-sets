import type { JsonValue } from "@chase-sets/primitives/json";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderIngestionUnitIdentityContract,
  CatalogProviderMappingContractDiagnostic,
  CatalogProviderMappingSourceContract,
  CatalogProviderProfileFixtureContract,
  CatalogProviderProfileLifecycle,
} from "./provider-integration-mapping-contract";
import {
  defineCatalogProviderIngestionUnitIdentityContract,
  validateCatalogProviderExecutableMappingContract,
} from "./provider-integration-mapping-contract";
import type { CatalogIntegrationUnitKey } from "./integration-unit";
import { evaluateCatalogIntegrationFixtureCoverageFromProfileVersion } from "./catalog-integration-fixture-lifecycle";
import type { CatalogProviderSourceObservationMappingContract } from "./provider-source-observation-normalizer";
import {
  mtgjsonMtgCardReferenceSourceObservationMappingContract,
  mtgjsonMtgSetReferenceSourceObservationMappingContract,
} from "./mtgjson-executable-mapping-contract";
import {
  lorcanajsonLorcanaCardReferenceSourceObservationMappingContract,
  lorcanajsonLorcanaSetReferenceSourceObservationMappingContract,
} from "./lorcanajson-executable-mapping-contract";
import {
  lorcastLorcanaCardReferenceSourceObservationMappingContract,
  lorcastLorcanaSetReferenceSourceObservationMappingContract,
} from "./lorcast-executable-mapping-contract";
import {
  ygoprodeckYugiohCardReferenceProviderProfile,
  ygoprodeckYugiohCardReferenceSourceObservationMappingContract,
  ygoprodeckYugiohSetReferenceProviderProfile,
  ygoprodeckYugiohSetReferenceSourceObservationMappingContract,
} from "./ygoprodeck-executable-mapping-contract";
import {
  ygojsonYugiohSealedProductReferenceProviderProfile,
  ygojsonYugiohSealedProductReferenceSourceObservationMappingContract,
  ygojsonYugiohSetReferenceProviderProfile,
  ygojsonYugiohSetReferenceSourceObservationMappingContract,
} from "./ygojson-executable-mapping-contract";
import {
  scryfallMtgCardPrintSourceObservationMappingContract,
  scryfallMtgImageEvidenceSourceObservationMappingContract,
} from "./scryfall-executable-mapping-contract";
import {
  SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
  scrydexLorcanaCardPrintSourceObservationMappingContract,
  scrydexLorcanaSealedProductSourceObservationMappingContract,
  scrydexLorcanaSetReferenceSourceObservationMappingContract,
} from "./scrydex-lorcana-executable-mapping-contract";
import {
  SCRYDEX_ONE_PIECE_PROFILE_VERSION,
  scrydexOnePieceCardPrintSourceObservationMappingContract,
  scrydexOnePieceSealedProductSourceObservationMappingContract,
  scrydexOnePieceSetReferenceSourceObservationMappingContract,
} from "./scrydex-one-piece-executable-mapping-contract";
import {
  TCGPLAYER_LORCANA_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION,
  tcgplayerLorcanaSingleCardProviderProductSourceObservationMappingContract,
  tcgplayerLorcanaSealedProductProviderProductSourceObservationMappingContract,
  TCGPLAYER_MTG_SINGLE_CARD_PROFILE_VERSION,
  tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract,
  TCGPLAYER_MTG_SEALED_PRODUCT_PROFILE_VERSION,
  tcgplayerMtgSealedProductSourceObservationMappingContract,
  TCGPLAYER_ONE_PIECE_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_PROFILE_VERSION,
  TCGPLAYER_POKEMON_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_POKEMON_SEALED_PRODUCT_PROFILE_VERSION,
  tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract,
  tcgplayerOnePieceSealedProductProviderProductSourceObservationMappingContract,
  tcgplayerPokemonSealedProductSourceObservationMappingContract,
  tcgplayerProviderProductSourceObservationMappingContract,
  TCGPLAYER_YUGIOH_SINGLE_CARD_PROFILE_VERSION,
  tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract,
} from "./tcgplayer-executable-mapping-contract";
import { tcgdexPokemonCardSourceObservationMappingContract } from "./tcgdex-executable-mapping-contract";

export {
  ygoprodeckYugiohCardReferenceProviderProfile,
  ygoprodeckYugiohSetReferenceProviderProfile,
  ygojsonYugiohSealedProductReferenceProviderProfile,
  ygojsonYugiohSetReferenceProviderProfile,
};

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

export const tcgdexPokemonTcgProviderProfile = {
  providerKey: "tcgdex",
  displayName: "TCGdex",
  status: "active",
  capabilities: [
    "provider-option-query",
    "source-observation-import",
    "catalog-item-promotion",
    "external-reference-extraction",
    "alias-candidate-extraction",
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
      queryKeySynonyms: ["language"],
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
        aliasesPath: "aliases",
        metadataPaths: {
          languageCode: "$languageCode",
          seriesId: "seriesId",
          logoUrl: "logoUrl",
        },
      },
    },
    {
      queryKind: "expansions",
      queryKeySynonyms: ["expansion"],
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
        aliasesPath: "aliases",
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
        key: { kind: "path", path: "seriesId" },
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
        key: { kind: "path", path: "expansionId" },
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

const lorcanajsonLorcanaSetOptionQuery = {
  queryKind: "sets",
  queryKeySynonyms: ["set"],
  displayName: "Set",
  scope: "set-name",
  parentScope: null,
  operation: "lorcanajson-list-sets",
  output: {
    valuePath: "setCode",
    labelPath: "name",
    description: { kind: "path", path: "releaseDate" },
    metadataPaths: {
      setId: "setId",
      setCode: "setCode",
      releaseDate: "releaseDate",
      prereleaseDate: "prereleaseDate",
      type: "type",
      setNumber: "setNumber",
      cardCount: "cardCount",
      formatVersion: "formatVersion",
      generatedOn: "generatedOn",
    },
  },
} as const satisfies CatalogProviderOptionQuery;

const lorcanajsonLorcanaCardOptionQuery = {
  queryKind: "cards",
  queryKeySynonyms: ["card"],
  displayName: "Card",
  scope: "product/card",
  parentScope: "set-name",
  operation: "lorcanajson-list-cards",
  parentValue: {
    required: true,
    valueKind: "set-code",
    diagnosticText: "LorcanaJSON card option queries require a selected set code.",
  },
  output: {
    valuePath: "cardId",
    labelPath: "name",
    parentValuePath: "setCode",
    imageUrlPath: "imageUrl",
    metadataPaths: {
      cardId: "cardId",
      setCode: "setCode",
      setName: "setName",
      cardNumber: "cardNumber",
      rarity: "rarity",
      cardType: "cardType",
      inkColor: "inkColor",
      tcgplayerProductId: "tcgplayerProductId",
    },
  },
} as const satisfies CatalogProviderOptionQuery;

const lorcanajsonLorcanaOptionQueries = [
  lorcanajsonLorcanaSetOptionQuery,
  lorcanajsonLorcanaCardOptionQuery,
] as const satisfies readonly CatalogProviderOptionQuery[];

export const lorcanajsonLorcanaCardReferenceProviderProfile = {
  providerKey: "lorcanajson",
  displayName: "LorcanaJSON",
  status: "active",
  capabilities: [
    "provider-option-query",
    "source-observation-import",
    "catalog-item-promotion",
    "external-reference-extraction",
  ],
  supportedScopes: ["set-name", "product/card"],
  languageOptions: ["en"],
  optionQueries: lorcanajsonLorcanaOptionQueries,
  connector: {
    kind: "lorcanajson-json",
    baseUrl: "https://lorcanajson.org/files/current/en",
    sourceContractDocument: "bounded-contexts/catalog/docs/catalog-integration-production-signoff.md#lorcana",
    authentication: {
      scheme: "public-json",
      credentialsRequired: false,
    },
    bulkPolicy: {
      freshnessDocument: "metadata.json",
      optionDiscoveryDocument: "allCards.json",
      selectedSetDocumentPattern: "sets/setdata.{setCode}.json",
      normalImportStrategy: "bulk-first",
    },
    acceptedEvidence: [
      "lorcanajson-card-id",
      "set-code",
      "set-name",
      "collector-number",
      "rarity",
      "ink-color",
      "card-type",
      "image-url",
      "tcgplayer-id",
      "release-date",
      "card-count",
    ],
    excludedEvidence: ["price", "seller", "inventory", "ruling", "legality", "unapproved-scrape"],
  },
  normalizedObservationMapping: {
    kind: "lorcana-card-print",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified LorcanaJSON Variant",
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
    providerReferenceIdPrefix: "ref_lorcanajson_lorcana",
    providerAttributes: [
      { typeKey: "product-line", providerAttributeKey: "lorcanajson-product-line" },
      { typeKey: "set", providerAttributeKey: "lorcanajson-set-code" },
      { typeKey: "set", providerAttributeKey: "lorcanajson-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "lorcanajson-product-line"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A Disney Lorcana release group.",
        attributeKeys: ["lorcanajson-set-code", "lorcanajson-set-name"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "lorcana-product-line",
        typeKey: "product-line",
        recordId: { kind: "static", referenceRecordId: "ref_lorcanajson_lorcana_product_line" },
        key: { kind: "static", value: "disney-lorcana" },
        name: { kind: "static", value: "Disney Lorcana" },
        description: { kind: "static", value: "Disney Lorcana trading card game." },
        attributes: [
          { attributeKey: "official-name", value: { kind: "static", value: "Disney Lorcana" } },
          { attributeKey: "short-name", value: { kind: "static", value: "Lorcana" } },
          { attributeKey: "lorcanajson-product-line", value: { kind: "static", value: "lorcana" } },
        ],
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["setCode", "setName"] },
        key: { kind: "path", path: "setCode" },
        name: { kind: "path", path: "setName" },
        description: {
          kind: "template",
          template: "{setName} Disney Lorcana set.",
          values: { setName: { kind: "path", path: "setName" } },
        },
        requiredPaths: ["setCode", "setName"],
        attributes: [
          { attributeKey: "lorcanajson-set-code", value: { kind: "path", path: "setCode" } },
          { attributeKey: "lorcanajson-set-name", value: { kind: "path", path: "setName" } },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "lorcana-product-line" }],
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
        valueKeys: ["tcgplayerProductId"],
        recordIdKeys: ["tcgplayerProductId"],
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
        ruleKey: "exact-tcgplayer-bridge-reference",
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
        bridgeReferenceProviderKeys: ["lorcast", "scrydex", "tcgplayer"],
        candidatePolicy: "review-only",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const lorcanajsonLorcanaSetReferenceProviderProfile = {
  ...lorcanajsonLorcanaCardReferenceProviderProfile,
  displayName: "LorcanaJSON Set Reference",
  capabilities: ["provider-option-query", "source-observation-import", "reference-data-promotion"],
  supportedScopes: ["set-name"],
  optionQueries: [lorcanajsonLorcanaSetOptionQuery],
  normalizedObservationMapping: {
    ...lorcanajsonLorcanaCardReferenceProviderProfile.normalizedObservationMapping,
    kind: "lorcana-set-reference",
    unknownVariantLabelPrefix: "Unclassified LorcanaJSON Set Variant",
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

const lorcastLorcanaSetOptionQuery = {
  queryKind: "sets",
  queryKeySynonyms: ["set"],
  displayName: "Set",
  scope: "set-name",
  parentScope: null,
  operation: "lorcast-list-sets",
  output: {
    valuePath: "setCode",
    labelPath: "name",
    description: { kind: "path", path: "releaseDate" },
    metadataPaths: {
      setId: "setId",
      setCode: "setCode",
      releaseDate: "releaseDate",
      prereleaseDate: "prereleaseDate",
      cacheGuidance: "cacheGuidance",
    },
  },
} as const satisfies CatalogProviderOptionQuery;

const lorcastLorcanaCardOptionQuery = {
  queryKind: "cards",
  queryKeySynonyms: ["card"],
  displayName: "Card",
  scope: "product/card",
  parentScope: "set-name",
  operation: "lorcast-list-cards",
  parentValue: {
    required: true,
    valueKind: "set-code",
    diagnosticText: "Lorcast card option queries require a selected set code.",
  },
  output: {
    valuePath: "cardId",
    labelPath: "name",
    parentValuePath: "setCode",
    imageUrlPath: "imageUrl",
    metadataPaths: {
      cardId: "cardId",
      setId: "setId",
      setCode: "setCode",
      setName: "setName",
      cardNumber: "cardNumber",
      rarity: "rarity",
      cardType: "cardType",
      inkColor: "inkColor",
      tcgplayerProductId: "tcgplayerProductId",
      releaseDate: "releaseDate",
    },
  },
} as const satisfies CatalogProviderOptionQuery;

const lorcastLorcanaOptionQueries = [
  lorcastLorcanaSetOptionQuery,
  lorcastLorcanaCardOptionQuery,
] as const satisfies readonly CatalogProviderOptionQuery[];

export const lorcastLorcanaCardReferenceProviderProfile = {
  providerKey: "lorcast",
  displayName: "Lorcast",
  status: "active",
  capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
  supportedScopes: ["set-name", "product/card"],
  languageOptions: ["en"],
  optionQueries: lorcastLorcanaOptionQueries,
  connector: {
    kind: "lorcast-json",
    baseUrl: "https://api.lorcast.com/v0",
    sourceContractDocument: "https://lorcast.com/docs/api",
    authentication: {
      scheme: "public-api",
      credentialsRequired: false,
    },
    requestPolicy: {
      normalImportStrategy: "bulk-set-scoped",
      optionDiscoveryEndpoint: "/sets",
      selectedSetCardsEndpoint: "/sets/{setCode}/cards",
      selectedSetEndpoint: "/sets/{setCode}",
      cacheProviderDataForAtLeastHours: 24,
      recommendedDelayMilliseconds: "50-100",
    },
    acceptedEvidence: [
      "lorcast-card-id",
      "lorcast-set-id",
      "set-code",
      "set-name",
      "collector-number",
      "rarity",
      "ink-color",
      "card-type",
      "image-url",
      "tcgplayer-id",
      "release-date",
    ],
    excludedEvidence: ["price", "seller", "inventory", "ruling", "legality"],
  },
  normalizedObservationMapping: {
    kind: "lorcana-card-print",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified Lorcast Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: lorcanajsonLorcanaCardReferenceProviderProfile.catalogFieldMapping,
  referenceHierarchyMapping: {
    providerReferenceIdPrefix: "ref_lorcast_lorcana",
    providerAttributes: [
      { typeKey: "product-line", providerAttributeKey: "lorcast-product-line" },
      { typeKey: "set", providerAttributeKey: "lorcast-set-code" },
      { typeKey: "set", providerAttributeKey: "lorcast-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "lorcast-product-line"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A Disney Lorcana release group.",
        attributeKeys: ["lorcast-set-code", "lorcast-set-name"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "lorcana-product-line",
        typeKey: "product-line",
        recordId: { kind: "static", referenceRecordId: "ref_lorcast_lorcana_product_line" },
        key: { kind: "static", value: "disney-lorcana" },
        name: { kind: "static", value: "Disney Lorcana" },
        description: { kind: "static", value: "Disney Lorcana trading card game." },
        attributes: [
          { attributeKey: "official-name", value: { kind: "static", value: "Disney Lorcana" } },
          { attributeKey: "short-name", value: { kind: "static", value: "Lorcana" } },
          { attributeKey: "lorcast-product-line", value: { kind: "static", value: "lorcana" } },
        ],
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["setCode", "setName"] },
        key: { kind: "path", path: "setCode" },
        name: { kind: "path", path: "setName" },
        description: {
          kind: "template",
          template: "{setName} Disney Lorcana set.",
          values: { setName: { kind: "path", path: "setName" } },
        },
        requiredPaths: ["setCode", "setName"],
        attributes: [
          { attributeKey: "lorcast-set-code", value: { kind: "path", path: "setCode" } },
          { attributeKey: "lorcast-set-name", value: { kind: "path", path: "setName" } },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "lorcana-product-line" }],
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
        valueKeys: ["tcgplayerProductId"],
        recordIdKeys: ["tcgplayerProductId"],
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
        ruleKey: "exact-tcgplayer-bridge-reference",
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
        bridgeReferenceProviderKeys: ["lorcanajson", "scrydex", "tcgplayer"],
        candidatePolicy: "review-only",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const lorcastLorcanaSetReferenceProviderProfile = {
  ...lorcastLorcanaCardReferenceProviderProfile,
  displayName: "Lorcast Set Reference",
  capabilities: ["provider-option-query", "source-observation-import", "reference-data-promotion"],
  supportedScopes: ["set-name"],
  optionQueries: [lorcastLorcanaSetOptionQuery],
  normalizedObservationMapping: {
    ...lorcastLorcanaCardReferenceProviderProfile.normalizedObservationMapping,
    kind: "lorcana-set-reference",
    unknownVariantLabelPrefix: "Unclassified Lorcast Set Variant",
  },
  catalogFieldMapping: lorcanajsonLorcanaSetReferenceProviderProfile.catalogFieldMapping,
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

export const catalogProviderIntegrationProfiles = [
  mtgjsonMtgCardReferenceProviderProfile,
  mtgjsonMtgSetReferenceProviderProfile,
  lorcanajsonLorcanaCardReferenceProviderProfile,
  lorcanajsonLorcanaSetReferenceProviderProfile,
  lorcastLorcanaCardReferenceProviderProfile,
  lorcastLorcanaSetReferenceProviderProfile,
  scryfallMtgCardPrintProviderProfile,
  scryfallMtgImageEvidenceProviderProfile,
  scrydexOnePieceCardPrintProviderProfile,
  scrydexOnePieceSetReferenceProviderProfile,
  scrydexOnePieceSealedProductProviderProfile,
  scrydexLorcanaCardPrintProviderProfile,
  scrydexLorcanaSetReferenceProviderProfile,
  scrydexLorcanaSealedProductProviderProfile,
  ygoprodeckYugiohCardReferenceProviderProfile,
  ygoprodeckYugiohSetReferenceProviderProfile,
  ygojsonYugiohSetReferenceProviderProfile,
  ygojsonYugiohSealedProductReferenceProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerMtgSingleCardProviderProfile,
  tcgplayerMtgSealedProductProviderProfile,
  tcgplayerYugiohSingleCardProviderProfile,
  tcgplayerOnePieceSingleCardProviderProfile,
  tcgplayerOnePieceSealedProductProviderProfile,
  tcgplayerLorcanaSingleCardProviderProfile,
  tcgplayerLorcanaSealedProductProviderProfile,
  tcgplayerPokemonSealedProductProviderProfile,
  tcgplayerAutomationClientProviderProfile,
] as const satisfies readonly CatalogProviderIntegrationProfile[];

export const catalogProviderIntegrationProfileVersions = [
  {
    providerKey: "mtgjson",
    profileKey: "mtg-card-reference-data",
    profileVersion: "2026.06.19",
    ingestionUnitIdentity: mtgjsonMtgCardReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: mtgjsonMtgCardReferenceProviderProfile,
    sourceContract: mtgjsonMtgCardReferenceSourceObservationMappingContract.sourceContract,
    fixtures: mtgjsonMtgCardReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: mtgjsonMtgCardReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "mtgjson",
    profileKey: "mtg-set-reference-data",
    profileVersion: "2026.06.19",
    ingestionUnitIdentity: mtgjsonMtgSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: mtgjsonMtgSetReferenceProviderProfile,
    sourceContract: mtgjsonMtgSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: mtgjsonMtgSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: mtgjsonMtgSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "lorcanajson",
    profileKey: "lorcana-card-reference-data",
    profileVersion: lorcanajsonLorcanaCardReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: lorcanajsonLorcanaCardReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: lorcanajsonLorcanaCardReferenceProviderProfile,
    sourceContract: lorcanajsonLorcanaCardReferenceSourceObservationMappingContract.sourceContract,
    fixtures: lorcanajsonLorcanaCardReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: lorcanajsonLorcanaCardReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "lorcanajson",
    profileKey: "lorcana-set-reference-data",
    profileVersion: lorcanajsonLorcanaSetReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: lorcanajsonLorcanaSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: lorcanajsonLorcanaSetReferenceProviderProfile,
    sourceContract: lorcanajsonLorcanaSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: lorcanajsonLorcanaSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: lorcanajsonLorcanaSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "lorcast",
    profileKey: "lorcana-card-reference-data",
    profileVersion: lorcastLorcanaCardReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: lorcastLorcanaCardReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: lorcastLorcanaCardReferenceProviderProfile,
    sourceContract: lorcastLorcanaCardReferenceSourceObservationMappingContract.sourceContract,
    fixtures: lorcastLorcanaCardReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: lorcastLorcanaCardReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "lorcast",
    profileKey: "lorcana-set-reference-data",
    profileVersion: lorcastLorcanaSetReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: lorcastLorcanaSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: lorcastLorcanaSetReferenceProviderProfile,
    sourceContract: lorcastLorcanaSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: lorcastLorcanaSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: lorcastLorcanaSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "scryfall",
    profileKey: "mtg-card-print-reference-data",
    profileVersion: "2026.06.19",
    ingestionUnitIdentity: scryfallMtgCardPrintSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scryfallMtgCardPrintProviderProfile,
    sourceContract: scryfallMtgCardPrintSourceObservationMappingContract.sourceContract,
    fixtures: scryfallMtgCardPrintSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scryfallMtgCardPrintSourceObservationMappingContract,
  },
  {
    providerKey: "scryfall",
    profileKey: "mtg-card-image-evidence",
    profileVersion: "2026.06.19",
    ingestionUnitIdentity: scryfallMtgImageEvidenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scryfallMtgImageEvidenceProviderProfile,
    sourceContract: scryfallMtgImageEvidenceSourceObservationMappingContract.sourceContract,
    fixtures: scryfallMtgImageEvidenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scryfallMtgImageEvidenceSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "one-piece-card-print-source-observation",
    profileVersion: SCRYDEX_ONE_PIECE_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexOnePieceCardPrintSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scrydexOnePieceCardPrintProviderProfile,
    sourceContract: scrydexOnePieceCardPrintSourceObservationMappingContract.sourceContract,
    fixtures: scrydexOnePieceCardPrintSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexOnePieceCardPrintSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "one-piece-set-reference-data",
    profileVersion: SCRYDEX_ONE_PIECE_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexOnePieceSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scrydexOnePieceSetReferenceProviderProfile,
    sourceContract: scrydexOnePieceSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: scrydexOnePieceSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexOnePieceSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "one-piece-sealed-product-source-observation",
    profileVersion: SCRYDEX_ONE_PIECE_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexOnePieceSealedProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scrydexOnePieceSealedProductProviderProfile,
    sourceContract: scrydexOnePieceSealedProductSourceObservationMappingContract.sourceContract,
    fixtures: scrydexOnePieceSealedProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexOnePieceSealedProductSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "lorcana-card-print-source-observation",
    profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexLorcanaCardPrintSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scrydexLorcanaCardPrintProviderProfile,
    sourceContract: scrydexLorcanaCardPrintSourceObservationMappingContract.sourceContract,
    fixtures: scrydexLorcanaCardPrintSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexLorcanaCardPrintSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "lorcana-set-reference-data",
    profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexLorcanaSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scrydexLorcanaSetReferenceProviderProfile,
    sourceContract: scrydexLorcanaSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: scrydexLorcanaSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexLorcanaSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "lorcana-sealed-product-source-observation",
    profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexLorcanaSealedProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "test",
    active: false,
    profile: scrydexLorcanaSealedProductProviderProfile,
    sourceContract: scrydexLorcanaSealedProductSourceObservationMappingContract.sourceContract,
    fixtures: scrydexLorcanaSealedProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexLorcanaSealedProductSourceObservationMappingContract,
  },
  {
    providerKey: "ygoprodeck",
    profileKey: "yugioh-card-print-reference-data",
    profileVersion: ygoprodeckYugiohCardReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: ygoprodeckYugiohCardReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: ygoprodeckYugiohCardReferenceProviderProfile,
    sourceContract: ygoprodeckYugiohCardReferenceSourceObservationMappingContract.sourceContract,
    fixtures: ygoprodeckYugiohCardReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: ygoprodeckYugiohCardReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "ygoprodeck",
    profileKey: "yugioh-set-reference-data",
    profileVersion: ygoprodeckYugiohSetReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: ygoprodeckYugiohSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: ygoprodeckYugiohSetReferenceProviderProfile,
    sourceContract: ygoprodeckYugiohSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: ygoprodeckYugiohSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: ygoprodeckYugiohSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "ygojson",
    profileKey: "yugioh-set-reference-data",
    profileVersion: ygojsonYugiohSetReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: ygojsonYugiohSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: ygojsonYugiohSetReferenceProviderProfile,
    sourceContract: ygojsonYugiohSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: ygojsonYugiohSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: ygojsonYugiohSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "ygojson",
    profileKey: "yugioh-sealed-product-reference-data",
    profileVersion: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: ygojsonYugiohSealedProductReferenceProviderProfile,
    sourceContract: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.sourceContract,
    fixtures: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract,
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
    retirementPlan: null,
    executableMappingContract: tcgdexPokemonCardSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "mtg-single-card-product-sku",
    profileVersion: TCGPLAYER_MTG_SINGLE_CARD_PROFILE_VERSION,
    ingestionUnitIdentity: tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerMtgSingleCardProviderProfile,
    sourceContract: tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "mtg-sealed-product-sku",
    profileVersion: TCGPLAYER_MTG_SEALED_PRODUCT_PROFILE_VERSION,
    ingestionUnitIdentity: tcgplayerMtgSealedProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerMtgSealedProductProviderProfile,
    sourceContract: tcgplayerMtgSealedProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerMtgSealedProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerMtgSealedProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "yugioh-single-card-product-sku",
    profileVersion: TCGPLAYER_YUGIOH_SINGLE_CARD_PROFILE_VERSION,
    ingestionUnitIdentity:
      tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerYugiohSingleCardProviderProfile,
    sourceContract: tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "one-piece-single-card-product-sku",
    profileVersion: TCGPLAYER_ONE_PIECE_SINGLE_CARD_PROFILE_VERSION,
    ingestionUnitIdentity:
      tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerOnePieceSingleCardProviderProfile,
    sourceContract: tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "one-piece-sealed-product-sku",
    profileVersion: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_PROFILE_VERSION,
    ingestionUnitIdentity:
      tcgplayerOnePieceSealedProductProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerOnePieceSealedProductProviderProfile,
    sourceContract: tcgplayerOnePieceSealedProductProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerOnePieceSealedProductProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerOnePieceSealedProductProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "lorcana-single-card-product-sku",
    profileVersion: TCGPLAYER_LORCANA_SINGLE_CARD_PROFILE_VERSION,
    ingestionUnitIdentity:
      tcgplayerLorcanaSingleCardProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerLorcanaSingleCardProviderProfile,
    sourceContract: tcgplayerLorcanaSingleCardProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerLorcanaSingleCardProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerLorcanaSingleCardProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "lorcana-sealed-product-sku",
    profileVersion: TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION,
    ingestionUnitIdentity:
      tcgplayerLorcanaSealedProductProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerLorcanaSealedProductProviderProfile,
    sourceContract: tcgplayerLorcanaSealedProductProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerLorcanaSealedProductProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerLorcanaSealedProductProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "pokemon-single-card-product-sku",
    profileVersion: TCGPLAYER_POKEMON_SINGLE_CARD_PROFILE_VERSION,
    ingestionUnitIdentity: tcgplayerProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerPokemonSingleCardProviderProfile,
    sourceContract: tcgplayerProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "pokemon-sealed-product-sku",
    profileVersion: TCGPLAYER_POKEMON_SEALED_PRODUCT_PROFILE_VERSION,
    ingestionUnitIdentity: tcgplayerPokemonSealedProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerPokemonSealedProductProviderProfile,
    sourceContract: tcgplayerPokemonSealedProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerPokemonSealedProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerPokemonSealedProductSourceObservationMappingContract,
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
  selectorOrVersions?:
    | CatalogProviderProfileVersionSelector
    | readonly CatalogProviderIntegrationProfileVersionRecord[]
    | null,
  versionsInput?: readonly CatalogProviderIntegrationProfileVersionRecord[],
): CatalogProviderIntegrationProfileVersionRecord | null {
  const selector: CatalogProviderProfileVersionSelector | null | undefined = Array.isArray(selectorOrVersions)
    ? null
    : (selectorOrVersions as CatalogProviderProfileVersionSelector | null | undefined);
  const versions = Array.isArray(selectorOrVersions)
    ? selectorOrVersions
    : (versionsInput ?? catalogProviderIntegrationProfileVersions);
  const normalizedProviderKey = normalizeProviderKey(providerKey);
  const normalizedVersion = profileVersion?.trim() ?? "";
  const candidates = versions.filter((version) => normalizeProviderKey(version.providerKey) === normalizedProviderKey);

  if (normalizedVersion.length > 0) {
    return selectCatalogProviderProfileVersion(
      normalizedProviderKey,
      candidates.filter((version) => version.profileVersion === normalizedVersion),
      selector,
      normalizedVersion,
    );
  }

  if (selector) {
    return (
      selectActiveCatalogProviderProfileVersion(
        normalizedProviderKey,
        candidates.filter((version) => version.active && version.lifecycle === "active"),
        selector,
      ) ??
      candidates.find(
        (version) => version.lifecycle === "test" && catalogProviderProfileVersionMatchesSelector(version, selector),
      ) ??
      candidates.find(
        (version) => version.lifecycle === "draft" && catalogProviderProfileVersionMatchesSelector(version, selector),
      ) ??
      null
    );
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
  selectorOrVersions?:
    | CatalogProviderProfileVersionSelector
    | readonly CatalogProviderIntegrationProfileVersionRecord[]
    | null,
  versionsInput?: readonly CatalogProviderIntegrationProfileVersionRecord[],
): CatalogProviderIntegrationProfileVersionRecord | null {
  const selector: CatalogProviderProfileVersionSelector | null | undefined = Array.isArray(selectorOrVersions)
    ? null
    : (selectorOrVersions as CatalogProviderProfileVersionSelector | null | undefined);
  const versions = Array.isArray(selectorOrVersions)
    ? selectorOrVersions
    : (versionsInput ?? catalogProviderIntegrationProfileVersions);
  const normalizedProviderKey = normalizeProviderKey(providerKey);
  const candidates = versions.filter(
    (version) =>
      normalizeProviderKey(version.providerKey) === normalizedProviderKey &&
      version.active &&
      version.lifecycle === "active",
  );

  return selectActiveCatalogProviderProfileVersion(normalizedProviderKey, candidates, selector);
}

export function getActiveCatalogProviderSourceObservationMappingContract(
  providerKey: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderSourceObservationMappingContract | null {
  const contract = getActiveCatalogProviderIntegrationProfileVersion(
    providerKey,
    null,
    versions,
  )?.executableMappingContract;
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
    null,
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

  if (isRetiredMagicScrydexProofActive(version)) {
    diagnostics.push({
      code: "retired-magic-scrydex-proof-active",
      path: "profile.connector.kind",
      diagnosticText:
        "The retired Scrydex Scryfall-style Magic proof is test-scoped evidence and cannot be activated as a production sync unit. Use MTGJSON, Scryfall, and TCGplayer Magic profiles for production Magic sync.",
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

  if (
    version.ingestionUnitIdentity &&
    version.executableMappingContract.ingestionUnitIdentity &&
    !sameIngestionUnitIdentity(version.ingestionUnitIdentity, version.executableMappingContract.ingestionUnitIdentity)
  ) {
    diagnostics.push({
      code: "ingestion-unit-identity-mismatch",
      path: "executableMappingContract.ingestionUnitIdentity",
      diagnosticText: "The executable mapping contract ingestion-unit identity must match the profile version record.",
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

function isRetiredMagicScrydexProofActive(version: CatalogProviderIntegrationProfileVersionRecord): boolean {
  return (
    version.active &&
    version.lifecycle === "active" &&
    normalizeProviderKey(version.providerKey) === "scrydex" &&
    (version.profile.connector.kind === "scrydex-scryfall-json" || version.profileKey === "scryfall-card-fixture")
  );
}

function sameIngestionUnitIdentity(
  expected: CatalogProviderIngestionUnitIdentityContract,
  actual: CatalogProviderIngestionUnitIdentityContract | undefined,
): boolean {
  if (!actual) {
    return false;
  }

  return (
    actual.unitKey === expected.unitKey &&
    actual.providerKey === expected.providerKey &&
    actual.productDomain === expected.productDomain &&
    actual.productForm === expected.productForm &&
    actual.ingestionPurpose === expected.ingestionPurpose
  );
}

export function activateCatalogProviderIntegrationProfileVersion(
  providerKey: string,
  profileVersion: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  selector?: CatalogProviderProfileVersionSelector | null,
): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  const normalizedProviderKey = normalizeProviderKey(providerKey);
  const target = getCatalogProviderIntegrationProfileVersion(providerKey, profileVersion, selector, versions);
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
    if (sameCatalogProviderProfileVersionIdentity(version, target)) {
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
    return version.active && catalogProviderProfileVersionsCompete(version, target)
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
  selector?: CatalogProviderProfileVersionSelector | null,
): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  return activateCatalogProviderIntegrationProfileVersion(providerKey, rollbackToProfileVersion, versions, selector);
}

export function metadataObject(entries: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  return entries;
}

function normalizeProviderKey(providerKey: string): string {
  return providerKey.trim().toLowerCase();
}

export function catalogProviderProfileVersionIngestionUnitKey(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogIntegrationUnitKey {
  return (
    version.ingestionUnitIdentity?.unitKey ??
    version.executableMappingContract?.ingestionUnitIdentity?.unitKey ??
    inferCatalogProviderIngestionUnitKey(version)
  );
}

export function catalogProviderProfileVersionsCompete(
  candidate: CatalogProviderIntegrationProfileVersionRecord,
  target: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  if (normalizeProviderKey(candidate.providerKey) !== normalizeProviderKey(target.providerKey)) {
    return false;
  }

  return (
    candidate.profileKey === target.profileKey ||
    catalogProviderProfileVersionIngestionUnitKey(candidate) === catalogProviderProfileVersionIngestionUnitKey(target)
  );
}

export function selectActiveCatalogProviderProfileVersion(
  providerKey: string,
  activeVersions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  selector?: CatalogProviderProfileVersionSelector | null,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const normalizedProfileKey = selector?.profileKey?.trim().toLowerCase() ?? "";
  const normalizedUnitKey = selector?.ingestionUnitKey?.trim().toLowerCase() ?? "";
  const selected =
    normalizedProfileKey || normalizedUnitKey
      ? activeVersions.filter(
          (version) =>
            (!normalizedProfileKey || version.profileKey.trim().toLowerCase() === normalizedProfileKey) &&
            (!normalizedUnitKey ||
              catalogProviderProfileVersionIngestionUnitKey(version).trim().toLowerCase() === normalizedUnitKey),
        )
      : activeVersions;

  if (selected.length === 0) {
    return null;
  }
  if (selected.length === 1) {
    return selected[0] ?? null;
  }

  const options = selected
    .map(
      (version) =>
        `${version.providerKey}/${version.profileKey}@${version.profileVersion} (${catalogProviderProfileVersionIngestionUnitKey(
          version,
        )})`,
    )
    .join(", ");
  const selectorText =
    normalizedProfileKey || normalizedUnitKey
      ? `profileKey='${normalizedProfileKey || "*"}' ingestionUnitKey='${normalizedUnitKey || "*"}'`
      : "no profileKey or ingestionUnitKey";
  throw new Error(
    `Catalog provider '${normalizeProviderKey(
      providerKey,
    )}' has multiple active profile units for ${selectorText}. Select a profileKey or ingestionUnitKey. Active versions: ${options}.`,
  );
}

function catalogProviderProfileVersionMatchesSelector(
  version: CatalogProviderIntegrationProfileVersionRecord,
  selector: CatalogProviderProfileVersionSelector,
): boolean {
  const normalizedProfileKey = selector.profileKey?.trim().toLowerCase() ?? "";
  const normalizedUnitKey = selector.ingestionUnitKey?.trim().toLowerCase() ?? "";
  return (
    (!normalizedProfileKey || version.profileKey.trim().toLowerCase() === normalizedProfileKey) &&
    (!normalizedUnitKey ||
      catalogProviderProfileVersionIngestionUnitKey(version).trim().toLowerCase() === normalizedUnitKey)
  );
}

function selectCatalogProviderProfileVersion(
  providerKey: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  selector: CatalogProviderProfileVersionSelector | null | undefined,
  profileVersion: string,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const normalizedProfileKey = selector?.profileKey?.trim().toLowerCase() ?? "";
  const normalizedUnitKey = selector?.ingestionUnitKey?.trim().toLowerCase() ?? "";
  const selected = versions.filter(
    (version) =>
      (!normalizedProfileKey || version.profileKey.trim().toLowerCase() === normalizedProfileKey) &&
      (!normalizedUnitKey ||
        catalogProviderProfileVersionIngestionUnitKey(version).trim().toLowerCase() === normalizedUnitKey),
  );

  if (selected.length === 0) {
    return null;
  }
  if (selected.length === 1) {
    return selected[0] ?? null;
  }

  const options = selected
    .map(
      (version) =>
        `${version.providerKey}/${version.profileKey}@${version.profileVersion} (${catalogProviderProfileVersionIngestionUnitKey(
          version,
        )})`,
    )
    .join(", ");
  throw new Error(
    `Catalog provider '${normalizeProviderKey(
      providerKey,
    )}' has multiple profile units for version '${profileVersion}'. Select a profileKey or ingestionUnitKey. Versions: ${options}.`,
  );
}

function sameCatalogProviderProfileVersionIdentity(
  candidate: CatalogProviderIntegrationProfileVersionRecord,
  target: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  return (
    normalizeProviderKey(candidate.providerKey) === normalizeProviderKey(target.providerKey) &&
    candidate.profileKey === target.profileKey &&
    candidate.profileVersion === target.profileVersion &&
    catalogProviderProfileVersionIngestionUnitKey(candidate) === catalogProviderProfileVersionIngestionUnitKey(target)
  );
}

function inferCatalogProviderIngestionUnitKey(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogIntegrationUnitKey {
  return defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: version.providerKey,
    productDomain: inferProductDomain(version),
    productForm: inferProductForm(version),
    ingestionPurpose: "source-observation-import",
  }).unitKey;
}

function inferProductDomain(
  version: CatalogProviderIntegrationProfileVersionRecord,
): "pokemon" | "mtg" | "yugioh" | "one-piece" | "lorcana" {
  const signals = [
    version.profileKey,
    version.profile.catalogFieldMapping.blueprintKey,
    version.profile.catalogFieldMapping.categoryKey,
    version.executableMappingContract?.normalizedObservation.outputKind ?? "",
    version.executableMappingContract?.normalizedObservation.fields.tcg?.selector.kind === "constant"
      ? String(version.executableMappingContract.normalizedObservation.fields.tcg.selector.value)
      : "",
    version.executableMappingContract?.normalizedObservation.fields.productLineName?.selector.kind === "constant"
      ? String(version.executableMappingContract.normalizedObservation.fields.productLineName.selector.value)
      : "",
  ]
    .join(" ")
    .toLowerCase();

  if (
    signals.includes("yugioh") ||
    signals.includes("yu-gi-oh") ||
    signals.includes("yu gi oh") ||
    signals.includes("ygoprodeck") ||
    signals.includes("ygojson")
  ) {
    return "yugioh";
  }
  if (signals.includes("one-piece") || signals.includes("one piece") || signals.includes("onepiece")) {
    return "one-piece";
  }
  if (signals.includes("lorcana")) {
    return "lorcana";
  }
  return signals.includes("magic") || signals.includes("scryfall") || signals.includes("mtg") ? "mtg" : "pokemon";
}

function inferProductForm(
  version: CatalogProviderIntegrationProfileVersionRecord,
): "single-card" | "sealed-product" | "set" | "pack" {
  const signals = [
    version.profileKey,
    version.profile.catalogFieldMapping.blueprintKey,
    version.profile.supportedScopes.join(" "),
    version.executableMappingContract?.displayName ?? "",
    version.executableMappingContract?.normalizedObservation.outputKind ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (signals.includes("pack-reference") || signals.includes(":pack:")) {
    return "pack";
  }
  if (signals.includes("sealed-product")) {
    return "sealed-product";
  }
  if (
    signals.includes("set") &&
    (version.executableMappingContract?.normalizedObservation.outputKind === "magic-set-reference" ||
      version.executableMappingContract?.normalizedObservation.outputKind === "yugioh-set-reference" ||
      version.executableMappingContract?.normalizedObservation.outputKind === "one-piece-set-reference" ||
      version.executableMappingContract?.normalizedObservation.outputKind === "lorcana-set-reference")
  ) {
    return "set";
  }
  return "single-card";
}
