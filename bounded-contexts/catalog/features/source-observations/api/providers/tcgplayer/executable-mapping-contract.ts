import type { JsonValue } from "@chase-sets/primitives/json";
import {
  defineCatalogProviderIngestionUnitIdentityContract,
  type CatalogProviderExecutableMappingContract,
  type CatalogProviderMappingEvidenceOwner,
  type CatalogProviderMappingEvidenceUse,
  type CatalogProviderMappingValueExpression,
} from "../provider-integration-mapping-contract";

export const TCGPLAYER_MTG_SINGLE_CARD_PROFILE_VERSION = "2026.06.19";
export const TCGPLAYER_MTG_SEALED_PRODUCT_PROFILE_VERSION = "2026.06.19";
export const TCGPLAYER_YUGIOH_SINGLE_CARD_PROFILE_VERSION = "2026.06.20";
export const TCGPLAYER_ONE_PIECE_SINGLE_CARD_PROFILE_VERSION = "2026.06.22";
export const TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_PROFILE_VERSION = "2026.06.23";
export const TCGPLAYER_LORCANA_SINGLE_CARD_PROFILE_VERSION = "2026.06.23";
export const TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION = "2026.06.23";
export const TCGPLAYER_POKEMON_SINGLE_CARD_PROFILE_VERSION = "2026.06.05";
export const TCGPLAYER_POKEMON_SEALED_PRODUCT_PROFILE_VERSION = "2026.07.13";

export const tcgplayerPokemonSingleCardIngestionUnitIdentity = defineCatalogProviderIngestionUnitIdentityContract({
  providerKey: "tcgplayer",
  productDomain: "pokemon",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const tcgplayerMtgSingleCardIngestionUnitIdentity = defineCatalogProviderIngestionUnitIdentityContract({
  providerKey: "tcgplayer",
  productDomain: "mtg",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const tcgplayerYugiohSingleCardIngestionUnitIdentity = defineCatalogProviderIngestionUnitIdentityContract({
  providerKey: "tcgplayer",
  productDomain: "yugioh",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const tcgplayerOnePieceSingleCardIngestionUnitIdentity = defineCatalogProviderIngestionUnitIdentityContract({
  providerKey: "tcgplayer",
  productDomain: "one-piece",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const tcgplayerLorcanaSingleCardIngestionUnitIdentity = defineCatalogProviderIngestionUnitIdentityContract({
  providerKey: "tcgplayer",
  productDomain: "lorcana",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const tcgplayerMtgSealedProductIngestionUnitIdentity = defineCatalogProviderIngestionUnitIdentityContract({
  providerKey: "tcgplayer",
  productDomain: "mtg",
  productForm: "sealed-product",
  ingestionPurpose: "source-observation-import",
});

export const tcgplayerPokemonSealedProductIngestionUnitIdentity = defineCatalogProviderIngestionUnitIdentityContract({
  providerKey: "tcgplayer",
  productDomain: "pokemon",
  productForm: "sealed-product",
  ingestionPurpose: "source-observation-import",
});

export const tcgplayerOnePieceSealedProductIngestionUnitIdentity = defineCatalogProviderIngestionUnitIdentityContract({
  providerKey: "tcgplayer",
  productDomain: "one-piece",
  productForm: "sealed-product",
  ingestionPurpose: "source-observation-import",
});

export const tcgplayerLorcanaSealedProductIngestionUnitIdentity = defineCatalogProviderIngestionUnitIdentityContract({
  providerKey: "tcgplayer",
  productDomain: "lorcana",
  productForm: "sealed-product",
  ingestionPurpose: "source-observation-import",
});

const tcgplayerConnectorContract = {
  kind: "tcgplayer-automation-client",
  transportOwns: ["auth", "domains", "endpoint-paths", "pagination", "throttling", "raw-provider-parse"],
  mappingOwns: [
    "source-payload",
    "normalized-observation",
    "hash-material",
    "merge-identity",
    "external-reference",
    "selected-option",
    "reference-hierarchy",
  ],
} as const;

const tcgplayerFixtureFlows = [
  "normal",
  "partial",
  "stale",
  "changed",
  "ambiguous",
  "replay",
  "sealed-product",
  "unknown-option",
] as const;

const sourceObservation = {
  observationId: pathExpression("observationId", "catalog-merge-evidence", ["normalized-observation"]),
  externalKey: pathExpression("externalKey", "external-reference", ["external-reference"]),
  sourceUrl: pathExpression("sourceUrl", "operations", ["source-payload"]),
  sourceUpdatedAt: optionalPathExpression("sourceUpdatedAt", "catalog-truth", ["normalized-observation"]),
  sourcePayload: pathExpression("sourcePayload", "catalog-merge-evidence", ["source-payload"]),
} as const;

const providerProductFields = {
  name: pathExpression("productName", "catalog-truth", ["normalized-observation", "hash-material"]),
  setName: pathExpression("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
  expansionName: pathExpression("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
  cardNumber: optionalPathExpression("customAttributes.number", "catalog-truth", [
    "normalized-observation",
    "hash-material",
  ]),
  imageUrls: constantExpression([], "catalog-truth", ["normalized-observation"]),
  mergeIdentity: pathExpression("mergeIdentity", "catalog-merge-evidence", [
    "normalized-observation",
    "merge-identity",
  ]),
  externalCatalogItemReferences: pathExpression("externalCatalogItemReferences", "external-reference", [
    "normalized-observation",
    "external-reference",
  ]),
  externalProductReferences: pathExpression("externalProductReferences", "external-reference", [
    "normalized-observation",
    "external-reference",
  ]),
  providerProductId: pathExpression("productId", "external-reference", ["normalized-observation", "hash-material"], {
    transforms: [{ kind: "coerce", to: "string" }],
  }),
  providerProductName: pathExpression("productName", "catalog-truth", ["normalized-observation", "hash-material"]),
  productLineName: pathExpression("productLineName", "catalog-merge-evidence", [
    "normalized-observation",
    "merge-identity",
  ]),
  productCategoryName: pathExpression("productTypeName", "catalog-merge-evidence", ["normalized-observation"]),
  skuReferences: pathExpression("skuReferences", "external-reference", ["normalized-observation"]),
  productForm: pathExpression("productForm", "catalog-merge-evidence", ["normalized-observation", "merge-identity"]),
  barcode: optionalPathExpression("barcode", "catalog-merge-evidence", ["normalized-observation", "merge-identity"]),
} as const;

const providerProductNormalizedObservation = {
  outputKind: "provider-product",
  languageCode: constantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
  fields: providerProductFields,
  hashMaterial: [pathExpression("catalogHashMaterial", "catalog-truth", ["hash-material"])],
  mergeIdentity: [pathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"])],
} as const;

const magicSealedProductFields = {
  tcg: constantExpression("magic", "catalog-truth", ["normalized-observation", "hash-material"]),
  name: pathExpression("productName", "catalog-truth", ["normalized-observation", "hash-material"]),
  setCode: pathExpression("setCode", "catalog-truth", ["normalized-observation", "hash-material"]),
  setName: pathExpression("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
  setId: pathExpression("setId", "catalog-merge-evidence", ["normalized-observation", "merge-identity"], {
    transforms: [{ kind: "coerce", to: "string" }],
  }),
  sealedProductForm: pathExpression("sealedProductForm", "catalog-truth", ["normalized-observation", "hash-material"]),
  packCount: pathExpression("packCount", "catalog-truth", ["normalized-observation", "hash-material"], {
    transforms: [{ kind: "coerce", to: "number" }],
  }),
  releaseDate: optionalPathExpression("customAttributes.releaseDate", "catalog-truth", [
    "normalized-observation",
    "hash-material",
  ]),
  releaseYear: optionalPathExpression("releaseYear", "catalog-truth", ["normalized-observation", "hash-material"]),
  productLineName: constantExpression("Magic: The Gathering", "catalog-truth", [
    "normalized-observation",
    "hash-material",
  ]),
  barcode: optionalPathExpression("barcode", "catalog-merge-evidence", ["normalized-observation", "merge-identity"]),
  imageUrls: pathExpression("imageUrls", "catalog-truth", ["normalized-observation"]),
  mergeIdentity: pathExpression("mergeIdentity", "catalog-merge-evidence", [
    "normalized-observation",
    "merge-identity",
  ]),
  externalCatalogItemReferences: pathExpression("externalCatalogItemReferences", "external-reference", [
    "normalized-observation",
    "external-reference",
  ]),
  externalProductReferences: pathExpression("externalProductReferences", "external-reference", [
    "normalized-observation",
    "external-reference",
  ]),
} as const;

const magicSealedProductNormalizedObservation = {
  outputKind: "magic-sealed-product",
  languageCode: constantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
  fields: magicSealedProductFields,
  hashMaterial: [pathExpression("catalogHashMaterial", "catalog-truth", ["hash-material"])],
  mergeIdentity: [pathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"])],
} as const;

const pokemonSealedProductFields = {
  tcg: constantExpression("pokemon", "catalog-truth", ["normalized-observation", "hash-material"]),
  name: pathExpression("productName", "catalog-truth", ["normalized-observation", "hash-material"]),
  setCode: optionalPathExpression("setCode", "catalog-truth", ["normalized-observation", "hash-material"]),
  setName: pathExpression("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
  setId: pathExpression("setId", "catalog-merge-evidence", ["normalized-observation", "merge-identity"], {
    transforms: [{ kind: "coerce", to: "string" }],
  }),
  sealedProductForm: pathExpression("sealedProductForm", "catalog-truth", ["normalized-observation", "hash-material"]),
  packCount: pathExpression("packCount", "catalog-truth", ["normalized-observation", "hash-material"], {
    transforms: [{ kind: "coerce", to: "number" }],
  }),
  releaseDate: optionalPathExpression("customAttributes.releaseDate", "catalog-truth", [
    "normalized-observation",
    "hash-material",
  ]),
  releaseYear: optionalPathExpression("releaseYear", "catalog-truth", ["normalized-observation", "hash-material"]),
  productLineName: constantExpression("Pokemon", "catalog-truth", ["normalized-observation", "hash-material"]),
  barcode: optionalPathExpression("barcode", "catalog-merge-evidence", ["normalized-observation", "merge-identity"]),
  imageUrls: pathExpression("imageUrls", "catalog-truth", ["normalized-observation"]),
  mergeIdentity: pathExpression("mergeIdentity", "catalog-merge-evidence", [
    "normalized-observation",
    "merge-identity",
  ]),
  externalCatalogItemReferences: pathExpression("externalCatalogItemReferences", "external-reference", [
    "normalized-observation",
    "external-reference",
  ]),
  externalProductReferences: pathExpression("externalProductReferences", "external-reference", [
    "normalized-observation",
    "external-reference",
  ]),
} as const;

const pokemonSealedProductNormalizedObservation = {
  outputKind: "pokemon-sealed-product",
  languageCode: constantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
  fields: pokemonSealedProductFields,
  hashMaterial: [pathExpression("catalogHashMaterial", "catalog-truth", ["hash-material"])],
  mergeIdentity: [pathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"])],
} as const;

const externalReferences = [
  {
    target: "catalog-item-reference",
    providerKey: "tcgplayer",
    externalKeyPrefix: "product:",
    source: pathExpression("externalCatalogItemReferences", "external-reference", ["external-reference"]),
    ambiguityPolicy: "skip-reference",
  },
  {
    target: "product-reference",
    providerKey: "tcgplayer",
    externalKeyPrefix: "sku:",
    source: pathExpression("externalProductReferences", "external-reference", [
      "external-reference",
      "selected-option",
    ]),
    selectedOptions: {
      dimensions: [],
      missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
    },
    ambiguityPolicy: "review-evidence",
  },
] as const;

const referenceHierarchy = [
  {
    targetTypeKey: "expansion",
    providerAttributeKey: "tcgplayer-set-name",
    referenceRecordKey: pathExpression("setName", "catalog-merge-evidence", ["reference-hierarchy"]),
    parent: {
      targetTypeKey: "product-line",
      providerAttributeKey: "tcgplayer-product-line-id",
      referenceRecordKey: pathExpression("productLineId", "external-reference", ["reference-hierarchy"], {
        transforms: [{ kind: "coerce", to: "string" }],
      }),
    },
  },
] as const;

const duplicatePrevention = {
  exactExternalCatalogItemReferencesFirst: true,
  mergeCandidateEvidence: [
    pathExpression("externalCatalogItemReferences", "external-reference", ["external-reference"]),
    pathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"]),
    optionalPathExpression("barcode", "catalog-merge-evidence", ["merge-identity"]),
  ],
  identityRules: [
    {
      ruleKey: "exact-external-catalog-item-reference",
      ruleKind: "exact-external-catalog-item-reference",
      evidence: [pathExpression("externalCatalogItemReferences", "external-reference", ["external-reference"])],
      candidatePolicy: "reuse",
    },
    {
      ruleKey: "exact-external-product-reference",
      ruleKind: "exact-external-product-reference",
      evidence: [pathExpression("externalProductReferences", "external-reference", ["external-reference"])],
      candidatePolicy: "reuse",
    },
    {
      ruleKey: "sealed-product-deterministic-fields",
      ruleKind: "sealed-product-match",
      evidence: [pathExpression("mergeIdentity.productForm", "catalog-merge-evidence", ["merge-identity"])],
      candidatePolicy: "review-only",
    },
    {
      ruleKey: "barcode-gtin-review",
      ruleKind: "barcode-gtin-match",
      evidence: [optionalPathExpression("barcode", "catalog-merge-evidence", ["merge-identity"])],
      candidatePolicy: "review-only",
    },
    {
      ruleKey: "future-provider-bridge-review",
      ruleKind: "future-provider-bridge-match",
      evidence: [pathExpression("externalCatalogItemReferences", "external-reference", ["external-reference"])],
      candidatePolicy: "review-only",
    },
  ],
  ambiguousCandidatePolicy: "block-promotion",
  replayPolicy: "same-profile-version",
} as const;

const promotionCommandPlan = {
  planKind: "catalog-item-promotion",
  requiresReview: true,
  commands: [],
} as const;

const magicSealedPromotionCommandPlan = {
  planKind: "catalog-item-promotion",
  requiresReview: true,
  commands: [
    {
      commandName: "CreateCatalogItem",
      inputs: { title: pathExpression("productName", "catalog-truth", ["promotion-command"]) },
    },
    {
      commandName: "AssignBlueprintToCatalogItem",
      inputs: {
        blueprintKey: constantExpression("magic-sealed-product", "catalog-truth", ["promotion-command"]),
      },
    },
    {
      commandName: "SetCatalogItemFieldValue",
      inputs: {
        fieldKey: constantExpression("pack-count", "catalog-truth", ["promotion-command"]),
        value: pathExpression("packCount", "catalog-truth", ["promotion-command"], {
          transforms: [{ kind: "coerce", to: "number" }],
        }),
      },
    },
    {
      commandName: "AssignCatalogItemToCategory",
      inputs: { categoryKey: constantExpression("magic-booster-packs", "catalog-truth", ["promotion-command"]) },
    },
    {
      commandName: "LinkExternalCatalogItemReference",
      inputs: {
        references: pathExpression("externalCatalogItemReferences", "external-reference", ["promotion-command"]),
      },
    },
  ],
} as const;

const pokemonSealedPromotionCommandPlan = {
  planKind: "catalog-item-promotion",
  requiresReview: true,
  commands: [
    {
      commandName: "CreateCatalogItem",
      inputs: { title: pathExpression("productName", "catalog-truth", ["promotion-command"]) },
    },
    {
      commandName: "AssignBlueprintToCatalogItem",
      inputs: {
        blueprintKey: constantExpression("pokemon-sealed-product", "catalog-truth", ["promotion-command"]),
      },
    },
    {
      commandName: "SetCatalogItemFieldValue",
      inputs: {
        fieldKey: constantExpression("pack-count", "catalog-truth", ["promotion-command"]),
        value: pathExpression("packCount", "catalog-truth", ["promotion-command"], {
          transforms: [{ kind: "coerce", to: "number" }],
        }),
      },
    },
    {
      commandName: "AssignCatalogItemToCategory",
      inputs: { categoryKey: constantExpression("sealed-products", "catalog-truth", ["promotion-command"]) },
    },
    {
      commandName: "LinkExternalCatalogItemReference",
      inputs: {
        references: pathExpression("externalCatalogItemReferences", "external-reference", ["promotion-command"]),
      },
    },
  ],
} as const;

const nonGoals = [
  "no-live-provider-calls-in-mapping-tests",
  "no-pricing-facts-as-catalog-truth",
  "no-inventory-facts-as-global-catalog-truth",
  "no-provider-secrets-in-events-logs-or-fixtures",
  "no-provider-transport-branches-in-mapping-interpreter",
] as const;

export const tcgplayerProviderProductSourceObservationMappingContract = {
  providerKey: "tcgplayer",
  profileKey: "pokemon-single-card-product-sku",
  displayName: "TCGplayer Pokemon Single Cards",
  profileVersion: TCGPLAYER_POKEMON_SINGLE_CARD_PROFILE_VERSION,
  lifecycle: "active",
  ingestionUnitIdentity: tcgplayerPokemonSingleCardIngestionUnitIdentity,
  sourceContract: {
    owner: "Catalog",
    repository: "todd-skelton/tcgplayer-automation-app",
    commit: "bf42aa8",
    documentPath: "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
    fixtureSetVersion: "automation-client-contract-v1",
  },
  connector: tcgplayerConnectorContract,
  fixtures: {
    fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-automation",
    coveredFlows: tcgplayerFixtureFlows,
    liveProviderCallsAllowed: false,
  },
  sourceObservation,
  normalizedObservation: {
    ...providerProductNormalizedObservation,
    fields: {
      ...providerProductFields,
      mergeIdentity: tcgplayerPokemonMergeIdentityExpression(),
    },
  },
  externalReferences,
  referenceHierarchy,
  duplicatePrevention,
  promotionCommandPlan,
  nonGoals,
} as const satisfies CatalogProviderExecutableMappingContract;

export const tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract = {
  ...tcgplayerProviderProductSourceObservationMappingContract,
  profileKey: "mtg-single-card-product-sku",
  displayName: "TCGplayer Magic Single-Card Product and SKU",
  profileVersion: TCGPLAYER_MTG_SINGLE_CARD_PROFILE_VERSION,
  lifecycle: "active",
  ingestionUnitIdentity: tcgplayerMtgSingleCardIngestionUnitIdentity,
  sourceContract: {
    ...tcgplayerProviderProductSourceObservationMappingContract.sourceContract,
    owner: "chase-sets/catalog",
    repository: "chase-sets/chase-sets",
    commit: null,
    fixtureSetVersion: "tcgplayer-mtg-single-card-production-v1",
  },
  fixtures: {
    fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-mtg-single-card",
    coveredFlows: tcgplayerFixtureFlows,
    liveProviderCallsAllowed: false,
  },
  normalizedObservation: {
    ...providerProductNormalizedObservation,
    fields: {
      tcg: constantExpression("magic", "catalog-truth", ["normalized-observation", "hash-material"]),
      ...providerProductFields,
    },
  },
} as const satisfies CatalogProviderExecutableMappingContract;

export const tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract = {
  ...tcgplayerProviderProductSourceObservationMappingContract,
  profileKey: "yugioh-single-card-product-sku",
  displayName: "TCGplayer Yu-Gi-Oh Single-Card Product and SKU",
  profileVersion: TCGPLAYER_YUGIOH_SINGLE_CARD_PROFILE_VERSION,
  lifecycle: "active",
  ingestionUnitIdentity: tcgplayerYugiohSingleCardIngestionUnitIdentity,
  sourceContract: {
    ...tcgplayerProviderProductSourceObservationMappingContract.sourceContract,
    owner: "chase-sets/catalog",
    repository: "chase-sets/chase-sets",
    commit: null,
    fixtureSetVersion: "tcgplayer-yugioh-single-card-production-v1",
  },
  fixtures: {
    fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-yugioh-single-card",
    coveredFlows: tcgplayerFixtureFlows,
    liveProviderCallsAllowed: false,
  },
  normalizedObservation: {
    ...providerProductNormalizedObservation,
    fields: {
      tcg: constantExpression("yugioh", "catalog-truth", ["normalized-observation", "hash-material"]),
      ...providerProductFields,
    },
  },
} as const satisfies CatalogProviderExecutableMappingContract;

export const tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract = {
  ...tcgplayerProviderProductSourceObservationMappingContract,
  profileKey: "one-piece-single-card-product-sku",
  displayName: "TCGplayer One Piece Single-Card Product and SKU",
  profileVersion: TCGPLAYER_ONE_PIECE_SINGLE_CARD_PROFILE_VERSION,
  lifecycle: "active",
  ingestionUnitIdentity: tcgplayerOnePieceSingleCardIngestionUnitIdentity,
  sourceContract: {
    ...tcgplayerProviderProductSourceObservationMappingContract.sourceContract,
    owner: "chase-sets/catalog",
    repository: "chase-sets/chase-sets",
    commit: null,
    fixtureSetVersion: "tcgplayer-one-piece-single-card-production-v1",
  },
  fixtures: {
    fixtureRoot:
      "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-one-piece-single-card",
    coveredFlows: tcgplayerFixtureFlows,
    liveProviderCallsAllowed: false,
  },
  normalizedObservation: {
    ...providerProductNormalizedObservation,
    fields: {
      tcg: constantExpression("one-piece", "catalog-truth", ["normalized-observation", "hash-material"]),
      ...providerProductFields,
      imageUrls: tcgplayerOnePieceImageUrlsExpression(),
    },
  },
} as const satisfies CatalogProviderExecutableMappingContract;

export const tcgplayerMtgSealedProductSourceObservationMappingContract = {
  ...tcgplayerProviderProductSourceObservationMappingContract,
  profileKey: "mtg-sealed-product-sku",
  displayName: "TCGplayer Magic Sealed Product and SKU",
  profileVersion: TCGPLAYER_MTG_SEALED_PRODUCT_PROFILE_VERSION,
  lifecycle: "active",
  ingestionUnitIdentity: tcgplayerMtgSealedProductIngestionUnitIdentity,
  sourceContract: {
    ...tcgplayerProviderProductSourceObservationMappingContract.sourceContract,
    owner: "chase-sets/catalog",
    repository: "chase-sets/chase-sets",
    commit: null,
    fixtureSetVersion: "tcgplayer-mtg-sealed-product-production-v1",
  },
  fixtures: {
    fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-mtg-sealed-product",
    coveredFlows: tcgplayerFixtureFlows,
    liveProviderCallsAllowed: false,
  },
  normalizedObservation: magicSealedProductNormalizedObservation,
  promotionCommandPlan: magicSealedPromotionCommandPlan,
  duplicatePrevention: {
    ...duplicatePrevention,
    identityRules: duplicatePrevention.identityRules.map((rule) =>
      rule.ruleKey === "sealed-product-deterministic-fields"
        ? {
            ...rule,
            evidence: [
              pathExpression("sealedProductForm", "catalog-merge-evidence", ["merge-identity"]),
              pathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"]),
            ],
          }
        : rule,
    ),
  },
} as const satisfies CatalogProviderExecutableMappingContract;

export const tcgplayerPokemonSealedProductSourceObservationMappingContract = {
  ...tcgplayerProviderProductSourceObservationMappingContract,
  profileKey: "pokemon-sealed-product-sku",
  displayName: "TCGplayer Pokemon Sealed Product and SKU",
  profileVersion: TCGPLAYER_POKEMON_SEALED_PRODUCT_PROFILE_VERSION,
  lifecycle: "active",
  ingestionUnitIdentity: tcgplayerPokemonSealedProductIngestionUnitIdentity,
  sourceContract: {
    ...tcgplayerProviderProductSourceObservationMappingContract.sourceContract,
    owner: "chase-sets/catalog",
    repository: "chase-sets/chase-sets",
    commit: null,
    fixtureSetVersion: "tcgplayer-pokemon-sealed-product-production-v1",
  },
  fixtures: {
    fixtureRoot:
      "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-pokemon-sealed-product",
    coveredFlows: tcgplayerFixtureFlows,
    liveProviderCallsAllowed: false,
  },
  normalizedObservation: pokemonSealedProductNormalizedObservation,
  promotionCommandPlan: pokemonSealedPromotionCommandPlan,
  duplicatePrevention: {
    ...duplicatePrevention,
    identityRules: duplicatePrevention.identityRules.map((rule) =>
      rule.ruleKey === "sealed-product-deterministic-fields"
        ? {
            ...rule,
            evidence: [
              pathExpression("sealedProductForm", "catalog-merge-evidence", ["merge-identity"]),
              pathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"]),
            ],
          }
        : rule,
    ),
  },
} as const satisfies CatalogProviderExecutableMappingContract;

export const tcgplayerOnePieceSealedProductProviderProductSourceObservationMappingContract = {
  ...tcgplayerProviderProductSourceObservationMappingContract,
  profileKey: "one-piece-sealed-product-sku",
  displayName: "TCGplayer One Piece Sealed Product and SKU",
  profileVersion: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_PROFILE_VERSION,
  lifecycle: "active",
  ingestionUnitIdentity: tcgplayerOnePieceSealedProductIngestionUnitIdentity,
  sourceContract: {
    ...tcgplayerProviderProductSourceObservationMappingContract.sourceContract,
    owner: "chase-sets/catalog",
    repository: "chase-sets/chase-sets",
    commit: null,
    fixtureSetVersion: "tcgplayer-one-piece-sealed-product-production-v1",
  },
  fixtures: {
    fixtureRoot:
      "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-one-piece-sealed-product",
    coveredFlows: tcgplayerFixtureFlows,
    liveProviderCallsAllowed: false,
  },
  normalizedObservation: {
    ...providerProductNormalizedObservation,
    fields: {
      tcg: constantExpression("one-piece", "catalog-truth", ["normalized-observation", "hash-material"]),
      ...providerProductFields,
    },
  },
} as const satisfies CatalogProviderExecutableMappingContract;

export const tcgplayerLorcanaSingleCardProviderProductSourceObservationMappingContract = {
  ...tcgplayerProviderProductSourceObservationMappingContract,
  profileKey: "lorcana-single-card-product-sku",
  displayName: "TCGplayer Lorcana Single-Card Product and SKU",
  profileVersion: TCGPLAYER_LORCANA_SINGLE_CARD_PROFILE_VERSION,
  lifecycle: "active",
  ingestionUnitIdentity: tcgplayerLorcanaSingleCardIngestionUnitIdentity,
  sourceContract: {
    ...tcgplayerProviderProductSourceObservationMappingContract.sourceContract,
    owner: "chase-sets/catalog",
    repository: "chase-sets/chase-sets",
    commit: null,
    fixtureSetVersion: "tcgplayer-lorcana-single-card-production-v1",
  },
  fixtures: {
    fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-lorcana-single-card",
    coveredFlows: tcgplayerFixtureFlows,
    liveProviderCallsAllowed: false,
  },
  normalizedObservation: {
    ...providerProductNormalizedObservation,
    fields: {
      tcg: constantExpression("lorcana", "catalog-truth", ["normalized-observation", "hash-material"]),
      ...providerProductFields,
    },
  },
} as const satisfies CatalogProviderExecutableMappingContract;

export const tcgplayerLorcanaSealedProductProviderProductSourceObservationMappingContract = {
  ...tcgplayerProviderProductSourceObservationMappingContract,
  profileKey: "lorcana-sealed-product-sku",
  displayName: "TCGplayer Lorcana Sealed Product and SKU",
  profileVersion: TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION,
  lifecycle: "active",
  ingestionUnitIdentity: tcgplayerLorcanaSealedProductIngestionUnitIdentity,
  sourceContract: {
    ...tcgplayerProviderProductSourceObservationMappingContract.sourceContract,
    owner: "chase-sets/catalog",
    repository: "chase-sets/chase-sets",
    commit: null,
    fixtureSetVersion: "tcgplayer-lorcana-sealed-product-production-v1",
  },
  fixtures: {
    fixtureRoot:
      "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-lorcana-sealed-product",
    coveredFlows: tcgplayerFixtureFlows,
    liveProviderCallsAllowed: false,
  },
  normalizedObservation: {
    ...providerProductNormalizedObservation,
    fields: {
      tcg: constantExpression("lorcana", "catalog-truth", ["normalized-observation", "hash-material"]),
      ...providerProductFields,
    },
  },
} as const satisfies CatalogProviderExecutableMappingContract;

function pathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
  options: Partial<Pick<CatalogProviderMappingValueExpression, "transforms" | "redaction">> = {},
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: true,
      nullPolicy: "diagnostic",
    },
    transforms: options.transforms,
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function optionalPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: false,
      nullPolicy: "allow-null",
    },
    owner,
    uses,
    redaction: "none",
  };
}

function constantExpression(
  value: JsonValue,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "constant",
      value,
    },
    owner,
    uses,
    redaction: "none",
  };
}

function objectExpression(
  fields: Readonly<Record<string, CatalogProviderMappingValueExpression>>,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "object",
      fields,
    },
    owner,
    uses,
    redaction: "none",
  };
}

function tcgplayerPokemonMergeIdentityExpression(): CatalogProviderMappingValueExpression {
  return objectExpression(
    {
      tcg: constantExpression("pokemon", "catalog-merge-evidence", ["merge-identity"]),
      productLineName: pathExpression("productLineName", "catalog-merge-evidence", ["merge-identity"]),
      setName: pathExpression("setName", "catalog-merge-evidence", ["merge-identity"]),
      printedProductName: pathExpression("productName", "catalog-merge-evidence", ["merge-identity"]),
      collectorNumber: optionalPathExpression("customAttributes.number", "catalog-merge-evidence", ["merge-identity"]),
      languageCode: constantExpression("en", "catalog-merge-evidence", ["merge-identity"]),
      productForm: pathExpression("productForm", "catalog-merge-evidence", ["merge-identity"]),
      barcode: optionalPathExpression("barcode", "catalog-merge-evidence", ["merge-identity"]),
    },
    "catalog-merge-evidence",
    ["normalized-observation", "merge-identity"],
  );
}

function tcgplayerOnePieceImageUrlsExpression(): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "coalesce",
      selectors: [
        {
          kind: "path",
          path: "imageUrls",
          required: false,
          nullPolicy: "omit",
        },
        {
          kind: "constant",
          value: [],
        },
      ],
      required: true,
    },
    owner: "catalog-truth",
    uses: ["normalized-observation"],
    redaction: "none",
  };
}
