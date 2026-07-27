import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogProviderIntegrationProfile, CatalogProviderOptionQuery } from "../profile-types";
import {
  lorcanajsonLorcanaCardReferenceProviderProfile,
  lorcanajsonLorcanaSetReferenceProviderProfile,
} from "../lorcanajson/profiles";

const lorcastLorcanaSetOptionQuery = {
  queryKind: "sets",
  queryKeySynonyms: ["set"],
  displayName: "Set",
  scope: "set-name",
  parentScope: null,
  operation: "lorcast-list-sets",
  output: {
    valuePath: "setCode",
    labelPath: "name",
    description: { kind: "path", path: "releaseDate" },
    metadataPaths: {
      setId: "setId",
      setCode: "setCode",
      releaseDate: "releaseDate",
      prereleaseDate: "prereleaseDate",
      cacheGuidance: "cacheGuidance",
    },
  },
} as const satisfies CatalogProviderOptionQuery;

const lorcastLorcanaCardOptionQuery = {
  queryKind: "cards",
  queryKeySynonyms: ["card"],
  displayName: "Card",
  scope: "product/card",
  parentScope: "set-name",
  operation: "lorcast-list-cards",
  parentValue: {
    required: true,
    valueKind: "set-code",
    diagnosticText: "Lorcast card option queries require a selected set code.",
  },
  output: {
    valuePath: "cardId",
    labelPath: "name",
    parentValuePath: "setCode",
    imageUrlPath: "imageUrl",
    metadataPaths: {
      cardId: "cardId",
      setId: "setId",
      setCode: "setCode",
      setName: "setName",
      cardNumber: "cardNumber",
      rarity: "rarity",
      cardType: "cardType",
      inkColor: "inkColor",
      tcgplayerProductId: "tcgplayerProductId",
      releaseDate: "releaseDate",
    },
  },
} as const satisfies CatalogProviderOptionQuery;

const lorcastLorcanaOptionQueries = [
  lorcastLorcanaSetOptionQuery,
  lorcastLorcanaCardOptionQuery,
] as const satisfies readonly CatalogProviderOptionQuery[];

export const lorcastLorcanaCardReferenceProviderProfile = {
  providerKey: "lorcast",
  displayName: "Lorcast",
  status: "active",
  capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
  supportedScopes: ["set-name", "product/card"],
  languageOptions: ["en"],
  optionQueries: lorcastLorcanaOptionQueries,
  connector: {
    kind: "lorcast-json",
    baseUrl: "https://api.lorcast.com/v0",
    sourceContractDocument: "https://lorcast.com/docs/api",
    authentication: {
      scheme: "public-api",
      credentialsRequired: false,
    },
    requestPolicy: {
      normalImportStrategy: "bulk-set-scoped",
      optionDiscoveryEndpoint: "/sets",
      selectedSetCardsEndpoint: "/sets/{setCode}/cards",
      selectedSetEndpoint: "/sets/{setCode}",
      cacheProviderDataForAtLeastHours: 24,
      recommendedDelayMilliseconds: "50-100",
    },
    acceptedEvidence: [
      "lorcast-card-id",
      "lorcast-set-id",
      "set-code",
      "set-name",
      "collector-number",
      "rarity",
      "ink-color",
      "card-type",
      "image-url",
      "tcgplayer-id",
      "release-date",
    ],
    excludedEvidence: ["price", "seller", "inventory", "ruling", "legality"],
  },
  normalizedObservationMapping: {
    kind: "lorcana-card-print",
    variantRules: [],
    unknownVariantLabelPrefix: "Unclassified Lorcast Variant",
    duplicateReferenceRule: "drop-repeated-across-variants",
  },
  catalogFieldMapping: lorcanajsonLorcanaCardReferenceProviderProfile.catalogFieldMapping,
  referenceHierarchyMapping: {
    providerReferenceIdPrefix: "ref_lorcast_lorcana",
    providerAttributes: [
      { typeKey: "product-line", providerAttributeKey: "lorcast-product-line" },
      { typeKey: "set", providerAttributeKey: "lorcast-set-code" },
      { typeKey: "set", providerAttributeKey: "lorcast-set-name" },
    ],
    targetRecordRuleKey: "set",
    referenceTypes: [
      {
        referenceTypeId: catalogSeedIds.referenceTypes.productLine,
        typeKey: "product-line",
        name: "Product Line",
        descriptionText: "A branded collectible product line.",
        attributeKeys: ["official-name", "short-name", "lorcast-product-line"],
      },
      {
        referenceTypeId: catalogSeedIds.referenceTypes.set,
        typeKey: "set",
        name: "Set",
        descriptionText: "A Disney Lorcana release group.",
        attributeKeys: ["lorcast-set-code", "lorcast-set-name"],
      },
    ],
    referenceRecords: [
      {
        ruleKey: "lorcana-product-line",
        typeKey: "product-line",
        recordId: { kind: "static", referenceRecordId: "ref_lorcast_lorcana_product_line" },
        key: { kind: "static", value: "disney-lorcana" },
        name: { kind: "static", value: "Disney Lorcana" },
        description: { kind: "static", value: "Disney Lorcana trading card game." },
        attributes: [
          { attributeKey: "official-name", value: { kind: "static", value: "Disney Lorcana" } },
          { attributeKey: "short-name", value: { kind: "static", value: "Lorcana" } },
          { attributeKey: "lorcast-product-line", value: { kind: "static", value: "lorcana" } },
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
          { attributeKey: "lorcast-set-code", value: { kind: "path", path: "setCode" } },
          { attributeKey: "lorcast-set-name", value: { kind: "path", path: "setName" } },
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
        bridgeReferenceProviderKeys: ["lorcanajson", "scrydex", "tcgplayer"],
        candidatePolicy: "review-only",
      },
    ],
  },
  ambiguityRules: {
    repeatedMarketplaceReference: "skip-reference",
    missingVariantSpecificReference: "leave-unmapped",
  },
} as const satisfies CatalogProviderIntegrationProfile;

export const lorcastLorcanaSetReferenceProviderProfile = {
  ...lorcastLorcanaCardReferenceProviderProfile,
  displayName: "Lorcast Set Reference",
  capabilities: ["provider-option-query", "source-observation-import", "reference-data-promotion"],
  supportedScopes: ["set-name"],
  optionQueries: [lorcastLorcanaSetOptionQuery],
  normalizedObservationMapping: {
    ...lorcastLorcanaCardReferenceProviderProfile.normalizedObservationMapping,
    kind: "lorcana-set-reference",
    unknownVariantLabelPrefix: "Unclassified Lorcast Set Variant",
  },
  catalogFieldMapping: lorcanajsonLorcanaSetReferenceProviderProfile.catalogFieldMapping,
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
