import type { JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingEvidenceOwner,
  CatalogProviderMappingEvidenceUse,
  CatalogProviderMappingValueExpression,
} from "../provider-integration-mapping-contract";

export const tcgdexPokemonCardSourceObservationMappingContract = {
  providerKey: "tcgdex",
  profileKey: "pokemon-tcg",
  displayName: "TCGdex Pokemon Card",
  profileVersion: "2026.06.03",
  lifecycle: "active",
  sourceContract: {
    owner: "chase-sets/catalog",
    repository: "chase-sets/chase-sets",
    commit: null,
    documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
    fixtureSetVersion: "tcgdex-pokemon-executable-v1",
  },
  connector: {
    kind: "tcgdex-json",
    transportOwns: ["domains", "endpoint-paths", "raw-provider-parse"],
    mappingOwns: [
      "source-payload",
      "normalized-observation",
      "hash-material",
      "merge-identity",
      "external-reference",
      "reference-hierarchy",
      "alias-candidate",
      "promotion-command",
    ],
  },
  fixtures: {
    fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex",
    coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
    liveProviderCallsAllowed: false,
  },
  sourceObservation: {
    observationId: tcgdexPathExpression("observationId", "catalog-merge-evidence", ["normalized-observation"]),
    externalKey: tcgdexPathExpression("externalKey", "external-reference", ["external-reference"]),
    sourceUrl: tcgdexPathExpression("sourceUrl", "operations", ["source-payload"]),
    sourceUpdatedAt: tcgdexOptionalPathExpression("sourceUpdatedAt", "catalog-truth", ["normalized-observation"]),
    sourcePayload: tcgdexPathExpression("sourcePayload", "catalog-merge-evidence", ["source-payload"]),
  },
  normalizedObservation: {
    outputKind: "pokemon-card",
    languageCode: tcgdexPathExpression("languageCode", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
      tcg: tcgdexConstantExpression("pokemon", "catalog-truth", ["normalized-observation", "hash-material"]),
      name: tcgdexPathExpression("card.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardNumber: tcgdexPathExpression(
        "card.localId",
        "catalog-truth",
        ["normalized-observation", "hash-material", "merge-identity"],
        { transforms: [{ kind: "coerce", to: "string" }] },
      ),
      setId: tcgdexPathExpression("set.id", "external-reference", ["normalized-observation", "hash-material"]),
      setName: tcgdexPathExpression("set.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      expansionId: tcgdexPathExpression("set.id", "external-reference", ["normalized-observation", "hash-material"]),
      expansionName: tcgdexPathExpression("set.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      expansionAbbreviation: tcgdexOptionalPathExpression("expansionAbbreviation", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      expansionCardCount: tcgdexOptionalPathExpression("expansionCardCount", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      expansionParallelSetCardCount: tcgdexOptionalPathExpression("expansionParallelSetCardCount", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      seriesId: tcgdexOptionalPathExpression("seriesId", "external-reference", [
        "normalized-observation",
        "hash-material",
      ]),
      seriesName: tcgdexOptionalPathExpression("seriesName", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      rarity: tcgdexOptionalPathExpression("card.rarity", "catalog-truth", ["normalized-observation", "hash-material"]),
      illustrator: tcgdexOptionalPathExpression("card.illustrator", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseDate: tcgdexOptionalPathExpression("releaseDate", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseYear: tcgdexOptionalPathExpression("releaseYear", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      category: tcgdexPathExpression("card.category", "catalog-truth", ["normalized-observation", "hash-material"]),
      imageBaseUrl: tcgdexOptionalPathExpression("imageBaseUrl", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      imageUrls: tcgdexPathExpression("sourceImageUrls", "catalog-truth", ["normalized-observation", "hash-material"]),
      mergeIdentity: tcgdexPathExpression("mergeIdentity", "catalog-merge-evidence", [
        "normalized-observation",
        "merge-identity",
      ]),
      productAssetSet: tcgdexConstantExpression(null, "catalog-truth", ["normalized-observation", "hash-material"]),
      parallelSet: tcgdexPathExpression("variant.parallelSet", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      cardVariantKey: tcgdexPathExpression("variant.key", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      cardVariantLabel: tcgdexPathExpression("variant.displayName", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      cardVariantSourceKey: tcgdexOptionalPathExpression("variant.sourceKey", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      cardVariantIsPrimaryImage: tcgdexPathExpression("variant.isPrimaryImage", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      imageDisclaimer: tcgdexOptionalPathExpression("imageDisclaimer", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      variants: tcgdexPathExpression("variants", "catalog-truth", ["normalized-observation", "hash-material"]),
      externalCatalogItemReferences: tcgdexPathExpression("externalCatalogItemReferences", "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [tcgdexPathExpression("catalogHashMaterial", "catalog-truth", ["hash-material"])],
    mergeIdentity: [tcgdexPathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"])],
  },
  externalReferences: [
    {
      target: "catalog-item-reference",
      providerKey: "tcgplayer",
      externalKeyPrefix: "product:",
      source: tcgdexPathExpression("externalCatalogItemReferences", "external-reference", ["external-reference"]),
      ambiguityPolicy: "skip-reference",
    },
    {
      target: "catalog-item-reference",
      providerKey: "cardmarket",
      externalKeyPrefix: "product:",
      source: tcgdexPathExpression("externalCatalogItemReferences", "external-reference", ["external-reference"]),
      ambiguityPolicy: "skip-reference",
    },
  ],
  referenceHierarchy: [
    {
      targetTypeKey: "expansion",
      providerAttributeKey: "tcgdex-set-id",
      referenceRecordKey: tcgdexPathExpression("expansionId", "external-reference", ["reference-hierarchy"]),
      parent: {
        targetTypeKey: "series",
        providerAttributeKey: "tcgdex-series-id",
        referenceRecordKey: tcgdexOptionalPathExpression("seriesId", "external-reference", ["reference-hierarchy"]),
        parent: {
          targetTypeKey: "product-line",
          providerAttributeKey: "official-name",
          referenceRecordKey: tcgdexConstantExpression("Pokemon Trading Card Game", "catalog-truth", [
            "reference-hierarchy",
          ]),
        },
      },
    },
  ],
  aliasCandidates: [
    {
      aliasCandidateKey: "tcgdex-localized-card-name",
      target: { kind: "catalog-item", catalogItemFieldKey: "card-name" },
      aliasType: "provider-localized-name",
      aliasText: tcgdexPathExpression("card.name", "catalog-alias-evidence", ["alias-candidate"]),
      aliasLanguage: { kind: "path", path: "languageCode", required: true },
      confidencePolicy: { sourceCategory: "provider-localized-name", reviewPolicy: "always-review" },
      evidence: tcgdexPathExpression("externalKey", "catalog-alias-evidence", ["alias-candidate"]),
      missingEvidencePolicy: "review-evidence",
      unknownAliasTextPolicy: "omit",
    },
  ],
  duplicatePrevention: {
    exactExternalCatalogItemReferencesFirst: true,
    mergeCandidateEvidence: [
      tcgdexPathExpression("mergeIdentity", "catalog-merge-evidence", ["merge-identity"]),
      tcgdexPathExpression("externalCatalogItemReferences", "external-reference", ["external-reference"]),
    ],
    identityRules: [
      {
        ruleKey: "exact-external-catalog-item-reference",
        ruleKind: "exact-external-catalog-item-reference",
        evidence: [tcgdexPathExpression("externalCatalogItemReferences", "external-reference", ["external-reference"])],
        candidatePolicy: "reuse",
      },
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [tcgdexPathExpression("externalKey", "external-reference", ["external-reference"])],
        candidatePolicy: "reuse",
      },
      {
        ruleKey: "pokemon-card-deterministic-fields",
        ruleKind: "deterministic-field-match",
        evidence: [
          tcgdexPathExpression("set.name", "catalog-truth", ["merge-identity"]),
          tcgdexPathExpression("card.localId", "catalog-truth", ["merge-identity"], {
            transforms: [{ kind: "coerce", to: "string" }],
          }),
          tcgdexPathExpression("variant.displayName", "catalog-truth", ["merge-identity"]),
        ],
        candidatePolicy: "reuse",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  },
  promotionCommandPlan: {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: [
      {
        commandName: "CreateCatalogItem",
        inputs: { title: tcgdexPathExpression("card.name", "catalog-truth", ["promotion-command"]) },
      },
      {
        commandName: "AssignBlueprintToCatalogItem",
        inputs: {
          blueprintKey: tcgdexConstantExpression("pokemon-card-single", "catalog-truth", ["promotion-command"]),
        },
      },
      {
        commandName: "SetCatalogItemFieldValue",
        inputs: {
          fieldKey: tcgdexConstantExpression("card-number", "catalog-truth", ["promotion-command"]),
          value: tcgdexPathExpression("card.localId", "catalog-truth", ["promotion-command"], {
            transforms: [{ kind: "coerce", to: "string" }],
          }),
        },
      },
      {
        commandName: "AssignCatalogItemToCategory",
        inputs: { categoryKey: tcgdexConstantExpression("singles", "catalog-truth", ["promotion-command"]) },
      },
      {
        commandName: "LinkExternalCatalogItemReference",
        inputs: {
          references: tcgdexPathExpression("externalCatalogItemReferences", "external-reference", [
            "promotion-command",
          ]),
        },
      },
    ],
  },
  nonGoals: [
    "no-live-provider-calls-in-mapping-tests",
    "no-pricing-facts-as-catalog-truth",
    "no-inventory-facts-as-global-catalog-truth",
    "no-provider-secrets-in-events-logs-or-fixtures",
    "no-provider-transport-branches-in-mapping-interpreter",
  ],
} as const satisfies CatalogProviderExecutableMappingContract;

function tcgdexPathExpression(
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

function tcgdexOptionalPathExpression(
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

function tcgdexConstantExpression(
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
