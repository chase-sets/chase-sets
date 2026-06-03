import { describe, expect, it } from "vitest";
import {
  catalogProviderRequiredFixtureFlows,
  validateCatalogProviderExecutableMappingContract,
  type CatalogProviderExecutableMappingContract,
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

  it("represents Scrydex/Scryfall-style TCGplayer ID evidence as duplicate-prevention data", () => {
    const contract = scrydexContract();

    expect(validateCatalogProviderExecutableMappingContract(contract)).toEqual([]);
    expect(contract.providerKey).toBe("scrydex");
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
      fields: {
        name: expr("name", "catalog-truth", ["normalized-observation", "hash-material"]),
        setName: expr("set.name", "catalog-truth", ["normalized-observation", "hash-material", "merge-identity"]),
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

function duplicatePrevention(): CatalogProviderExecutableMappingContract["duplicatePrevention"] {
  return {
    exactExternalCatalogItemReferencesFirst: true,
    mergeCandidateEvidence: [
      expr("setName", "catalog-truth", ["merge-identity"]),
      expr("productName", "catalog-truth", ["merge-identity"]),
      expr("customAttributes.number", "catalog-truth", ["merge-identity"]),
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
