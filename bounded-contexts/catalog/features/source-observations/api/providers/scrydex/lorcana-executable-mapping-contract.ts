import type { JsonValue } from "@chase-sets/primitives/json";
import {
  SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
  SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./adapter";

export { SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION } from "./adapter";
import {
  defineCatalogProviderIngestionUnitIdentityContract,
  type CatalogProviderExecutableMappingContract,
  type CatalogProviderMappingEvidenceOwner,
  type CatalogProviderMappingEvidenceUse,
  type CatalogProviderMappingValueExpression,
  type CatalogProviderSourceObservationContract,
} from "../../provider-integration-mapping-contract";

const scrydexLorcanaSourceContract = {
  owner: "chase-sets/catalog",
  repository: "chase-sets/chase-sets",
  commit: null,
  documentPath: "bounded-contexts/catalog/docs/catalog-integration-production-signoff.md#lorcana",
  fixtureSetVersion: "scrydex-lorcana-production-v1",
} as const;

const scrydexLorcanaConnectorContract = {
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
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/scrydex-lorcana-card-print",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

const setFixtures = {
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/scrydex-lorcana-set-reference",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

const sealedFixtures = {
  fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/scrydex-lorcana-sealed-product",
  coveredFlows: ["normal", "partial", "stale", "changed", "ambiguous", "replay", "sealed-product", "unknown-option"],
  liveProviderCallsAllowed: false,
} as const;

export const scrydexLorcanaCardPrintSourceObservationMappingContract = {
  providerKey: "scrydex",
  profileKey: "lorcana-card-print-source-observation",
  displayName: "Scrydex Lorcana Card Print Source Observations",
  profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: "scrydex",
    productDomain: "lorcana",
    productForm: "single-card",
    ingestionPurpose: "source-observation-import",
  }),
  lifecycle: "active",
  sourceContract: scrydexLorcanaSourceContract,
  connector: scrydexLorcanaConnectorContract,
  fixtures: cardFixtures,
  sourceObservation: scrydexLorcanaSourceObservationContract(
    "scrydex_lorcana_card_{languageCode}_{cardId}",
    "card",
    "card.id",
    "card.expansion.release_date",
  ),
  normalizedObservation: scrydexLorcanaCardNormalizedObservation(),
  externalReferences: [
    {
      target: "catalog-item-reference",
      providerKey: "tcgplayer",
      externalKeyPrefix: "product:",
      source: optionalPathExpression("card.tcgplayer_id", "external-reference", ["external-reference"]),
      ambiguityPolicy: "review-evidence",
    },
  ],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "scrydex-lorcana-set-id",
      referenceRecordKey: pathExpression("card.expansion.id", "external-reference", ["reference-hierarchy"]),
    },
  ],
  duplicatePrevention: scrydexLorcanaCardDuplicatePrevention(),
  promotionCommandPlan: reviewPromotionPlan(),
  nonGoals: nonGoals(),
} as const satisfies CatalogProviderExecutableMappingContract;

export const scrydexLorcanaSetReferenceSourceObservationMappingContract = {
  providerKey: "scrydex",
  profileKey: "lorcana-set-reference-data",
  displayName: "Scrydex Lorcana Set Reference Data",
  profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: "scrydex",
    productDomain: "lorcana",
    productForm: "set",
    ingestionPurpose: "reference-data",
  }),
  lifecycle: "active",
  sourceContract: { ...scrydexLorcanaSourceContract, fixtureSetVersion: "scrydex-lorcana-set-reference-production-v1" },
  connector: scrydexLorcanaConnectorContract,
  fixtures: setFixtures,
  sourceObservation: scrydexLorcanaSourceObservationContract(
    "scrydex_lorcana_set_{languageCode}_{setId}",
    "set",
    "expansion.id",
    "expansion.release_date",
  ),
  normalizedObservation: scrydexLorcanaSetNormalizedObservation(),
  externalReferences: [],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "scrydex-lorcana-set-id",
      referenceRecordKey: pathExpression("expansion.id", "external-reference", ["reference-hierarchy"]),
    },
  ],
  duplicatePrevention: setDuplicatePrevention(),
  promotionCommandPlan: referencePromotionPlan(),
  nonGoals: nonGoals(),
} as const satisfies CatalogProviderExecutableMappingContract;

export const scrydexLorcanaSealedProductSourceObservationMappingContract = {
  providerKey: "scrydex",
  profileKey: "lorcana-sealed-product-source-observation",
  displayName: "Scrydex Lorcana Sealed Product Source Observations",
  profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
  ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: "scrydex",
    productDomain: "lorcana",
    productForm: "sealed-product",
    ingestionPurpose: "source-observation-import",
  }),
  lifecycle: "test",
  sourceContract: { ...scrydexLorcanaSourceContract, fixtureSetVersion: "scrydex-lorcana-sealed-production-v1" },
  connector: scrydexLorcanaConnectorContract,
  fixtures: sealedFixtures,
  sourceObservation: scrydexLorcanaSourceObservationContract(
    "scrydex_lorcana_sealed_{languageCode}_{sealedProductId}",
    "sealed",
    "sealedProduct.id",
    "sealedProduct.expansion.release_date",
  ),
  normalizedObservation: scrydexLorcanaSealedNormalizedObservation(),
  externalReferences: [],
  referenceHierarchy: [
    {
      targetTypeKey: "set",
      providerAttributeKey: "scrydex-lorcana-set-id",
      referenceRecordKey: optionalPathExpression("sealedProduct.expansion.id", "external-reference", [
        "reference-hierarchy",
      ]),
    },
  ],
  duplicatePrevention: sealedDuplicatePrevention(),
  promotionCommandPlan: reviewPromotionPlan(),
  nonGoals: nonGoals(),
} as const satisfies CatalogProviderExecutableMappingContract;

function scrydexLorcanaSourceObservationContract(
  template: string,
  externalKeyPrefix: "card" | "set" | "sealed",
  idPath: string,
  sourceUpdatedAtPath: string,
): CatalogProviderSourceObservationContract {
  const externalId = pathExpression(idPath, "external-reference", ["external-reference"]);
  return {
    observationId: templateExpression(template, {
      languageCode: languageExpression(),
      cardId: externalId,
      setId: externalId,
      sealedProductId: externalId,
    }),
    externalKey: templateExpression(`${externalKeyPrefix}:{externalId}`, { externalId }),
    sourceUrl: pathExpression("sourceUrl", "operations", ["source-payload"]),
    sourceUpdatedAt: optionalPathExpression(sourceUpdatedAtPath, "catalog-truth", ["normalized-observation"]),
    sourcePayload: pathExpression(".", "catalog-merge-evidence", ["source-payload"]),
  };
}

function scrydexLorcanaCardNormalizedObservation(): CatalogProviderExecutableMappingContract["normalizedObservation"] {
  const cardNumber = coalesceExpression(
    [pathSelector("card.printed_number", false), pathSelector("card.number", true)],
    "catalog-truth",
    ["normalized-observation", "hash-material", "merge-identity"],
  );
  return {
    outputKind: "lorcana-card-print",
    languageCode: languageExpression(),
    fields: {
      tcg: constantExpression("lorcana", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: constantExpression("Disney Lorcana", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      name: pathExpression("card.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardNumber,
      setId: pathExpression("card.expansion.id", "external-reference", ["normalized-observation", "hash-material"]),
      setCode: optionalPathExpression("card.expansion.code", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      setName: pathExpression("card.expansion.name", "catalog-truth", [
        "normalized-observation",
        "hash-material",
        "merge-identity",
      ]),
      expansionName: pathExpression("card.expansion.name", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      rarity: optionalPathExpression("card.rarity", "catalog-truth", ["normalized-observation", "hash-material"]),
      cardType: optionalPathExpression("card.type", "catalog-truth", ["normalized-observation", "hash-material"]),
      inkColor: optionalPathExpression("card.ink", "catalog-truth", ["normalized-observation", "hash-material"]),
      releaseDate: optionalPathExpression("card.expansion.release_date", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseYear: constantExpression(null, "catalog-truth", ["normalized-observation"]),
      imageUrls: imageUrlsExpression("card.imageUrls"),
      mergeIdentity: mergeIdentityExpression({
        setNamePath: "card.expansion.name",
        printedProductNamePath: "card.name",
        collectorNumber: cardNumber,
        productForm: "lorcana-card-print",
      }),
      externalCatalogItemReferences: externalCatalogItemReferencesExpression(),
      externalProductReferences: constantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      objectExpression(
        {
          id: pathExpression("card.id", "external-reference", ["hash-material"]),
          name: pathExpression("card.name", "catalog-truth", ["hash-material"]),
          cardNumber,
          setId: pathExpression("card.expansion.id", "external-reference", ["hash-material"]),
          setName: pathExpression("card.expansion.name", "catalog-truth", ["hash-material"]),
          rarity: optionalPathExpression("card.rarity", "catalog-truth", ["hash-material"]),
          cardType: optionalPathExpression("card.type", "catalog-truth", ["hash-material"]),
          ink: optionalPathExpression("card.ink", "catalog-truth", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      pathExpression("card.id", "external-reference", ["merge-identity"]),
      pathExpression("card.expansion.id", "external-reference", ["merge-identity"]),
      pathExpression("card.name", "catalog-merge-evidence", ["merge-identity"]),
      cardNumber,
    ],
  };
}

function scrydexLorcanaSetNormalizedObservation(): CatalogProviderExecutableMappingContract["normalizedObservation"] {
  return {
    outputKind: "lorcana-set-reference",
    languageCode: languageExpression(),
    fields: {
      tcg: constantExpression("lorcana", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: constantExpression("Disney Lorcana", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      name: pathExpression("expansion.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      setId: pathExpression("expansion.id", "external-reference", ["normalized-observation", "hash-material"]),
      setCode: optionalPathExpression("expansion.code", "catalog-truth", ["normalized-observation", "hash-material"]),
      setName: pathExpression("expansion.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      expansionName: pathExpression("expansion.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      releaseDate: optionalPathExpression("expansion.release_date", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseYear: constantExpression(null, "catalog-truth", ["normalized-observation"]),
      cardCount: optionalNumberPathExpression("expansion.total", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      externalCatalogItemReferences: constantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      objectExpression(
        {
          id: pathExpression("expansion.id", "external-reference", ["hash-material"]),
          name: pathExpression("expansion.name", "catalog-truth", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      pathExpression("expansion.id", "external-reference", ["merge-identity"]),
      pathExpression("expansion.name", "catalog-merge-evidence", ["merge-identity"]),
    ],
  };
}

function scrydexLorcanaSealedNormalizedObservation(): CatalogProviderExecutableMappingContract["normalizedObservation"] {
  return {
    outputKind: "lorcana-sealed-product",
    languageCode: languageExpression(),
    fields: {
      tcg: constantExpression("lorcana", "catalog-truth", ["normalized-observation", "hash-material"]),
      productLineName: constantExpression("Disney Lorcana", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      name: pathExpression("sealedProduct.name", "catalog-truth", ["normalized-observation", "hash-material"]),
      setId: optionalPathExpression("sealedProduct.expansion.id", "external-reference", [
        "normalized-observation",
        "hash-material",
      ]),
      setCode: optionalPathExpression("sealedProduct.expansion.code", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      setName: optionalPathExpression("sealedProduct.expansion.name", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      expansionName: optionalPathExpression("sealedProduct.expansion.name", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      sealedProductForm: constantExpression("sealed-product", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseDate: optionalPathExpression("sealedProduct.expansion.release_date", "catalog-truth", [
        "normalized-observation",
        "hash-material",
      ]),
      releaseYear: constantExpression(null, "catalog-truth", ["normalized-observation"]),
      barcode: constantExpression(null, "external-reference", ["normalized-observation"]),
      imageUrls: imageUrlsExpression("sealedProduct.imageUrls"),
      mergeIdentity: mergeIdentityExpression({
        setNamePath: "sealedProduct.expansion.name",
        printedProductNamePath: "sealedProduct.name",
        collectorNumber: constantExpression(null, "catalog-merge-evidence", ["merge-identity"]),
        productForm: "sealed-product",
      }),
      externalCatalogItemReferences: constantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
      externalProductReferences: constantExpression([], "external-reference", [
        "normalized-observation",
        "external-reference",
      ]),
    },
    hashMaterial: [
      objectExpression(
        {
          id: pathExpression("sealedProduct.id", "external-reference", ["hash-material"]),
          name: pathExpression("sealedProduct.name", "catalog-truth", ["hash-material"]),
        },
        "catalog-truth",
        ["hash-material"],
      ),
    ],
    mergeIdentity: [
      pathExpression("sealedProduct.id", "external-reference", ["merge-identity"]),
      pathExpression("sealedProduct.name", "catalog-merge-evidence", ["merge-identity"]),
      optionalPathExpression("sealedProduct.expansion.id", "external-reference", ["merge-identity"]),
    ],
  };
}

function scrydexLorcanaCardDuplicatePrevention(): CatalogProviderExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: true,
    mergeCandidateEvidence: [
      pathExpression("card.id", "external-reference", ["merge-identity"]),
      pathExpression("card.expansion.id", "external-reference", ["merge-identity"]),
      pathExpression("card.name", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "exact-external-catalog-item-reference",
        ruleKind: "exact-external-catalog-item-reference",
        evidence: [externalCatalogItemReferencesExpression()],
        candidatePolicy: "reuse",
      },
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [pathExpression("card.id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
      {
        ruleKey: "lorcana-card-print-deterministic-fields",
        ruleKind: "deterministic-field-match",
        evidence: [pathExpression("card.id", "external-reference", ["merge-identity"])],
        candidatePolicy: "review-only",
      },
      {
        ruleKey: "future-provider-bridge-review",
        ruleKind: "future-provider-bridge-match",
        evidence: [externalCatalogItemReferencesExpression()],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function setDuplicatePrevention(): CatalogProviderExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: false,
    mergeCandidateEvidence: [
      pathExpression("expansion.id", "external-reference", ["merge-identity"]),
      pathExpression("expansion.name", "catalog-merge-evidence", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [pathExpression("expansion.id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function sealedDuplicatePrevention(): CatalogProviderExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: false,
    mergeCandidateEvidence: [
      pathExpression("sealedProduct.id", "external-reference", ["merge-identity"]),
      pathExpression("sealedProduct.name", "catalog-merge-evidence", ["merge-identity"]),
      optionalPathExpression("sealedProduct.expansion.id", "external-reference", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "source-observation-link",
        ruleKind: "source-observation-link",
        evidence: [pathExpression("sealedProduct.id", "external-reference", ["external-reference"])],
        candidatePolicy: "review-only",
      },
      {
        ruleKey: "sealed-product-deterministic-fields",
        ruleKind: "deterministic-field-match",
        evidence: [pathExpression("sealedProduct.name", "catalog-merge-evidence", ["merge-identity"])],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function reviewPromotionPlan(): CatalogProviderExecutableMappingContract["promotionCommandPlan"] {
  return { planKind: "catalog-item-promotion", requiresReview: true, commands: [] };
}

function referencePromotionPlan(): CatalogProviderExecutableMappingContract["promotionCommandPlan"] {
  return { planKind: "catalog-item-promotion", requiresReview: true, commands: [] };
}

function nonGoals(): CatalogProviderExecutableMappingContract["nonGoals"] {
  return [
    "no-live-provider-calls-in-mapping-tests",
    "no-pricing-facts-as-catalog-truth",
    "no-inventory-facts-as-global-catalog-truth",
    "no-provider-secrets-in-events-logs-or-fixtures",
    "no-provider-transport-branches-in-mapping-interpreter",
  ];
}

function languageExpression(): CatalogProviderMappingValueExpression {
  return coalesceExpression(
    [
      pathSelector("card.language_code", false),
      pathSelector("sealedProduct.language_code", false),
      pathSelector("expansion.language_code", false),
      pathSelector("card.language", false),
      pathSelector("sealedProduct.language", false),
      pathSelector("expansion.language", false),
      { kind: "constant", value: "en" },
    ],
    "catalog-truth",
    ["normalized-observation", "hash-material"],
  );
}

function imageUrlsExpression(path: string): CatalogProviderMappingValueExpression {
  return coalesceExpression([pathSelector(path, false), { kind: "constant", value: [] }], "catalog-truth", [
    "normalized-observation",
  ]);
}

function externalCatalogItemReferencesExpression(): CatalogProviderMappingValueExpression {
  return arrayExpression(
    [
      objectExpression(
        {
          providerKey: constantExpression("tcgplayer", "external-reference", ["external-reference"]),
          externalKey: templateExpression("product:{tcgplayerProductId}", {
            tcgplayerProductId: pathExpression("card.tcgplayer_id", "external-reference", ["external-reference"]),
          }),
        },
        "external-reference",
        ["external-reference"],
      ),
    ],
    "external-reference",
    ["normalized-observation", "external-reference"],
  );
}

function mergeIdentityExpression(input: {
  setNamePath: string;
  printedProductNamePath: string;
  collectorNumber: CatalogProviderMappingValueExpression;
  productForm: string;
}): CatalogProviderMappingValueExpression {
  return objectExpression(
    {
      tcg: constantExpression("lorcana", "catalog-merge-evidence", ["merge-identity"]),
      productLineName: constantExpression("Disney Lorcana", "catalog-merge-evidence", ["merge-identity"]),
      setName: optionalPathExpression(input.setNamePath, "catalog-merge-evidence", ["merge-identity"]),
      printedProductName: pathExpression(input.printedProductNamePath, "catalog-merge-evidence", ["merge-identity"]),
      collectorNumber: input.collectorNumber,
      languageCode: languageExpression(),
      productForm: constantExpression(input.productForm, "catalog-merge-evidence", ["merge-identity"]),
    },
    "catalog-merge-evidence",
    ["normalized-observation", "merge-identity"],
  );
}

function pathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return { selector: pathSelector(path, true), owner, uses, redaction: "none" };
}

function optionalPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return { selector: pathSelector(path, false), owner, uses, redaction: "none" };
}

function optionalNumberPathExpression(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return { ...optionalPathExpression(path, owner, uses), transforms: [{ kind: "coerce", to: "number" }] };
}

function pathSelector(path: string, required: boolean): CatalogProviderMappingValueExpression["selector"] {
  return { kind: "path", path, required, nullPolicy: required ? "diagnostic" : "omit" };
}

function coalesceExpression(
  selectors: readonly CatalogProviderMappingValueExpression["selector"][],
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return { selector: { kind: "coalesce", selectors, required: true }, owner, uses, redaction: "none" };
}

function templateExpression(
  template: string,
  values: Readonly<Record<string, CatalogProviderMappingValueExpression>>,
): CatalogProviderMappingValueExpression {
  return {
    selector: { kind: "template", template, values, required: true },
    owner: "external-reference",
    uses: ["external-reference"],
    redaction: "none",
  };
}

function objectExpression(
  fields: Readonly<Record<string, CatalogProviderMappingValueExpression>>,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return { selector: { kind: "object", fields }, owner, uses, redaction: "none" };
}

function arrayExpression(
  items: readonly CatalogProviderMappingValueExpression[],
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return { selector: { kind: "array", items }, owner, uses, redaction: "none" };
}

function constantExpression(
  value: JsonValue,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return { selector: { kind: "constant", value }, owner, uses, redaction: "none" };
}
