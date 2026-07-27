import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogProviderIntegrationProfile, CatalogProviderOptionQuery } from "../profile-types";

const lorcanajsonLorcanaSetOptionQuery = {
  queryKind: "sets",
  queryKeySynonyms: ["set"],
  displayName: "Set",
  scope: "set-name",
  parentScope: null,
  operation: "lorcanajson-list-sets",
  output: {
    valuePath: "setCode",
    labelPath: "name",
    description: { kind: "path", path: "releaseDate" },
    metadataPaths: {
      setId: "setId",
      setCode: "setCode",
      releaseDate: "releaseDate",
      prereleaseDate: "prereleaseDate",
      type: "type",
      setNumber: "setNumber",
      cardCount: "cardCount",
      formatVersion: "formatVersion",
      generatedOn: "generatedOn",
    },
  },
} as const satisfies CatalogProviderOptionQuery;

const lorcanajsonLorcanaCardOptionQuery = {
  queryKind: "cards",
  queryKeySynonyms: ["card"],
  displayName: "Card",
  scope: "product/card",
  parentScope: "set-name",
  operation: "lorcanajson-list-cards",
  parentValue: {
    required: true,
    valueKind: "set-code",
    diagnosticText: "LorcanaJSON card option queries require a selected set code.",
  },
  output: {
    valuePath: "cardId",
    labelPath: "name",
    parentValuePath: "setCode",
    imageUrlPath: "imageUrl",
    metadataPaths: {
      cardId: "cardId",
      setCode: "setCode",
      setName: "setName",
      cardNumber: "cardNumber",
      rarity: "rarity",
      cardType: "cardType",
      inkColor: "inkColor",
      tcgplayerProductId: "tcgplayerProductId",
    },
  },
} as const satisfies CatalogProviderOptionQuery;

const lorcanajsonLorcanaOptionQueries = [
  lorcanajsonLorcanaSetOptionQuery,
  lorcanajsonLorcanaCardOptionQuery,
] as const satisfies readonly CatalogProviderOptionQuery[];

export const lorcanajsonLorcanaCardReferenceProviderProfile = {
  providerKey: "lorcanajson",
  displayName: "LorcanaJSON",
  status: "active",
  capabilities: [
    "provider-option-query",
    "source-observation-import",
    "catalog-item-promotion",
    "external-reference-extraction",
  ],
  supportedScopes: ["set-name", "product/card"],
  languageOptions: ["en"],
  optionQueries: lorcanajsonLorcanaOptionQueries,
  connector: {
    kind: "lorcanajson-json",
    baseUrl: "https://lorcanajson.org/files/current/en",
    sourceContractDocument: "bounded-contexts/catalog/docs/catalog-integration-production-signoff.md#lorcana",
    authentication: {
      scheme: "public-json",
      credentialsRequired: false,
    },
    bulkPolicy: {
      freshnessDocument: "metadata.json",
      optionDiscoveryDocument: "allCards.json",
      selectedSetDocumentPattern: "sets/setdata.{setCode}.json",
      normalImportStrategy: "bulk-first",
    },
    acceptedEvidence: [
      "lorcanajson-card-id",
      "set-code",
      "set-name",
      "collector-number",
      "rarity",
      "ink-color",
      "card-type",
      "image-url",
      "tcgplayer-id",
      "release-date",
      "card-count",
    ],
    excludedEvidence: ["price", "seller", "inventory", "ruling", "legality", "unapproved-scrape"],
  },
  normalizedObservationMapping: {
    kind: "lorcana-card-print",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified LorcanaJSON Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: {
    blueprintKey: "lorcana-card-print",
    categoryKey: "lorcana-card-prints",
    fieldKeys: {
      cardNumber: "card-number",
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
    providerReferenceIdPrefix: "ref_lorcanajson_lorcana",
    providerAttributes: [
      { typeKey: "product-line", providerAttributeKey: "lorcanajson-product-line" },
      { typeKey: "set", providerAttributeKey: "lorcanajson-set-code" },
      { typeKey: "set", providerAttributeKey: "lorcanajson-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "lorcanajson-product-line"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A Disney Lorcana release group.",
        attributeKeys: ["lorcanajson-set-code", "lorcanajson-set-name"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "lorcana-product-line",
        typeKey: "product-line",
        recordId: { kind: "static", referenceRecordId: "ref_lorcanajson_lorcana_product_line" },
        key: { kind: "static", value: "disney-lorcana" },
        name: { kind: "static", value: "Disney Lorcana" },
        description: { kind: "static", value: "Disney Lorcana trading card game." },
        attributes: [
          { attributeKey: "official-name", value: { kind: "static", value: "Disney Lorcana" } },
          { attributeKey: "short-name", value: { kind: "static", value: "Lorcana" } },
          { attributeKey: "lorcanajson-product-line", value: { kind: "static", value: "lorcana" } },
        ],
      },
      {
        ruleKey: "set",
        typeKey: "set",
        recordId: { kind: "provider", typeKey: "set", providerValuePaths: ["setCode", "setName"] },
        key: { kind: "path", path: "setCode" },
        name: { kind: "path", path: "setName" },
        description: {
          kind: "template",
          template: "{setName} Disney Lorcana set.",
          values: { setName: { kind: "path", path: "setName" } },
        },
        requiredPaths: ["setCode", "setName"],
        attributes: [
          { attributeKey: "lorcanajson-set-code", value: { kind: "path", path: "setCode" } },
          { attributeKey: "lorcanajson-set-name", value: { kind: "path", path: "setName" } },
        ],
        relationships: [{ relationshipType: "part-of", ruleKey: "lorcana-product-line" }],
      },
    ],
  },
  externalReferenceExtractionRules: {
    referenceTarget: "catalog-item-reference",
    rules: [
      {
        providerKey: "tcgplayer",
        target: "catalog-item-reference",
        externalKeyPrefix: "product:",
        containerKeys: [],
        valueKeys: ["tcgplayerProductId"],
        recordIdKeys: ["tcgplayerProductId"],
        pricingRootKeys: [],
        pricingScope: "card",
      },
    ],
  },
  duplicatePreventionMapping: {
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
    rules: [
      {
        ruleKey: "exact-tcgplayer-bridge-reference",
        matchKind: "exact-external-catalog-item-reference",
        sourcePath: "externalCatalogItemReferences",
      },
      {
        ruleKey: "source-observation-link",
        matchKind: "source-observation-link",
        providerKeySource: "observation-provider",
        externalKey: "language-prefixed-observation-external-key",
      },
      {
        ruleKey: "future-provider-bridge-review",
        matchKind: "future-provider-bridge-match",
        bridgeReferenceProviderKeys: ["lorcast", "scrydex", "tcgplayer"],
        candidatePolicy: "review-only",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const lorcanajsonLorcanaSetReferenceProviderProfile = {
  ...lorcanajsonLorcanaCardReferenceProviderProfile,
  displayName: "LorcanaJSON Set Reference",
  capabilities: ["provider-option-query", "source-observation-import", "reference-data-promotion"],
  supportedScopes: ["set-name"],
  optionQueries: [lorcanajsonLorcanaSetOptionQuery],
  normalizedObservationMapping: {
    ...lorcanajsonLorcanaCardReferenceProviderProfile.normalizedObservationMapping,
    kind: "lorcana-set-reference",
    unknownVariantLabelPrefix: "Unclassified LorcanaJSON Set Variant",
  },
  catalogFieldMapping: {
    blueprintKey: "lorcana-set-reference",
    categoryKey: "lorcana-sets",
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
  externalReferenceExtractionRules: {
    referenceTarget: "catalog-item-reference",
    rules: [],
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
} as const satisfies CatalogProviderIntegrationProfile;
