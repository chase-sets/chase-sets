import type { JsonValue } from "@chase-sets/primitives/json";
import { MTGJSON_PRODUCTION_PROFILE_VERSION } from "./adapter";
import {
  defineCatalogProviderIngestionUnitIdentityContract,
  type CatalogProviderExecutableMappingContract,
  type CatalogProviderMappingEvidenceOwner,
  type CatalogProviderMappingEvidenceUse,
  type CatalogProviderMappingValueExpression,
  type CatalogProviderSourceObservationContract,
} from "../../provider-integration-mapping-contract";

const mtgjsonSourceContract = {
  owner: "chase-sets/catalog",
  repository: "chase-sets/chase-sets",
  commit: null,
  documentPath: "bounded-contexts/catalog/docs/catalog-integration-production-signoff.md#magic",
  fixtureSetVersion: "mtgjson-mtg-card-reference-production-v1",
} as const;

const mtgjsonConnectorContract = {
  kind: "mtgjson-json",
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

const cardFixtures = {
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/mtgjson-card-reference",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

const setFixtures = {
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/mtgjson-set-reference",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

export const mtgjsonMtgCardReferenceSourceObservationMappingContract = {
  providerKey: "mtgjson",
  profileKey: "mtg-card-reference-data",
  displayName: "MTGJSON MTG Card Reference Data",
  profileVersion: MTGJSON_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: "mtgjson",
    productDomain: "mtg",
    productForm: "single-card",
    ingestionPurpose: "reference-data",
  }),
  lifecycle: "active",
  sourceContract: mtgjsonSourceContract,
  connector: mtgjsonConnectorContract,
  fixtures: cardFixtures,
  sourceObservation: mtgjsonSourceObservationContract(
    "mtgjson_card_{languageCode}_{cardUuid}",
    "card",
    mtgjsonPathExpression("card.uuid", "external-reference", ["external-reference"]),
  ),
  normalizedObservation: mtgjsonCardNormalizedObservation(),
  externalReferences: [
    {
      target: "catalog-item-reference",
      providerKey: "scryfall",
      externalKeyPrefix: "card:",
      source: mtgjsonOptionalPathExpression("card.identifiers.scryfallId", "external-reference", [
        "external-reference",
      ]),
      ambiguityPolicy: "review-evidence",
    },
  ],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "mtgjson-set-code",
      referenceRecordKey: mtgjsonPathExpression("set.code", "external-reference", ["reference-hierarchy"]),
    },
  ],
  duplicatePrevention: mtgjsonDuplicatePrevention(),
  promotionCommandPlan: mtgjsonReferenceDataPromotionPlan(),
  nonGoals: mtgjsonNonGoals(),
} as const satisfies CatalogProviderExecutableMappingContract;

export const mtgjsonMtgSetReferenceSourceObservationMappingContract = {
  providerKey: "mtgjson",
  profileKey: "mtg-set-reference-data",
  displayName: "MTGJSON MTG Set Reference Data",
  profileVersion: MTGJSON_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: "mtgjson",
    productDomain: "mtg",
    productForm: "set",
    ingestionPurpose: "reference-data",
  }),
  lifecycle: "active",
  sourceContract: {
    ...mtgjsonSourceContract,
    fixtureSetVersion: "mtgjson-mtg-set-reference-production-v1",
  },
  connector: mtgjsonConnectorContract,
  fixtures: setFixtures,
  sourceObservation: mtgjsonSourceObservationContract(
    "mtgjson_set_{languageCode}_{setCode}",
    "set",
    mtgjsonPathExpression("set.code", "external-reference", ["external-reference"]),
  ),
  normalizedObservation: mtgjsonSetNormalizedObservation(),
  externalReferences: [],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "mtgjson-set-code",
      referenceRecordKey: mtgjsonPathExpression("set.code", "external-reference", ["reference-hierarchy"]),
    },
  ],
  duplicatePrevention: {
    exactExternalCatalogItemReferencesFirst: false,
    mergeCandidateEvidence: [
      mtgjsonPathExpression("set.code", "catalog-merge-evidence", ["merge-identity"]),
      mtgjsonPathExpression("set.name", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [mtgjsonPathExpression("set.code", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  },
  promotionCommandPlan: mtgjsonReferenceDataPromotionPlan(),
  nonGoals: mtgjsonNonGoals(),
} as const satisfies CatalogProviderExecutableMappingContract;

function mtgjsonSourceObservationContract(
  observationTemplate: string,
  externalKeyPrefix: "card" | "set",
  externalValue: CatalogProviderMappingValueExpression,
): CatalogProviderSourceObservationContract {
  return {
    observationId: mtgjsonTemplateExpression(observationTemplate, {
      languageCode: mtgjsonConstantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardUuid: externalValue,
      setCode: externalValue,
    }),
    externalKey: mtgjsonTemplateExpression(`${externalKeyPrefix}:{externalValue}`, {
      externalValue,
    }),
    sourceUrl: mtgjsonPathExpression("sourceUrl", "operations", ["source-payload"]),
    sourceUpdatedAt: mtgjsonOptionalPathExpression("meta.date", "catalog-truth", ["normalized-observation"]),
    sourcePayload: mtgjsonPathExpression(".", "catalog-merge-evidence", ["source-payload"]),
  };
}

function mtgjsonCardNormalizedObservation(): CatalogProviderExecutableMappingContract["normalizedObservation"] {
  return {
    outputKind: "magic-card-print",
    languageCode: mtgjsonConstantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
      tcg: mtgjsonConstantExpression("magic", "catalog-truth", ["normalized-observation", "hash-material"]),
      name: mtgjsonPathExpression("card.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      setCode: mtgjsonPathExpression("set.code", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      setId: mtgjsonConstantExpression(null, "external-reference", ["normalized-observation"]),
      setName: mtgjsonPathExpression("set.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      expansionName: mtgjsonPathExpression("set.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardNumber: mtgjsonPathExpression("card.number", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      oracleId: mtgjsonOptionalPathExpression("card.identifiers.scryfallOracleId", "external-reference", [
        "normalized-observation",
        "hash-material",
      ]),
      rarity: mtgjsonOptionalPathExpression("card.rarity", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      illustrator: mtgjsonOptionalPathExpression("card.artist", "catalog-truth", ["normalized-observation"]),
      releaseDate: mtgjsonOptionalPathExpression("set.releaseDate", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseYear: mtgjsonConstantExpression(null, "catalog-truth", ["normalized-observation"]),
      cardVariantKey: mtgjsonConstantExpression("standard", "catalog-truth", ["normalized-observation"]),
      cardVariantLabel: mtgjsonConstantExpression("Standard", "catalog-truth", ["normalized-observation"]),
      imageUrls: mtgjsonConstantExpression([], "catalog-truth", ["normalized-observation", "hash-material"]),
      mergeIdentity: mtgjsonCardMergeIdentity(),
      externalCatalogItemReferences: mtgjsonArrayExpression(
        [
          mtgjsonObjectExpression(
            {
              providerKey: mtgjsonConstantExpression("scryfall", "external-reference", ["external-reference"]),
              externalKey: mtgjsonTemplateExpression(
                "card:{scryfallId}",
                {
                  scryfallId: mtgjsonOptionalPathExpression("card.identifiers.scryfallId", "external-reference", [
                    "external-reference",
                  ]),
                },
                false,
              ),
            },
            "external-reference",
            ["external-reference"],
          ),
        ],
        "external-reference",
        ["normalized-observation", "external-reference"],
      ),
      externalProductReferences: mtgjsonConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      mtgjsonObjectExpression(
        {
          uuid: mtgjsonPathExpression("card.uuid", "external-reference", ["hash-material"]),
          name: mtgjsonPathExpression("card.name", "catalog-truth", ["hash-material"]),
          setCode: mtgjsonPathExpression("set.code", "external-reference", ["hash-material"]),
          setName: mtgjsonPathExpression("set.name", "catalog-truth", ["hash-material"]),
          collectorNumber: mtgjsonPathExpression("card.number", "catalog-truth", ["hash-material"]),
          scryfallId: mtgjsonOptionalPathExpression("card.identifiers.scryfallId", "external-reference", [
            "hash-material",
          ]),
          mtgjsonVersion: mtgjsonOptionalPathExpression("meta.version", "operations", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      mtgjsonPathExpression("set.name", "catalog-merge-evidence", ["merge-identity"]),
      mtgjsonPathExpression("card.number", "catalog-merge-evidence", ["merge-identity"]),
      mtgjsonOptionalPathExpression("card.identifiers.scryfallId", "external-reference", ["merge-identity"]),
    ],
  };
}

function mtgjsonSetNormalizedObservation(): CatalogProviderExecutableMappingContract["normalizedObservation"] {
  return {
    outputKind: "magic-set-reference",
    languageCode: mtgjsonConstantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
      tcg: mtgjsonConstantExpression("magic", "catalog-truth", ["normalized-observation", "hash-material"]),
      name: mtgjsonPathExpression("set.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      setCode: mtgjsonPathExpression("set.code", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      setId: mtgjsonConstantExpression(null, "external-reference", ["normalized-observation"]),
      setName: mtgjsonPathExpression("set.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      releaseDate: mtgjsonOptionalPathExpression("set.releaseDate", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseYear: mtgjsonConstantExpression(null, "catalog-truth", ["normalized-observation"]),
      cardCount: mtgjsonOptionalPathExpression("set.totalSetSize", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      productLineName: mtgjsonConstantExpression("Magic: The Gathering", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      externalCatalogItemReferences: mtgjsonConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      mtgjsonObjectExpression(
        {
          code: mtgjsonPathExpression("set.code", "external-reference", ["hash-material"]),
          name: mtgjsonPathExpression("set.name", "catalog-truth", ["hash-material"]),
          releaseDate: mtgjsonOptionalPathExpression("set.releaseDate", "catalog-truth", ["hash-material"]),
          cardCount: mtgjsonOptionalPathExpression("set.totalSetSize", "catalog-truth", ["hash-material"]),
          mtgjsonVersion: mtgjsonOptionalPathExpression("meta.version", "operations", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      mtgjsonPathExpression("set.code", "catalog-merge-evidence", ["merge-identity"]),
      mtgjsonPathExpression("set.name", "catalog-merge-evidence", ["merge-identity"]),
    ],
  };
}

function mtgjsonCardMergeIdentity(): CatalogProviderMappingValueExpression {
  return mtgjsonObjectExpression(
    {
      tcg: mtgjsonConstantExpression("magic", "catalog-merge-evidence", ["merge-identity"]),
      productLineName: mtgjsonConstantExpression("Magic: The Gathering", "catalog-merge-evidence", ["merge-identity"]),
      setName: mtgjsonPathExpression("set.name", "catalog-merge-evidence", ["merge-identity"]),
      printedProductName: mtgjsonPathExpression("card.name", "catalog-merge-evidence", ["merge-identity"]),
      collectorNumber: mtgjsonPathExpression("card.number", "catalog-merge-evidence", ["merge-identity"]),
      languageCode: mtgjsonConstantExpression("en", "catalog-merge-evidence", ["merge-identity"]),
      productForm: mtgjsonConstantExpression("magic-card-print", "catalog-merge-evidence", ["merge-identity"]),
    },
    "catalog-merge-evidence",
    ["normalized-observation", "merge-identity"],
  );
}

function mtgjsonDuplicatePrevention(): CatalogProviderExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: true,
    mergeCandidateEvidence: [
      mtgjsonOptionalPathExpression("card.identifiers.scryfallId", "external-reference", [
        "external-reference",
        "merge-identity",
      ]),
      mtgjsonPathExpression("card.number", "catalog-merge-evidence", ["merge-identity"]),
      mtgjsonPathExpression("set.name", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "exact-scryfall-bridge-reference",
        ruleKind: "exact-external-catalog-item-reference",
        evidence: [
          mtgjsonOptionalPathExpression("card.identifiers.scryfallId", "external-reference", ["external-reference"]),
        ],
        candidatePolicy: "reuse",
      },
      {
        ruleKey: "future-provider-bridge-review",
        ruleKind: "future-provider-bridge-match",
        evidence: [
          mtgjsonOptionalPathExpression("card.identifiers.scryfallId", "external-reference", ["external-reference"]),
        ],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function mtgjsonReferenceDataPromotionPlan(): CatalogProviderExecutableMappingContract["promotionCommandPlan"] {
  return {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: [],
  };
}

function mtgjsonNonGoals(): CatalogProviderExecutableMappingContract["nonGoals"] {
  return [
    "no-live-provider-calls-in-mapping-tests",
    "no-pricing-facts-as-catalog-truth",
    "no-inventory-facts-as-global-catalog-truth",
    "no-provider-secrets-in-events-logs-or-fixtures",
    "no-provider-transport-branches-in-mapping-interpreter",
  ];
}

function mtgjsonPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
  options: Partial<Pick<CatalogProviderMappingValueExpression, "transforms" | "redaction">> = {},
): CatalogProviderMappingValueExpression {
  return {
    selector: mtgjsonPathSelector(path, true),
    transforms: options.transforms,
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function mtgjsonOptionalPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: mtgjsonPathSelector(path, false),
    owner,
    uses,
    redaction: "none",
  };
}

function mtgjsonPathSelector(path: string, required: boolean): CatalogProviderMappingValueExpression["selector"] {
  return {
    kind: "path",
    path,
    required,
    nullPolicy: required ? "diagnostic" : "omit",
  };
}

function mtgjsonTemplateExpression(
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

function mtgjsonObjectExpression(
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

function mtgjsonArrayExpression(
  items: readonly CatalogProviderMappingValueExpression[],
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "array",
      items,
    },
    owner,
    uses,
    redaction: "none",
  };
}

function mtgjsonConstantExpression(
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
