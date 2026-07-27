import type { JsonValue } from "@chase-sets/primitives/json";
import { LORCANAJSON_PRODUCTION_PROFILE_VERSION } from "./adapter";
import {
  defineCatalogProviderIngestionUnitIdentityContract,
  type CatalogProviderExecutableMappingContract,
  type CatalogProviderMappingEvidenceOwner,
  type CatalogProviderMappingEvidenceUse,
  type CatalogProviderMappingValueExpression,
  type CatalogProviderSourceObservationContract,
} from "../provider-integration-mapping-contract";

const lorcanajsonSourceContract = {
  owner: "chase-sets/catalog",
  repository: "chase-sets/chase-sets",
  commit: null,
  documentPath: "bounded-contexts/catalog/docs/catalog-integration-production-signoff.md#lorcana",
  fixtureSetVersion: "lorcanajson-lorcana-card-reference-production-v1",
} as const;

const lorcanajsonConnectorContract = {
  kind: "lorcanajson-json",
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
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/lorcanajson-card-reference",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

const setFixtures = {
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/lorcanajson-set-reference",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

export const lorcanajsonLorcanaCardReferenceSourceObservationMappingContract = {
  providerKey: "lorcanajson",
  profileKey: "lorcana-card-reference-data",
  displayName: "LorcanaJSON Lorcana Card Reference Data",
  profileVersion: LORCANAJSON_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: "lorcanajson",
    productDomain: "lorcana",
    productForm: "single-card",
    ingestionPurpose: "reference-data",
  }),
  lifecycle: "active",
  sourceContract: lorcanajsonSourceContract,
  connector: lorcanajsonConnectorContract,
  fixtures: cardFixtures,
  sourceObservation: lorcanajsonSourceObservationContract("lorcanajson_card_{languageCode}_{cardId}", "card", "cardId"),
  normalizedObservation: lorcanajsonCardNormalizedObservation(),
  externalReferences: [
    {
      target: "catalog-item-reference",
      providerKey: "tcgplayer",
      externalKeyPrefix: "product:",
      source: optionalPathExpression("tcgplayerProductId", "external-reference", ["external-reference"]),
      ambiguityPolicy: "review-evidence",
    },
  ],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "lorcanajson-set-code",
      referenceRecordKey: pathExpression("setCode", "external-reference", ["reference-hierarchy"]),
    },
  ],
  duplicatePrevention: lorcanajsonCardDuplicatePrevention(),
  promotionCommandPlan: lorcanajsonReferenceDataPromotionPlan(),
  nonGoals: lorcanajsonNonGoals(),
} as const satisfies CatalogProviderExecutableMappingContract;

export const lorcanajsonLorcanaSetReferenceSourceObservationMappingContract = {
  providerKey: "lorcanajson",
  profileKey: "lorcana-set-reference-data",
  displayName: "LorcanaJSON Lorcana Set Reference Data",
  profileVersion: LORCANAJSON_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: "lorcanajson",
    productDomain: "lorcana",
    productForm: "set",
    ingestionPurpose: "reference-data",
  }),
  lifecycle: "active",
  sourceContract: {
    ...lorcanajsonSourceContract,
    fixtureSetVersion: "lorcanajson-lorcana-set-reference-production-v1",
  },
  connector: lorcanajsonConnectorContract,
  fixtures: setFixtures,
  sourceObservation: lorcanajsonSourceObservationContract("lorcanajson_set_{languageCode}_{setId}", "set", "setId"),
  normalizedObservation: lorcanajsonSetNormalizedObservation(),
  externalReferences: [],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "lorcanajson-set-code",
      referenceRecordKey: pathExpression("setCode", "external-reference", ["reference-hierarchy"]),
    },
  ],
  duplicatePrevention: {
    exactExternalCatalogItemReferencesFirst: false,
    mergeCandidateEvidence: [
      pathExpression("setId", "catalog-merge-evidence", ["merge-identity"]),
      pathExpression("setName", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [pathExpression("setId", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  },
  promotionCommandPlan: lorcanajsonReferenceDataPromotionPlan(),
  nonGoals: lorcanajsonNonGoals(),
} as const satisfies CatalogProviderExecutableMappingContract;

function lorcanajsonSourceObservationContract(
  observationTemplate: string,
  externalKeyPrefix: "card" | "set",
  externalValuePath: string,
): CatalogProviderSourceObservationContract {
  return {
    observationId: templateExpression(observationTemplate, {
      languageCode: pathExpression("languageCode", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardId: pathExpression(externalValuePath, "external-reference", ["external-reference"]),
      setId: pathExpression(externalValuePath, "external-reference", ["external-reference"]),
    }),
    externalKey: templateExpression(`${externalKeyPrefix}:{externalValue}`, {
      externalValue: pathExpression(externalValuePath, "external-reference", ["external-reference"]),
    }),
    sourceUrl: pathExpression("sourceUrl", "operations", ["source-payload"]),
    sourceUpdatedAt: optionalPathExpression("sourceUpdatedAt", "catalog-truth", ["normalized-observation"]),
    sourcePayload: pathExpression("sourcePayload", "catalog-merge-evidence", ["source-payload"]),
  };
}

function lorcanajsonCardNormalizedObservation(): CatalogProviderExecutableMappingContract["normalizedObservation"] {
  return {
    outputKind: "lorcana-card-print",
    languageCode: pathExpression("languageCode", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
      tcg: constantExpression("lorcana", "catalog-truth", ["normalized-observation", "hash-material"]),
      name: pathExpression("name", "catalog-truth", ["normalized-observation", "hash-material"]),
      setId: pathExpression("setId", "external-reference", ["normalized-observation", "hash-material"]),
      setCode: pathExpression("setCode", "catalog-truth", ["normalized-observation", "hash-material"]),
      setName: pathExpression("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
      expansionName: pathExpression("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardNumber: pathExpression("cardNumber", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      rarity: optionalPathExpression("rarity", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardType: optionalPathExpression("cardType", "catalog-truth", ["normalized-observation", "hash-material"]),
      inkColor: optionalPathExpression("inkColor", "catalog-truth", ["normalized-observation", "hash-material"]),
      releaseDate: optionalPathExpression("releaseDate", "catalog-truth", ["normalized-observation", "hash-material"]),
      releaseYear: optionalPathExpression("releaseYear", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: constantExpression("Disney Lorcana", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      imageUrls: pathExpression("imageUrls", "catalog-truth", ["normalized-observation"]),
      mergeIdentity: pathExpression("mergeIdentity", "catalog-merge-evidence", [
        "normalized-observation",
        "merge-identity",
      ]),
      externalCatalogItemReferences: pathExpression("externalCatalogItemReferences", "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
      externalProductReferences: constantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [pathExpression("catalogHashMaterial", "catalog-truth", ["hash-material"])],
    mergeIdentity: [pathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"])],
  };
}

function lorcanajsonSetNormalizedObservation(): CatalogProviderExecutableMappingContract["normalizedObservation"] {
  return {
    outputKind: "lorcana-set-reference",
    languageCode: pathExpression("languageCode", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
      tcg: constantExpression("lorcana", "catalog-truth", ["normalized-observation", "hash-material"]),
      name: pathExpression("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
      setId: pathExpression("setId", "external-reference", ["normalized-observation", "hash-material"]),
      setCode: pathExpression("setCode", "catalog-truth", ["normalized-observation", "hash-material"]),
      setName: pathExpression("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
      expansionName: pathExpression("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
      releaseDate: optionalPathExpression("releaseDate", "catalog-truth", ["normalized-observation", "hash-material"]),
      releaseYear: optionalPathExpression("releaseYear", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardCount: optionalPathExpression("cardCount", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: constantExpression("Disney Lorcana", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      externalCatalogItemReferences: constantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [pathExpression("catalogHashMaterial", "catalog-truth", ["hash-material"])],
    mergeIdentity: [pathExpression("setId", "catalog-merge-evidence", ["merge-identity"])],
  };
}

function lorcanajsonCardDuplicatePrevention(): CatalogProviderExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: true,
    mergeCandidateEvidence: [
      pathExpression("externalCatalogItemReferences", "external-reference", ["external-reference"]),
      pathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "exact-external-catalog-item-reference",
        ruleKind: "exact-external-catalog-item-reference",
        evidence: [pathExpression("externalCatalogItemReferences", "external-reference", ["external-reference"])],
        candidatePolicy: "reuse",
      },
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [pathExpression("externalKey", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
      {
        ruleKey: "lorcana-card-print-deterministic-fields",
        ruleKind: "deterministic-field-match",
        evidence: [pathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"])],
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
  };
}

function lorcanajsonReferenceDataPromotionPlan(): CatalogProviderExecutableMappingContract["promotionCommandPlan"] {
  return {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: [],
  };
}

function lorcanajsonNonGoals(): CatalogProviderExecutableMappingContract["nonGoals"] {
  return [
    "no-live-provider-calls-in-mapping-tests",
    "no-pricing-facts-as-catalog-truth",
    "no-inventory-facts-as-global-catalog-truth",
    "no-provider-secrets-in-events-logs-or-fixtures",
    "no-provider-transport-branches-in-mapping-interpreter",
  ];
}

function pathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: { kind: "path", path, required: true, nullPolicy: "diagnostic" },
    owner,
    uses,
    redaction: "none",
  };
}

function optionalPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: { kind: "path", path, required: false, nullPolicy: "allow-null" },
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
    selector: { kind: "constant", value },
    owner,
    uses,
    redaction: "none",
  };
}

function templateExpression(
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
