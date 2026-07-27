import type { JsonValue } from "@chase-sets/primitives/json";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import {
  YGOPRODECK_PRODUCTION_PROFILE_VERSION,
  YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
  YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "./adapter";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingEvidenceOwner,
  CatalogProviderMappingEvidenceUse,
  CatalogProviderMappingValueExpression,
  CatalogProviderSourceObservationContract,
} from "../../provider-integration-mapping-contract";
import type { CatalogProviderIntegrationProfile } from "../profile-types";

export const ygoprodeckCentralTypeAdditions = {
  productDomain: "Add 'yugioh' to CatalogProviderIngestionUnitProductDomain.",
  normalizedObservation:
    "Add 'yugioh-card-print' and 'yugioh-set-reference' to CatalogProviderNormalizedObservationContract.outputKind and CatalogProviderIntegrationProfile.normalizedObservationMapping.kind.",
  optionQueryOperation:
    "Add 'ygoprodeck-list-sets' and 'ygoprodeck-list-cards' to CatalogProviderOptionQueryOperation and route them through ProviderAdapter.listOptions transports.",
  duplicatePrevention:
    "Add a Yu-Gi-Oh deterministic duplicate-prevention rule or reuse a generic collectible-card field-match rule before promotion activation.",
} as const;

type YgoprodeckIngestionUnitIdentity = Readonly<{
  unitKey: string;
  providerKey: "ygoprodeck";
  productDomain: "yugioh";
  productForm: "single-card" | "set";
  ingestionPurpose: "reference-data";
}>;

type YgoprodeckNormalizedObservation = Omit<
  CatalogProviderExecutableMappingContract["normalizedObservation"],
  "outputKind"
> &
  Readonly<{ outputKind: "yugioh-card-print" | "yugioh-set-reference" }>;

type YgoprodeckExecutableMappingContract = Omit<
  CatalogProviderExecutableMappingContract,
  "ingestionUnitIdentity" | "normalizedObservation"
> &
  Readonly<{
    ingestionUnitIdentity: YgoprodeckIngestionUnitIdentity;
    normalizedObservation: YgoprodeckNormalizedObservation;
  }>;

type YgoprodeckProviderOptionQuery = Omit<CatalogProviderIntegrationProfile["optionQueries"][number], "operation"> &
  Readonly<{ operation: "ygoprodeck-list-sets" | "ygoprodeck-list-cards" }>;

type YgoprodeckProviderProfile = Omit<
  CatalogProviderIntegrationProfile,
  "optionQueries" | "connector" | "normalizedObservationMapping" | "duplicatePreventionMapping"
> &
  Readonly<{
    optionQueries: readonly YgoprodeckProviderOptionQuery[];
    connector: Readonly<{
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
        | "ygoprodeck-passcode"
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
        | "image-evidence-url"
      )[];
      excludedEvidence: readonly ("price" | "seller" | "inventory" | "image-hotlink")[];
      assetPolicy: Readonly<{
        hotlinkingAllowed: false;
        requiresCatalogAssetStorage: true;
      }>;
    }>;
    normalizedObservationMapping: Omit<CatalogProviderIntegrationProfile["normalizedObservationMapping"], "kind"> &
      Readonly<{ kind: "yugioh-card-print" | "yugioh-set-reference" }>;
    duplicatePreventionMapping: Readonly<{
      ambiguousCandidatePolicy: "block-promotion" | "review-only";
      replayPolicy: "same-profile-version";
      rules: readonly Readonly<Record<string, JsonValue>>[];
    }>;
  }>;

const ygoprodeckSourceContract = {
  owner: "chase-sets/catalog",
  repository: "chase-sets/chase-sets",
  commit: null,
  documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
  fixtureSetVersion: "ygoprodeck-yugioh-reference-production-v1",
} as const;

const ygoprodeckConnectorContract = {
  kind: "ygoprodeck-json",
  transportOwns: ["domains", "endpoint-paths", "pagination", "throttling", "raw-provider-parse"],
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

const cardFixtures = {
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/ygoprodeck-yugioh-card-print",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

const setFixtures = {
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/ygoprodeck-yugioh-set-reference",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

const ygoprodeckOptionQueries = [
  {
    queryKind: "sets",
    queryKeySynonyms: ["set"],
    displayName: "Set",
    scope: "set-name",
    parentScope: null,
    operation: "ygoprodeck-list-sets",
    output: {
      valuePath: "setName",
      labelPath: "setName",
      description: { kind: "path", path: "releaseDate" },
      metadataPaths: {
        setName: "setName",
        setCode: "setCode",
        releaseDate: "releaseDate",
        cardCount: "cardCount",
      },
    },
  },
  {
    queryKind: "cards",
    queryKeySynonyms: ["card"],
    displayName: "Card",
    scope: "product/card",
    parentScope: "set-name",
    operation: "ygoprodeck-list-cards",
    parentValue: {
      required: true,
      valueKind: "set-code",
      diagnosticText: "YGOPRODeck card option queries require a selected set name or set code.",
    },
    output: {
      valuePath: "cardPrintId",
      labelPath: "name",
      parentValuePath: "setName",
      metadataPaths: {
        cardId: "cardId",
        setName: "setName",
        setCode: "setCode",
        rarity: "rarity",
        cardType: "cardType",
        frameType: "frameType",
        race: "race",
        attribute: "attribute",
        archetype: "archetype",
        imageEvidenceAvailable: "imageEvidenceAvailable",
      },
    },
  },
] as const satisfies readonly YgoprodeckProviderOptionQuery[];

export const ygoprodeckYugiohCardReferenceSourceObservationMappingContract = {
  providerKey: "ygoprodeck",
  profileKey: "yugioh-card-print-reference-data",
  displayName: "YGOPRODeck Yu-Gi-Oh Card Print Reference Data",
  profileVersion: YGOPRODECK_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: {
    unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    providerKey: "ygoprodeck",
    productDomain: "yugioh",
    productForm: "single-card",
    ingestionPurpose: "reference-data",
  },
  lifecycle: "active",
  sourceContract: ygoprodeckSourceContract,
  connector: ygoprodeckConnectorContract,
  fixtures: cardFixtures,
  sourceObservation: ygoprodeckSourceObservationContract("ygoprodeck_yugioh_card_{passcode}_{setCode}", "card"),
  normalizedObservation: ygoprodeckCardNormalizedObservation(),
  externalReferences: [],
  referenceHierarchy: ygoprodeckReferenceHierarchy("selectedPrint.set_name"),
  duplicatePrevention: ygoprodeckDuplicatePrevention("card"),
  promotionCommandPlan: ygoprodeckPromotionCommandPlan(),
  nonGoals: ygoprodeckNonGoals(),
} as const satisfies YgoprodeckExecutableMappingContract;

export const ygoprodeckYugiohSetReferenceSourceObservationMappingContract = {
  providerKey: "ygoprodeck",
  profileKey: "yugioh-set-reference-data",
  displayName: "YGOPRODeck Yu-Gi-Oh Set Reference Data",
  profileVersion: YGOPRODECK_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: {
    unitKey: YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
    providerKey: "ygoprodeck",
    productDomain: "yugioh",
    productForm: "set",
    ingestionPurpose: "reference-data",
  },
  lifecycle: "active",
  sourceContract: {
    ...ygoprodeckSourceContract,
    fixtureSetVersion: "ygoprodeck-yugioh-set-reference-production-v1",
  },
  connector: ygoprodeckConnectorContract,
  fixtures: setFixtures,
  sourceObservation: ygoprodeckSourceObservationContract("ygoprodeck_yugioh_set_{setCode}", "set"),
  normalizedObservation: ygoprodeckSetNormalizedObservation(),
  externalReferences: [],
  referenceHierarchy: ygoprodeckReferenceHierarchy("set.set_name"),
  duplicatePrevention: ygoprodeckDuplicatePrevention("set"),
  promotionCommandPlan: ygoprodeckPromotionCommandPlan(),
  nonGoals: ygoprodeckNonGoals(),
} as const satisfies YgoprodeckExecutableMappingContract;

export const ygoprodeckYugiohCardReferenceProviderProfile = {
  providerKey: "ygoprodeck",
  displayName: "YGOPRODeck",
  status: "active",
  capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
  supportedScopes: ["set-name", "product/card"],
  languageOptions: ["en"],
  optionQueries: ygoprodeckOptionQueries,
  connector: {
    kind: "ygoprodeck-json",
    baseUrl: "https://db.ygoprodeck.com/api/v7",
    sourceContractDocument: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
    authentication: {
      scheme: "public-api",
      credentialsRequired: false,
      userAgentRequired: true,
    },
    throttling: {
      providerLimit: "20-requests-per-second",
      cacheProviderDataLocally: true,
      cacheImagesLocally: true,
    },
    acceptedEvidence: [
      "ygoprodeck-passcode",
      "set-code",
      "set-name",
      "rarity",
      "card-type",
      "frame-type",
      "race",
      "attribute",
      "archetype",
      "release-date",
      "card-count",
      "image-evidence-url",
    ],
    excludedEvidence: ["price", "seller", "inventory", "image-hotlink"],
    assetPolicy: {
      hotlinkingAllowed: false,
      requiresCatalogAssetStorage: true,
    },
  },
  normalizedObservationMapping: {
    kind: "yugioh-card-print",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified YGOPRODeck Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: {
    blueprintKey: "yugioh-card-print",
    categoryKey: "yugioh-card-prints",
    fieldKeys: {
      cardNumber: "set-code",
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
    providerReferenceIdPrefix: "ref_ygoprodeck",
    providerAttributes: [
      { typeKey: "set", providerAttributeKey: "ygoprodeck-set-code" },
      { typeKey: "set", providerAttributeKey: "ygoprodeck-set-name" },
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
        descriptionText: "A Yu-Gi-Oh release group.",
        attributeKeys: ["ygoprodeck-set-code", "ygoprodeck-set-name"],
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
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["selectedPrint.set_name"] },
        key: { kind: "path", path: "selectedPrint.set_name" },
        name: { kind: "path", path: "selectedPrint.set_name" },
        description: {
          kind: "template",
          template: "{setName} Yu-Gi-Oh set.",
          values: { setName: { kind: "path", path: "selectedPrint.set_name" } },
        },
        requiredPaths: ["selectedPrint.set_name"],
        attributes: [
          { attributeKey: "ygoprodeck-set-code", value: { kind: "path", path: "selectedPrint.set_code" } },
          { attributeKey: "ygoprodeck-set-name", value: { kind: "path", path: "selectedPrint.set_name" } },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "yugioh-product-line" }],
      },
    ],
  },
  externalReferenceExtractionRules: { referenceTarget: "catalog-item-reference", rules: [] },
  duplicatePreventionMapping: {
    ambiguousCandidatePolicy: "block-promotion",
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
        bridgeReferenceProviderKeys: ["ygoprodeck", "ygojson", "tcgplayer"],
        candidatePolicy: "review-only",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies YgoprodeckProviderProfile;

export const ygoprodeckYugiohSetReferenceProviderProfile = {
  ...ygoprodeckYugiohCardReferenceProviderProfile,
  displayName: "YGOPRODeck Set Reference",
  capabilities: ["source-observation-import", "reference-data-promotion"],
  supportedScopes: ["set-name"],
  optionQueries: [],
  normalizedObservationMapping: {
    ...ygoprodeckYugiohCardReferenceProviderProfile.normalizedObservationMapping,
    kind: "yugioh-set-reference",
    unknownVariantLabelPrefix: "Unclassified YGOPRODeck Set Variant",
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
} as const satisfies YgoprodeckProviderProfile;

function ygoprodeckSourceObservationContract(
  observationTemplate: string,
  externalKeyPrefix: "card" | "set",
): CatalogProviderSourceObservationContract {
  if (externalKeyPrefix === "set") {
    return {
      observationId: ygoprodeckTemplateExpression(observationTemplate, {
        setCode: ygoprodeckPathExpression("set.set_code", "external-reference", ["external-reference"]),
      }),
      externalKey: ygoprodeckTemplateExpression("set:{setCode}", {
        setCode: ygoprodeckPathExpression("set.set_code", "external-reference", ["external-reference"]),
      }),
      sourceUrl: ygoprodeckPathExpression("sourceUrl", "operations", ["source-payload"]),
      sourceUpdatedAt: ygoprodeckOptionalPathExpression("set.tcg_date", "catalog-truth", ["normalized-observation"]),
      sourcePayload: ygoprodeckPathExpression(".", "catalog-merge-evidence", ["source-payload"]),
    };
  }

  return {
    observationId: ygoprodeckTemplateExpression(observationTemplate, {
      passcode: ygoprodeckPathExpression("card.id", "external-reference", ["external-reference"]),
      setCode: ygoprodeckPathExpression("selectedPrint.set_code", "external-reference", ["external-reference"]),
    }),
    externalKey: ygoprodeckTemplateExpression("card:{passcode}:{setCode}", {
      passcode: ygoprodeckPathExpression("card.id", "external-reference", ["external-reference"]),
      setCode: ygoprodeckPathExpression("selectedPrint.set_code", "external-reference", ["external-reference"]),
    }),
    sourceUrl: ygoprodeckPathExpression("sourceUrl", "operations", ["source-payload"]),
    sourceUpdatedAt: ygoprodeckConstantExpression(null, "catalog-truth", ["normalized-observation"]),
    sourcePayload: ygoprodeckPathExpression(".", "catalog-merge-evidence", ["source-payload"]),
  };
}

function ygoprodeckCardNormalizedObservation(): YgoprodeckNormalizedObservation {
  return {
    outputKind: "yugioh-card-print",
    languageCode: ygoprodeckConstantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
      tcg: ygoprodeckConstantExpression("yugioh", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: ygoprodeckConstantExpression("Yu-Gi-Oh!", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      name: ygoprodeckPathExpression("card.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      passcode: ygoprodeckPathExpression("card.id", "external-reference", ["normalized-observation", "hash-material"]),
      setName: ygoprodeckPathExpression("selectedPrint.set_name", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      setCode: ygoprodeckPathExpression("selectedPrint.set_code", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      rarity: ygoprodeckOptionalPathExpression("selectedPrint.set_rarity", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      cardType: ygoprodeckOptionalPathExpression("card.type", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      frameType: ygoprodeckOptionalPathExpression("card.frameType", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      race: ygoprodeckOptionalPathExpression("card.race", "catalog-truth", ["normalized-observation"]),
      attribute: ygoprodeckOptionalPathExpression("card.attribute", "catalog-truth", ["normalized-observation"]),
      archetype: ygoprodeckOptionalPathExpression("card.archetype", "catalog-truth", ["normalized-observation"]),
      imageEvidenceCount: ygoprodeckConstantExpression(null, "operations", ["source-payload"]),
      imageUrls: ygoprodeckConstantExpression([], "catalog-truth", ["normalized-observation", "hash-material"]),
      mergeIdentity: ygoprodeckObjectExpression(
        {
          tcg: ygoprodeckConstantExpression("yugioh", "catalog-merge-evidence", ["merge-identity"]),
          productLineName: ygoprodeckConstantExpression("Yu-Gi-Oh!", "catalog-merge-evidence", ["merge-identity"]),
          printedProductName: ygoprodeckPathExpression("card.name", "catalog-merge-evidence", ["merge-identity"]),
          setName: ygoprodeckPathExpression("selectedPrint.set_name", "catalog-merge-evidence", ["merge-identity"]),
          setCode: ygoprodeckPathExpression("selectedPrint.set_code", "catalog-merge-evidence", ["merge-identity"]),
          languageCode: ygoprodeckConstantExpression("en", "catalog-merge-evidence", ["merge-identity"]),
          productForm: ygoprodeckConstantExpression("yugioh-card-print", "catalog-merge-evidence", ["merge-identity"]),
        },
        "catalog-merge-evidence",
        ["normalized-observation", "merge-identity"],
      ),
      externalCatalogItemReferences: ygoprodeckConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
      externalProductReferences: ygoprodeckConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      ygoprodeckObjectExpression(
        {
          passcode: ygoprodeckPathExpression("card.id", "external-reference", ["hash-material"]),
          name: ygoprodeckPathExpression("card.name", "catalog-truth", ["hash-material"]),
          setName: ygoprodeckPathExpression("selectedPrint.set_name", "catalog-truth", ["hash-material"]),
          setCode: ygoprodeckPathExpression("selectedPrint.set_code", "catalog-truth", ["hash-material"]),
          rarity: ygoprodeckOptionalPathExpression("selectedPrint.set_rarity", "catalog-truth", ["hash-material"]),
          cardType: ygoprodeckOptionalPathExpression("card.type", "catalog-truth", ["hash-material"]),
          frameType: ygoprodeckOptionalPathExpression("card.frameType", "catalog-truth", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      ygoprodeckPathExpression("card.name", "catalog-merge-evidence", ["merge-identity"]),
      ygoprodeckPathExpression("selectedPrint.set_name", "catalog-merge-evidence", ["merge-identity"]),
      ygoprodeckPathExpression("selectedPrint.set_code", "catalog-merge-evidence", ["merge-identity"]),
    ],
  };
}

function ygoprodeckSetNormalizedObservation(): YgoprodeckNormalizedObservation {
  return {
    outputKind: "yugioh-set-reference",
    languageCode: ygoprodeckConstantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
      tcg: ygoprodeckConstantExpression("yugioh", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: ygoprodeckConstantExpression("Yu-Gi-Oh!", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      name: ygoprodeckPathExpression("set.set_name", "catalog-truth", ["normalized-observation", "hash-material"]),
      setName: ygoprodeckPathExpression("set.set_name", "catalog-truth", ["normalized-observation", "hash-material"]),
      setCode: ygoprodeckPathExpression("set.set_code", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      releaseDate: ygoprodeckOptionalPathExpression("set.tcg_date", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      cardCount: ygoprodeckOptionalPathExpression("set.num_of_cards", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      externalCatalogItemReferences: ygoprodeckConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      ygoprodeckObjectExpression(
        {
          setName: ygoprodeckPathExpression("set.set_name", "catalog-truth", ["hash-material"]),
          setCode: ygoprodeckPathExpression("set.set_code", "catalog-truth", ["hash-material"]),
          releaseDate: ygoprodeckOptionalPathExpression("set.tcg_date", "catalog-truth", ["hash-material"]),
          cardCount: ygoprodeckOptionalPathExpression("set.num_of_cards", "catalog-truth", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      ygoprodeckPathExpression("set.set_name", "catalog-merge-evidence", ["merge-identity"]),
      ygoprodeckPathExpression("set.set_code", "catalog-merge-evidence", ["merge-identity"]),
    ],
  };
}

function ygoprodeckReferenceHierarchy(path: string): YgoprodeckExecutableMappingContract["referenceHierarchy"] {
  return [
    {
      targetTypeKey: "set",
      providerAttributeKey: "ygoprodeck-set-name",
      referenceRecordKey: ygoprodeckPathExpression(path, "external-reference", ["reference-hierarchy"]),
    },
  ];
}

function ygoprodeckDuplicatePrevention(
  kind: "card" | "set",
): YgoprodeckExecutableMappingContract["duplicatePrevention"] {
  if (kind === "set") {
    return {
      exactExternalCatalogItemReferencesFirst: false,
      mergeCandidateEvidence: [
        ygoprodeckPathExpression("set.set_name", "catalog-merge-evidence", ["merge-identity"]),
        ygoprodeckPathExpression("set.set_code", "catalog-merge-evidence", ["merge-identity"]),
      ],
      identityRules: [
        {
          ruleKey: "source-observation-link",
          ruleKind: "source-observation-link",
          evidence: [ygoprodeckPathExpression("set.set_code", "external-reference", ["external-reference"])],
          candidatePolicy: "review-only",
        },
      ],
      ambiguousCandidatePolicy: "review-only",
      replayPolicy: "same-profile-version",
    };
  }

  return {
    exactExternalCatalogItemReferencesFirst: false,
    mergeCandidateEvidence: [
      ygoprodeckPathExpression("card.id", "external-reference", ["merge-identity"]),
      ygoprodeckPathExpression("selectedPrint.set_code", "catalog-merge-evidence", ["merge-identity"]),
      ygoprodeckPathExpression("card.name", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [ygoprodeckPathExpression("card.id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
      {
        ruleKey: "future-provider-bridge-review",
        ruleKind: "future-provider-bridge-match",
        evidence: [ygoprodeckPathExpression("card.id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function ygoprodeckPromotionCommandPlan(): YgoprodeckExecutableMappingContract["promotionCommandPlan"] {
  return {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: [],
  };
}

function ygoprodeckNonGoals(): YgoprodeckExecutableMappingContract["nonGoals"] {
  return [
    "no-live-provider-calls-in-mapping-tests",
    "no-pricing-facts-as-catalog-truth",
    "no-inventory-facts-as-global-catalog-truth",
    "no-provider-secrets-in-events-logs-or-fixtures",
    "no-provider-transport-branches-in-mapping-interpreter",
  ];
}

function ygoprodeckPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: true,
      nullPolicy: "diagnostic",
    },
    owner,
    uses,
    redaction: "none",
  };
}

function ygoprodeckOptionalPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: false,
      nullPolicy: "omit",
    },
    owner,
    uses,
    redaction: "none",
  };
}

function ygoprodeckTemplateExpression(
  template: string,
  values: Readonly<Record<string, CatalogProviderMappingValueExpression>>,
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "template",
      template,
      values,
      required: true,
    },
    owner: "external-reference",
    uses: ["external-reference"],
    redaction: "none",
  };
}

function ygoprodeckObjectExpression(
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

function ygoprodeckConstantExpression(
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
