import { describe, expect, it } from "vitest";
import {
  catalogProviderRequiredFixtureFlows,
  defineCatalogProviderIngestionUnitIdentityContract,
  validateCatalogProviderExecutableMappingContract,
  type CatalogProviderAliasCandidateContract,
  type CatalogProviderExecutableMappingContract,
  type CatalogProviderIngestionPurpose,
  type CatalogProviderIngestionUnitIdentityContract,
  type CatalogProviderIngestionUnitProductForm,
  type CatalogProviderMappingEvidenceOwner,
  type CatalogProviderMappingEvidenceUse,
  type CatalogProviderMappingRuntimeFunctionKey,
  type CatalogProviderMappingValueExpression,
} from "./provider-integration-mapping-contract";

describe("provider integration executable mapping contract", () => {
  it("represents the existing TCGdex Pokemon mapping without live provider calls", () => {
    const contract = tcgdexContract();

    expect(validateCatalogProviderExecutableMappingContract(contract)).toEqual([]);
    expect(contract.connector).toMatchObject({
      kind: "tcgdex-json",
      transportOwns: ["domains", "endpoint-paths", "raw-provider-parse"],
    });
    expect(contract.normalizedObservation.outputKind).toBe("pokemon-card");
    expect(contract.externalReferences).toContainEqual(
      expect.objectContaining({
        target: "catalog-item-reference",
        providerKey: "tcgplayer",
        externalKeyPrefix: "product:",
      }),
    );
    expect(contract.nonGoals).toContain("no-pricing-facts-as-catalog-truth");
  });

  it("represents TCGplayer automation Product IDs and SKU evidence without importing price or seller truth", () => {
    const contract = tcgplayerContract();

    expect(validateCatalogProviderExecutableMappingContract(contract)).toEqual([]);
    expect(contract.sourceContract).toMatchObject({
      repository: "todd-skelton/tcgplayer-automation-app",
      commit: "bf42aa8",
    });
    expect(contract.externalReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "catalog-item-reference",
          providerKey: "tcgplayer",
          externalKeyPrefix: "product:",
        }),
        expect.objectContaining({
          target: "product-reference",
          providerKey: "tcgplayer",
          externalKeyPrefix: "sku:",
        }),
      ]),
    );
    expect(contract.normalizedObservation.hashMaterial.map((expression) => expression.owner)).not.toEqual(
      expect.arrayContaining(["pricing-signal", "inventory-signal"]),
    );
  });

  it("represents Scrydex/Scryfall-style Magic card-print evidence as duplicate-prevention data", () => {
    const contract = scrydexContract();

    expect(validateCatalogProviderExecutableMappingContract(contract)).toEqual([]);
    expect(contract.providerKey).toBe("scrydex");
    expect(contract.normalizedObservation.outputKind).toBe("magic-card-print");
    expect(contract.externalReferences).toContainEqual(
      expect.objectContaining({
        target: "catalog-item-reference",
        providerKey: "tcgplayer",
        externalKeyPrefix: "product:",
      }),
    );
    expect(contract.duplicatePrevention.exactExternalCatalogItemReferencesFirst).toBe(true);
    expect(contract.promotionCommandPlan.requiresReview).toBe(true);
  });

  it("represents Magic ingestion-unit identities as contract data without provider runtime branches", () => {
    const identities = [
      ingestionUnit("mtgjson", "set", "reference-data"),
      ingestionUnit("mtgjson", "single-card", "reference-data"),
      ingestionUnit("scryfall", "single-card", "image-evidence"),
      ingestionUnit("scryfall", "single-card", "source-observation-import"),
      ingestionUnit("tcgplayer", "single-card", "source-observation-import"),
      ingestionUnit("tcgplayer", "sealed-product", "source-observation-import"),
    ];

    expect(identities.map((identity) => identity.unitKey)).toEqual([
      "mtgjson:mtg:set:reference-data",
      "mtgjson:mtg:single-card:reference-data",
      "scryfall:mtg:single-card:image-evidence",
      "scryfall:mtg:single-card:source-observation-import",
      "tcgplayer:mtg:single-card:source-observation-import",
      "tcgplayer:mtg:sealed-product:source-observation-import",
    ]);

    for (const identity of identities) {
      expect(validateCatalogProviderExecutableMappingContract(identityOnlyContract(identity))).toEqual([]);
    }
  });

  it("represents Yu-Gi-Oh ingestion-unit identities without product-line-specific importer branches", () => {
    const identities = [
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "ygoprodeck",
        productDomain: "yugioh",
        productForm: "single-card",
        ingestionPurpose: "reference-data",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "ygojson",
        productDomain: "yugioh",
        productForm: "set",
        ingestionPurpose: "reference-data",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "ygojson",
        productDomain: "yugioh",
        productForm: "pack",
        ingestionPurpose: "reference-data",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "tcgplayer",
        productDomain: "yugioh",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
      }),
    ];

    expect(identities.map((identity) => identity.unitKey)).toEqual([
      "ygoprodeck:yugioh:single-card:reference-data",
      "ygojson:yugioh:set:reference-data",
      "ygojson:yugioh:pack:reference-data",
      "tcgplayer:yugioh:single-card:source-observation-import",
    ]);

    for (const identity of identities) {
      expect(validateCatalogProviderExecutableMappingContract(identityOnlyContract(identity))).toEqual([]);
    }
  });

  it("represents One Piece ingestion-unit identities without product-line-specific importer branches", () => {
    const identities = [
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "scrydex",
        productDomain: "one-piece",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "scrydex",
        productDomain: "one-piece",
        productForm: "set",
        ingestionPurpose: "reference-data",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "scrydex",
        productDomain: "one-piece",
        productForm: "sealed-product",
        ingestionPurpose: "source-observation-import",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "tcgplayer",
        productDomain: "one-piece",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "tcgplayer",
        productDomain: "one-piece",
        productForm: "sealed-product",
        ingestionPurpose: "source-observation-import",
      }),
    ];

    expect(identities.map((identity) => identity.unitKey)).toEqual([
      "scrydex:one-piece:single-card:source-observation-import",
      "scrydex:one-piece:set:reference-data",
      "scrydex:one-piece:sealed-product:source-observation-import",
      "tcgplayer:one-piece:single-card:source-observation-import",
      "tcgplayer:one-piece:sealed-product:source-observation-import",
    ]);

    for (const identity of identities) {
      expect(validateCatalogProviderExecutableMappingContract(identityOnlyContract(identity))).toEqual([]);
    }
  });

  it("represents Lorcana ingestion-unit identities without product-line-specific importer branches", () => {
    const identities = [
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "lorcanajson",
        productDomain: "lorcana",
        productForm: "single-card",
        ingestionPurpose: "reference-data",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "lorcanajson",
        productDomain: "lorcana",
        productForm: "set",
        ingestionPurpose: "reference-data",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "lorcast",
        productDomain: "lorcana",
        productForm: "single-card",
        ingestionPurpose: "reference-data",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "lorcast",
        productDomain: "lorcana",
        productForm: "set",
        ingestionPurpose: "reference-data",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "scrydex",
        productDomain: "lorcana",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "tcgplayer",
        productDomain: "lorcana",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
      }),
      defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "tcgplayer",
        productDomain: "lorcana",
        productForm: "sealed-product",
        ingestionPurpose: "source-observation-import",
      }),
    ];

    expect(identities.map((identity) => identity.unitKey)).toEqual([
      "lorcanajson:lorcana:single-card:reference-data",
      "lorcanajson:lorcana:set:reference-data",
      "lorcast:lorcana:single-card:reference-data",
      "lorcast:lorcana:set:reference-data",
      "scrydex:lorcana:single-card:source-observation-import",
      "tcgplayer:lorcana:single-card:source-observation-import",
      "tcgplayer:lorcana:sealed-product:source-observation-import",
    ]);

    for (const identity of identities) {
      expect(validateCatalogProviderExecutableMappingContract(identityOnlyContract(identity))).toEqual([]);
    }
  });

  it("flags missing fixture coverage and unsafe cross-context leakage", () => {
    const invalidContract: CatalogProviderExecutableMappingContract = {
      ...tcgplayerContract(),
      profileVersion: "",
      fixtures: {
        fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/fixtures/tcgplayer",
        coveredFlows: ["normal"],
        liveProviderCallsAllowed: false,
      },
      normalizedObservation: {
        ...tcgplayerContract().normalizedObservation,
        hashMaterial: [
          expr("marketPrice", "pricing-signal", ["hash-material"], {
            redaction: "price",
          }),
          expr("auth.cookie", "catalog-truth", ["normalized-observation"], {
            redaction: "secret",
          }),
        ],
      },
    };

    expect(validateCatalogProviderExecutableMappingContract(invalidContract)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-profile-version", path: "profileVersion" }),
        expect.objectContaining({ code: "missing-fixture-flow", diagnosticText: expect.stringContaining("partial") }),
        expect.objectContaining({ code: "unsafe-owner-for-catalog-use" }),
        expect.objectContaining({ code: "secret-used-as-catalog-fact" }),
      ]),
    );
  });

  it("flags ingestion-unit contract identities that do not match their key or provider", () => {
    const contract: CatalogProviderExecutableMappingContract = {
      ...identityOnlyContract(ingestionUnit("mtgjson", "single-card", "reference-data")),
      providerKey: "scryfall",
      ingestionUnitIdentity: {
        ...ingestionUnit("mtgjson", "single-card", "reference-data"),
        unitKey: "mtgjson:mtg:set:reference-data",
      },
    };

    expect(validateCatalogProviderExecutableMappingContract(contract)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ingestion-unit-provider-mismatch" }),
        expect.objectContaining({ code: "ingestion-unit-key-mismatch" }),
      ]),
    );
  });

  it("keeps existing profiles without alias candidate support valid", () => {
    const contract = tcgdexContract();

    expect(contract.aliasCandidates).toBeUndefined();
    expect(validateCatalogProviderExecutableMappingContract(contract)).toEqual([]);
  });

  it("accepts a governed official-equivalent alias candidate extraction without provider runtime branches", () => {
    const contract: CatalogProviderExecutableMappingContract = {
      ...tcgdexContract(),
      aliasCandidates: [
        // Positive extraction: an English official equivalent resolved from a
        // governed same-id localized endpoint, supported by the shared record id.
        aliasCandidate({
          aliasCandidateKey: "english-official-equivalent",
          target: { kind: "catalog-item", catalogItemFieldKey: "card-name" },
          aliasType: "official-equivalent",
          aliasText: aliasExpr("name"),
          aliasLanguage: { kind: "static", languageCode: "en" },
          sourceLanguage: { kind: "path", path: "language", required: true },
          confidencePolicy: {
            sourceCategory: "provider-same-id-localized-endpoint",
            reviewPolicy: "always-review",
          },
          evidence: aliasExpr("id"),
          missingEvidencePolicy: "diagnostic",
          unknownAliasTextPolicy: "omit",
        }),
        // Lookup / missing-evidence review path: a provider-localized name held
        // for review, surfaced as review evidence when no backing id is present.
        aliasCandidate({
          aliasCandidateKey: "provider-localized-name",
          target: { kind: "catalog-item", catalogItemFieldKey: "card-name" },
          aliasType: "provider-localized-name",
          aliasText: aliasExpr("name"),
          aliasLanguage: { kind: "path", path: "language", required: true },
          confidencePolicy: { sourceCategory: "provider-localized-name", reviewPolicy: "always-review" },
          evidence: aliasExpr("id"),
          missingEvidencePolicy: "review-evidence",
          unknownAliasTextPolicy: "omit",
        }),
        // Reference-record alias: a set-equivalent from a curated mapping that
        // is eligible for governed auto-accept.
        aliasCandidate({
          aliasCandidateKey: "japanese-set-equivalent",
          target: { kind: "reference-record", referenceTypeKey: "expansion" },
          aliasType: "set-equivalent",
          aliasText: aliasExpr("set.name"),
          aliasLanguage: { kind: "static", languageCode: "ja" },
          confidencePolicy: { sourceCategory: "curated-operator-mapping", reviewPolicy: "governed-auto-accept" },
          evidence: aliasExpr("set.id"),
          missingEvidencePolicy: "diagnostic",
          unknownAliasTextPolicy: "diagnostic",
        }),
      ],
    };

    expect(validateCatalogProviderExecutableMappingContract(contract)).toEqual([]);
  });

  it("flags missing alias text, invalid type, invalid language, invalid target, and unsupported confidence policy", () => {
    const contract: CatalogProviderExecutableMappingContract = {
      ...tcgdexContract(),
      aliasCandidates: [
        // Missing alias text (empty path).
        aliasCandidate({
          aliasCandidateKey: "missing-text",
          target: { kind: "catalog-item", catalogItemFieldKey: "card-name" },
          aliasType: "literal-translation",
          aliasText: aliasExpr(""),
          aliasLanguage: { kind: "static", languageCode: "fr" },
          confidencePolicy: { sourceCategory: "machine-translation", reviewPolicy: "always-review" },
          evidence: aliasExpr("id"),
          missingEvidencePolicy: "review-evidence",
          unknownAliasTextPolicy: "omit",
        }),
        // Invalid alias type.
        aliasCandidate({
          aliasCandidateKey: "invalid-type",
          target: { kind: "catalog-item", catalogItemFieldKey: "card-name" },
          aliasType: "not-a-real-type" as CatalogProviderAliasCandidateContract["aliasType"],
          aliasText: aliasExpr("name"),
          aliasLanguage: { kind: "static", languageCode: "fr" },
          confidencePolicy: { sourceCategory: "machine-translation", reviewPolicy: "always-review" },
          evidence: aliasExpr("id"),
          missingEvidencePolicy: "review-evidence",
          unknownAliasTextPolicy: "omit",
        }),
        // Invalid language: Indonesian `id` used as an English official equivalent.
        aliasCandidate({
          aliasCandidateKey: "indonesian-as-english",
          target: { kind: "catalog-item", catalogItemFieldKey: "card-name" },
          aliasType: "official-equivalent",
          aliasText: aliasExpr("name"),
          aliasLanguage: { kind: "static", languageCode: "id" },
          confidencePolicy: { sourceCategory: "official-english-source", reviewPolicy: "governed-auto-accept" },
          evidence: aliasExpr("id"),
          missingEvidencePolicy: "diagnostic",
          unknownAliasTextPolicy: "omit",
        }),
        // Invalid target: a set-equivalent (reference-level) pointed at a Catalog Item.
        aliasCandidate({
          aliasCandidateKey: "set-equivalent-on-item",
          target: { kind: "catalog-item", catalogItemFieldKey: "card-name" },
          aliasType: "set-equivalent",
          aliasText: aliasExpr("set.name"),
          aliasLanguage: { kind: "static", languageCode: "ja" },
          confidencePolicy: { sourceCategory: "curated-operator-mapping", reviewPolicy: "governed-auto-accept" },
          evidence: aliasExpr("set.id"),
          missingEvidencePolicy: "diagnostic",
          unknownAliasTextPolicy: "diagnostic",
        }),
        // Unsupported confidence policy: machine translation can never auto-accept.
        aliasCandidate({
          aliasCandidateKey: "machine-auto-accept",
          target: { kind: "catalog-item", catalogItemFieldKey: "card-name" },
          aliasType: "generated-translation",
          aliasText: aliasExpr("name"),
          aliasLanguage: { kind: "static", languageCode: "fr" },
          confidencePolicy: { sourceCategory: "machine-translation", reviewPolicy: "governed-auto-accept" },
          evidence: aliasExpr("id"),
          missingEvidencePolicy: "review-evidence",
          unknownAliasTextPolicy: "omit",
        }),
      ],
    };

    const diagnostics = validateCatalogProviderExecutableMappingContract(contract);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "alias-candidate-missing-text", path: "aliasCandidates.0.aliasText" }),
        expect.objectContaining({ code: "alias-candidate-invalid-type", path: "aliasCandidates.1.aliasType" }),
        expect.objectContaining({
          code: "alias-candidate-invalid-language",
          path: "aliasCandidates.2.aliasLanguage.languageCode",
        }),
        expect.objectContaining({ code: "alias-candidate-invalid-target", path: "aliasCandidates.3.target" }),
        expect.objectContaining({
          code: "alias-candidate-unsupported-confidence-policy",
          path: "aliasCandidates.4.confidencePolicy.reviewPolicy",
        }),
      ]),
    );
  });
});

function tcgdexContract(): CatalogProviderExecutableMappingContract {
  return {
    providerKey: "tcgdex",
    profileKey: "tcgdex-pokemon-tcg",
    displayName: "TCGdex Pokemon TCG",
    profileVersion: "2026.06.02",
    lifecycle: "active",
    sourceContract: {
      owner: "Catalog",
      repository: null,
      commit: null,
      documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
      fixtureSetVersion: "tcgdex-pokemon-v1",
    },
    connector: {
      kind: "tcgdex-json",
      transportOwns: ["domains", "endpoint-paths", "raw-provider-parse"],
      mappingOwns: [
        "normalized-observation",
        "hash-material",
        "merge-identity",
        "external-reference",
        "reference-hierarchy",
        "promotion-command",
      ],
    },
    fixtures: fixtureContract("tcgdex"),
    normalizedObservation: {
      outputKind: "pokemon-card",
      languageCode: expr("language", "catalog-truth", ["normalized-observation", "hash-material"]),
      fields: {
        cardName: expr("name", "catalog-truth", ["normalized-observation", "hash-material", "promotion-command"]),
        cardNumber: expr("localId", "catalog-truth", ["normalized-observation", "hash-material", "merge-identity"]),
        expansionId: expr("set.id", "external-reference", ["normalized-observation", "reference-hierarchy"]),
        variant: namedExpr("tcgdex-card-variant-expander", "catalog-truth", [
          "normalized-observation",
          "hash-material",
          "merge-identity",
        ]),
      },
      hashMaterial: [
        expr("id", "external-reference", ["hash-material"]),
        expr("name", "catalog-truth", ["hash-material"]),
        expr("localId", "catalog-truth", ["hash-material"]),
      ],
      mergeIdentity: [
        expr("set.id", "external-reference", ["merge-identity"]),
        expr("localId", "catalog-truth", ["merge-identity"]),
        expr("name", "catalog-truth", ["merge-identity"]),
      ],
    },
    externalReferences: [
      {
        target: "catalog-item-reference",
        providerKey: "tcgplayer",
        externalKeyPrefix: "product:",
        source: namedExpr("tcgdex-marketplace-reference-extractor", "external-reference", ["external-reference"]),
        ambiguityPolicy: "skip-reference",
      },
    ],
    referenceHierarchy: [
      {
        targetTypeKey: "expansion",
        providerAttributeKey: "tcgdex-set-id",
        referenceRecordKey: expr("set.id", "external-reference", ["reference-hierarchy"]),
        parent: {
          targetTypeKey: "series",
          providerAttributeKey: "tcgdex-series-id",
          referenceRecordKey: expr("set.series.id", "external-reference", ["reference-hierarchy"]),
        },
      },
    ],
    duplicatePrevention: duplicatePrevention(),
    promotionCommandPlan: pokemonPromotionPlan(),
    nonGoals: nonGoals(),
  };
}

function tcgplayerContract(): CatalogProviderExecutableMappingContract {
  return {
    providerKey: "tcgplayer",
    profileKey: "tcgplayer-automation-pokemon",
    displayName: "TCGplayer Automation Pokemon",
    profileVersion: "2026.06.02",
    lifecycle: "test",
    sourceContract: {
      owner: "Catalog",
      repository: "todd-skelton/tcgplayer-automation-app",
      commit: "bf42aa8",
      documentPath: "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
      fixtureSetVersion: "tcgplayer-automation-v1",
    },
    connector: {
      kind: "tcgplayer-automation-client",
      transportOwns: ["auth", "domains", "endpoint-paths", "pagination", "throttling", "raw-provider-parse"],
      mappingOwns: [
        "normalized-observation",
        "hash-material",
        "merge-identity",
        "external-reference",
        "selected-option",
        "reference-hierarchy",
        "promotion-command",
      ],
    },
    fixtures: fixtureContract("tcgplayer"),
    normalizedObservation: {
      outputKind: "provider-product",
      languageCode: constantExpr("en", "catalog-truth", ["normalized-observation", "hash-material"]),
      fields: {
        providerProductId: expr("productId", "external-reference", ["normalized-observation", "hash-material"]),
        productName: expr("productName", "catalog-truth", ["normalized-observation", "hash-material"]),
        setName: expr("setName", "catalog-truth", ["normalized-observation", "hash-material", "merge-identity"]),
        collectorNumber: expr("customAttributes.number", "catalog-truth", ["normalized-observation", "merge-identity"]),
      },
      hashMaterial: [
        expr("productId", "external-reference", ["hash-material"]),
        expr("productName", "catalog-truth", ["hash-material"]),
        expr("setName", "catalog-truth", ["hash-material"]),
        expr("skus", "catalog-merge-evidence", ["hash-material"]),
      ],
      mergeIdentity: [
        expr("productLineName", "catalog-merge-evidence", ["merge-identity"]),
        expr("setName", "catalog-truth", ["merge-identity"]),
        expr("productName", "catalog-truth", ["merge-identity"]),
        expr("customAttributes.number", "catalog-truth", ["merge-identity"]),
      ],
    },
    externalReferences: [
      {
        target: "catalog-item-reference",
        providerKey: "tcgplayer",
        externalKeyPrefix: "product:",
        source: expr("productId", "external-reference", ["external-reference"]),
        ambiguityPolicy: "diagnostic",
      },
      {
        target: "product-reference",
        providerKey: "tcgplayer",
        externalKeyPrefix: "sku:",
        source: expr("skus.sku", "external-reference", ["external-reference"]),
        selectedOptions: {
          missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
          dimensions: [
            optionDimension("condition", "skus.condition"),
            optionDimension("printing", "skus.variant"),
            optionDimension("language", "skus.language"),
            optionDimension("product-form", "sealed"),
          ],
        },
        ambiguityPolicy: "review-evidence",
      },
    ],
    referenceHierarchy: [
      {
        targetTypeKey: "expansion",
        providerAttributeKey: "tcgplayer-set-name",
        referenceRecordKey: expr("setName", "catalog-truth", ["reference-hierarchy"]),
      },
    ],
    duplicatePrevention: duplicatePrevention(),
    promotionCommandPlan: pokemonPromotionPlan(),
    nonGoals: nonGoals(),
  };
}

function scrydexContract(): CatalogProviderExecutableMappingContract {
  return {
    ...tcgplayerContract(),
    providerKey: "scrydex",
    profileKey: "scrydex-pokemon-proof",
    displayName: "Scrydex Pokemon Proof",
    lifecycle: "draft",
    sourceContract: {
      owner: "Catalog",
      repository: null,
      commit: null,
      documentPath: "bounded-contexts/catalog/docs/provider-integration-mapping-contract.md",
      fixtureSetVersion: "scrydex-proof-v1",
    },
    connector: {
      kind: "scrydex-json",
      transportOwns: ["domains", "endpoint-paths", "raw-provider-parse"],
      mappingOwns: [
        "normalized-observation",
        "hash-material",
        "merge-identity",
        "external-reference",
        "promotion-command",
      ],
    },
    normalizedObservation: {
      ...tcgplayerContract().normalizedObservation,
      outputKind: "magic-card-print",
      fields: {
        tcg: constantExpr("magic", "catalog-truth", ["normalized-observation"]),
        name: expr("name", "catalog-truth", ["normalized-observation", "hash-material"]),
        setCode: expr("set.code", "catalog-truth", ["normalized-observation", "hash-material", "merge-identity"]),
        setName: expr("set.name", "catalog-truth", ["normalized-observation", "hash-material", "merge-identity"]),
        cardNumber: expr("collector_number", "catalog-truth", [
          "normalized-observation",
          "hash-material",
          "merge-identity",
        ]),
        tcgplayerId: expr("tcgplayer_id", "external-reference", ["external-reference", "merge-identity"]),
      },
      hashMaterial: [
        expr("id", "external-reference", ["hash-material"]),
        expr("name", "catalog-truth", ["hash-material"]),
        expr("set.name", "catalog-truth", ["hash-material"]),
        expr("tcgplayer_id", "external-reference", ["hash-material"]),
      ],
      mergeIdentity: [
        expr("set.name", "catalog-truth", ["merge-identity"]),
        expr("collector_number", "catalog-truth", ["merge-identity"]),
        expr("name", "catalog-truth", ["merge-identity"]),
        expr("tcgplayer_id", "external-reference", ["merge-identity"]),
      ],
    },
    externalReferences: [
      {
        target: "catalog-item-reference",
        providerKey: "tcgplayer",
        externalKeyPrefix: "product:",
        source: expr("tcgplayer_id", "external-reference", ["external-reference"]),
        ambiguityPolicy: "diagnostic",
      },
    ],
  };
}

function fixtureContract(providerKey: string): CatalogProviderExecutableMappingContract["fixtures"] {
  return {
    fixtureRoot: `bounded-contexts/catalog/features/source-observations/api/fixtures/${providerKey}`,
    coveredFlows: catalogProviderRequiredFixtureFlows,
    liveProviderCallsAllowed: false,
  };
}

function ingestionUnit(
  providerKey: string,
  productForm: CatalogProviderIngestionUnitProductForm,
  ingestionPurpose: CatalogProviderIngestionPurpose,
): CatalogProviderIngestionUnitIdentityContract {
  return defineCatalogProviderIngestionUnitIdentityContract({
    providerKey,
    productDomain: "mtg",
    productForm,
    ingestionPurpose,
  });
}

function identityOnlyContract(
  identity: CatalogProviderIngestionUnitIdentityContract,
): CatalogProviderExecutableMappingContract {
  return {
    providerKey: identity.providerKey,
    profileKey: identity.unitKey,
    displayName: identity.unitKey,
    profileVersion: "2026.06.19",
    ingestionUnitIdentity: identity,
    lifecycle: "draft",
    sourceContract: {
      owner: "Catalog",
      repository: null,
      commit: null,
      documentPath: "bounded-contexts/catalog/docs/provider-integration-mapping-contract.md",
      fixtureSetVersion: "identity-proof-v1",
    },
    connector: {
      kind: "identity-proof",
      transportOwns: ["raw-provider-parse"],
      mappingOwns: ["normalized-observation", "hash-material", "merge-identity"],
    },
    fixtures: fixtureContract(identity.providerKey),
    normalizedObservation: {
      outputKind: "provider-product",
      languageCode: constantExpr("en", "catalog-truth", ["normalized-observation", "hash-material"]),
      fields: {
        name: expr("name", "catalog-truth", ["normalized-observation", "hash-material"]),
      },
      hashMaterial: [expr("id", "external-reference", ["hash-material"])],
      mergeIdentity: [expr("id", "external-reference", ["merge-identity"])],
    },
    externalReferences: [],
    referenceHierarchy: [],
    duplicatePrevention: {
      exactExternalCatalogItemReferencesFirst: true,
      mergeCandidateEvidence: [expr("id", "external-reference", ["merge-identity"])],
      identityRules: [],
      ambiguousCandidatePolicy: "review-only",
      replayPolicy: "same-profile-version",
    },
    promotionCommandPlan: {
      planKind: "catalog-item-promotion",
      requiresReview: true,
      commands: [],
    },
    nonGoals: nonGoals(),
  };
}

function duplicatePrevention(): CatalogProviderExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: true,
    mergeCandidateEvidence: [
      expr("setName", "catalog-truth", ["merge-identity"]),
      expr("productName", "catalog-truth", ["merge-identity"]),
      expr("customAttributes.number", "catalog-truth", ["merge-identity"]),
    ],
    identityRules: [
      {
        ruleKey: "exact-external-catalog-item-reference",
        ruleKind: "exact-external-catalog-item-reference",
        evidence: [expr("ids.tcgplayer", "external-reference", ["merge-identity"])],
        candidatePolicy: "reuse",
      },
      {
        ruleKey: "barcode-review",
        ruleKind: "barcode-gtin-match",
        evidence: [expr("barcode", "catalog-merge-evidence", ["merge-identity"])],
        candidatePolicy: "review-only",
      },
    ],
    ambiguousCandidatePolicy: "block-promotion",
    replayPolicy: "same-profile-version",
  };
}

function pokemonPromotionPlan(): CatalogProviderExecutableMappingContract["promotionCommandPlan"] {
  return {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: [
      {
        commandName: "CreateCatalogItem",
        inputs: {
          title: expr("name", "catalog-truth", ["promotion-command"]),
        },
      },
      {
        commandName: "LinkExternalCatalogItemReference",
        inputs: {
          externalKey: expr("productId", "external-reference", ["promotion-command"]),
        },
      },
    ],
  };
}

function optionDimension(dimensionKey: string, path: string) {
  return {
    dimensionKey,
    providerValue: expr(path, "catalog-merge-evidence", ["selected-option"]),
    optionLookupTableKey: `${dimensionKey}-aliases`,
    required: true,
  };
}

function expr(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
  options: Partial<Pick<CatalogProviderMappingValueExpression, "redaction">> = {},
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: true,
      nullPolicy: "diagnostic",
    },
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function constantExpr(
  value: string,
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

function namedExpr(
  functionKey: CatalogProviderMappingRuntimeFunctionKey,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "named-runtime-selector",
      functionKey,
      reason: "Existing provider-specific behavior is reviewed and named until the generic interpreter owns it.",
    },
    owner,
    uses,
    redaction: "none",
  };
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

function aliasCandidate(candidate: CatalogProviderAliasCandidateContract): CatalogProviderAliasCandidateContract {
  return candidate;
}

function aliasExpr(path: string): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: false,
      nullPolicy: "omit",
    },
    owner: "catalog-alias-evidence",
    uses: ["alias-candidate"],
    redaction: "none",
  };
}
