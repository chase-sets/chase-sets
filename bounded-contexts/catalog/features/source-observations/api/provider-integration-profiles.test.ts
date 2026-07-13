import { describe, expect, it } from "vitest";
import {
  activateCatalogProviderIntegrationProfileVersion,
  catalogProviderProfileVersionIngestionUnitKey,
  catalogProviderIntegrationProfileVersions,
  getActiveCatalogProviderIntegrationProfileVersion,
  getActiveCatalogProviderSourceObservationMappingContract,
  getCatalogProviderSourceObservationMappingContract,
  getCatalogProviderIntegrationProfile,
  getCatalogProviderIntegrationProfileVersion,
  lorcanajsonLorcanaCardReferenceProviderProfile,
  lorcanajsonLorcanaSetReferenceProviderProfile,
  lorcastLorcanaCardReferenceProviderProfile,
  lorcastLorcanaSetReferenceProviderProfile,
  listCatalogProviderIntegrationProfiles,
  listCatalogProviderIntegrationProfileVersions,
  mtgjsonMtgCardReferenceProviderProfile,
  mtgjsonMtgSetReferenceProviderProfile,
  rollbackCatalogProviderIntegrationProfileVersion,
  validateCatalogProviderIntegrationProfileVersion,
  scryfallMtgCardPrintProviderProfile,
  scryfallMtgImageEvidenceProviderProfile,
  scrydexScryfallCardProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  scrydexLorcanaCardPrintProviderProfile,
  scrydexLorcanaSealedProductProviderProfile,
  scrydexLorcanaSetReferenceProviderProfile,
  scrydexOnePieceCardPrintProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  tcgplayerLorcanaSingleCardProviderProfile,
  tcgplayerLorcanaSealedProductProviderProfile,
  tcgplayerMtgSingleCardProviderProfile,
  tcgplayerMtgSealedProductProviderProfile,
  tcgplayerOnePieceSingleCardProviderProfile,
  tcgplayerOnePieceSealedProductProviderProfile,
  tcgplayerPokemonSingleCardProviderProfile,
  tcgplayerYugiohSingleCardProviderProfile,
  ygojsonYugiohSealedProductReferenceProviderProfile,
  ygojsonYugiohSetReferenceProviderProfile,
  ygoprodeckYugiohCardReferenceProviderProfile,
  ygoprodeckYugiohSetReferenceProviderProfile,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import { scrydexScryfallCardSourceObservationMappingContract } from "./scrydex-executable-mapping-contract";
import {
  catalogProviderRequiredFixtureFlows,
  defineCatalogProviderIngestionUnitIdentityContract,
  type CatalogProviderExecutableMappingContract,
  type CatalogProviderMappingEvidenceOwner,
  type CatalogProviderMappingEvidenceUse,
  type CatalogProviderMappingValueExpression,
} from "./provider-integration-mapping-contract";
import { catalogProviderProfileFixtureCases } from "./provider-profile-fixture-cases";

describe("catalog provider integration profiles", () => {
  it("registers TCGplayer as an active Magic automation-client connector sourced from the automation app", () => {
    const profile = getCatalogProviderIntegrationProfile("TCGPLAYER");

    expect(profile).toBe(tcgplayerMtgSingleCardProviderProfile);
    expect(profile).toMatchObject({
      providerKey: "tcgplayer",
      displayName: "TCGplayer Magic Single Cards",
      status: "active",
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
      normalizedObservationMapping: { kind: "provider-product" },
      catalogFieldMapping: {
        blueprintKey: "magic-card-print",
        categoryKey: "magic-card-prints",
        fieldKeys: expect.objectContaining({ set: "set" }),
      },
    });
  });

  it("keeps the Pokemon TCGplayer single-card profile available as an active provider-product unit", () => {
    const profile = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.05", {
      profileKey: "pokemon-single-card-product-sku",
    })?.profile;

    expect(profile).toBe(tcgplayerPokemonSingleCardProviderProfile);
    expect(profile).toMatchObject({
      providerKey: "tcgplayer",
      status: "active",
      normalizedObservationMapping: { kind: "provider-product" },
      catalogFieldMapping: tcgdexPokemonTcgProviderProfile.catalogFieldMapping,
    });
  });

  it("registers TCGplayer Magic sealed products as an active promotable profile unit", () => {
    const profile = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.19", {
      profileKey: "mtg-sealed-product-sku",
    })?.profile;

    expect(profile).toBe(tcgplayerMtgSealedProductProviderProfile);
    expect(profile).toMatchObject({
      providerKey: "tcgplayer",
      displayName: "TCGplayer Magic Sealed Products",
      status: "active",
      capabilities: [
        "provider-option-query",
        "source-observation-import",
        "catalog-item-promotion",
        "external-reference-extraction",
      ],
      normalizedObservationMapping: { kind: "magic-sealed-product" },
      catalogFieldMapping: {
        blueprintKey: "magic-sealed-product",
        categoryKey: "magic-booster-packs",
        fieldKeys: expect.objectContaining({ packCount: "pack-count", set: "set" }),
      },
    });
  });

  it("registers TCGplayer One Piece sealed products as an active marketplace-evidence profile unit", () => {
    const profile = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.23", {
      profileKey: "one-piece-sealed-product-sku",
    })?.profile;

    expect(profile).toBe(tcgplayerOnePieceSealedProductProviderProfile);
    expect(profile).toMatchObject({
      providerKey: "tcgplayer",
      displayName: "TCGplayer One Piece Sealed Products",
      status: "active",
      capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
      connector: {
        kind: "tcgplayer-automation-client",
        catalogBoundary: {
          acceptedEvidence: ["product-id", "sku-id", "product-condition-id", "set-name", "product-line"],
          excludedEvidence: ["listing-price", "sales-history", "order", "message", "seller-inventory"],
        },
      },
      normalizedObservationMapping: { kind: "provider-product" },
      catalogFieldMapping: {
        blueprintKey: "one-piece-sealed-product",
        categoryKey: "one-piece-sealed-products",
        fieldKeys: expect.objectContaining({ cardName: "sealed-product-name", set: "set" }),
      },
      selectedOptionMapping: {
        dimensions: [
          expect.objectContaining({
            dimensionKey: "product-form",
            valueMappings: [{ from: true, value: "unopened" }],
          }),
          expect.objectContaining({
            dimensionKey: "language",
            valueSynonyms: [{ optionKey: "english", providerValues: ["English", "EN"] }],
          }),
        ],
      },
    });
  });

  it("registers TCGplayer Lorcana single cards and sealed products as active marketplace-evidence units", () => {
    const singleCard = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.23", {
      profileKey: "lorcana-single-card-product-sku",
    });
    const sealedProduct = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.23", {
      profileKey: "lorcana-sealed-product-sku",
    });

    expect(singleCard?.profile).toBe(tcgplayerLorcanaSingleCardProviderProfile);
    expect(sealedProduct?.profile).toBe(tcgplayerLorcanaSealedProductProviderProfile);
    expect(catalogProviderProfileVersionIngestionUnitKey(singleCard!)).toBe(
      "tcgplayer:lorcana:single-card:source-observation-import",
    );
    expect(catalogProviderProfileVersionIngestionUnitKey(sealedProduct!)).toBe(
      "tcgplayer:lorcana:sealed-product:source-observation-import",
    );
    expect(singleCard?.profile).toMatchObject({
      providerKey: "tcgplayer",
      displayName: "TCGplayer Lorcana Single Cards",
      status: "active",
      normalizedObservationMapping: { kind: "provider-product" },
      catalogFieldMapping: {
        blueprintKey: "lorcana-card-print",
        categoryKey: "lorcana-card-prints",
      },
    });
    expect(sealedProduct?.profile).toMatchObject({
      providerKey: "tcgplayer",
      displayName: "TCGplayer Lorcana Sealed Products",
      status: "active",
      normalizedObservationMapping: { kind: "provider-product" },
      catalogFieldMapping: {
        blueprintKey: "lorcana-sealed-product",
        categoryKey: "lorcana-sealed-products",
      },
      selectedOptionMapping: {
        dimensions: [
          expect.objectContaining({
            dimensionKey: "product-form",
            valueMappings: [{ from: true, value: "unopened" }],
          }),
          expect.objectContaining({
            dimensionKey: "language",
            valueSynonyms: [{ optionKey: "english", providerValues: ["English", "EN"] }],
          }),
        ],
      },
    });
  });

  it("registers Scrydex One Piece as live credentialed transport with fixture-backed activation evidence", () => {
    const profile = getActiveCatalogProviderIntegrationProfileVersion("scrydex", {
      profileKey: "one-piece-card-print-source-observation",
    })?.profile;

    expect(profile).toBe(scrydexOnePieceCardPrintProviderProfile);
    expect(profile?.connector).toMatchObject({
      kind: "scrydex-json",
      transportMode: "live-credentialed",
      fixtureEvidence: "required-for-active-profile-validation",
      authentication: {
        scheme: "scrydex-api-key",
        credentialsRequired: true,
        teamIdentifierRequired: true,
        retainedCredentialMaterial: "never",
      },
      requestPolicy: {
        normalImportStrategy: "bulk-first",
        selectedFieldsOnly: true,
        highestSafePageSizeRequired: true,
        perRecordFallbackPolicy: "documented-tested-preflighted-operator-visible",
      },
      excludedEvidence: expect.arrayContaining(["unapproved-price-history"]),
    });
    expect(profile?.connector).not.toHaveProperty("fixtureBackedOnly");
  });

  it("registers supported Scrydex Lorcana units against the shared Scrydex credentialed connector", () => {
    const card = getActiveCatalogProviderIntegrationProfileVersion("scrydex", {
      profileKey: "lorcana-card-print-source-observation",
    });
    const set = getActiveCatalogProviderIntegrationProfileVersion("scrydex", {
      profileKey: "lorcana-set-reference-data",
    });
    const sealed = getCatalogProviderIntegrationProfileVersion("scrydex", "2026.06.23", {
      profileKey: "lorcana-sealed-product-source-observation",
    });

    expect(
      getActiveCatalogProviderIntegrationProfileVersion("scrydex", {
        profileKey: "lorcana-sealed-product-source-observation",
      }),
    ).toBeNull();

    expect(card?.profile).toBe(scrydexLorcanaCardPrintProviderProfile);
    expect(set?.profile).toBe(scrydexLorcanaSetReferenceProviderProfile);
    expect(sealed?.profile).toBe(scrydexLorcanaSealedProductProviderProfile);
    expect(card).toMatchObject({
      ingestionUnitIdentity: {
        unitKey: "scrydex:lorcana:single-card:source-observation-import",
        productDomain: "lorcana",
      },
      profile: {
        connector: { kind: "scrydex-json", authentication: { scheme: "scrydex-api-key" } },
        normalizedObservationMapping: { kind: "lorcana-card-print" },
      },
    });
    expect(set).toMatchObject({
      ingestionUnitIdentity: { unitKey: "scrydex:lorcana:set:reference-data", productDomain: "lorcana" },
      profile: { normalizedObservationMapping: { kind: "lorcana-set-reference" } },
    });
    expect(sealed).toMatchObject({
      lifecycle: "test",
      active: false,
      ingestionUnitIdentity: {
        unitKey: "scrydex:lorcana:sealed-product:source-observation-import",
        productDomain: "lorcana",
      },
      profile: { normalizedObservationMapping: { kind: "lorcana-sealed-product" } },
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

  it("registers Scryfall as active Magic card-print and image-evidence profiles", () => {
    const profile = getCatalogProviderIntegrationProfile("SCRYFALL");

    expect(profile).toBe(scryfallMtgCardPrintProviderProfile);
    expect(profile).toMatchObject({
      providerKey: "scryfall",
      status: "active",
      capabilities: [
        "provider-option-query",
        "source-observation-import",
        "catalog-item-promotion",
        "external-reference-extraction",
      ],
      supportedScopes: ["set-name", "product/card"],
      optionQueries: [
        expect.objectContaining({ queryKind: "sets", operation: "scryfall-list-sets" }),
        expect.objectContaining({ queryKind: "cards", operation: "scryfall-list-cards" }),
      ],
      normalizedObservationMapping: { kind: "magic-card-print" },
      catalogFieldMapping: {
        blueprintKey: "magic-card-print",
        categoryKey: "magic-card-prints",
        fieldKeys: expect.objectContaining({ set: "set" }),
      },
      referenceHierarchyMapping: {
        targetRecordRuleKey: "set",
        referenceTypes: expect.arrayContaining([
          expect.objectContaining({ typeKey: "set", attributeKeys: ["scryfall-set-code", "scryfall-set-name"] }),
        ]),
      },
      connector: {
        kind: "scryfall-json",
        acceptedEvidence: expect.arrayContaining(["tcgplayer-id", "collector-number", "image-url", "oracle-id"]),
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
    expect(scryfallMtgImageEvidenceProviderProfile).toMatchObject({
      providerKey: "scryfall",
      displayName: "Scryfall Image Evidence",
      status: "active",
      capabilities: ["source-observation-import", "external-reference-extraction"],
    });
  });

  it("registers MTGJSON as active Magic set and card reference profiles", () => {
    const profile = getCatalogProviderIntegrationProfile("MTGJSON");

    expect(profile).toBe(mtgjsonMtgCardReferenceProviderProfile);
    expect(profile).toMatchObject({
      providerKey: "mtgjson",
      status: "active",
      capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
      supportedScopes: ["set-name", "product/card"],
      optionQueries: [
        expect.objectContaining({ queryKind: "sets", operation: "mtgjson-list-sets" }),
        expect.objectContaining({ queryKind: "cards", operation: "mtgjson-list-cards" }),
      ],
      normalizedObservationMapping: { kind: "magic-card-print" },
      connector: {
        kind: "mtgjson-json",
        acceptedEvidence: expect.arrayContaining(["mtgjson-uuid", "set-code", "scryfall-id"]),
        excludedEvidence: ["price", "legality", "ruling", "deck", "format"],
      },
      externalReferenceExtractionRules: {
        referenceTarget: "catalog-item-reference",
        rules: [
          expect.objectContaining({
            providerKey: "scryfall",
            target: "catalog-item-reference",
            externalKeyPrefix: "card:",
            valueKeys: ["identifiers.scryfallId"],
          }),
        ],
      },
    });
    expect(mtgjsonMtgSetReferenceProviderProfile).toMatchObject({
      providerKey: "mtgjson",
      displayName: "MTGJSON Set Reference",
      status: "active",
      capabilities: ["provider-option-query", "source-observation-import", "reference-data-promotion"],
      normalizedObservationMapping: { kind: "magic-set-reference" },
      optionQueries: [
        expect.objectContaining({ queryKind: "sets", scope: "set-name", operation: "mtgjson-list-sets" }),
      ],
    });
    expect(mtgjsonMtgSetReferenceProviderProfile.optionQueries).toHaveLength(1);
    expect(mtgjsonMtgSetReferenceProviderProfile.optionQueries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ queryKind: "cards" })]),
    );
  });

  it("registers LorcanaJSON as active Disney Lorcana set and card reference profiles", () => {
    const profile = getCatalogProviderIntegrationProfile("LORCANAJSON");

    expect(profile).toBe(lorcanajsonLorcanaCardReferenceProviderProfile);
    expect(profile).toMatchObject({
      providerKey: "lorcanajson",
      status: "active",
      capabilities: [
        "provider-option-query",
        "source-observation-import",
        "catalog-item-promotion",
        "external-reference-extraction",
      ],
      supportedScopes: ["set-name", "product/card"],
      optionQueries: [
        expect.objectContaining({ queryKind: "sets", operation: "lorcanajson-list-sets" }),
        expect.objectContaining({ queryKind: "cards", operation: "lorcanajson-list-cards" }),
      ],
      normalizedObservationMapping: { kind: "lorcana-card-print" },
      connector: {
        kind: "lorcanajson-json",
        bulkPolicy: {
          freshnessDocument: "metadata.json",
          optionDiscoveryDocument: "allCards.json",
          selectedSetDocumentPattern: "sets/setdata.{setCode}.json",
          normalImportStrategy: "bulk-first",
        },
        acceptedEvidence: expect.arrayContaining(["lorcanajson-card-id", "set-code", "tcgplayer-id"]),
        excludedEvidence: ["price", "seller", "inventory", "ruling", "legality", "unapproved-scrape"],
      },
      externalReferenceExtractionRules: {
        referenceTarget: "catalog-item-reference",
        rules: [
          expect.objectContaining({
            providerKey: "tcgplayer",
            target: "catalog-item-reference",
            externalKeyPrefix: "product:",
            valueKeys: ["tcgplayerProductId"],
          }),
        ],
      },
    });
    expect(lorcanajsonLorcanaSetReferenceProviderProfile).toMatchObject({
      providerKey: "lorcanajson",
      displayName: "LorcanaJSON Set Reference",
      status: "active",
      capabilities: ["provider-option-query", "source-observation-import", "reference-data-promotion"],
      normalizedObservationMapping: { kind: "lorcana-set-reference" },
      optionQueries: [
        expect.objectContaining({ queryKind: "sets", scope: "set-name", operation: "lorcanajson-list-sets" }),
      ],
    });
    expect(lorcanajsonLorcanaSetReferenceProviderProfile.optionQueries).toHaveLength(1);
    expect(lorcanajsonLorcanaSetReferenceProviderProfile.optionQueries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ queryKind: "cards" })]),
    );
  });

  it("registers Lorcast as active Disney Lorcana set and card reference profiles", () => {
    const profile = getCatalogProviderIntegrationProfile("LORCAST");

    expect(profile).toBe(lorcastLorcanaCardReferenceProviderProfile);
    expect(profile).toMatchObject({
      providerKey: "lorcast",
      status: "active",
      capabilities: ["provider-option-query", "source-observation-import", "external-reference-extraction"],
      supportedScopes: ["set-name", "product/card"],
      optionQueries: [
        expect.objectContaining({ queryKind: "sets", operation: "lorcast-list-sets" }),
        expect.objectContaining({ queryKind: "cards", operation: "lorcast-list-cards" }),
      ],
      normalizedObservationMapping: { kind: "lorcana-card-print" },
      connector: {
        kind: "lorcast-json",
        authentication: { scheme: "public-api", credentialsRequired: false },
        requestPolicy: {
          normalImportStrategy: "bulk-set-scoped",
          cacheProviderDataForAtLeastHours: 24,
          recommendedDelayMilliseconds: "50-100",
        },
        acceptedEvidence: expect.arrayContaining(["lorcast-card-id", "lorcast-set-id", "tcgplayer-id"]),
        excludedEvidence: ["price", "seller", "inventory", "ruling", "legality"],
      },
      externalReferenceExtractionRules: {
        referenceTarget: "catalog-item-reference",
        rules: [
          expect.objectContaining({
            providerKey: "tcgplayer",
            target: "catalog-item-reference",
            externalKeyPrefix: "product:",
            valueKeys: ["tcgplayerProductId"],
          }),
        ],
      },
    });
    expect(lorcastLorcanaSetReferenceProviderProfile).toMatchObject({
      providerKey: "lorcast",
      displayName: "Lorcast Set Reference",
      status: "active",
      capabilities: ["provider-option-query", "source-observation-import", "reference-data-promotion"],
      normalizedObservationMapping: { kind: "lorcana-set-reference" },
      optionQueries: [
        expect.objectContaining({ queryKind: "sets", scope: "set-name", operation: "lorcast-list-sets" }),
      ],
    });
    expect(lorcastLorcanaSetReferenceProviderProfile.optionQueries).toHaveLength(1);
    expect(lorcastLorcanaSetReferenceProviderProfile.optionQueries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ queryKind: "cards" })]),
    );
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

  it("keeps TCGplayer Magic, Yu-Gi-Oh, One Piece, and Pokemon profile units distinct", () => {
    const magic = getActiveCatalogProviderIntegrationProfileVersion("tcgplayer", {
      profileKey: "mtg-single-card-product-sku",
    });
    const sealed = getActiveCatalogProviderIntegrationProfileVersion("tcgplayer", {
      profileKey: "mtg-sealed-product-sku",
    });
    const yugioh = getActiveCatalogProviderIntegrationProfileVersion("tcgplayer", {
      profileKey: "yugioh-single-card-product-sku",
    });
    const onePiece = getActiveCatalogProviderIntegrationProfileVersion("tcgplayer", {
      profileKey: "one-piece-single-card-product-sku",
    });
    const onePieceSealed = getActiveCatalogProviderIntegrationProfileVersion("tcgplayer", {
      profileKey: "one-piece-sealed-product-sku",
    });
    const pokemon = getActiveCatalogProviderIntegrationProfileVersion("tcgplayer", {
      profileKey: "pokemon-single-card-product-sku",
    });

    expect(magic).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "mtg-single-card-product-sku",
      lifecycle: "active",
      active: true,
      ingestionUnitIdentity: {
        unitKey: "tcgplayer:mtg:single-card:source-observation-import",
        productDomain: "mtg",
      },
      profile: {
        normalizedObservationMapping: { kind: "provider-product" },
        catalogFieldMapping: { blueprintKey: "magic-card-print" },
      },
    });
    expect(yugioh).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "yugioh-single-card-product-sku",
      lifecycle: "active",
      active: true,
      ingestionUnitIdentity: {
        unitKey: "tcgplayer:yugioh:single-card:source-observation-import",
        productDomain: "yugioh",
      },
      profile: {
        normalizedObservationMapping: { kind: "provider-product" },
        catalogFieldMapping: { blueprintKey: "yugioh-card-print" },
      },
    });
    expect(yugioh?.profile).toBe(tcgplayerYugiohSingleCardProviderProfile);
    expect(onePiece).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "one-piece-single-card-product-sku",
      lifecycle: "active",
      active: true,
      ingestionUnitIdentity: {
        unitKey: "tcgplayer:one-piece:single-card:source-observation-import",
        productDomain: "one-piece",
      },
      profile: {
        normalizedObservationMapping: { kind: "provider-product" },
        catalogFieldMapping: { blueprintKey: "one-piece-card-print" },
      },
    });
    expect(onePiece?.profile).toBe(tcgplayerOnePieceSingleCardProviderProfile);
    expect(onePieceSealed).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "one-piece-sealed-product-sku",
      lifecycle: "active",
      active: true,
      ingestionUnitIdentity: {
        unitKey: "tcgplayer:one-piece:sealed-product:source-observation-import",
        productDomain: "one-piece",
        productForm: "sealed-product",
      },
      profile: {
        normalizedObservationMapping: { kind: "provider-product" },
        catalogFieldMapping: { blueprintKey: "one-piece-sealed-product" },
      },
    });
    expect(onePieceSealed?.profile).toBe(tcgplayerOnePieceSealedProductProviderProfile);
    expect(sealed).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "mtg-sealed-product-sku",
      lifecycle: "active",
      active: true,
      ingestionUnitIdentity: {
        unitKey: "tcgplayer:mtg:sealed-product:source-observation-import",
        productDomain: "mtg",
        productForm: "sealed-product",
      },
      profile: {
        normalizedObservationMapping: { kind: "magic-sealed-product" },
        catalogFieldMapping: { blueprintKey: "magic-sealed-product", categoryKey: "magic-booster-packs" },
      },
    });
    expect(pokemon).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "pokemon-single-card-product-sku",
      lifecycle: "active",
      active: true,
      ingestionUnitIdentity: {
        unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
        productDomain: "pokemon",
      },
      profile: {
        normalizedObservationMapping: { kind: "provider-product" },
        catalogFieldMapping: { blueprintKey: "pokemon-card-single" },
      },
    });
    expect(pokemon?.profile).toBe(tcgplayerPokemonSingleCardProviderProfile);
    expect(magic?.profile.selectedOptionMapping?.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimensionKey: "printing",
          valueSynonyms: [
            { optionKey: "normal", providerValues: ["Normal", "Standard", "Nonfoil", "Non-Foil"] },
            { optionKey: "foil", providerValues: ["Foil", "Holofoil"] },
          ],
        }),
      ]),
    );
    expect(pokemon?.profile.selectedOptionMapping?.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimensionKey: "printing",
          valueSynonyms: [
            { optionKey: "normal", providerValues: ["Normal", "Standard"] },
            { optionKey: "holofoil", providerValues: ["Holofoil", "Holo", "Foil"] },
            { optionKey: "reverse-holofoil", providerValues: ["Reverse Holofoil", "Reverse Holo", "Reverse"] },
          ],
        }),
      ]),
    );
    expect(yugioh?.profile.selectedOptionMapping?.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimensionKey: "printing",
          valueSynonyms: [
            { optionKey: "unlimited", providerValues: ["Unlimited", "Unlimited Edition"] },
            { optionKey: "first-edition", providerValues: ["1st Edition", "First Edition", "1st"] },
            { optionKey: "limited", providerValues: ["Limited", "Limited Edition"] },
            { optionKey: "duel-terminal", providerValues: ["Duel Terminal"] },
          ],
        }),
      ]),
    );
  });

  it("registers Yu-Gi-Oh public reference-data providers as shared importer profiles", () => {
    expect(
      getActiveCatalogProviderIntegrationProfileVersion("ygoprodeck", {
        profileKey: "yugioh-card-print-reference-data",
      }),
    ).toMatchObject({
      providerKey: "ygoprodeck",
      profileKey: "yugioh-card-print-reference-data",
      active: true,
      ingestionUnitIdentity: {
        unitKey: "ygoprodeck:yugioh:single-card:reference-data",
        productDomain: "yugioh",
      },
      profile: {
        normalizedObservationMapping: { kind: "yugioh-card-print" },
        connector: {
          kind: "ygoprodeck-json",
          assetPolicy: { hotlinkingAllowed: false, requiresCatalogAssetStorage: true },
        },
      },
    });
    expect(
      getActiveCatalogProviderIntegrationProfileVersion("ygoprodeck", {
        profileKey: "yugioh-set-reference-data",
      })?.profile,
    ).toBe(ygoprodeckYugiohSetReferenceProviderProfile);
    expect(
      getActiveCatalogProviderIntegrationProfileVersion("ygojson", {
        profileKey: "yugioh-set-reference-data",
      })?.profile,
    ).toBe(ygojsonYugiohSetReferenceProviderProfile);
    expect(
      getActiveCatalogProviderIntegrationProfileVersion("ygojson", {
        profileKey: "yugioh-sealed-product-reference-data",
      }),
    ).toMatchObject({
      providerKey: "ygojson",
      profileKey: "yugioh-sealed-product-reference-data",
      ingestionUnitIdentity: {
        unitKey: "ygojson:yugioh:sealed-product:reference-data",
        productDomain: "yugioh",
        productForm: "sealed-product",
      },
      profile: {
        normalizedObservationMapping: { kind: "yugioh-sealed-product" },
      },
    });
    expect(ygoprodeckYugiohCardReferenceProviderProfile.optionQueries.map((query) => query.operation)).toEqual([
      "ygoprodeck-list-sets",
      "ygoprodeck-list-cards",
    ]);
    expect(ygojsonYugiohSealedProductReferenceProviderProfile.optionQueries.map((query) => query.operation)).toEqual([
      "ygojson-list-sealed-products",
    ]);
  });

  it("lists active and planned providers through the same provider catalog", () => {
    expect(listCatalogProviderIntegrationProfiles().map((profile) => [profile.providerKey, profile.status])).toEqual([
      ["lorcanajson", "active"],
      ["lorcanajson", "active"],
      ["lorcast", "active"],
      ["lorcast", "active"],
      ["mtgjson", "active"],
      ["mtgjson", "active"],
      ["scrydex", "active"],
      ["scrydex", "active"],
      ["scrydex", "active"],
      ["scrydex", "active"],
      ["scrydex", "active"],
      ["scrydex", "active"],
      ["scryfall", "active"],
      ["scryfall", "active"],
      ["tcgdex", "active"],
      ["tcgplayer", "active"],
      ["tcgplayer", "active"],
      ["tcgplayer", "active"],
      ["tcgplayer", "active"],
      ["tcgplayer", "active"],
      ["tcgplayer", "active"],
      ["tcgplayer", "active"],
      ["tcgplayer", "active"],
      ["tcgplayer", "active"],
      ["ygojson", "active"],
      ["ygojson", "active"],
      ["ygoprodeck", "active"],
      ["ygoprodeck", "active"],
    ]);
  });

  it("wraps current profiles as versioned Catalog-owned seed data with source contract metadata", () => {
    const versions = listCatalogProviderIntegrationProfileVersions();

    expect(versions.map((version) => [version.providerKey, version.profileVersion, version.lifecycle])).toEqual([
      ["lorcanajson", "2026.06.23", "active"],
      ["lorcanajson", "2026.06.23", "active"],
      ["lorcast", "2026.06.23", "active"],
      ["lorcast", "2026.06.23", "active"],
      ["mtgjson", "2026.06.19", "active"],
      ["mtgjson", "2026.06.19", "active"],
      ["scrydex", "2026.06.23", "active"],
      ["scrydex", "2026.06.23", "active"],
      ["scrydex", "2026.06.23", "test"],
      ["scrydex", "2026.06.22", "active"],
      ["scrydex", "2026.06.22", "active"],
      ["scrydex", "2026.06.22", "active"],
      ["scryfall", "2026.06.19", "active"],
      ["scryfall", "2026.06.19", "active"],
      ["tcgdex", "2026.06.03", "active"],
      ["tcgplayer", "2026.07.13", "active"],
      ["tcgplayer", "2026.06.23", "active"],
      ["tcgplayer", "2026.06.23", "active"],
      ["tcgplayer", "2026.06.23", "active"],
      ["tcgplayer", "2026.06.22", "active"],
      ["tcgplayer", "2026.06.20", "active"],
      ["tcgplayer", "2026.06.19", "active"],
      ["tcgplayer", "2026.06.19", "active"],
      ["tcgplayer", "2026.06.05", "active"],
      ["ygojson", "2026.06.21", "active"],
      ["ygojson", "2026.06.21", "active"],
      ["ygoprodeck", "2026.06.21", "active"],
      ["ygoprodeck", "2026.06.21", "active"],
    ]);
    expect(getCatalogProviderIntegrationProfileVersion("mtgjson")).toMatchObject({
      providerKey: "mtgjson",
      profileKey: "mtg-card-reference-data",
      profileVersion: "2026.06.19",
      active: true,
      sourceContract: {
        repository: "chase-sets/chase-sets",
        fixtureSetVersion: "mtgjson-mtg-card-reference-production-v1",
      },
      retirementPlan: null,
      executableMappingContract: expect.objectContaining({
        providerKey: "mtgjson",
        profileKey: "mtg-card-reference-data",
        profileVersion: "2026.06.19",
        lifecycle: "active",
        sourceObservation: expect.any(Object),
      }),
    });
    expect(() => getActiveCatalogProviderIntegrationProfileVersion("MTGJSON")).toThrow(/multiple active profile units/);
    expect(
      getActiveCatalogProviderIntegrationProfileVersion("MTGJSON", {
        ingestionUnitKey: "mtgjson:mtg:set:reference-data",
      }),
    ).toMatchObject({
      providerKey: "mtgjson",
      profileKey: "mtg-set-reference-data",
    });
    expect(() => getActiveCatalogProviderIntegrationProfileVersion("LORCANAJSON")).toThrow(
      /multiple active profile units/,
    );
    expect(
      getCatalogProviderIntegrationProfileVersion("LORCANAJSON", null, {
        ingestionUnitKey: "lorcanajson:lorcana:set:reference-data",
      }),
    ).toMatchObject({
      providerKey: "lorcanajson",
      profileKey: "lorcana-set-reference-data",
    });
    expect(
      getActiveCatalogProviderIntegrationProfileVersion("LORCANAJSON", {
        ingestionUnitKey: "lorcanajson:lorcana:set:reference-data",
      }),
    ).toMatchObject({
      providerKey: "lorcanajson",
      profileKey: "lorcana-set-reference-data",
      sourceContract: {
        repository: "chase-sets/chase-sets",
        fixtureSetVersion: "lorcanajson-lorcana-set-reference-production-v1",
      },
      executableMappingContract: expect.objectContaining({
        providerKey: "lorcanajson",
        profileKey: "lorcana-set-reference-data",
        sourceObservation: expect.any(Object),
      }),
    });
    expect(() => getActiveCatalogProviderIntegrationProfileVersion("LORCAST")).toThrow(/multiple active profile units/);
    expect(
      getActiveCatalogProviderIntegrationProfileVersion("LORCAST", {
        ingestionUnitKey: "lorcast:lorcana:set:reference-data",
      }),
    ).toMatchObject({
      providerKey: "lorcast",
      profileKey: "lorcana-set-reference-data",
      sourceContract: {
        repository: null,
        fixtureSetVersion: "lorcast-lorcana-set-reference-production-v1",
      },
      executableMappingContract: expect.objectContaining({
        providerKey: "lorcast",
        profileKey: "lorcana-set-reference-data",
        sourceObservation: expect.any(Object),
      }),
    });
    expect(getCatalogProviderIntegrationProfileVersion("scryfall")).toMatchObject({
      providerKey: "scryfall",
      profileKey: "mtg-card-print-reference-data",
      profileVersion: "2026.06.19",
      active: true,
      sourceContract: {
        repository: "chase-sets/chase-sets",
        fixtureSetVersion: "scryfall-mtg-card-print-production-v1",
      },
      retirementPlan: null,
      executableMappingContract: expect.objectContaining({
        providerKey: "scryfall",
        profileKey: "mtg-card-print-reference-data",
        profileVersion: "2026.06.19",
        lifecycle: "active",
        sourceObservation: expect.any(Object),
      }),
    });
    expect(
      getCatalogProviderIntegrationProfileVersion("scryfall", "2026.06.19", {
        ingestionUnitKey: "scryfall:mtg:single-card:reference-data",
      })?.executableMappingContract,
    ).toMatchObject({
      providerKey: "scryfall",
      sourceObservation: {
        observationId: expect.any(Object),
      },
    });
    expect(() => getActiveCatalogProviderIntegrationProfileVersion("SCRYFALL")).toThrow(
      /multiple active profile units/,
    );
    expect(
      getActiveCatalogProviderIntegrationProfileVersion("SCRYFALL", {
        ingestionUnitKey: "scryfall:mtg:single-card:reference-data",
      }),
    ).toMatchObject({
      providerKey: "scryfall",
      profileKey: "mtg-card-print-reference-data",
    });
    expect(validateCatalogProviderIntegrationProfileVersion(catalogProviderIntegrationProfileVersions[1])).toEqual([]);
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
      profileKey: "mtg-single-card-product-sku",
      profileVersion: "2026.06.19",
      active: true,
      sourceContract: {
        repository: "chase-sets/chase-sets",
        fixtureSetVersion: "tcgplayer-mtg-single-card-production-v1",
      },
      retirementPlan: null,
      executableMappingContract: expect.objectContaining({
        providerKey: "tcgplayer",
        profileKey: "mtg-single-card-product-sku",
        profileVersion: "2026.06.19",
        lifecycle: "active",
        sourceObservation: expect.any(Object),
      }),
    });
    expect(getCatalogProviderSourceObservationMappingContract("TCGPLAYER")).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "mtg-single-card-product-sku",
      sourceObservation: {
        observationId: expect.any(Object),
      },
    });
    expect(() => getActiveCatalogProviderIntegrationProfileVersion("TCGPLAYER")).toThrow(
      /multiple active profile units/,
    );
    expect(
      getActiveCatalogProviderIntegrationProfileVersion("TCGPLAYER", {
        ingestionUnitKey: "tcgplayer:mtg:sealed-product:source-observation-import",
      }),
    ).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "mtg-sealed-product-sku",
    });
    expect(
      getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.05", {
        profileKey: "pokemon-single-card-product-sku",
      }),
    ).toMatchObject({
      providerKey: "tcgplayer",
      profileKey: "pokemon-single-card-product-sku",
      profileVersion: "2026.06.05",
      active: true,
      sourceContract: {
        repository: "todd-skelton/tcgplayer-automation-app",
        commit: "bf42aa8",
        fixtureSetVersion: "automation-client-contract-v1",
      },
      retirementPlan: null,
      executableMappingContract: expect.objectContaining({
        providerKey: "tcgplayer",
        profileKey: "pokemon-single-card-product-sku",
        profileVersion: "2026.06.05",
        lifecycle: "active",
        sourceObservation: expect.any(Object),
      }),
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

  it("gates every active Magic profile version on executable fixture-backed mapping coverage", () => {
    const fixtureCases = catalogProviderProfileFixtureCases();
    const activeMagicVersions = catalogProviderIntegrationProfileVersions.filter(
      (version) =>
        version.active &&
        version.lifecycle === "active" &&
        (executableContractProductDomain(version.executableMappingContract) === "mtg" ||
          version.profile.normalizedObservationMapping.kind.startsWith("magic-")),
    );

    expect(activeMagicVersions.map((version) => [version.providerKey, version.profileKey])).toEqual([
      ["mtgjson", "mtg-card-reference-data"],
      ["mtgjson", "mtg-set-reference-data"],
      ["scryfall", "mtg-card-print-reference-data"],
      ["scryfall", "mtg-card-image-evidence"],
      ["tcgplayer", "mtg-single-card-product-sku"],
      ["tcgplayer", "mtg-sealed-product-sku"],
    ]);
    expect(activeMagicVersions.some((version) => version.providerKey === "scrydex")).toBe(false);

    for (const version of activeMagicVersions) {
      expect(version.executableMappingContract, version.profileKey).toBeDefined();
      expect(version.fixtures.liveProviderCallsAllowed, version.profileKey).toBe(false);
      expect(version.fixtures.coveredFlows, version.profileKey).toEqual(catalogProviderRequiredFixtureFlows);
      expect(validateCatalogProviderIntegrationProfileVersion(version), version.profileKey).toEqual([]);

      const matchingCases = fixtureCases.filter(
        (fixtureCase) =>
          fixtureCase.providerKey === version.providerKey &&
          fixtureCase.profileKey === version.profileKey &&
          fixtureCase.profileVersion === version.profileVersion &&
          fixtureCase.ingestionUnitKey === catalogProviderProfileVersionIngestionUnitKey(version),
      );
      expect(
        matchingCases.map((fixtureCase) => fixtureCase.flow),
        version.profileKey,
      ).toEqual(catalogProviderRequiredFixtureFlows);
    }
  });

  it("blocks the retired Scrydex Scryfall-style Magic proof from production activation", () => {
    const retiredScrydexMagicProof = {
      providerKey: "scrydex",
      profileKey: "scryfall-card-fixture",
      profileVersion: "2026.06.03",
      lifecycle: "test",
      active: false,
      profile: scrydexScryfallCardProviderProfile,
      sourceContract: scrydexScryfallCardSourceObservationMappingContract.sourceContract,
      fixtures: scrydexScryfallCardSourceObservationMappingContract.fixtures,
      retirementPlan: null,
      executableMappingContract: scrydexScryfallCardSourceObservationMappingContract,
    } satisfies CatalogProviderIntegrationProfileVersionRecord;

    expect(() =>
      activateCatalogProviderIntegrationProfileVersion("scrydex", "2026.06.03", [retiredScrydexMagicProof]),
    ).toThrow(/retired Scrydex Scryfall-style Magic proof/);

    expect(
      validateCatalogProviderIntegrationProfileVersion({
        ...retiredScrydexMagicProof,
        lifecycle: "active",
        active: true,
        executableMappingContract: {
          ...scrydexScryfallCardSourceObservationMappingContract,
          lifecycle: "active",
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "retired-magic-scrydex-proof-active",
          path: "profile.connector.kind",
        }),
      ]),
    );
  });

  it("gates every active Lorcana profile version on executable fixture-backed mapping coverage", () => {
    const fixtureCases = catalogProviderProfileFixtureCases();
    const activeLorcanaVersions = catalogProviderIntegrationProfileVersions.filter(
      (version) =>
        version.active &&
        version.lifecycle === "active" &&
        executableContractProductDomain(version.executableMappingContract) === "lorcana" &&
        ["lorcanajson", "lorcast", "tcgplayer"].includes(version.providerKey),
    );

    expect(activeLorcanaVersions.map((version) => version.profileKey)).toEqual([
      "lorcana-card-reference-data",
      "lorcana-set-reference-data",
      "lorcana-card-reference-data",
      "lorcana-set-reference-data",
      "lorcana-single-card-product-sku",
      "lorcana-sealed-product-sku",
    ]);

    for (const version of activeLorcanaVersions) {
      expect(version.executableMappingContract, version.profileKey).toBeDefined();
      expect(version.fixtures.liveProviderCallsAllowed, version.profileKey).toBe(false);
      expect(version.fixtures.coveredFlows, version.profileKey).toEqual(catalogProviderRequiredFixtureFlows);
      expect(validateCatalogProviderIntegrationProfileVersion(version), version.profileKey).toEqual([]);

      const matchingCases = fixtureCases.filter(
        (fixtureCase) =>
          fixtureCase.providerKey === version.providerKey &&
          fixtureCase.profileVersion === version.profileVersion &&
          fixtureCase.profileKey === version.profileKey,
      );
      expect(
        new Set(matchingCases.map((fixtureCase) => fixtureCase.flow)),
        `${version.providerKey}/${version.profileKey}`,
      ).toEqual(new Set(catalogProviderRequiredFixtureFlows));
    }
  });

  it("gates every active Yu-Gi-Oh profile version on executable fixture-backed mapping coverage", () => {
    const fixtureCases = catalogProviderProfileFixtureCases();
    const activeYugiohVersions = catalogProviderIntegrationProfileVersions.filter(
      (version) =>
        version.active &&
        version.lifecycle === "active" &&
        executableContractProductDomain(version.executableMappingContract) === "yugioh" &&
        ["ygoprodeck", "ygojson", "tcgplayer"].includes(version.providerKey),
    );

    expect(activeYugiohVersions.map((version) => version.profileKey)).toEqual([
      "yugioh-card-print-reference-data",
      "yugioh-set-reference-data",
      "yugioh-set-reference-data",
      "yugioh-sealed-product-reference-data",
      "yugioh-single-card-product-sku",
    ]);

    for (const version of activeYugiohVersions) {
      expect(version.executableMappingContract, version.profileKey).toBeDefined();
      expect(version.fixtures.liveProviderCallsAllowed, version.profileKey).toBe(false);
      expect(version.fixtures.coveredFlows, version.profileKey).toEqual(catalogProviderRequiredFixtureFlows);
      expect(validateCatalogProviderIntegrationProfileVersion(version), version.profileKey).toEqual([]);

      const matchingCases = fixtureCases.filter(
        (fixtureCase) =>
          fixtureCase.providerKey === version.providerKey &&
          fixtureCase.profileKey === version.profileKey &&
          fixtureCase.profileVersion === version.profileVersion &&
          fixtureCase.ingestionUnitKey === catalogProviderProfileVersionIngestionUnitKey(version),
      );
      expect(
        matchingCases.map((fixtureCase) => fixtureCase.flow),
        version.profileKey,
      ).toEqual(catalogProviderRequiredFixtureFlows);
    }
  });

  it("gates every active One Piece provider profile version on executable fixture-backed mapping coverage", () => {
    const fixtureCases = catalogProviderProfileFixtureCases();
    const activeOnePieceVersions = catalogProviderIntegrationProfileVersions.filter(
      (version) =>
        version.active &&
        version.lifecycle === "active" &&
        executableContractProductDomain(version.executableMappingContract) === "one-piece",
    );

    expect(activeOnePieceVersions.map((version) => version.profileKey)).toEqual([
      "one-piece-card-print-source-observation",
      "one-piece-set-reference-data",
      "one-piece-sealed-product-source-observation",
      "one-piece-single-card-product-sku",
      "one-piece-sealed-product-sku",
    ]);
    expect(activeOnePieceVersions.map(catalogProviderProfileVersionIngestionUnitKey)).not.toContain(
      "scrydex:one-piece:price-history:reference-data",
    );

    for (const version of activeOnePieceVersions) {
      expect(version.executableMappingContract, version.profileKey).toBeDefined();
      expect(version.fixtures.liveProviderCallsAllowed, version.profileKey).toBe(false);
      expect(version.fixtures.coveredFlows, version.profileKey).toEqual(catalogProviderRequiredFixtureFlows);
      expect(validateCatalogProviderIntegrationProfileVersion(version), version.profileKey).toEqual([]);

      const matchingCases = fixtureCases.filter(
        (fixtureCase) =>
          fixtureCase.providerKey === version.providerKey &&
          fixtureCase.profileKey === version.profileKey &&
          fixtureCase.profileVersion === version.profileVersion &&
          fixtureCase.ingestionUnitKey === catalogProviderProfileVersionIngestionUnitKey(version),
      );
      expect(
        matchingCases.map((fixtureCase) => fixtureCase.flow),
        version.profileKey,
      ).toEqual(catalogProviderRequiredFixtureFlows);
    }
  });

  it("blocks explicit ingestion-unit identity drift between profile versions and executable contracts", () => {
    const tcgplayerVersion = executableTcgplayerVersion();

    expect(
      validateCatalogProviderIntegrationProfileVersion({
        ...tcgplayerVersion,
        ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
          providerKey: "tcgplayer",
          productDomain: "mtg",
          productForm: "sealed-product",
          ingestionPurpose: "source-observation-import",
        }),
        executableMappingContract: {
          ...tcgplayerVersion.executableMappingContract!,
          ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
            providerKey: "tcgplayer",
            productDomain: "mtg",
            productForm: "single-card",
            ingestionPurpose: "source-observation-import",
          }),
        },
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ingestion-unit-identity-mismatch" })]));
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

  it("keeps same-provider different-unit active profile versions side by side", () => {
    const pokemonActive = executableVersion("2026.06.03", "active");
    const mtgActive = executableVersionWithUnit("2026.06.04", "active", "magic-card-profile", {
      productDomain: "mtg",
      productForm: "single-card",
      ingestionPurpose: "source-observation-import",
    });
    const mtgNext = executableVersionWithUnit("2026.06.05", "test", "magic-card-profile", {
      productDomain: "mtg",
      productForm: "single-card",
      ingestionPurpose: "source-observation-import",
    });

    const activated = activateCatalogProviderIntegrationProfileVersion("tcgdex", "2026.06.05", [
      pokemonActive,
      mtgActive,
      mtgNext,
    ]);

    expect(
      activated.map((version) => [version.profileKey, version.profileVersion, version.lifecycle, version.active]),
    ).toEqual([
      ["pokemon-tcg", "2026.06.03", "active", true],
      ["magic-card-profile", "2026.06.04", "deprecated", false],
      ["magic-card-profile", "2026.06.05", "active", true],
    ]);
  });

  it("keeps provider-only active lookup compatible for one unit and fails closed for ambiguous units", () => {
    const pokemonActive = executableVersion("2026.06.03", "active");
    const mtgActive = executableVersionWithUnit("2026.06.04", "active", "magic-card-profile", {
      productDomain: "mtg",
      productForm: "single-card",
      ingestionPurpose: "source-observation-import",
    });

    expect(getActiveCatalogProviderIntegrationProfileVersion("tcgdex", null, [pokemonActive])).toBe(pokemonActive);
    expect(() => getActiveCatalogProviderIntegrationProfileVersion("tcgdex", null, [pokemonActive, mtgActive])).toThrow(
      /multiple active profile units/,
    );
    expect(
      getActiveCatalogProviderIntegrationProfileVersion(
        "tcgdex",
        { ingestionUnitKey: catalogProviderProfileVersionIngestionUnitKey(mtgActive) },
        [pokemonActive, mtgActive],
      ),
    ).toBe(mtgActive);
  });

  it("requires a selector when the same provider reuses a profile version label across units", () => {
    const pokemonActive = executableVersion("2026.06.03", "active");
    const mtgNext = executableVersionWithUnit("2026.06.03", "test", "magic-card-profile", {
      productDomain: "mtg",
      productForm: "single-card",
      ingestionPurpose: "source-observation-import",
    });

    expect(() => getCatalogProviderIntegrationProfileVersion("tcgdex", "2026.06.03", [pokemonActive, mtgNext])).toThrow(
      /multiple profile units/,
    );
    expect(
      getCatalogProviderIntegrationProfileVersion("tcgdex", "2026.06.03", { profileKey: "magic-card-profile" }, [
        pokemonActive,
        mtgNext,
      ]),
    ).toBe(mtgNext);

    const activated = activateCatalogProviderIntegrationProfileVersion(
      "tcgdex",
      "2026.06.03",
      [pokemonActive, mtgNext],
      { profileKey: "magic-card-profile" },
    );

    expect(
      activated.map((version) => [version.profileKey, version.profileVersion, version.lifecycle, version.active]),
    ).toEqual([
      ["pokemon-tcg", "2026.06.03", "active", true],
      ["magic-card-profile", "2026.06.03", "active", true],
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

function executableVersionWithUnit(
  profileVersion: string,
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"],
  profileKey: string,
  unit: Readonly<{
    productDomain: "pokemon" | "mtg";
    productForm: "single-card" | "sealed-product" | "set";
    ingestionPurpose: "source-observation-import" | "reference-data" | "image-evidence";
  }>,
): CatalogProviderIntegrationProfileVersionRecord {
  const base = executableVersion(profileVersion, lifecycle);
  const ingestionUnitIdentity = defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: base.providerKey,
    ...unit,
  });
  return {
    ...base,
    profileKey,
    ingestionUnitIdentity,
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          profileKey,
          ingestionUnitIdentity,
        }
      : undefined,
  };
}

function executableTcgplayerVersion(): CatalogProviderIntegrationProfileVersionRecord {
  const tcgplayerVersion = getCatalogProviderIntegrationProfileVersion("tcgplayer")!;
  return {
    ...tcgplayerVersion,
    profileVersion: "2026.06.02",
  };
}

function executableContractProductDomain(
  contract: CatalogProviderIntegrationProfileVersionRecord["executableMappingContract"],
): string | null {
  return (
    (contract as Readonly<{ ingestionUnitIdentity?: Readonly<{ productDomain?: string }> }> | undefined)
      ?.ingestionUnitIdentity?.productDomain ?? null
  );
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
