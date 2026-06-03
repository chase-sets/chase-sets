import type { JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingEvidenceOwner,
  CatalogProviderMappingEvidenceUse,
  CatalogProviderMappingValueExpression,
} from "./provider-integration-mapping-contract";

export const tcgplayerProviderProductSourceObservationMappingContract = {
  providerKey: "tcgplayer",
  profileKey: "pokemon-tcg-automation-client",
  displayName: "TCGplayer Provider Product",
  profileVersion: "2026.06.03",
  lifecycle: "test",
  sourceContract: {
    owner: "Catalog",
    repository: "todd-skelton/tcgplayer-automation-app",
    commit: "bf42aa8",
    documentPath: "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
    fixtureSetVersion: "automation-client-contract-v1",
  },
  connector: {
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
  },
  fixtures: {
    fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer-automation",
    coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
    liveProviderCallsAllowed: false,
  },
  sourceObservation: {
    observationId: pathExpression("observationId", "catalog-merge-evidence", ["normalized-observation"]),
    externalKey: pathExpression("externalKey", "external-reference", ["external-reference"]),
    sourceUrl: pathExpression("sourceUrl", "operations", ["source-payload"]),
    sourceUpdatedAt: optionalPathExpression("sourceUpdatedAt", "catalog-truth", ["normalized-observation"]),
    sourcePayload: pathExpression("sourcePayload", "catalog-merge-evidence", ["source-payload"]),
  },
  normalizedObservation: {
    outputKind: "provider-product",
    languageCode: constantExpression("en", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
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
      providerProductId: pathExpression(
        "productId",
        "external-reference",
        ["normalized-observation", "hash-material"],
        {
          transforms: [{ kind: "coerce", to: "string" }],
        },
      ),
      providerProductName: pathExpression("productName", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: pathExpression("productLineName", "catalog-merge-evidence", [
        "normalized-observation",
        "merge-identity",
      ]),
      productCategoryName: pathExpression("productTypeName", "catalog-merge-evidence", ["normalized-observation"]),
      skuReferences: pathExpression("skuReferences", "external-reference", ["normalized-observation"]),
      productForm: pathExpression("productForm", "catalog-merge-evidence", [
        "normalized-observation",
        "merge-identity",
      ]),
      barcode: optionalPathExpression("barcode", "catalog-merge-evidence", [
        "normalized-observation",
        "merge-identity",
      ]),
    },
    hashMaterial: [pathExpression("catalogHashMaterial", "catalog-truth", ["hash-material"])],
    mergeIdentity: [pathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"])],
  },
  externalReferences: [
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
  ],
  referenceHierarchy: [
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
  ],
  duplicatePrevention: {
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
  },
  promotionCommandPlan: {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: [],
  },
  nonGoals: [
    "no-live-provider-calls-in-mapping-tests",
    "no-pricing-facts-as-catalog-truth",
    "no-inventory-facts-as-global-catalog-truth",
    "no-provider-secrets-in-events-logs-or-fixtures",
    "no-provider-transport-branches-in-mapping-interpreter",
  ],
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
