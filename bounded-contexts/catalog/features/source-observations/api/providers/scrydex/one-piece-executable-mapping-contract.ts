import type { JsonValue } from "@chase-sets/primitives/json";
import {
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./adapter";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderIngestionPurpose,
  CatalogProviderMappingEvidenceOwner,
  CatalogProviderMappingEvidenceUse,
  CatalogProviderMappingValueExpression,
  CatalogProviderSourceObservationContract,
} from "../provider-integration-mapping-contract";

export const SCRYDEX_ONE_PIECE_PROFILE_VERSION = "2026.06.22";

type ScrydexOnePieceOutputKind = "one-piece-card-print" | "one-piece-set-reference" | "one-piece-sealed-product";

type ScrydexOnePieceProductForm = "single-card" | "set" | "sealed-product";

type ScrydexOnePieceExecutableMappingContract = Omit<
  CatalogProviderExecutableMappingContract,
  "ingestionUnitIdentity" | "normalizedObservation"
> &
  Readonly<{
    ingestionUnitIdentity: Readonly<{
      unitKey: string;
      providerKey: "scrydex";
      productDomain: "one-piece";
      productForm: ScrydexOnePieceProductForm;
      ingestionPurpose: CatalogProviderIngestionPurpose;
    }>;
    normalizedObservation: Omit<CatalogProviderExecutableMappingContract["normalizedObservation"], "outputKind"> &
      Readonly<{ outputKind: ScrydexOnePieceOutputKind }>;
  }>;

const scrydexOnePieceSourceContract = {
  owner: "chase-sets/catalog",
  repository: "chase-sets/chase-sets",
  commit: null,
  documentPath: "bounded-contexts/catalog/docs/catalog-integration-production-signoff.md#one-piece",
  fixtureSetVersion: "scrydex-one-piece-production-v1",
} as const;

const scrydexOnePieceConnectorContract = {
  kind: "scrydex-json",
  transportOwns: ["auth", "domains", "endpoint-paths", "pagination", "throttling", "raw-provider-parse"],
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
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/scrydex-one-piece-card-print",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

const setFixtures = {
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/scrydex-one-piece-set-reference",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

const sealedProductFixtures = {
  fixtureRoot:
    "bounded-contexts/catalog/features/source-observations/api/__fixtures__/scrydex-one-piece-sealed-product",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

export const scrydexOnePieceCardPrintSourceObservationMappingContract = {
  providerKey: "scrydex",
  profileKey: "one-piece-card-print-source-observation",
  displayName: "Scrydex One Piece Card Print Source Observations",
  profileVersion: SCRYDEX_ONE_PIECE_PROFILE_VERSION,
  ingestionUnitIdentity: {
    unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    providerKey: "scrydex",
    productDomain: "one-piece",
    productForm: "single-card",
    ingestionPurpose: "source-observation-import",
  },
  lifecycle: "active",
  sourceContract: scrydexOnePieceSourceContract,
  connector: scrydexOnePieceConnectorContract,
  fixtures: cardFixtures,
  sourceObservation: scrydexOnePieceSourceObservationContract("scrydex_one_piece_card_{languageCode}_{cardId}", {
    externalKeyPrefix: "card",
    idPath: "card.id",
    sourceUpdatedAtPath: "card.expansion.release_date",
  }),
  normalizedObservation: scrydexOnePieceCardNormalizedObservation(),
  externalReferences: [],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "scrydex-one-piece-set-id",
      referenceRecordKey: scrydexOnePiecePathExpression("card.expansion.id", "external-reference", [
        "reference-hierarchy",
      ]),
    },
  ],
  duplicatePrevention: scrydexOnePieceCardDuplicatePrevention(),
  promotionCommandPlan: scrydexOnePieceReviewOnlyPromotionPlan(),
  nonGoals: scrydexOnePieceNonGoals(),
} as const satisfies ScrydexOnePieceExecutableMappingContract;

export const scrydexOnePieceSetReferenceSourceObservationMappingContract = {
  providerKey: "scrydex",
  profileKey: "one-piece-set-reference-data",
  displayName: "Scrydex One Piece Set Reference Data",
  profileVersion: SCRYDEX_ONE_PIECE_PROFILE_VERSION,
  ingestionUnitIdentity: {
    unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
    providerKey: "scrydex",
    productDomain: "one-piece",
    productForm: "set",
    ingestionPurpose: "reference-data",
  },
  lifecycle: "active",
  sourceContract: {
    ...scrydexOnePieceSourceContract,
    fixtureSetVersion: "scrydex-one-piece-set-reference-production-v1",
  },
  connector: scrydexOnePieceConnectorContract,
  fixtures: setFixtures,
  sourceObservation: scrydexOnePieceSourceObservationContract("scrydex_one_piece_set_{languageCode}_{setId}", {
    externalKeyPrefix: "set",
    idPath: "expansion.id",
    sourceUpdatedAtPath: "expansion.release_date",
  }),
  normalizedObservation: scrydexOnePieceSetNormalizedObservation(),
  externalReferences: [],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "scrydex-one-piece-set-id",
      referenceRecordKey: scrydexOnePiecePathExpression("expansion.id", "external-reference", ["reference-hierarchy"]),
    },
  ],
  duplicatePrevention: scrydexOnePieceSetDuplicatePrevention(),
  promotionCommandPlan: scrydexOnePieceReviewOnlyPromotionPlan(),
  nonGoals: scrydexOnePieceNonGoals(),
} as const satisfies ScrydexOnePieceExecutableMappingContract;

export const scrydexOnePieceSealedProductSourceObservationMappingContract = {
  providerKey: "scrydex",
  profileKey: "one-piece-sealed-product-source-observation",
  displayName: "Scrydex One Piece Sealed Product Source Observations",
  profileVersion: SCRYDEX_ONE_PIECE_PROFILE_VERSION,
  ingestionUnitIdentity: {
    unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    providerKey: "scrydex",
    productDomain: "one-piece",
    productForm: "sealed-product",
    ingestionPurpose: "source-observation-import",
  },
  lifecycle: "active",
  sourceContract: {
    ...scrydexOnePieceSourceContract,
    fixtureSetVersion: "scrydex-one-piece-sealed-product-production-v1",
  },
  connector: scrydexOnePieceConnectorContract,
  fixtures: sealedProductFixtures,
  sourceObservation: scrydexOnePieceSourceObservationContract(
    "scrydex_one_piece_sealed_{languageCode}_{sealedProductId}",
    {
      externalKeyPrefix: "sealed",
      idPath: "sealedProduct.id",
      sourceUpdatedAtPath: "sealedProduct.expansion.release_date",
    },
  ),
  normalizedObservation: scrydexOnePieceSealedProductNormalizedObservation(),
  externalReferences: [],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "scrydex-one-piece-set-id",
      referenceRecordKey: scrydexOnePieceOptionalPathExpression("sealedProduct.expansion.id", "external-reference", [
        "reference-hierarchy",
      ]),
    },
  ],
  duplicatePrevention: scrydexOnePieceSealedProductDuplicatePrevention(),
  promotionCommandPlan: scrydexOnePieceReviewOnlyPromotionPlan(),
  nonGoals: scrydexOnePieceNonGoals(),
} as const satisfies ScrydexOnePieceExecutableMappingContract;

function scrydexOnePieceSourceObservationContract(
  observationTemplate: string,
  input: Readonly<{
    externalKeyPrefix: "card" | "set" | "sealed";
    idPath: string;
    sourceUpdatedAtPath: string;
  }>,
): CatalogProviderSourceObservationContract {
  const externalId = scrydexOnePiecePathExpression(input.idPath, "external-reference", ["external-reference"]);

  return {
    observationId: scrydexOnePieceTemplateExpression(observationTemplate, {
      languageCode: scrydexOnePieceLanguageExpression(),
      cardId: externalId,
      setId: externalId,
      sealedProductId: externalId,
    }),
    externalKey: scrydexOnePieceTemplateExpression(`${input.externalKeyPrefix}:{externalId}`, { externalId }),
    sourceUrl: scrydexOnePiecePathExpression("sourceUrl", "operations", ["source-payload"]),
    sourceUpdatedAt: scrydexOnePieceOptionalPathExpression(input.sourceUpdatedAtPath, "catalog-truth", [
      "normalized-observation",
    ]),
    sourcePayload: scrydexOnePiecePathExpression(".", "catalog-merge-evidence", ["source-payload"]),
  };
}

function scrydexOnePieceCardNormalizedObservation(): ScrydexOnePieceExecutableMappingContract["normalizedObservation"] {
  const cardNumber = scrydexOnePieceCoalesceExpression(
    [scrydexOnePiecePathSelector("card.printed_number", false), scrydexOnePiecePathSelector("card.number", true)],
    "catalog-truth",
    ["normalized-observation", "hash-material", "merge-identity"],
  );

  return {
    outputKind: "one-piece-card-print",
    languageCode: scrydexOnePieceLanguageExpression(),
    fields: {
      tcg: scrydexOnePieceConstantExpression("one-piece", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: scrydexOnePieceProductLineExpression(),
      name: scrydexOnePiecePathExpression("card.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardNumber,
      setId: scrydexOnePiecePathExpression("card.expansion.id", "external-reference", [
        "normalized-observation",
        "hash-material",
      ]),
      setCode: scrydexOnePieceOptionalPathExpression("card.expansion.code", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      setName: scrydexOnePiecePathExpression("card.expansion.name", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      expansionName: scrydexOnePiecePathExpression("card.expansion.name", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      rarity: scrydexOnePieceOptionalPathExpression("card.rarity", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      cardType: scrydexOnePieceOptionalPathExpression("card.type", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      printings: scrydexOnePieceOptionalPathExpression("card.printings", "catalog-merge-evidence", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      variants: scrydexOnePieceOptionalPathExpression("card.variants", "catalog-merge-evidence", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseDate: scrydexOnePieceOptionalPathExpression("card.expansion.release_date", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseYear: scrydexOnePieceConstantExpression(null, "catalog-truth", ["normalized-observation"]),
      imageUrls: scrydexOnePieceImageUrlsExpression("card.imageUrls"),
      mergeIdentity: scrydexOnePieceMergeIdentityExpression({
        setNamePath: "card.expansion.name",
        printedProductNamePath: "card.name",
        collectorNumber: cardNumber,
        productForm: "one-piece-card-print",
      }),
      externalCatalogItemReferences: scrydexOnePieceConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
      externalProductReferences: scrydexOnePieceConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      scrydexOnePieceObjectExpression(
        {
          id: scrydexOnePiecePathExpression("card.id", "external-reference", ["hash-material"]),
          name: scrydexOnePiecePathExpression("card.name", "catalog-truth", ["hash-material"]),
          cardNumber,
          setId: scrydexOnePiecePathExpression("card.expansion.id", "external-reference", ["hash-material"]),
          setName: scrydexOnePiecePathExpression("card.expansion.name", "catalog-truth", ["hash-material"]),
          rarity: scrydexOnePieceOptionalPathExpression("card.rarity", "catalog-truth", ["hash-material"]),
          cardType: scrydexOnePieceOptionalPathExpression("card.type", "catalog-truth", ["hash-material"]),
          printings: scrydexOnePieceOptionalPathExpression("card.printings", "catalog-merge-evidence", [
            "hash-material",
          ]),
          variants: scrydexOnePieceOptionalPathExpression("card.variants", "catalog-merge-evidence", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      scrydexOnePiecePathExpression("card.id", "external-reference", ["merge-identity"]),
      scrydexOnePiecePathExpression("card.expansion.id", "external-reference", ["merge-identity"]),
      cardNumber,
    ],
  };
}

function scrydexOnePieceSetNormalizedObservation(): ScrydexOnePieceExecutableMappingContract["normalizedObservation"] {
  return {
    outputKind: "one-piece-set-reference",
    languageCode: scrydexOnePieceLanguageExpression(),
    fields: {
      tcg: scrydexOnePieceConstantExpression("one-piece", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: scrydexOnePieceProductLineExpression(),
      name: scrydexOnePiecePathExpression("expansion.name", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      setId: scrydexOnePiecePathExpression("expansion.id", "external-reference", [
        "normalized-observation",
        "hash-material",
      ]),
      setCode: scrydexOnePieceOptionalPathExpression("expansion.code", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      setName: scrydexOnePiecePathExpression("expansion.name", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      releaseDate: scrydexOnePieceOptionalPathExpression("expansion.release_date", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseYear: scrydexOnePieceConstantExpression(null, "catalog-truth", ["normalized-observation"]),
      cardCount: scrydexOnePieceOptionalNumberPathExpression("expansion.total", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      externalCatalogItemReferences: scrydexOnePieceConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      scrydexOnePieceObjectExpression(
        {
          id: scrydexOnePiecePathExpression("expansion.id", "external-reference", ["hash-material"]),
          name: scrydexOnePiecePathExpression("expansion.name", "catalog-truth", ["hash-material"]),
          code: scrydexOnePieceOptionalPathExpression("expansion.code", "catalog-truth", ["hash-material"]),
          releaseDate: scrydexOnePieceOptionalPathExpression("expansion.release_date", "catalog-truth", [
            "hash-material",
          ]),
          cardCount: scrydexOnePieceOptionalNumberPathExpression("expansion.total", "catalog-truth", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      scrydexOnePiecePathExpression("expansion.id", "external-reference", ["merge-identity"]),
      scrydexOnePiecePathExpression("expansion.name", "catalog-merge-evidence", ["merge-identity"]),
    ],
  };
}

function scrydexOnePieceSealedProductNormalizedObservation(): ScrydexOnePieceExecutableMappingContract["normalizedObservation"] {
  return {
    outputKind: "one-piece-sealed-product",
    languageCode: scrydexOnePieceLanguageExpression(),
    fields: {
      tcg: scrydexOnePieceConstantExpression("one-piece", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: scrydexOnePieceProductLineExpression(),
      name: scrydexOnePiecePathExpression("sealedProduct.name", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      setId: scrydexOnePieceOptionalPathExpression("sealedProduct.expansion.id", "external-reference", [
        "normalized-observation",
        "hash-material",
      ]),
      setCode: scrydexOnePieceOptionalPathExpression("sealedProduct.expansion.code", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      setName: scrydexOnePieceOptionalPathExpression("sealedProduct.expansion.name", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      sealedProductForm: scrydexOnePieceConstantExpression("sealed-product", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseDate: scrydexOnePieceOptionalPathExpression("sealedProduct.expansion.release_date", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseYear: scrydexOnePieceConstantExpression(null, "catalog-truth", ["normalized-observation"]),
      barcode: scrydexOnePieceConstantExpression(null, "external-reference", ["normalized-observation"]),
      imageUrls: scrydexOnePieceImageUrlsExpression("sealedProduct.imageUrls"),
      mergeIdentity: scrydexOnePieceMergeIdentityExpression({
        setNamePath: "sealedProduct.expansion.name",
        printedProductNamePath: "sealedProduct.name",
        collectorNumber: scrydexOnePieceConstantExpression(null, "catalog-merge-evidence", ["merge-identity"]),
        productForm: "one-piece-sealed-product",
      }),
      externalCatalogItemReferences: scrydexOnePieceConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
      externalProductReferences: scrydexOnePieceConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      scrydexOnePieceObjectExpression(
        {
          id: scrydexOnePiecePathExpression("sealedProduct.id", "external-reference", ["hash-material"]),
          name: scrydexOnePiecePathExpression("sealedProduct.name", "catalog-truth", ["hash-material"]),
          type: scrydexOnePieceOptionalPathExpression("sealedProduct.type", "catalog-truth", ["hash-material"]),
          setId: scrydexOnePieceOptionalPathExpression("sealedProduct.expansion.id", "external-reference", [
            "hash-material",
          ]),
          setName: scrydexOnePieceOptionalPathExpression("sealedProduct.expansion.name", "catalog-truth", [
            "hash-material",
          ]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      scrydexOnePiecePathExpression("sealedProduct.id", "external-reference", ["merge-identity"]),
      scrydexOnePiecePathExpression("sealedProduct.name", "catalog-merge-evidence", ["merge-identity"]),
      scrydexOnePieceOptionalPathExpression("sealedProduct.expansion.id", "external-reference", ["merge-identity"]),
    ],
  };
}

function scrydexOnePieceCardDuplicatePrevention(): ScrydexOnePieceExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: false,
    mergeCandidateEvidence: [
      scrydexOnePiecePathExpression("card.id", "external-reference", ["merge-identity"]),
      scrydexOnePiecePathExpression("card.expansion.id", "external-reference", ["merge-identity"]),
      scrydexOnePiecePathExpression("card.name", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [scrydexOnePiecePathExpression("card.id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
      {
        ruleKey: "future-provider-bridge-review",
        ruleKind: "future-provider-bridge-match",
        evidence: [scrydexOnePiecePathExpression("card.id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function scrydexOnePieceSetDuplicatePrevention(): ScrydexOnePieceExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: false,
    mergeCandidateEvidence: [
      scrydexOnePiecePathExpression("expansion.id", "external-reference", ["merge-identity"]),
      scrydexOnePiecePathExpression("expansion.name", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [scrydexOnePiecePathExpression("expansion.id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "review-only",
    replayPolicy: "same-profile-version",
  };
}

function scrydexOnePieceSealedProductDuplicatePrevention(): ScrydexOnePieceExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: false,
    mergeCandidateEvidence: [
      scrydexOnePiecePathExpression("sealedProduct.id", "external-reference", ["merge-identity"]),
      scrydexOnePiecePathExpression("sealedProduct.name", "catalog-merge-evidence", ["merge-identity"]),
      scrydexOnePieceOptionalPathExpression("sealedProduct.expansion.id", "external-reference", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [scrydexOnePiecePathExpression("sealedProduct.id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
      {
        ruleKey: "sealed-product-name-and-set-review",
        ruleKind: "sealed-product-match",
        evidence: [
          scrydexOnePiecePathExpression("sealedProduct.name", "catalog-merge-evidence", ["merge-identity"]),
          scrydexOnePieceOptionalPathExpression("sealedProduct.expansion.id", "external-reference", ["merge-identity"]),
        ],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function scrydexOnePieceReviewOnlyPromotionPlan(): ScrydexOnePieceExecutableMappingContract["promotionCommandPlan"] {
  return {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: [],
  };
}

function scrydexOnePieceNonGoals(): ScrydexOnePieceExecutableMappingContract["nonGoals"] {
  return [
    "no-live-provider-calls-in-mapping-tests",
    "no-pricing-facts-as-catalog-truth",
    "no-inventory-facts-as-global-catalog-truth",
    "no-provider-secrets-in-events-logs-or-fixtures",
    "no-provider-transport-branches-in-mapping-interpreter",
  ];
}

function scrydexOnePieceLanguageExpression(): CatalogProviderMappingValueExpression {
  return scrydexOnePieceCoalesceExpression(
    [
      scrydexOnePiecePathSelector("card.language_code", false),
      scrydexOnePiecePathSelector("sealedProduct.language_code", false),
      scrydexOnePiecePathSelector("expansion.language_code", false),
      scrydexOnePiecePathSelector("card.language", false),
      scrydexOnePiecePathSelector("sealedProduct.language", false),
      scrydexOnePiecePathSelector("expansion.language", false),
      { kind: "constant", value: "en" },
    ],
    "catalog-truth",
    ["normalized-observation", "hash-material"],
  );
}

function scrydexOnePieceProductLineExpression(): CatalogProviderMappingValueExpression {
  return scrydexOnePieceConstantExpression("One Piece Card Game", "catalog-truth", [
    "normalized-observation",
    "hash-material",
  ]);
}

function scrydexOnePieceImageUrlsExpression(path: string): CatalogProviderMappingValueExpression {
  return scrydexOnePieceCoalesceExpression(
    [scrydexOnePiecePathSelector(path, false), { kind: "constant", value: [] }],
    "catalog-truth",
    ["normalized-observation", "hash-material"],
  );
}

function scrydexOnePieceMergeIdentityExpression(input: {
  setNamePath: string;
  printedProductNamePath: string;
  collectorNumber: CatalogProviderMappingValueExpression;
  productForm: string;
}): CatalogProviderMappingValueExpression {
  return scrydexOnePieceObjectExpression(
    {
      tcg: scrydexOnePieceConstantExpression("one-piece", "catalog-merge-evidence", ["merge-identity"]),
      productLineName: scrydexOnePieceConstantExpression("One Piece Card Game", "catalog-merge-evidence", [
        "merge-identity",
      ]),
      setName: scrydexOnePieceOptionalPathExpression(input.setNamePath, "catalog-merge-evidence", ["merge-identity"]),
      printedProductName: scrydexOnePiecePathExpression(input.printedProductNamePath, "catalog-merge-evidence", [
        "merge-identity",
      ]),
      collectorNumber: input.collectorNumber,
      languageCode: scrydexOnePieceLanguageExpression(),
      productForm: scrydexOnePieceConstantExpression(input.productForm, "catalog-merge-evidence", ["merge-identity"]),
    },
    "catalog-merge-evidence",
    ["normalized-observation", "merge-identity"],
  );
}

function scrydexOnePiecePathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
  options: Partial<Pick<CatalogProviderMappingValueExpression, "transforms" | "redaction">> = {},
): CatalogProviderMappingValueExpression {
  return {
    selector: scrydexOnePiecePathSelector(path, true),
    transforms: options.transforms,
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function scrydexOnePieceOptionalPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
  options: Partial<Pick<CatalogProviderMappingValueExpression, "transforms" | "redaction">> = {},
): CatalogProviderMappingValueExpression {
  return {
    selector: scrydexOnePiecePathSelector(path, false),
    transforms: options.transforms,
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function scrydexOnePieceOptionalNumberPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return scrydexOnePieceOptionalPathExpression(path, owner, uses, {
    transforms: [{ kind: "coerce", to: "number" }],
  });
}

function scrydexOnePiecePathSelector(
  path: string,
  required: boolean,
): CatalogProviderMappingValueExpression["selector"] {
  return {
    kind: "path",
    path,
    required,
    nullPolicy: required ? "diagnostic" : "omit",
  };
}

function scrydexOnePieceCoalesceExpression(
  selectors: readonly CatalogProviderMappingValueExpression["selector"][],
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "coalesce",
      selectors,
      required: true,
    },
    owner,
    uses,
    redaction: "none",
  };
}

function scrydexOnePieceTemplateExpression(
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

function scrydexOnePieceObjectExpression(
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

function scrydexOnePieceConstantExpression(
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
