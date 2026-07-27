import type { JsonValue } from "@chase-sets/primitives/json";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import {
  YGOJSON_PRODUCTION_PROFILE_VERSION,
  YGOJSON_YUGIOH_SEALED_PRODUCT_PROFILE_VERSION,
  YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
  YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
} from "./adapter";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderIngestionPurpose,
  CatalogProviderMappingEvidenceOwner,
  CatalogProviderMappingEvidenceUse,
  CatalogProviderMappingValueExpression,
  CatalogProviderSourceObservationContract,
} from "../../provider-integration-mapping-contract";
import type { CatalogProviderIntegrationProfile } from "../profile-types";

export const ygojsonYugiohMappingContractCentralTypeAdditions = {
  productDomain: "yugioh",
  normalizedOutputKinds: ["yugioh-set-reference", "yugioh-sealed-product"],
} as const;

export const ygojsonYugiohProviderGovernance = {
  provider: "YGOJSON",
  sourceRepository: "iconmaster5326/YGOJSON",
  sourceLicense: "MIT",
  upstreamSources: ["YGOPRODeck", "YAML Yugi", "Yugipedia", "YGO Prog pack-odds research"],
  yamlYugiBoundary:
    "YAML Yugi data is an upstream source of YGOJSON. Chase Sets must not copy YAML Yugi AGPL pipeline code into this connector.",
  copyrightBoundary:
    "Yu-Gi-Oh card text, images, symbols, and official product data remain third-party copyright evidence until reviewed.",
  priceVendorBoundary:
    "Price, vendor, and marketplace availability fields are evidence only and are not Catalog truth.",
} as const;

type YgojsonOutputKind = "yugioh-set-reference" | "yugioh-sealed-product";

type YgojsonExecutableMappingContract = Omit<
  CatalogProviderExecutableMappingContract,
  "ingestionUnitIdentity" | "normalizedObservation"
> &
  Readonly<{
    ingestionUnitIdentity: Readonly<{
      unitKey: string;
      providerKey: "ygojson";
      productDomain: "yugioh";
      productForm: "set" | "sealed-product";
      ingestionPurpose: CatalogProviderIngestionPurpose;
    }>;
    normalizedObservation: Omit<CatalogProviderExecutableMappingContract["normalizedObservation"], "outputKind"> &
      Readonly<{
        outputKind: YgojsonOutputKind;
      }>;
  }>;

const ygojsonSourceContract = {
  owner: "chase-sets/catalog",
  repository: "iconmaster5326/YGOJSON",
  commit: null,
  documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
  fixtureSetVersion: "ygojson-yugioh-reference-data-production-v1",
} as const;

const ygojsonConnectorContract = {
  kind: "ygojson-json",
  transportOwns: ["domains", "endpoint-paths", "raw-provider-parse"],
  mappingOwns: [
    "source-payload",
    "normalized-observation",
    "hash-material",
    "merge-identity",
    "external-reference",
    "reference-hierarchy",
    "promotion-command",
  ],
} as const;

const setFixtures = {
  fixtureRoot:
    "bounded-contexts/catalog/features/source-observations/api/__fixtures__/ygojson-yugioh-set-reference-data",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

const sealedProductFixtures = {
  fixtureRoot:
    "bounded-contexts/catalog/features/source-observations/api/__fixtures__/ygojson-yugioh-sealed-product-reference-data",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

export const ygojsonYugiohSetReferenceSourceObservationMappingContract = {
  providerKey: "ygojson",
  profileKey: "yugioh-set-reference-data",
  displayName: "YGOJSON Yu-Gi-Oh Set Reference Data",
  profileVersion: YGOJSON_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: {
    unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
    providerKey: "ygojson",
    productDomain: "yugioh",
    productForm: "set",
    ingestionPurpose: "reference-data",
  },
  lifecycle: "active",
  sourceContract: {
    ...ygojsonSourceContract,
    fixtureSetVersion: "ygojson-yugioh-set-reference-production-v1",
  },
  connector: ygojsonConnectorContract,
  fixtures: setFixtures,
  sourceObservation: ygojsonSourceObservationContract("ygojson_set_{languageCode}_{setId}", "set", "set.id"),
  normalizedObservation: ygojsonSetNormalizedObservation(),
  externalReferences: [],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "ygojson-set-id",
      referenceRecordKey: ygojsonPathExpression("set.id", "external-reference", ["reference-hierarchy"]),
    },
  ],
  duplicatePrevention: ygojsonSetDuplicatePrevention(),
  promotionCommandPlan: ygojsonReviewOnlyPromotionPlan(),
  nonGoals: ygojsonNonGoals(),
} as const satisfies YgojsonExecutableMappingContract;

export const ygojsonYugiohSealedProductReferenceSourceObservationMappingContract = {
  providerKey: "ygojson",
  profileKey: "yugioh-sealed-product-reference-data",
  displayName: "YGOJSON Yu-Gi-Oh Sealed Product Reference Data",
  profileVersion: YGOJSON_YUGIOH_SEALED_PRODUCT_PROFILE_VERSION,
  ingestionUnitIdentity: {
    unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
    providerKey: "ygojson",
    productDomain: "yugioh",
    productForm: "sealed-product",
    ingestionPurpose: "reference-data",
  },
  lifecycle: "active",
  sourceContract: {
    ...ygojsonSourceContract,
    fixtureSetVersion: "ygojson-yugioh-sealed-product-reference-production-v1",
  },
  connector: ygojsonConnectorContract,
  fixtures: sealedProductFixtures,
  sourceObservation: ygojsonSourceObservationContract(
    "ygojson_sealed_product_{languageCode}_{sealedProductId}",
    "sealed-product",
    "sealedProduct.id",
  ),
  normalizedObservation: ygojsonSealedProductNormalizedObservation(),
  externalReferences: [
    {
      target: "catalog-item-reference",
      providerKey: "ygojson",
      externalKeyPrefix: "sealed-product:",
      source: ygojsonPathExpression("sealedProduct.id", "external-reference", ["external-reference"]),
      ambiguityPolicy: "review-evidence",
    },
    {
      target: "product-reference",
      providerKey: "ygojson",
      externalKeyPrefix: "sealed-product:",
      source: ygojsonPathExpression("sealedProduct.id", "external-reference", ["external-reference"]),
      selectedOptions: {
        dimensions: [],
        missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
      },
      ambiguityPolicy: "review-evidence",
    },
  ],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "ygojson-box-of-set-id",
      referenceRecordKey: ygojsonOptionalPathExpression("sealedProduct.boxOf", "catalog-merge-evidence", [
        "reference-hierarchy",
      ]),
    },
  ],
  duplicatePrevention: ygojsonSealedProductDuplicatePrevention(),
  promotionCommandPlan: ygojsonSealedProductPromotionPlan(),
  nonGoals: ygojsonNonGoals(),
} as const satisfies YgojsonExecutableMappingContract;

export const ygojsonYugiohReferenceDataMappingContracts = [
  ygojsonYugiohSetReferenceSourceObservationMappingContract,
  ygojsonYugiohSealedProductReferenceSourceObservationMappingContract,
] as const;

const ygojsonOptionQueries = [
  {
    queryKind: "sets",
    queryKeySynonyms: ["set"],
    displayName: "Set",
    scope: "set-name",
    parentScope: null,
    operation: "ygojson-list-sets",
    output: {
      valuePath: "setId",
      labelPath: "name",
      description: { kind: "path", path: "releaseDate" },
      metadataPaths: {
        setId: "setId",
        releaseDate: "releaseDate",
        localeCount: "localeCount",
        printCount: "printCount",
        packContentEvidenceCount: "packContentEvidenceCount",
        yugipediaId: "yugipediaId",
      },
    },
  },
  {
    queryKind: "sealed-products",
    queryKeySynonyms: ["sealed-product", "products", "product"],
    displayName: "Sealed Product",
    scope: "product",
    parentScope: null,
    operation: "ygojson-list-sealed-products",
    output: {
      valuePath: "sealedProductId",
      labelPath: "name",
      description: { kind: "path", path: "releaseDate" },
      metadataPaths: {
        sealedProductId: "sealedProductId",
        releaseDate: "releaseDate",
        localeCount: "localeCount",
        boxOfSetCount: "boxOfSetCount",
        packContentEvidenceCount: "packContentEvidenceCount",
        yugipediaId: "yugipediaId",
      },
    },
  },
] as const satisfies readonly CatalogProviderIntegrationProfile["optionQueries"][number][];

const ygojsonConnectorProfile = {
  kind: "ygojson-json",
  baseUrl: "https://raw.githubusercontent.com/iconmaster5326/YGOJSON/v1",
  sourceContractDocument: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
  authentication: {
    scheme: "public-json",
    credentialsRequired: false,
  },
  acceptedEvidence: [
    "card-id",
    "passcode",
    "set-code",
    "set-name",
    "sealed-product",
    "pack-content",
    "pack-odds",
    "format",
  ],
  excludedEvidence: ["price", "seller", "inventory", "order", "message"],
} as const;

const ygojsonBaseProviderProfile = {
  providerKey: "ygojson",
  displayName: "YGOJSON",
  status: "active",
  capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
  supportedScopes: ["set-name", "product"],
  languageOptions: ["en"],
  optionQueries: ygojsonOptionQueries,
  connector: ygojsonConnectorProfile,
  normalizedObservationMapping: {
    kind: "yugioh-set-reference",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified YGOJSON Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: {
    blueprintKey: "yugioh-set-reference",
    categoryKey: "yugioh-sets",
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
  referenceHierarchyMapping: {
    providerReferenceIdPrefix: "ref_ygojson",
    providerAttributes: [
      { typeKey: "product-line", providerAttributeKey: "ygojson-product-line" },
      { typeKey: "set", providerAttributeKey: "ygojson-set-id" },
      { typeKey: "set", providerAttributeKey: "ygojson-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "ygojson-product-line"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A Yu-Gi-Oh release group.",
        attributeKeys: ["ygojson-set-id", "ygojson-set-name"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "yugioh-product-line",
        typeKey: "product-line",
        recordId: { kind: "provider", typeKey: "product-line", providerValuePaths: ["productLineName"] },
        key: { kind: "static", value: "yu-gi-oh" },
        name: { kind: "static", value: "Yu-Gi-Oh!" },
        description: { kind: "static", value: "Yu-Gi-Oh trading card game." },
        attributes: [
          { attributeKey: "official-name", value: { kind: "static", value: "Yu-Gi-Oh!" } },
          { attributeKey: "short-name", value: { kind: "static", value: "YGO" } },
          { attributeKey: "ygojson-product-line", value: { kind: "static", value: "yugioh" } },
        ],
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["set.id", "set.name.en"] },
        key: { kind: "path", path: "set.id" },
        name: { kind: "path", path: "set.name.en" },
        description: {
          kind: "template",
          template: "{setName} Yu-Gi-Oh set.",
          values: { setName: { kind: "path", path: "set.name.en" } },
        },
        requiredPaths: ["set.id", "set.name.en"],
        attributes: [
          { attributeKey: "ygojson-set-id", value: { kind: "path", path: "set.id" } },
          { attributeKey: "ygojson-set-name", value: { kind: "path", path: "set.name.en" } },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "yugioh-product-line" }],
      },
    ],
  },
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
      {
        ruleKey: "future-provider-bridge-review",
        matchKind: "future-provider-bridge-match",
        bridgeReferenceProviderKeys: ["ygoprodeck", "tcgplayer"],
        candidatePolicy: "review-only",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const ygojsonYugiohSetReferenceProviderProfile = ygojsonBaseProviderProfile;

export const ygojsonYugiohSealedProductReferenceProviderProfile = {
  ...ygojsonBaseProviderProfile,
  displayName: "YGOJSON Sealed Products",
  capabilities: [...ygojsonBaseProviderProfile.capabilities, "catalog-item-promotion"],
  supportedScopes: ["product"],
  optionQueries: [
    {
      queryKind: "sealed-products",
      queryKeySynonyms: ["sealed-product", "products", "product"],
      displayName: "Sealed Product",
      scope: "product",
      parentScope: null,
      operation: "ygojson-list-sealed-products",
      output: {
        valuePath: "sealedProductId",
        labelPath: "name",
        description: { kind: "path", path: "releaseDate" },
        metadataPaths: {
          sealedProductId: "sealedProductId",
          releaseDate: "releaseDate",
          localeCount: "localeCount",
          boxOfSetCount: "boxOfSetCount",
          packContentEvidenceCount: "packContentEvidenceCount",
          yugipediaId: "yugipediaId",
        },
      },
    },
  ],
  normalizedObservationMapping: {
    ...ygojsonBaseProviderProfile.normalizedObservationMapping,
    kind: "yugioh-sealed-product",
    unknownVariantLabelPrefix: "Unclassified YGOJSON Sealed Product Variant",
  },
  catalogFieldMapping: {
    blueprintKey: "yugioh-sealed-product",
    categoryKey: "yugioh-sealed-products",
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
  referenceHierarchyMapping: {
    ...ygojsonBaseProviderProfile.referenceHierarchyMapping,
    targetRecordRuleKey: "boxed-set",
    referenceRecords: [
      ygojsonBaseProviderProfile.referenceHierarchyMapping.referenceRecords[0],
      {
        ruleKey: "boxed-set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["sealedProduct.boxOf"] },
        key: { kind: "path", path: "sealedProduct.boxOf" },
        name: { kind: "path", path: "sealedProduct.boxOf" },
        description: {
          kind: "template",
          template: "YGOJSON sealed product boxed set evidence for {setIds}.",
          values: { setIds: { kind: "path", path: "sealedProduct.boxOf" } },
        },
        requiredPaths: ["sealedProduct.boxOf"],
        attributes: [{ attributeKey: "ygojson-set-id", value: { kind: "path", path: "sealedProduct.boxOf" } }],
        relationships: [{ relationshipType: "part-of", ruleKey: "yugioh-product-line" }],
      },
    ],
  },
} as const satisfies CatalogProviderIntegrationProfile;

function ygojsonSourceObservationContract(
  observationTemplate: string,
  externalKeyPrefix: "set" | "sealed-product",
  idPath: string,
): CatalogProviderSourceObservationContract {
  const externalValue = ygojsonPathExpression(idPath, "external-reference", ["external-reference"]);

  return {
    observationId: ygojsonTemplateExpression(observationTemplate, {
      languageCode: ygojsonConstantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
      setId: externalValue,
      sealedProductId: externalValue,
    }),
    externalKey: ygojsonTemplateExpression(`${externalKeyPrefix}:{externalValue}`, {
      externalValue,
    }),
    sourceUrl: ygojsonPathExpression("sourceUrl", "operations", ["source-payload"]),
    sourceUpdatedAt: ygojsonOptionalPathExpression("sourceUpdatedAt", "catalog-truth", ["normalized-observation"]),
    sourcePayload: ygojsonPathExpression(".", "catalog-merge-evidence", ["source-payload"]),
  };
}

function ygojsonSetNormalizedObservation(): YgojsonExecutableMappingContract["normalizedObservation"] {
  return {
    outputKind: "yugioh-set-reference",
    languageCode: ygojsonConstantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
      tcg: ygojsonConstantExpression("yugioh", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: ygojsonConstantExpression("Yu-Gi-Oh!", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      name: ygojsonPathExpression("set.name.en", "catalog-truth", ["normalized-observation", "hash-material"]),
      setName: ygojsonPathExpression("set.name.en", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      ygojsonId: ygojsonPathExpression("set.id", "external-reference", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      releaseDate: ygojsonOptionalPathExpression("set.locales.en.date", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      localeEvidence: ygojsonOptionalPathExpression("set.locales", "catalog-merge-evidence", [
        "normalized-observation",
      ]),
      cardPrintEvidence: ygojsonOptionalPathExpression("set.contents", "catalog-merge-evidence", [
        "normalized-observation",
        "hash-material",
      ]),
      packOddsEvidence: ygojsonOptionalPathExpression("distribution", "catalog-merge-evidence", [
        "normalized-observation",
        "hash-material",
      ]),
      externalCatalogItemReferences: ygojsonConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      ygojsonObjectExpression(
        {
          id: ygojsonPathExpression("set.id", "external-reference", ["hash-material"]),
          name: ygojsonPathExpression("set.name.en", "catalog-truth", ["hash-material"]),
          releaseDate: ygojsonOptionalPathExpression("set.locales.en.date", "catalog-truth", ["hash-material"]),
          contents: ygojsonOptionalPathExpression("set.contents", "catalog-merge-evidence", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      ygojsonPathExpression("set.id", "external-reference", ["merge-identity"]),
      ygojsonPathExpression("set.name.en", "catalog-merge-evidence", ["merge-identity"]),
    ],
  };
}

function ygojsonSealedProductNormalizedObservation(): YgojsonExecutableMappingContract["normalizedObservation"] {
  return {
    outputKind: "yugioh-sealed-product",
    languageCode: ygojsonConstantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
      tcg: ygojsonConstantExpression("yugioh", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: ygojsonConstantExpression("Yu-Gi-Oh!", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      name: ygojsonPathExpression("sealedProduct.name.en", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      setName: ygojsonConstantExpression(null, "catalog-truth", ["normalized-observation"]),
      sealedProductForm: ygojsonConstantExpression("sealed-product", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      ygojsonId: ygojsonPathExpression("sealedProduct.id", "external-reference", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      releaseDate: ygojsonOptionalPathExpression("sealedProduct.locales.en.date", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      boxOfSetEvidence: ygojsonOptionalPathExpression("sealedProduct.boxOf", "catalog-merge-evidence", [
        "normalized-observation",
        "reference-hierarchy",
      ]),
      imageUrls: ygojsonArrayExpression(
        [
          ygojsonOptionalPathExpression("sealedProduct.locales.en.image", "catalog-truth", [
            "normalized-observation",
            "hash-material",
          ]),
        ],
        "catalog-truth",
        ["normalized-observation", "hash-material"],
      ),
      productContentsEvidence: ygojsonOptionalPathExpression("sealedProduct.contents", "catalog-merge-evidence", [
        "normalized-observation",
        "hash-material",
      ]),
      externalCatalogItemReferences: ygojsonArrayExpression(
        [
          ygojsonObjectExpression(
            {
              providerKey: ygojsonConstantExpression("ygojson", "external-reference", ["external-reference"]),
              externalKey: ygojsonTemplateExpression("sealed-product:{sealedProductId}", {
                sealedProductId: ygojsonPathExpression("sealedProduct.id", "external-reference", [
                  "external-reference",
                ]),
              }),
            },
            "external-reference",
            ["external-reference"],
          ),
        ],
        "external-reference",
        ["normalized-observation", "external-reference"],
      ),
      externalProductReferences: ygojsonArrayExpression(
        [
          ygojsonObjectExpression(
            {
              providerKey: ygojsonConstantExpression("ygojson", "external-reference", ["external-reference"]),
              externalKey: ygojsonTemplateExpression("sealed-product:{sealedProductId}", {
                sealedProductId: ygojsonPathExpression("sealedProduct.id", "external-reference", [
                  "external-reference",
                ]),
              }),
              selectedOptions: ygojsonConstantExpression([], "external-reference", ["external-reference"]),
            },
            "external-reference",
            ["external-reference"],
          ),
        ],
        "external-reference",
        ["normalized-observation", "external-reference"],
      ),
    },
    hashMaterial: [
      ygojsonObjectExpression(
        {
          id: ygojsonPathExpression("sealedProduct.id", "external-reference", ["hash-material"]),
          name: ygojsonPathExpression("sealedProduct.name.en", "catalog-truth", ["hash-material"]),
          releaseDate: ygojsonOptionalPathExpression("sealedProduct.locales.en.date", "catalog-truth", [
            "hash-material",
          ]),
          image: ygojsonOptionalPathExpression("sealedProduct.locales.en.image", "catalog-truth", ["hash-material"]),
          boxOf: ygojsonOptionalPathExpression("sealedProduct.boxOf", "catalog-merge-evidence", ["hash-material"]),
          contents: ygojsonOptionalPathExpression("sealedProduct.contents", "catalog-merge-evidence", [
            "hash-material",
          ]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      ygojsonPathExpression("sealedProduct.id", "external-reference", ["merge-identity"]),
      ygojsonPathExpression("sealedProduct.name.en", "catalog-merge-evidence", ["merge-identity"]),
      ygojsonOptionalPathExpression("sealedProduct.boxOf", "catalog-merge-evidence", ["merge-identity"]),
    ],
  };
}

function ygojsonSetDuplicatePrevention(): YgojsonExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: false,
    mergeCandidateEvidence: [
      ygojsonPathExpression("set.id", "external-reference", ["merge-identity"]),
      ygojsonPathExpression("set.name.en", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [ygojsonPathExpression("set.id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function ygojsonSealedProductDuplicatePrevention(): YgojsonExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: false,
    mergeCandidateEvidence: [
      ygojsonPathExpression("sealedProduct.id", "external-reference", ["merge-identity"]),
      ygojsonPathExpression("sealedProduct.name.en", "catalog-merge-evidence", ["merge-identity"]),
      ygojsonOptionalPathExpression("sealedProduct.boxOf", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [ygojsonPathExpression("sealedProduct.id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
      {
        ruleKey: "sealed-product-name-and-box-content-review",
        ruleKind: "sealed-product-match",
        evidence: [
          ygojsonPathExpression("sealedProduct.name.en", "catalog-merge-evidence", ["merge-identity"]),
          ygojsonOptionalPathExpression("sealedProduct.boxOf", "catalog-merge-evidence", ["merge-identity"]),
        ],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function ygojsonReviewOnlyPromotionPlan(): YgojsonExecutableMappingContract["promotionCommandPlan"] {
  return {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: [],
  };
}

function ygojsonSealedProductPromotionPlan(): YgojsonExecutableMappingContract["promotionCommandPlan"] {
  return {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: [
      {
        commandName: "CreateCatalogItem",
        inputs: {
          title: ygojsonPathExpression("sealedProduct.name.en", "catalog-truth", ["promotion-command"]),
        },
      },
      {
        commandName: "AssignBlueprintToCatalogItem",
        inputs: {
          blueprintKey: ygojsonConstantExpression("yugioh-sealed-product", "catalog-truth", ["promotion-command"]),
        },
      },
      {
        commandName: "SetCatalogItemFieldValue",
        inputs: {
          fieldKey: ygojsonConstantExpression("set", "catalog-truth", ["promotion-command"]),
          value: ygojsonPathExpression("sealedProduct.boxOf", "catalog-merge-evidence", ["promotion-command"]),
        },
      },
      {
        commandName: "AssignCatalogItemToCategory",
        inputs: {
          categoryKey: ygojsonConstantExpression("yugioh-sealed-products", "catalog-truth", ["promotion-command"]),
        },
      },
      {
        commandName: "SetCatalogItemImageUrls",
        inputs: {
          imageUrls: ygojsonOptionalPathExpression("sealedProduct.locales.en.image", "catalog-truth", [
            "promotion-command",
          ]),
        },
      },
      {
        commandName: "LinkExternalCatalogItemReference",
        inputs: {
          references: ygojsonPathExpression("sealedProduct.id", "external-reference", ["promotion-command"]),
        },
      },
      {
        commandName: "LinkExternalProductReference",
        inputs: {
          references: ygojsonPathExpression("sealedProduct.id", "external-reference", ["promotion-command"]),
        },
      },
    ],
  };
}

function ygojsonNonGoals(): YgojsonExecutableMappingContract["nonGoals"] {
  return [
    "no-live-provider-calls-in-mapping-tests",
    "no-pricing-facts-as-catalog-truth",
    "no-inventory-facts-as-global-catalog-truth",
    "no-provider-secrets-in-events-logs-or-fixtures",
    "no-provider-transport-branches-in-mapping-interpreter",
  ];
}

function ygojsonPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: ygojsonPathSelector(path, true),
    owner,
    uses,
    redaction: "none",
  };
}

function ygojsonOptionalPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: ygojsonPathSelector(path, false),
    owner,
    uses,
    redaction: "none",
  };
}

function ygojsonPathSelector(path: string, required: boolean): CatalogProviderMappingValueExpression["selector"] {
  return {
    kind: "path",
    path,
    required,
    nullPolicy: required ? "diagnostic" : "omit",
  };
}

function ygojsonTemplateExpression(
  template: string,
  values: Readonly<Record<string, CatalogProviderMappingValueExpression>>,
  required = true,
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "template",
      template,
      values,
      required,
    },
    owner: "external-reference",
    uses: ["external-reference"],
    redaction: "none",
  };
}

function ygojsonObjectExpression(
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

function ygojsonArrayExpression(
  items: readonly CatalogProviderMappingValueExpression[],
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: { kind: "array", items },
    owner,
    uses,
    redaction: "none",
  };
}

function ygojsonConstantExpression(
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
