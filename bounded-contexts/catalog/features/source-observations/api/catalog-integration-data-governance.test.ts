import { describe, expect, it } from "vitest";
import {
  CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION,
  CATALOG_INTEGRATION_LORCANA_PRODUCTION_SIGNOFF_REFERENCE_ENV,
  CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE_ENV,
  TCGDEX_INDONESIAN_LANGUAGE_CODE,
  catalogAliasAcceptanceAuditRequirements,
  catalogAliasOfficialEnglishPrecedenceOrder,
  catalogAliasSourceGovernancePolicies,
  catalogAliasSourceGovernancePoliciesByCategory,
  catalogAliasTranslationProviderRequirements,
  catalogIntegrationDataGovernancePolicies,
  catalogIntegrationDataGovernancePoliciesByKey,
  catalogIntegrationLorcanaOfficialValidationScopes,
  catalogIntegrationLorcanaProviderAuthorityPolicies,
  catalogIntegrationLorcanaValidationChecks,
  catalogIntegrationOnePieceProviderAuthorityPolicies,
  catalogIntegrationOnePieceValidationChecks,
  catalogIntegrationProviderDataSignoffChecklist,
  catalogIntegrationScrydexLorcanaBulkImportPolicy,
  catalogIntegrationScrydexOnePieceBulkImportPolicy,
  decideCatalogAliasAcceptance,
  evaluateCatalogIntegrationProviderDataUse,
  getCatalogAliasSourceGovernancePolicy,
  getCatalogIntegrationDataGovernancePolicy,
  isRejectedNonEnglishLanguageCode,
  redactCatalogIntegrationProviderData,
  resolveCatalogAliasOfficialEnglish,
  type CatalogAliasSourceCategoryKey,
  type CatalogIntegrationGovernedDataClassKey,
} from "./catalog-integration-data-governance";

describe("Catalog integration data governance", () => {
  it("defines the #794 governed provider-data class inventory", () => {
    const expected: readonly CatalogIntegrationGovernedDataClassKey[] = [
      "raw-provider-payload",
      "sampled-provider-payload",
      "fixture-payload",
      "dry-run-input-payload",
      "dry-run-output-evidence",
      "engine-diagnostic",
      "provider-transport-diagnostic",
      "provider-credential-readiness",
      "provider-usage-summary",
      "audit-evidence",
      "job-progress-summary",
    ];

    expect(catalogIntegrationDataGovernancePolicies.map((policy) => policy.key)).toEqual(expected);
    expect(Object.keys(catalogIntegrationDataGovernancePoliciesByKey).sort()).toEqual([...expected].sort());
  });

  it("requires every data class to declare retention, redaction, access, export, logging, and evidence policy", () => {
    for (const policy of catalogIntegrationDataGovernancePolicies) {
      expect(policy.displayName.length).toBeGreaterThan(10);
      expect(policy.owner).toMatch(/^(catalog-source-observations|provider-adapter)$/);
      expect(policy.retentionPolicy.length).toBeGreaterThan(0);
      expect(policy.rawBodyPolicy.length).toBeGreaterThan(0);
      expect(policy.adminVisibility.length).toBeGreaterThan(0);
      expect(policy.exportPolicy.length).toBeGreaterThan(0);
      expect(policy.loggingPolicy).toMatch(/log|logs/i);
      expect(policy.allowedEvidence.length).toBeGreaterThan(0);
      expect(policy.redactedPathPatterns.length).toBeGreaterThan(0);
    }
  });

  it("gates raw provider, sampled provider, fixture, and dry-run body retention behind signoff", () => {
    expect(getCatalogIntegrationDataGovernancePolicy("raw-provider-payload")).toMatchObject({
      retentionPolicy: "request-only",
      rawBodyPolicy: "forbidden",
      exportPolicy: "no-export",
    });
    expect(getCatalogIntegrationDataGovernancePolicy("sampled-provider-payload").signoffTriggers).toEqual(
      expect.arrayContaining(["retain-real-provider-sample", "store-raw-body"]),
    );
    expect(getCatalogIntegrationDataGovernancePolicy("fixture-payload").signoffTriggers).toEqual(
      expect.arrayContaining(["retain-fixture-body", "include-provider-imagery"]),
    );
    expect(getCatalogIntegrationDataGovernancePolicy("dry-run-input-payload").signoffTriggers).toEqual(
      expect.arrayContaining(["retain-dry-run-body"]),
    );
    expect(getCatalogIntegrationDataGovernancePolicy("provider-usage-summary")).toMatchObject({
      owner: "provider-adapter",
      retentionPolicy: "retain-redacted-summary",
      rawBodyPolicy: "redacted-preview-only",
      exportPolicy: "redacted-summary-only",
    });
  });

  it("blocks retained real-provider fixture use without policy/legal signoff and retained-data exception", () => {
    const findings = evaluateCatalogIntegrationProviderDataUse({
      dataClass: "fixture-payload",
      providerKey: "tcgdex",
      retainsFixtureBody: true,
      includesProviderImagery: true,
      hasPolicyLegalSignoff: false,
      retainedDataExceptionIssue: null,
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "provider-data-signoff-required",
      "retained-data-exception-required",
    ]);
  });

  it("allows redacted sampled payload retention only after signoff and exception evidence exists", () => {
    expect(
      evaluateCatalogIntegrationProviderDataUse({
        dataClass: "sampled-provider-payload",
        providerKey: "tcgdex",
        retainsRealProviderSample: true,
        hasPolicyLegalSignoff: true,
        retainedDataExceptionIssue: 804,
      }),
    ).toEqual([]);
  });

  it("redacts provider secrets, seller/account facts, price, inventory, and listing evidence recursively", () => {
    const redacted = redactCatalogIntegrationProviderData({
      id: "provider-card-1",
      name: "Furret",
      headers: {
        Authorization: "Bearer token",
        Cookie: "TCGAuthTicket_Production=session",
      },
      seller: {
        sellerId: 123,
        sellerName: "Seller Name",
        sellerEmail: "seller@example.com",
        phone: "555-1234",
      },
      skus: [
        {
          skuId: 100,
          price: 1.23,
          inventoryQuantity: 9,
          condition: "Near Mint",
        },
      ],
      listingUrl: "https://example.test/listing/1",
    });

    expect(redacted).toEqual({
      id: "provider-card-1",
      name: "Furret",
      headers: {
        Authorization: "<redacted>",
        Cookie: "<redacted>",
      },
      seller: {
        sellerId: "<redacted>",
        sellerName: "<redacted>",
        sellerEmail: "<redacted>",
        phone: "<redacted>",
      },
      skus: [
        {
          skuId: 100,
          price: "<redacted>",
          inventoryQuantity: "<redacted>",
          condition: "Near Mint",
        },
      ],
      listingUrl: "<redacted>",
    });
  });

  it("publishes the provider-data signoff checklist for release verification", () => {
    expect(catalogIntegrationProviderDataSignoffChecklist()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("governed data class"),
        expect.stringContaining("policy/legal signoff"),
        expect.stringContaining("Admin UI surfaces"),
        expect.stringContaining("logs, metrics, traces"),
      ]),
    );
  });
});

describe("One Piece provider-data governance (#2269, #2270, #2287)", () => {
  it("records the production signoff reference environment gate", () => {
    expect(CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE_ENV).toBe(
      "CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE",
    );
  });

  it("defines provider authority without making official or fallback sources default ingestion providers", () => {
    expect(catalogIntegrationOnePieceProviderAuthorityPolicies.map((policy) => policy.key)).toEqual([
      "scrydex-one-piece",
      "tcgplayer-one-piece",
      "bandai-one-piece-official",
      "one-piece-fallback-sources",
    ]);

    const scrydex = catalogIntegrationOnePieceProviderAuthorityPolicies.find(
      (policy) => policy.key === "scrydex-one-piece",
    );
    const tcgplayer = catalogIntegrationOnePieceProviderAuthorityPolicies.find(
      (policy) => policy.key === "tcgplayer-one-piece",
    );
    const bandai = catalogIntegrationOnePieceProviderAuthorityPolicies.find(
      (policy) => policy.key === "bandai-one-piece-official",
    );
    const fallback = catalogIntegrationOnePieceProviderAuthorityPolicies.find(
      (policy) => policy.key === "one-piece-fallback-sources",
    );

    expect(scrydex).toMatchObject({
      providerKey: "scrydex",
      displayName: "Scrydex One Piece",
    });
    expect(scrydex?.catalogAuthority).toEqual(
      expect.arrayContaining(["card and variant identifiers", "sealed product identifiers and packaging labels"]),
    );
    expect(scrydex?.notCatalogTruth).toEqual(expect.arrayContaining(["API keys or team ids", "seller facts"]));
    expect(scrydex?.activationRequirement).toMatch(/bulk-first call-budget evidence/i);

    expect(tcgplayer?.catalogAuthority).toEqual(
      expect.arrayContaining([
        "product id external-reference candidates",
        "SKU external-product-reference candidates after selected options validate",
      ]),
    );
    expect(tcgplayer?.notCatalogTruth).toEqual(
      expect.arrayContaining(["market prices as Catalog truth", "session material"]),
    );

    expect(bandai?.productionRole).toMatch(/validation reference/i);
    expect(bandai?.notCatalogTruth).toEqual(
      expect.arrayContaining(["raw official page text", "scraped payload bodies"]),
    );

    expect(fallback?.productionRole).toMatch(/Comparison-only/i);
    expect(fallback?.notCatalogTruth).toEqual(expect.arrayContaining(["default production authority"]));
  });

  it("requires Scrydex One Piece imports to be bulk-first and credit-aware", () => {
    expect(catalogIntegrationScrydexOnePieceBulkImportPolicy).toMatchObject({
      providerKey: "scrydex",
      productLineKey: "one-piece",
      requestStrategy: "bulk-first",
      evidenceDataClass: "provider-usage-summary",
    });
    expect(catalogIntegrationScrydexOnePieceBulkImportPolicy.allowedRequestShapes).toEqual(
      expect.arrayContaining(["paginated-list", "paginated-search", "bulk-filtered-search", "usage-check"]),
    );
    expect(catalogIntegrationScrydexOnePieceBulkImportPolicy.forbiddenNormalPatterns).toEqual(
      expect.arrayContaining([
        "one Scrydex card request per card",
        "one Scrydex sealed-product request per sealed product",
      ]),
    );
    expect(catalogIntegrationScrydexOnePieceBulkImportPolicy.perRecordFallbackRequirement).toMatch(
      /no bulk\/list\/search endpoint/i,
    );
    expect(catalogIntegrationScrydexOnePieceBulkImportPolicy.requiredPreflightEvidence).toEqual(
      expect.arrayContaining([
        "estimated request count or estimate-unavailable diagnostic",
        "credit or usage readiness",
      ]),
    );
    expect(catalogIntegrationScrydexOnePieceBulkImportPolicy.requiredPostRunEvidence).toEqual(
      expect.arrayContaining(["actual request count", "bulk-first confirmation or per-record fallback reason"]),
    );
  });

  it("defines representative Bandai validation checks without making Bandai or fallback sources import authority", () => {
    expect(catalogIntegrationOnePieceValidationChecks.map((check) => check.target)).toEqual([
      "card",
      "expansion",
      "sealed-product",
    ]);

    for (const check of catalogIntegrationOnePieceValidationChecks) {
      expect(check.validationSource).toBe("bandai-one-piece-official");
      expect(check.comparedProviders).toEqual(expect.arrayContaining(["scrydex-one-piece"]));
      expect(check.allowedEvidence.join(" ")).toMatch(/redacted|normalized|diagnostic|checklist/i);
      expect(check.forbiddenEvidence).toEqual(
        expect.arrayContaining([expect.stringMatching(/official .*text/i), "official imagery copies"]),
      );
      expect(check.operatorEvidenceRequirement).toMatch(/Admin interface/i);
      expect(check.fallbackSourcePolicy).toMatch(/comparison-only/i);
      expect(check.fallbackSourcePolicy).toMatch(/after named approval|cannot/i);
    }

    expect(catalogIntegrationOnePieceValidationChecks.find((check) => check.target === "card")).toMatchObject({
      key: "one-piece-card-release-validation",
      comparedFieldClasses: expect.arrayContaining(["card number", "expansion membership"]),
    });
    expect(catalogIntegrationOnePieceValidationChecks.find((check) => check.target === "sealed-product")).toMatchObject(
      {
        comparedProviders: expect.arrayContaining(["tcgplayer-one-piece"]),
        comparedFieldClasses: expect.arrayContaining(["marketplace product/SKU bridge evidence"]),
      },
    );
  });
});

describe("Lorcana provider-data governance (#2464, #2466, #2472, #2473)", () => {
  it("records the production signoff reference environment gate", () => {
    expect(CATALOG_INTEGRATION_LORCANA_PRODUCTION_SIGNOFF_REFERENCE_ENV).toBe(
      "CATALOG_INTEGRATION_LORCANA_PRODUCTION_SIGNOFF_REFERENCE",
    );
  });

  it("defines provider authority without making official validation a default ingestion provider", () => {
    expect(catalogIntegrationLorcanaProviderAuthorityPolicies.map((policy) => policy.key)).toEqual([
      "lorcanajson-lorcana",
      "lorcast-lorcana",
      "tcgplayer-lorcana",
      "scrydex-lorcana",
      "ravensburger-lorcana-official",
    ]);

    const lorcanajson = catalogIntegrationLorcanaProviderAuthorityPolicies.find(
      (policy) => policy.key === "lorcanajson-lorcana",
    );
    const lorcast = catalogIntegrationLorcanaProviderAuthorityPolicies.find(
      (policy) => policy.key === "lorcast-lorcana",
    );
    const tcgplayer = catalogIntegrationLorcanaProviderAuthorityPolicies.find(
      (policy) => policy.key === "tcgplayer-lorcana",
    );
    const scrydex = catalogIntegrationLorcanaProviderAuthorityPolicies.find(
      (policy) => policy.key === "scrydex-lorcana",
    );
    const official = catalogIntegrationLorcanaProviderAuthorityPolicies.find(
      (policy) => policy.key === "ravensburger-lorcana-official",
    );

    expect(lorcanajson).toMatchObject({
      providerKey: "lorcanajson",
      displayName: "LorcanaJSON",
    });
    expect(lorcanajson?.productionRole).toMatch(/bulk-first/i);
    expect(lorcanajson?.catalogAuthority).toEqual(
      expect.arrayContaining(["set/chapter identifiers", "card print identifiers"]),
    );

    expect(lorcast?.catalogAuthority).toEqual(
      expect.arrayContaining(["set-scoped card lookup evidence", "TCGplayer id bridge candidates"]),
    );
    expect(lorcast?.notCatalogTruth).toEqual(expect.arrayContaining([expect.stringMatching(/canonical winner/i)]));

    expect(tcgplayer?.catalogAuthority).toEqual(
      expect.arrayContaining([
        "product id external-reference candidates",
        "SKU external-product-reference candidates after selected options validate",
      ]),
    );
    expect(tcgplayer?.notCatalogTruth).toEqual(
      expect.arrayContaining(["market prices as Catalog truth", "TCGCSV as a production provider"]),
    );

    expect(scrydex?.catalogAuthority).toEqual(
      expect.arrayContaining([
        "sealed product identifiers and packaging labels",
        "provider freshness, usage, credit, and cache diagnostics",
      ]),
    );
    expect(scrydex?.notCatalogTruth).toEqual(
      expect.arrayContaining(["API keys or team ids", "per-game Scrydex credential settings"]),
    );
    expect(scrydex?.activationRequirement).toMatch(/bulk-first call-budget evidence/i);

    expect(official?.productionRole).toMatch(/Canonical validation reference/i);
    expect(official?.notCatalogTruth).toEqual(
      expect.arrayContaining(["raw official page text", "scraped payload bodies"]),
    );
  });

  it("requires Scrydex Lorcana imports to use shared credentials and bulk-first credit-aware transport", () => {
    expect(catalogIntegrationScrydexLorcanaBulkImportPolicy).toMatchObject({
      providerKey: "scrydex",
      productLineKey: "lorcana",
      requestStrategy: "bulk-first",
      evidenceDataClass: "provider-usage-summary",
    });
    expect(catalogIntegrationScrydexLorcanaBulkImportPolicy.allowedRequestShapes).toEqual(
      expect.arrayContaining(["paginated-list", "paginated-search", "bulk-filtered-search", "usage-check"]),
    );
    expect(catalogIntegrationScrydexLorcanaBulkImportPolicy.forbiddenNormalPatterns).toEqual(
      expect.arrayContaining([
        "one Scrydex card request per card",
        "one Scrydex sealed-product request per sealed product",
        "per-game Scrydex credential lookup",
      ]),
    );
    expect(catalogIntegrationScrydexLorcanaBulkImportPolicy.requiredPreflightEvidence).toEqual(
      expect.arrayContaining([
        "shared credential readiness",
        "estimated request count or estimate-unavailable diagnostic",
      ]),
    );
    expect(catalogIntegrationScrydexLorcanaBulkImportPolicy.requiredPostRunEvidence).toEqual(
      expect.arrayContaining(["actual request count", "bulk-first confirmation or per-record fallback reason"]),
    );
  });

  it("defines Ravensburger validation checks without making official pages an import source", () => {
    expect(catalogIntegrationLorcanaValidationChecks.map((check) => check.target)).toEqual([
      "card",
      "set",
      "sealed-product",
      "official-deck",
    ]);

    for (const check of catalogIntegrationLorcanaValidationChecks) {
      expect(check.validationSource).toBe("ravensburger-lorcana-official");
      expect(check.allowedEvidence.join(" ")).toMatch(/redacted|normalized|diagnostic|checklist/i);
      expect(check.forbiddenEvidence).toEqual(
        expect.arrayContaining([expect.stringMatching(/official .*text/i), "official imagery copies"]),
      );
      expect(check.operatorEvidenceRequirement).toMatch(/Admin interface/i);
      expect(check.fallbackSourcePolicy).toMatch(/comparison-only/i);
    }

    expect(catalogIntegrationLorcanaValidationChecks.find((check) => check.target === "set")).toMatchObject({
      key: "lorcana-set-release-validation",
      comparedFieldClasses: expect.arrayContaining(["release date", "official app reference"]),
    });
    expect(catalogIntegrationLorcanaValidationChecks.find((check) => check.target === "sealed-product")).toMatchObject({
      comparedProviders: expect.arrayContaining(["tcgplayer-lorcana"]),
      comparedFieldClasses: expect.arrayContaining(["marketplace product/SKU bridge evidence"]),
    });
  });

  it("requires official validation coverage for a current Lorcana set and the older First Chapter set", () => {
    expect(catalogIntegrationLorcanaOfficialValidationScopes.map((scope) => scope.releasePosition)).toEqual([
      "current-or-most-recent-main-set",
      "older-main-set",
    ]);

    const current = catalogIntegrationLorcanaOfficialValidationScopes.find(
      (scope) => scope.releasePosition === "current-or-most-recent-main-set",
    );
    const older = catalogIntegrationLorcanaOfficialValidationScopes.find(
      (scope) => scope.releasePosition === "older-main-set",
    );

    expect(current).toMatchObject({
      displayName: "Operator-selected current or most recent main Lorcana set",
      setCode: null,
      evidenceDataClass: "audit-evidence",
    });
    expect(current?.requiredTargets).toEqual(expect.arrayContaining(["card", "set", "sealed-product"]));
    expect(current?.requiredFactClasses).toEqual(
      expect.arrayContaining(["release date", "card-gallery presence", "official product lineup"]),
    );
    expect(current?.evidenceRequirement).toMatch(/Admin interface/i);
    expect(current?.evidenceRequirement).toMatch(/redacted official-reference labels only/i);

    expect(older).toMatchObject({
      displayName: "The First Chapter",
      setCode: "TFC",
      evidenceDataClass: "audit-evidence",
    });
    expect(older?.requiredTargets).toEqual(expect.arrayContaining(["card", "set", "sealed-product", "official-deck"]));
    expect(older?.requiredFactClasses).toEqual(
      expect.arrayContaining(["printed total", "starter deck or official deck evidence"]),
    );
    expect(older?.evidenceRequirement).toMatch(/Admin interface/i);
    expect(older?.evidenceRequirement).toMatch(/redacted official-reference labels only/i);
  });
});

describe("Catalog alias source governance (#1912)", () => {
  it("defines the #1912 approved alias source category inventory", () => {
    const expected: readonly CatalogAliasSourceCategoryKey[] = [
      "official-english-source",
      "curated-operator-mapping",
      "provider-same-id-localized-endpoint",
      "provider-localized-name",
      "species-reference",
      "machine-translation",
      "romanization",
    ];

    expect(catalogAliasSourceGovernancePolicies.map((policy) => policy.category)).toEqual(expected);
    expect(Object.keys(catalogAliasSourceGovernancePoliciesByCategory).sort()).toEqual([...expected].sort());
  });

  it("requires every alias source category to declare a coherent governance shape", () => {
    for (const policy of catalogAliasSourceGovernancePolicies) {
      expect(policy.displayName.length).toBeGreaterThan(3);
      expect(policy.acceptancePolicy).toMatch(/^(auto-accept|require-review|never-official)$/);
      expect(policy.producibleAliasTypes.length).toBeGreaterThan(0);
      expect(policy.notes.length).toBeGreaterThan(10);
      // Only categories that can be official may auto-accept; never-official is never official.
      if (policy.acceptancePolicy === "auto-accept") {
        expect(policy.canProvideOfficialEnglish).toBe(true);
      }
      if (policy.acceptancePolicy === "never-official") {
        expect(policy.canProvideOfficialEnglish).toBe(false);
        expect(policy.evidenceMarkedLowConfidence).toBe(true);
      }
      // Official-English categories must carry a precedence rank; others must not.
      if (policy.canProvideOfficialEnglish) {
        expect(policy.officialEnglishPrecedence).toBeTypeOf("number");
      } else {
        expect(policy.officialEnglishPrecedence).toBeNull();
      }
    }
  });

  it("orders official-English source precedence for promotion conflict tiebreaks (#1909)", () => {
    expect(catalogAliasOfficialEnglishPrecedenceOrder()).toEqual([
      "official-english-source",
      "curated-operator-mapping",
      "provider-same-id-localized-endpoint",
    ]);
  });

  it("auto-accepts an approved official English source and stamps the policy version", () => {
    const decision = decideCatalogAliasAcceptance({
      category: "official-english-source",
      languageCode: "en",
      hasLegalSourceApproval: true,
    });

    expect(decision.reviewState).toBe("auto-accepted");
    expect(decision.official).toBe(true);
    expect(decision.policyVersion).toBe(CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION);
  });

  it("holds an auto-accept category for review until legal/source approval is recorded", () => {
    const decision = decideCatalogAliasAcceptance({
      category: "official-english-source",
      languageCode: "en",
      hasLegalSourceApproval: false,
    });

    expect(decision.reviewState).toBe("pending");
    expect(decision.official).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/legal\/source approval/i);
  });

  it("keeps provider same-id localized endpoint aliases pending review", () => {
    expect(
      decideCatalogAliasAcceptance({
        category: "provider-same-id-localized-endpoint",
        languageCode: "en",
        hasLegalSourceApproval: true,
      }).reviewState,
    ).toBe("pending");
  });

  it("never lets generated translations or romanizations become official equivalents", () => {
    for (const category of ["machine-translation", "romanization"] as const) {
      const decision = decideCatalogAliasAcceptance({ category });
      expect(decision.reviewState).toBe("pending");
      expect(decision.official).toBe(false);
      expect(decision.evidenceMarkedLowConfidence).toBe(true);
      expect(getCatalogAliasSourceGovernancePolicy(category).producibleAliasTypes).not.toContain("official-equivalent");
    }
  });

  it("rejects TCGdex `id` (Indonesian) as English evidence everywhere", () => {
    expect(TCGDEX_INDONESIAN_LANGUAGE_CODE).toBe("id");
    expect(isRejectedNonEnglishLanguageCode("id")).toBe(true);
    expect(isRejectedNonEnglishLanguageCode("ID")).toBe(true);
    expect(isRejectedNonEnglishLanguageCode("en")).toBe(false);
    expect(isRejectedNonEnglishLanguageCode(null)).toBe(false);

    const decision = decideCatalogAliasAcceptance({
      category: "official-english-source",
      languageCode: "id",
      hasLegalSourceApproval: true,
    });
    expect(decision.reviewState).toBe("pending");
    expect(decision.reasons.join(" ")).toMatch(/Indonesian/);
  });

  it("breaks official-English ties by source precedence and discards Indonesian evidence", () => {
    const resolution = resolveCatalogAliasOfficialEnglish([
      { category: "provider-same-id-localized-endpoint", englishName: "Furret (provider)" },
      { category: "official-english-source", englishName: "Furret" },
      { category: "official-english-source", englishName: "Furret (id)", languageCode: "id" },
      { category: "machine-translation", englishName: "Big Ferret" },
    ]);

    expect(resolution.winner?.category).toBe("official-english-source");
    expect(resolution.winner?.englishName).toBe("Furret");
    expect(resolution.rejected.map((entry) => entry.reason).sort()).toEqual([
      "category-cannot-be-official",
      "non-english-evidence",
      "outranked",
    ]);
  });

  it("returns no winner when every candidate is non-English or non-official", () => {
    const resolution = resolveCatalogAliasOfficialEnglish([
      { category: "official-english-source", englishName: "x", languageCode: "id" },
      { category: "romanization", englishName: "y" },
    ]);

    expect(resolution.winner).toBeNull();
    expect(resolution.rejected).toHaveLength(2);
  });

  it("requires the governing policy version in alias acceptance audit evidence", () => {
    expect(catalogAliasAcceptanceAuditRequirements()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("governing policy version"),
        expect.stringContaining(CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION),
        expect.stringContaining("revoked"),
      ]),
    );
  });

  it("publishes translation provider adapter governance requirements", () => {
    const requirements = catalogAliasTranslationProviderRequirements();
    expect(requirements.join(" ")).toMatch(/low-confidence/i);
    expect(requirements.join(" ")).toMatch(/never.*official/i);
    expect(requirements.join(" ")).toMatch(/fixtures/i);
    expect(requirements.join(" ")).toMatch(/id.*Indonesian/i);
  });
});
