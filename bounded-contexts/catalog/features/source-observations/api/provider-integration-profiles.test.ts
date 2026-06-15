import { describe, expect, it } from "vitest";
import {
  activateCatalogProviderIntegrationProfileVersion,
  catalogProviderIntegrationProfileVersions,
  getActiveCatalogProviderIntegrationProfileVersion,
  getActiveCatalogProviderSourceObservationMappingContract,
  getCatalogProviderSourceObservationMappingContract,
  getCatalogProviderIntegrationProfile,
  getCatalogProviderIntegrationProfileVersion,
  listCatalogProviderIntegrationProfiles,
  listCatalogProviderIntegrationProfileVersions,
  rollbackCatalogProviderIntegrationProfileVersion,
  validateCatalogProviderIntegrationProfileVersion,
  scrydexScryfallCardProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import {
  catalogProviderRequiredFixtureFlows,
  type CatalogProviderExecutableMappingContract,
  type CatalogProviderMappingEvidenceOwner,
  type CatalogProviderMappingEvidenceUse,
  type CatalogProviderMappingValueExpression,
} from "./provider-integration-mapping-contract";

describe("catalog provider integration profiles", () => {
  it("registers TCGplayer as a planned automation-client connector sourced from the automation app", () => {
    const profile = getCatalogProviderIntegrationProfile("TCGPLAYER");

    expect(profile).toBe(tcgplayerAutomationClientProviderProfile);
    expect(profile).toMatchObject({
      providerKey: "tcgplayer",
      status: "planned",
      capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
      supportedScopes: ["product-line/category", "set-name", "product", "sku"],
      optionQueries: [
        { queryKind: "product-lines", displayName: "Product Line", scope: "product-line/category", parentScope: null },
        { queryKind: "set-names", displayName: "Set Name", scope: "set-name", parentScope: "product-line/category" },
        { queryKind: "products", displayName: "Product", scope: "product", parentScope: "set-name" },
        { queryKind: "skus", displayName: "SKU", scope: "sku", parentScope: "product" },
      ],
      connector: {
        kind: "tcgplayer-automation-client",
        sourceRepository: {
          owner: "todd-skelton",
          name: "tcgplayer-automation-app",
          commit: "bf42aa8",
        },
        authentication: {
          scheme: "tcgplayer-production-cookie",
          cookieName: "TCGAuthTicket_Production",
          userAgentRequired: true,
        },
        domains: {
          search: "mp-search-api.tcgplayer.com",
          marketplaceApi: "mpapi.tcgplayer.com",
          infiniteApi: "infinite-api.tcgplayer.com",
          marketplaceGateway: "mpgateway.tcgplayer.com",
        },
        retryStatusCodes: [403, 429, 502, 503, 504],
        throttling: {
          strategy: "domain-adaptive",
          controls: ["request-delay", "cooldown", "max-concurrency", "learned-min-delay"],
        },
        externalReferencePolicy: {
          catalogItemReferencePrefix: "product:",
          productReferencePrefix: "sku:",
          productConditionIdSource: "sku-product-condition-id",
        },
      },
    });
  });

  it("keeps TCGplayer pricing and seller workflow evidence outside Catalog truth", () => {
    const connector = tcgplayerAutomationClientProviderProfile.connector;

    expect(connector.kind).toBe("tcgplayer-automation-client");
    expect(connector.catalogBoundary.acceptedEvidence).toEqual([
      "product-id",
      "sku-id",
      "product-condition-id",
      "set-name",
      "product-line",
    ]);
    expect(connector.catalogBoundary.excludedEvidence).toEqual([
      "listing-price",
      "sales-history",
      "order",
      "message",
      "seller-inventory",
    ]);
    expect(tcgplayerAutomationClientProviderProfile.externalReferenceExtractionRules.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerKey: "tcgplayer",
          target: "catalog-item-reference",
          externalKeyPrefix: "product:",
        }),
        expect.objectContaining({
          providerKey: "tcgplayer",
          target: "product-reference",
          externalKeyPrefix: "sku:",
        }),
      ]),
    );
  });

  it("distinguishes Product ID Catalog Item references from SKU Product references", () => {
    expect(tcgplayerAutomationClientProviderProfile.externalReferenceExtractionRules).toMatchObject({
      referenceTarget: "mixed",
      rules: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          target: "catalog-item-reference",
          externalKeyPrefix: "product:",
          valueKeys: expect.arrayContaining(["productId"]),
        }),
        expect.objectContaining({
          providerKey: "tcgplayer",
          target: "product-reference",
          externalKeyPrefix: "sku:",
          valueKeys: expect.arrayContaining(["skuId"]),
        }),
      ],
    });
  });

  it("registers Scrydex as a fixture-backed Scryfall-style extensibility profile", () => {
    const profile = getCatalogProviderIntegrationProfile("SCRYDEX");

    expect(profile).toBe(scrydexScryfallCardProviderProfile);
    expect(profile).toMatchObject({
      providerKey: "scrydex",
      status: "planned",
      capabilities: ["source-observation-import", "external-reference-extraction"],
      supportedScopes: ["product/card"],
      connector: {
        kind: "scrydex-scryfall-json",
        fixtureBackedOnly: true,
        acceptedEvidence: expect.arrayContaining(["tcgplayer-id", "collector-number", "image-url"]),
        excludedEvidence: ["price", "seller", "inventory", "ruling", "legality"],
      },
      externalReferenceExtractionRules: {
        referenceTarget: "catalog-item-reference",
        rules: [
          expect.objectContaining({
            providerKey: "tcgplayer",
            target: "catalog-item-reference",
            externalKeyPrefix: "product:",
            valueKeys: ["tcgplayer_id"],
          }),
        ],
      },
    });
  });

  it("declares ordered duplicate-prevention identity rules in provider profiles", () => {
    expect(tcgdexPokemonTcgProviderProfile.duplicatePreventionMapping).toMatchObject({
      ambiguousCandidatePolicy: "block-promotion",
      rules: [
        expect.objectContaining({ ruleKey: "exact-external-catalog-item-reference" }),
        expect.objectContaining({ ruleKey: "source-observation-link" }),
        expect.objectContaining({ ruleKey: "pokemon-card-deterministic-fields" }),
        expect.objectContaining({ ruleKey: "pokemon-card-partial-draft-retry" }),
      ],
    });

    expect(tcgplayerAutomationClientProviderProfile.duplicatePreventionMapping.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleKey: "exact-external-catalog-item-reference" }),
        expect.objectContaining({ ruleKey: "sealed-product-deterministic-fields" }),
        expect.objectContaining({ ruleKey: "barcode-gtin-review" }),
        expect.objectContaining({ ruleKey: "future-provider-bridge-review" }),
      ]),
    );
  });

  it("models reference hierarchy provisioning as provider profile data", () => {
    expect(tcgdexPokemonTcgProviderProfile.referenceHierarchyMapping).toMatchObject({
      providerReferenceIdPrefix: "ref_tcgdex",
      targetRecordRuleKey: "expansion",
      referenceTypes: expect.arrayContaining([
        expect.objectContaining({ typeKey: "manufacturer", attributeKeys: ["homepage-url"] }),
        expect.objectContaining({ typeKey: "product-line", attributeKeys: ["official-name", "short-name"] }),
        expect.objectContaining({ typeKey: "series", attributeKeys: ["tcgdex-series-id"] }),
        expect.objectContaining({ typeKey: "expansion", attributeKeys: expect.arrayContaining(["tcgdex-set-id"]) }),
      ]),
      referenceRecords: expect.arrayContaining([
        expect.objectContaining({ ruleKey: "manufacturer", typeKey: "manufacturer" }),
        expect.objectContaining({ ruleKey: "product-line", typeKey: "product-line" }),
        expect.objectContaining({
          ruleKey: "series",
          recordId: { kind: "provider", typeKey: "series", providerValuePaths: ["seriesId", "seriesName"] },
          key: { kind: "path", path: "seriesId" },
        }),
        expect.objectContaining({
          ruleKey: "expansion",
          recordId: { kind: "provider", typeKey: "expansion", providerValuePaths: ["expansionId"] },
          key: { kind: "path", path: "expansionId" },
        }),
      ]),
    });

    expect(tcgplayerAutomationClientProviderProfile.referenceHierarchyMapping).toMatchObject({
      providerReferenceIdPrefix: "ref_tcgplayer",
      targetRecordRuleKey: "set-name",
      referenceRecords: expect.arrayContaining([
        expect.objectContaining({
          ruleKey: "product-line",
          attributes: expect.arrayContaining([expect.objectContaining({ attributeKey: "tcgplayer-product-line-id" })]),
        }),
        expect.objectContaining({
          ruleKey: "set-name",
          attributes: expect.arrayContaining([expect.objectContaining({ attributeKey: "tcgplayer-set-name" })]),
        }),
      ]),
    });
  });

  it("maps TCGplayer SKU selected options to review evidence when provider values are unknown", () => {
    expect(tcgplayerAutomationClientProviderProfile.selectedOptionMapping).toMatchObject({
      source: "tcgplayer-sku-condition-variant-language",
      dimensions: [
        {
          dimensionKey: "condition",
          providerValue: { source: "record", path: "condition" },
          required: true,
          unknownPolicy: "review-evidence",
        },
        {
          dimensionKey: "printing",
          providerValue: { source: "record", path: "variant" },
          unknownPolicy: "review-evidence",
        },
        {
          dimensionKey: "language",
          providerValue: { source: "record", path: "language" },
          unknownPolicy: "review-evidence",
        },
        {
          dimensionKey: "product-form",
          providerValue: { source: "payload", path: "sealed" },
          valueMappings: [
            { from: true, value: "unopened" },
            { from: false, value: "single" },
          ],
          unknownPolicy: "review-evidence",
        },
      ],
      productReferenceRule: {
        providerKey: "tcgplayer",
        externalKeyPrefix: "sku:",
        requiredSourceKeys: ["sku", "condition", "variant", "language"],
        missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
      },
    });
  });

  it("lists active and planned providers through the same provider catalog", () => {
    expect(listCatalogProviderIntegrationProfiles().map((profile) => [profile.providerKey, profile.status])).toEqual([
      ["scrydex", "planned"],
      ["tcgdex", "active"],
      ["tcgplayer", "planned"],
    ]);
  });

  it("wraps current profiles as versioned Catalog-owned seed data with source contract metadata", () => {
    const versions = listCatalogProviderIntegrationProfileVersions();

    expect(versions.map((version) => [version.providerKey, version.profileVersion, version.lifecycle])).toEqual([
      ["scrydex", "2026.06.03", "test"],
      ["tcgdex", "2026.06.03", "active"],
      ["tcgplayer", "2026.06.03", "test"],
    ]);
    expect(getCatalogProviderIntegrationProfileVersion("scrydex")).toMatchObject({
      providerKey: "scrydex",
      profileKey: "scryfall-card-fixture",
      profileVersion: "2026.06.03",
      active: false,
      sourceContract: {
        repository: "chase-sets/chase-sets",
        fixtureSetVersion: "scrydex-scryfall-card-proof-v1",
      },
      retirementPlan: null,
      executableMappingContract: expect.objectContaining({
        providerKey: "scrydex",
        profileKey: "scryfall-card-fixture",
        profileVersion: "2026.06.03",
        lifecycle: "test",
        sourceObservation: expect.any(Object),
      }),
    });
    expect(getCatalogProviderSourceObservationMappingContract("SCRYDEX")).toMatchObject({
      providerKey: "scrydex",
      sourceObservation: {
        observationId: expect.any(Object),
      },
    });
    expect(validateCatalogProviderIntegrationProfileVersion(catalogProviderIntegrationProfileVersions[0])).toEqual([]);
    expect(getActiveCatalogProviderIntegrationProfileVersion("TCGDEX")).toMatchObject({
      providerKey: "tcgdex",
      profileKey: "pokemon-tcg",
      active: true,
      sourceContract: {
        repository: "chase-sets/chase-sets",
        fixtureSetVersion: "tcgdex-pokemon-executable-v1",
      },
      retirementPlan: null,
      executableMappingContract: expect.objectContaining({
        providerKey: "tcgdex",
        profileKey: "pokemon-tcg",
        profileVersion: "2026.06.03",
        lifecycle: "active",
        sourceObservation: expect.any(Object),
      }),
    });
    expect(getActiveCatalogProviderSourceObservationMappingContract("TCGDEX")).toMatchObject({
      providerKey: "tcgdex",
      sourceObservation: {
        observationId: expect.any(Object),
      },
    });
    expect(getCatalogProviderIntegrationProfileVersion("tcgplayer")).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "pokemon-tcg-automation-client",
      profileVersion: "2026.06.03",
      active: false,
      sourceContract: {
        repository: "todd-skelton/tcgplayer-automation-app",
        commit: "bf42aa8",
        fixtureSetVersion: "automation-client-contract-v1",
      },
      retirementPlan: null,
      executableMappingContract: expect.objectContaining({
        providerKey: "tcgplayer",
        profileKey: "pokemon-tcg-automation-client",
        profileVersion: "2026.06.03",
        lifecycle: "test",
        sourceObservation: expect.any(Object),
      }),
    });
    expect(getCatalogProviderSourceObservationMappingContract("TCGPLAYER")).toMatchObject({
      providerKey: "tcgplayer",
      sourceObservation: {
        observationId: expect.any(Object),
      },
    });
  });

  it("requires every profile version to carry an executable mapping contract", () => {
    const tcgplayerVersion = executableTcgplayerVersion();

    expect(
      validateCatalogProviderIntegrationProfileVersion({
        ...tcgplayerVersion,
        fixtures: { ...tcgplayerVersion.fixtures, coveredFlows: ["normal"] },
        executableMappingContract: undefined,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-profile-fixture-flow" }),
        expect.objectContaining({ code: "missing-executable-mapping-contract" }),
      ]),
    );
  });

  it("activates a validated executable profile version and deprecates the prior active version", () => {
    const versions = [
      executableVersion("2026.06.03", "active"),
      executableVersion("2026.06.04", "test"),
    ] as const satisfies readonly CatalogProviderIntegrationProfileVersionRecord[];

    const activated = activateCatalogProviderIntegrationProfileVersion("tcgdex", "2026.06.04", versions);

    expect(activated.map((version) => [version.profileVersion, version.lifecycle, version.active])).toEqual([
      ["2026.06.03", "deprecated", false],
      ["2026.06.04", "active", true],
    ]);
  });

  it("rolls back to a prior validated profile version without mutating history", () => {
    const activeNewVersion = executableVersion("2026.06.04", "active");
    const priorVersion = {
      ...executableVersion("2026.06.03", "deprecated"),
      active: false,
    };

    const rolledBack = rollbackCatalogProviderIntegrationProfileVersion("tcgdex", "2026.06.03", [
      priorVersion,
      activeNewVersion,
    ]);

    expect(rolledBack.map((version) => [version.profileVersion, version.lifecycle, version.active])).toEqual([
      ["2026.06.03", "active", true],
      ["2026.06.04", "deprecated", false],
    ]);
  });

  it("blocks activation when executable mapping fixtures are incomplete", () => {
    const invalidVersion = {
      ...executableVersion("2026.06.04", "test"),
      executableMappingContract: {
        ...mappingContract("2026.06.04", "test"),
        fixtures: {
          fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex",
          coveredFlows: ["normal"],
          liveProviderCallsAllowed: false,
        },
      },
    } satisfies CatalogProviderIntegrationProfileVersionRecord;

    expect(() =>
      activateCatalogProviderIntegrationProfileVersion("tcgdex", "2026.06.04", [
        getActiveCatalogProviderIntegrationProfileVersion("tcgdex")!,
        invalidVersion,
      ]),
    ).toThrow(/partial flow/);
  });
});

function executableVersion(
  profileVersion: string,
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"],
): CatalogProviderIntegrationProfileVersionRecord {
  const contract = mappingContract(profileVersion, lifecycle);
  return {
    providerKey: "tcgdex",
    profileKey: "pokemon-tcg",
    profileVersion,
    lifecycle,
    active: lifecycle === "active",
    profile: tcgdexPokemonTcgProviderProfile,
    sourceContract: contract.sourceContract,
    fixtures: contract.fixtures,
    retirementPlan: null,
    executableMappingContract: contract,
  };
}

function executableTcgplayerVersion(): CatalogProviderIntegrationProfileVersionRecord {
  const tcgplayerVersion = getCatalogProviderIntegrationProfileVersion("tcgplayer")!;
  return {
    ...tcgplayerVersion,
    profileVersion: "2026.06.02",
  };
}

function mappingContract(
  profileVersion: string,
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"],
): CatalogProviderExecutableMappingContract {
  return {
    providerKey: "tcgdex",
    profileKey: "pokemon-tcg",
    displayName: "TCGdex Pokemon TCG",
    profileVersion,
    lifecycle,
    sourceContract: {
      owner: "chase-sets/catalog",
      repository: "chase-sets/chase-sets",
      commit: "0bde010",
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
    fixtures: {
      fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex",
      coveredFlows: catalogProviderRequiredFixtureFlows,
      liveProviderCallsAllowed: false,
    },
    normalizedObservation: {
      outputKind: "pokemon-card",
      languageCode: expr("language", "catalog-truth", ["normalized-observation", "hash-material"]),
      fields: {
        cardName: expr("name", "catalog-truth", ["normalized-observation", "hash-material", "promotion-command"]),
        cardNumber: expr("localId", "catalog-truth", ["normalized-observation", "hash-material", "merge-identity"]),
      },
      hashMaterial: [
        expr("id", "external-reference", ["hash-material"]),
        expr("name", "catalog-truth", ["hash-material"]),
      ],
      mergeIdentity: [
        expr("set.id", "external-reference", ["merge-identity"]),
        expr("localId", "catalog-truth", ["merge-identity"]),
      ],
    },
    externalReferences: [
      {
        target: "catalog-item-reference",
        providerKey: "tcgplayer",
        externalKeyPrefix: "product:",
        source: expr("ids.tcgplayer", "external-reference", ["external-reference"]),
        ambiguityPolicy: "skip-reference",
      },
    ],
    referenceHierarchy: [
      {
        targetTypeKey: "expansion",
        providerAttributeKey: "tcgdex-set-id",
        referenceRecordKey: expr("set.id", "external-reference", ["reference-hierarchy"]),
      },
    ],
    duplicatePrevention: {
      exactExternalCatalogItemReferencesFirst: true,
      mergeCandidateEvidence: [
        expr("set.id", "external-reference", ["merge-identity"]),
        expr("localId", "catalog-truth", ["merge-identity"]),
      ],
      identityRules: [
        {
          ruleKey: "exact-external-catalog-item-reference",
          ruleKind: "exact-external-catalog-item-reference",
          evidence: [expr("ids.tcgplayer", "external-reference", ["merge-identity"])],
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
          inputs: {
            title: expr("name", "catalog-truth", ["promotion-command"]),
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
  };
}

function expr(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
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
    redaction: "none",
  };
}
