import type { JsonValue } from "@chase-sets/primitives/json";
import {
  SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
  SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  SCRYFALL_PRODUCTION_PROFILE_VERSION,
} from "./adapter";
import {
  defineCatalogProviderIngestionUnitIdentityContract,
  type CatalogProviderExecutableMappingContract,
  type CatalogProviderMappingEvidenceOwner,
  type CatalogProviderMappingEvidenceUse,
  type CatalogProviderMappingValueExpression,
  type CatalogProviderSourceObservationContract,
} from "../../provider-integration-mapping-contract";

const scryfallSourceContract = {
  owner: "chase-sets/catalog",
  repository: "chase-sets/chase-sets",
  commit: null,
  documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
  fixtureSetVersion: "scryfall-mtg-card-print-production-v1",
} as const;

const scryfallConnectorContract = {
  kind: "scryfall-json",
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

const fixtures = {
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/scryfall-card-print",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

const commonNormalizedFields = {
  tcg: scryfallConstantExpression("magic", "catalog-truth", ["normalized-observation", "hash-material"]),
  name: scryfallCoalesceExpression(
    [scryfallPathSelector("card.printed_name", false), scryfallPathSelector("card.name", true)],
    "catalog-truth",
    ["normalized-observation", "hash-material"],
  ),
  setCode: scryfallPathExpression("card.set", "catalog-truth", [
    "normalized-observation",
    "hash-material",
    "merge-identity",
  ]),
  setId: scryfallOptionalPathExpression("card.set_id", "external-reference", ["normalized-observation"]),
  setName: scryfallPathExpression("card.set_name", "catalog-truth", ["normalized-observation", "hash-material"]),
  expansionName: scryfallPathExpression("card.set_name", "catalog-truth", ["normalized-observation", "hash-material"]),
  cardNumber: scryfallPathExpression("card.collector_number", "catalog-truth", [
    "normalized-observation",
    "hash-material",
    "merge-identity",
  ]),
  oracleId: scryfallOptionalPathExpression("card.oracle_id", "external-reference", [
    "normalized-observation",
    "hash-material",
  ]),
  rarity: scryfallOptionalPathExpression("card.rarity", "catalog-truth", ["normalized-observation", "hash-material"]),
  illustrator: scryfallOptionalPathExpression("card.artist", "catalog-truth", ["normalized-observation"]),
  releaseDate: scryfallOptionalPathExpression("card.released_at", "catalog-truth", [
    "normalized-observation",
    "hash-material",
  ]),
  releaseYear: scryfallConstantExpression(null, "catalog-truth", ["normalized-observation"]),
  cardVariantKey: scryfallConstantExpression("standard", "catalog-truth", ["normalized-observation"]),
  cardVariantLabel: scryfallConstantExpression("Standard", "catalog-truth", ["normalized-observation"]),
  imageUrls: scryfallArrayExpression(
    [
      scryfallOptionalPathExpression("card.image_uris.normal", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      scryfallOptionalPathExpression("card.image_uris.png", "catalog-truth", ["normalized-observation"]),
    ],
    "catalog-truth",
    ["normalized-observation", "hash-material"],
  ),
  mergeIdentity: scryfallObjectExpression(
    {
      tcg: scryfallConstantExpression("magic", "catalog-merge-evidence", ["merge-identity"]),
      productLineName: scryfallConstantExpression("Magic: The Gathering", "catalog-merge-evidence", ["merge-identity"]),
      setName: scryfallPathExpression("card.set_name", "catalog-merge-evidence", ["merge-identity"]),
      printedProductName: scryfallPathExpression("card.name", "catalog-merge-evidence", ["merge-identity"]),
      collectorNumber: scryfallPathExpression("card.collector_number", "catalog-merge-evidence", ["merge-identity"]),
      languageCode: scryfallPathExpression("card.lang", "catalog-merge-evidence", ["merge-identity"]),
      productForm: scryfallConstantExpression("magic-card-print", "catalog-merge-evidence", ["merge-identity"]),
    },
    "catalog-merge-evidence",
    ["normalized-observation", "merge-identity"],
  ),
  externalCatalogItemReferences: scryfallArrayExpression(
    [
      scryfallObjectExpression(
        {
          providerKey: scryfallConstantExpression("tcgplayer", "external-reference", ["external-reference"]),
          externalKey: scryfallTemplateExpression(
            "product:{tcgplayerId}",
            {
              tcgplayerId: scryfallPathExpression("card.tcgplayer_id", "external-reference", ["external-reference"]),
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
  externalProductReferences: scryfallConstantExpression([], "external-reference", [
    "normalized-observation",
    "external-reference",
  ]),
} as const;

export const scryfallMtgCardPrintSourceObservationMappingContract = {
  providerKey: "scryfall",
  profileKey: "mtg-card-print-reference-data",
  displayName: "Scryfall MTG Card Print Reference Data",
  profileVersion: SCRYFALL_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: "scryfall",
    productDomain: "mtg",
    productForm: "single-card",
    ingestionPurpose: "reference-data",
  }),
  lifecycle: "active",
  sourceContract: scryfallSourceContract,
  connector: scryfallConnectorContract,
  fixtures,
  sourceObservation: scryfallSourceObservationContract("scryfall_card_{languageCode}_{scryfallId}", "card"),
  normalizedObservation: scryfallNormalizedObservation(),
  externalReferences: scryfallExternalReferences(),
  referenceHierarchy: scryfallReferenceHierarchy(),
  duplicatePrevention: scryfallDuplicatePrevention(),
  promotionCommandPlan: scryfallPromotionCommandPlan(),
  nonGoals: scryfallNonGoals(),
} as const satisfies CatalogProviderExecutableMappingContract;

export const scryfallMtgImageEvidenceSourceObservationMappingContract = {
  providerKey: "scryfall",
  profileKey: "mtg-card-image-evidence",
  displayName: "Scryfall MTG Card Image Evidence",
  profileVersion: SCRYFALL_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: "scryfall",
    productDomain: "mtg",
    productForm: "single-card",
    ingestionPurpose: "image-evidence",
  }),
  lifecycle: "active",
  sourceContract: {
    ...scryfallSourceContract,
    fixtureSetVersion: "scryfall-mtg-image-evidence-production-v1",
  },
  connector: scryfallConnectorContract,
  fixtures: {
    ...fixtures,
    fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/scryfall-image-evidence",
  },
  sourceObservation: scryfallSourceObservationContract("scryfall_image_{languageCode}_{scryfallId}", "image"),
  normalizedObservation: scryfallNormalizedObservation(),
  externalReferences: scryfallExternalReferences(),
  referenceHierarchy: scryfallReferenceHierarchy(),
  duplicatePrevention: scryfallDuplicatePrevention(),
  promotionCommandPlan: scryfallPromotionCommandPlan(),
  nonGoals: scryfallNonGoals(),
} as const satisfies CatalogProviderExecutableMappingContract;

function scryfallSourceObservationContract(
  observationTemplate: string,
  externalKeyPrefix: "card" | "image",
): CatalogProviderSourceObservationContract {
  return {
    observationId: scryfallTemplateExpression(observationTemplate, {
      languageCode: scryfallPathExpression("card.lang", "catalog-truth", ["normalized-observation", "hash-material"]),
      scryfallId: scryfallPathExpression("card.id", "external-reference", ["external-reference"]),
    }),
    externalKey: scryfallTemplateExpression(`${externalKeyPrefix}:{scryfallId}`, {
      scryfallId: scryfallPathExpression("card.id", "external-reference", ["external-reference"]),
    }),
    sourceUrl: scryfallPathExpression("card.uri", "operations", ["source-payload"]),
    sourceUpdatedAt: scryfallOptionalPathExpression("card.released_at", "catalog-truth", ["normalized-observation"]),
    sourcePayload: scryfallPathExpression(".", "catalog-merge-evidence", ["source-payload"]),
  };
}

function scryfallNormalizedObservation(): CatalogProviderExecutableMappingContract["normalizedObservation"] {
  return {
    outputKind: "magic-card-print",
    languageCode: scryfallPathExpression("card.lang", "catalog-truth", ["normalized-observation", "hash-material"]),
    fields: commonNormalizedFields,
    hashMaterial: [
      scryfallObjectExpression(
        {
          id: scryfallPathExpression("card.id", "external-reference", ["hash-material"]),
          name: scryfallPathExpression("card.name", "catalog-truth", ["hash-material"]),
          set: scryfallPathExpression("card.set", "external-reference", ["hash-material"]),
          setName: scryfallPathExpression("card.set_name", "catalog-truth", ["hash-material"]),
          collectorNumber: scryfallPathExpression("card.collector_number", "catalog-truth", ["hash-material"]),
          languageCode: scryfallPathExpression("card.lang", "catalog-truth", ["hash-material"]),
          tcgplayerId: scryfallOptionalPathExpression("card.tcgplayer_id", "external-reference", ["hash-material"]),
          imageNormal: scryfallOptionalPathExpression("card.image_uris.normal", "catalog-truth", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      scryfallPathExpression("card.set_name", "catalog-merge-evidence", ["merge-identity"]),
      scryfallPathExpression("card.collector_number", "catalog-merge-evidence", ["merge-identity"]),
      scryfallOptionalPathExpression("card.tcgplayer_id", "external-reference", ["merge-identity"]),
    ],
  };
}

function scryfallExternalReferences(): CatalogProviderExecutableMappingContract["externalReferences"] {
  return [
    {
      target: "catalog-item-reference",
      providerKey: "tcgplayer",
      externalKeyPrefix: "product:",
      source: scryfallOptionalPathExpression("card.tcgplayer_id", "external-reference", ["external-reference"]),
      ambiguityPolicy: "skip-reference",
    },
  ];
}

function scryfallReferenceHierarchy(): CatalogProviderExecutableMappingContract["referenceHierarchy"] {
  return [
    {
      targetTypeKey: "set",
      providerAttributeKey: "scryfall-set-code",
      referenceRecordKey: scryfallPathExpression("card.set", "external-reference", ["reference-hierarchy"]),
    },
  ];
}

function scryfallDuplicatePrevention(): CatalogProviderExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: true,
    mergeCandidateEvidence: [
      scryfallOptionalPathExpression("card.tcgplayer_id", "external-reference", [
        "external-reference",
        "merge-identity",
      ]),
      scryfallPathExpression("card.collector_number", "catalog-merge-evidence", ["merge-identity"]),
      scryfallPathExpression("card.set_name", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "exact-external-catalog-item-reference",
        ruleKind: "exact-external-catalog-item-reference",
        evidence: [scryfallOptionalPathExpression("card.tcgplayer_id", "external-reference", ["external-reference"])],
        candidatePolicy: "reuse",
      },
      {
        ruleKey: "future-provider-bridge-review",
        ruleKind: "future-provider-bridge-match",
        evidence: [scryfallOptionalPathExpression("card.tcgplayer_id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function scryfallPromotionCommandPlan(): CatalogProviderExecutableMappingContract["promotionCommandPlan"] {
  return {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: [
      {
        commandName: "CreateCatalogItem",
        inputs: {
          title: scryfallPathExpression("card.name", "catalog-truth", ["promotion-command"]),
        },
      },
      {
        commandName: "SetCatalogItemFieldValue",
        inputs: {
          fieldKey: scryfallConstantExpression("set", "catalog-truth", ["promotion-command"]),
          value: scryfallPathExpression("card.set_name", "catalog-truth", ["promotion-command"]),
        },
      },
      {
        commandName: "LinkExternalCatalogItemReference",
        inputs: {
          externalKey: scryfallOptionalPathExpression("card.tcgplayer_id", "external-reference", ["promotion-command"]),
        },
      },
    ],
  };
}

function scryfallNonGoals(): CatalogProviderExecutableMappingContract["nonGoals"] {
  return [
    "no-live-provider-calls-in-mapping-tests",
    "no-pricing-facts-as-catalog-truth",
    "no-inventory-facts-as-global-catalog-truth",
    "no-provider-secrets-in-events-logs-or-fixtures",
    "no-provider-transport-branches-in-mapping-interpreter",
  ];
}

function scryfallPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
  options: Partial<Pick<CatalogProviderMappingValueExpression, "transforms" | "redaction">> = {},
): CatalogProviderMappingValueExpression {
  return {
    selector: scryfallPathSelector(path, true),
    transforms: options.transforms,
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function scryfallOptionalPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: scryfallPathSelector(path, false),
    owner,
    uses,
    redaction: "none",
  };
}

function scryfallPathSelector(path: string, required: boolean): CatalogProviderMappingValueExpression["selector"] {
  return {
    kind: "path",
    path,
    required,
    nullPolicy: required ? "diagnostic" : "omit",
  };
}

function scryfallCoalesceExpression(
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

function scryfallTemplateExpression(
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

function scryfallObjectExpression(
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

function scryfallArrayExpression(
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

function scryfallConstantExpression(
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
