import type { JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingEvidenceOwner,
  CatalogProviderMappingEvidenceUse,
  CatalogProviderMappingValueExpression,
} from "../provider-integration-mapping-contract";

export const scrydexScryfallCardSourceObservationMappingContract = {
  providerKey: "scrydex",
  profileKey: "scryfall-card-fixture",
  displayName: "Scrydex Scryfall-style Card",
  profileVersion: "2026.06.03",
  lifecycle: "test",
  sourceContract: {
    owner: "chase-sets/catalog",
    repository: "chase-sets/chase-sets",
    commit: null,
    documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
    fixtureSetVersion: "scrydex-scryfall-card-proof-v1",
  },
  connector: {
    kind: "scrydex-scryfall-json",
    transportOwns: ["raw-provider-parse"],
    mappingOwns: [
      "source-payload",
      "normalized-observation",
      "hash-material",
      "merge-identity",
      "external-reference",
      "reference-hierarchy",
      "promotion-command",
    ],
  },
  fixtures: {
    fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/scrydex",
    coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
    liveProviderCallsAllowed: false,
  },
  sourceObservation: {
    observationId: scrydexTemplateExpression("scrydex_{languageCode}_{scryfallId}", {
      languageCode: scrydexPathExpression("lang", "catalog-truth", ["normalized-observation", "hash-material"]),
      scryfallId: scrydexPathExpression("id", "external-reference", ["external-reference"]),
    }),
    externalKey: scrydexTemplateExpression("scryfall:{scryfallId}", {
      scryfallId: scrydexPathExpression("id", "external-reference", ["external-reference"]),
    }),
    sourceUrl: scrydexPathExpression("scryfall_uri", "operations", ["source-payload"]),
    sourceUpdatedAt: scrydexOptionalPathExpression("released_at", "catalog-truth", ["normalized-observation"]),
    sourcePayload: scrydexPathExpression(".", "catalog-merge-evidence", ["source-payload"]),
  },
  normalizedObservation: {
    outputKind: "magic-card-print",
    languageCode: scrydexPathExpression("lang", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: {
      tcg: scrydexConstantExpression("magic", "catalog-truth", ["normalized-observation", "hash-material"]),
      name: scrydexCoalesceExpression(
        [scrydexPathSelector("printed_name", false), scrydexPathSelector("name", true)],
        "catalog-truth",
        ["normalized-observation", "hash-material"],
      ),
      setCode: scrydexPathExpression("set", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      setId: scrydexOptionalPathExpression("set_id", "external-reference", ["normalized-observation"]),
      setName: scrydexPathExpression("set_name", "catalog-truth", ["normalized-observation", "hash-material"]),
      expansionName: scrydexPathExpression("set_name", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardNumber: scrydexPathExpression("collector_number", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      oracleId: scrydexOptionalPathExpression("oracle_id", "external-reference", [
        "normalized-observation",
        "hash-material",
      ]),
      rarity: scrydexOptionalPathExpression("rarity", "catalog-truth", ["normalized-observation", "hash-material"]),
      illustrator: scrydexOptionalPathExpression("artist", "catalog-truth", ["normalized-observation"]),
      releaseDate: scrydexOptionalPathExpression("released_at", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseYear: scrydexConstantExpression(null, "catalog-truth", ["normalized-observation"]),
      cardVariantKey: scrydexConstantExpression("standard", "catalog-truth", ["normalized-observation"]),
      cardVariantLabel: scrydexConstantExpression("Standard", "catalog-truth", ["normalized-observation"]),
      imageUrls: scrydexArrayExpression(
        [
          scrydexOptionalPathExpression("image_uris.normal", "catalog-truth", [
            "normalized-observation",
            "hash-material",
          ]),
          scrydexOptionalPathExpression("image_uris.png", "catalog-truth", ["normalized-observation"]),
        ],
        "catalog-truth",
        ["normalized-observation", "hash-material"],
      ),
      mergeIdentity: scrydexObjectExpression(
        {
          tcg: scrydexConstantExpression("magic", "catalog-merge-evidence", ["merge-identity"]),
          productLineName: scrydexConstantExpression("Magic: The Gathering", "catalog-merge-evidence", [
            "merge-identity",
          ]),
          setName: scrydexPathExpression("set_name", "catalog-merge-evidence", ["merge-identity"]),
          printedProductName: scrydexPathExpression("name", "catalog-merge-evidence", ["merge-identity"]),
          collectorNumber: scrydexPathExpression("collector_number", "catalog-merge-evidence", ["merge-identity"]),
          languageCode: scrydexPathExpression("lang", "catalog-merge-evidence", ["merge-identity"]),
          productForm: scrydexConstantExpression("magic-card-print", "catalog-merge-evidence", ["merge-identity"]),
        },
        "catalog-merge-evidence",
        ["normalized-observation", "merge-identity"],
      ),
      externalCatalogItemReferences: scrydexArrayExpression(
        [
          scrydexObjectExpression(
            {
              providerKey: scrydexConstantExpression("tcgplayer", "external-reference", ["external-reference"]),
              externalKey: scrydexTemplateExpression("product:{tcgplayerId}", {
                tcgplayerId: scrydexPathExpression("tcgplayer_id", "external-reference", ["external-reference"]),
              }),
            },
            "external-reference",
            ["external-reference"],
          ),
        ],
        "external-reference",
        ["normalized-observation", "external-reference"],
      ),
      externalProductReferences: scrydexConstantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      scrydexObjectExpression(
        {
          id: scrydexPathExpression("id", "external-reference", ["hash-material"]),
          name: scrydexPathExpression("name", "catalog-truth", ["hash-material"]),
          set: scrydexPathExpression("set", "external-reference", ["hash-material"]),
          setName: scrydexPathExpression("set_name", "catalog-truth", ["hash-material"]),
          collectorNumber: scrydexPathExpression("collector_number", "catalog-truth", ["hash-material"]),
          languageCode: scrydexPathExpression("lang", "catalog-truth", ["hash-material"]),
          tcgplayerId: scrydexPathExpression("tcgplayer_id", "external-reference", ["hash-material"]),
          imageNormal: scrydexOptionalPathExpression("image_uris.normal", "catalog-truth", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      scrydexPathExpression("set_name", "catalog-merge-evidence", ["merge-identity"]),
      scrydexPathExpression("collector_number", "catalog-merge-evidence", ["merge-identity"]),
      scrydexPathExpression("tcgplayer_id", "external-reference", ["merge-identity"]),
    ],
  },
  externalReferences: [
    {
      target: "catalog-item-reference",
      providerKey: "tcgplayer",
      externalKeyPrefix: "product:",
      source: scrydexPathExpression("tcgplayer_id", "external-reference", ["external-reference"]),
      ambiguityPolicy: "skip-reference",
    },
  ],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "scryfall-set-code",
      referenceRecordKey: scrydexPathExpression("set", "external-reference", ["reference-hierarchy"]),
    },
  ],
  duplicatePrevention: {
    exactExternalCatalogItemReferencesFirst: true,
    mergeCandidateEvidence: [
      scrydexPathExpression("tcgplayer_id", "external-reference", ["external-reference", "merge-identity"]),
      scrydexPathExpression("collector_number", "catalog-merge-evidence", ["merge-identity"]),
      scrydexPathExpression("set_name", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "exact-external-catalog-item-reference",
        ruleKind: "exact-external-catalog-item-reference",
        evidence: [scrydexPathExpression("tcgplayer_id", "external-reference", ["external-reference"])],
        candidatePolicy: "reuse",
      },
      {
        ruleKey: "future-provider-bridge-review",
        ruleKind: "future-provider-bridge-match",
        evidence: [scrydexPathExpression("tcgplayer_id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
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
        inputs: {
          title: scrydexPathExpression("name", "catalog-truth", ["promotion-command"]),
        },
      },
      {
        commandName: "SetCatalogItemFieldValue",
        inputs: {
          fieldKey: scrydexConstantExpression("set", "catalog-truth", ["promotion-command"]),
          value: scrydexPathExpression("set_name", "catalog-truth", ["promotion-command"]),
        },
      },
      {
        commandName: "LinkExternalCatalogItemReference",
        inputs: {
          externalKey: scrydexPathExpression("tcgplayer_id", "external-reference", ["promotion-command"]),
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

function scrydexPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
  options: Partial<Pick<CatalogProviderMappingValueExpression, "transforms" | "redaction">> = {},
): CatalogProviderMappingValueExpression {
  return {
    selector: scrydexPathSelector(path, true),
    transforms: options.transforms,
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function scrydexOptionalPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: scrydexPathSelector(path, false),
    owner,
    uses,
    redaction: "none",
  };
}

function scrydexPathSelector(path: string, required: boolean): CatalogProviderMappingValueExpression["selector"] {
  return {
    kind: "path",
    path,
    required,
    nullPolicy: required ? "diagnostic" : "omit",
  };
}

function scrydexCoalesceExpression(
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

function scrydexTemplateExpression(
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

function scrydexObjectExpression(
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

function scrydexArrayExpression(
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

function scrydexConstantExpression(
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
