import { describe, expect, it } from "vitest";

import {
  assembleCatalogProviderIngestionUnitProfileSections,
  catalogProviderProfileActivationReadinessInput,
  catalogProviderProfileModelsRawGradedAsConditionSemantics,
  canEditCatalogProviderIngestionUnitProfile,
  defineCatalogProviderIngestionUnitProfileIdentity,
  evaluateCatalogProviderProfileActivationReadiness,
  evaluateCatalogProviderProfileLifecyclePolicy,
} from "./provider-profile-sections";
import {
  defineCatalogProviderIngestionUnitIdentityContract,
  type CatalogProviderIngestionPurpose,
  type CatalogProviderIngestionUnitProductForm,
} from "./provider-integration-mapping-contract";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";

describe("Catalog provider profile section domain", () => {
  it("assembles seeded profile versions into Catalog-facing ingestion-unit sections", () => {
    const sectionsByProfile = Object.fromEntries(
      catalogProviderIntegrationProfileVersions.map((version) => [
        version.profileKey,
        assembleCatalogProviderIngestionUnitProfileSections(version),
      ]),
    );

    expect(sectionsByProfile["pokemon-tcg"].ingestionUnitIdentity.value.unitKey).toBe(
      "tcgdex:pokemon:single-card:source-observation-import",
    );
    expect(sectionsByProfile["pokemon-single-card-product-sku"].ingestionUnitIdentity.value.unitKey).toBe(
      "tcgplayer:pokemon:single-card:source-observation-import",
    );
    expect(sectionsByProfile["mtg-single-card-product-sku"].ingestionUnitIdentity.value.unitKey).toBe(
      "tcgplayer:mtg:single-card:source-observation-import",
    );
    expect(sectionsByProfile["mtg-sealed-product-sku"].ingestionUnitIdentity.value.unitKey).toBe(
      "tcgplayer:mtg:sealed-product:source-observation-import",
    );
    expect(sectionsByProfile["mtg-card-reference-data"].ingestionUnitIdentity.value.unitKey).toBe(
      "mtgjson:mtg:single-card:reference-data",
    );
    expect(sectionsByProfile["mtg-set-reference-data"].ingestionUnitIdentity.value.unitKey).toBe(
      "mtgjson:mtg:set:reference-data",
    );
    expect(sectionsByProfile["mtg-card-print-reference-data"].ingestionUnitIdentity.value.unitKey).toBe(
      "scryfall:mtg:single-card:reference-data",
    );
    expect(sectionsByProfile["mtg-card-image-evidence"].ingestionUnitIdentity.value.unitKey).toBe(
      "scryfall:mtg:single-card:image-evidence",
    );

    for (const sections of Object.values(sectionsByProfile)) {
      const unitKey = sections.ingestionUnitIdentity.value.unitKey;
      expect(sections.profileIdentity.ingestionUnitKey).toBe(unitKey);
      expect(sections.sourceContract.sectionKey).toBe("source-contract");
      expect(sections.fixtureContract.validation.status).toBe("valid");
      expect(sections.connectorBinding.value.transportBoundary).toBe("adapter-owned");
      expect(sections.normalizedObservation.value.catalogFieldMapping.blueprintKey).toBeTruthy();
    }
  });

  it("keeps raw and graded cards as condition or certification semantics inside single-card units", () => {
    const tcgplayerSections = assembleCatalogProviderIngestionUnitProfileSections(
      catalogProviderIntegrationProfileVersions.find((version) => version.providerKey === "tcgplayer")!,
    );

    expect(tcgplayerSections.ingestionUnitIdentity.value.productForm).toBe("single-card");
    expect(tcgplayerSections.conditionCertificationMapping.value.selectedOptionDimensions).toEqual([
      "condition",
      "printing",
      "language",
      "product-form",
    ]);
    expect(catalogProviderProfileModelsRawGradedAsConditionSemantics(tcgplayerSections)).toBe(true);
    expect(() =>
      defineCatalogProviderIngestionUnitProfileIdentity({
        providerKey: "tcgplayer",
        productDomain: "pokemon",
        productForm: "graded-card",
        displayName: "TCGplayer graded Pokemon cards",
      }),
    ).toThrow("Raw and graded cards must be modeled as condition/certification semantics inside a single-card");
  });

  it("represents production Magic ingestion-unit identities by provider, domain, form, and purpose", () => {
    const magicUnits = [
      ["mtgjson", "set", "reference-data"],
      ["mtgjson", "single-card", "reference-data"],
      ["scryfall", "single-card", "image-evidence"],
      ["scryfall", "single-card", "reference-data"],
      ["tcgplayer", "single-card", "source-observation-import"],
      ["tcgplayer", "sealed-product", "source-observation-import"],
    ] as const satisfies readonly (readonly [
      string,
      CatalogProviderIngestionUnitProductForm,
      CatalogProviderIngestionPurpose,
    ])[];

    const unitKeys = magicUnits.map(
      ([providerKey, productForm, ingestionPurpose]) =>
        defineCatalogProviderIngestionUnitProfileIdentity({
          providerKey,
          productDomain: "mtg",
          productForm,
          ingestionPurpose,
          displayName: `${providerKey} MTG ${productForm} ${ingestionPurpose}`,
        }).unitKey,
    );

    expect(unitKeys).toEqual([
      "mtgjson:mtg:set:reference-data",
      "mtgjson:mtg:single-card:reference-data",
      "scryfall:mtg:single-card:image-evidence",
      "scryfall:mtg:single-card:reference-data",
      "tcgplayer:mtg:single-card:source-observation-import",
      "tcgplayer:mtg:sealed-product:source-observation-import",
    ]);
  });

  it("uses explicit ingestion-unit profile identity when inference is too narrow for Magic units", () => {
    const baseVersion = catalogProviderIntegrationProfileVersions.find(
      (version) => version.providerKey === "tcgplayer",
    )!;
    const version = {
      ...baseVersion,
      providerKey: "mtgjson",
      profileKey: "mtgjson-mtg-set-reference-data",
      ingestionUnitIdentity: defineCatalogProviderIngestionUnitIdentityContract({
        providerKey: "mtgjson",
        productDomain: "mtg",
        productForm: "set",
        ingestionPurpose: "reference-data",
      }),
      profile: {
        ...baseVersion.profile,
        providerKey: "mtgjson",
        displayName: "MTGJSON MTG Set Reference Data",
        status: "planned",
        capabilities: ["provider-option-query"],
      },
      executableMappingContract: undefined,
    } as CatalogProviderIntegrationProfileVersionRecord;

    const sections = assembleCatalogProviderIngestionUnitProfileSections(version);

    expect(sections.ingestionUnitIdentity.value).toMatchObject({
      unitKey: "mtgjson:mtg:set:reference-data",
      providerKey: "mtgjson",
      productDomain: "mtg",
      productForm: "set",
      ingestionPurpose: "reference-data",
    });
    expect(sections.ingestionUnitIdentity.validation.status).toBe("valid");
  });

  it("exposes activation readiness inputs and active lifecycle policy decisions", () => {
    const activeVersion = catalogProviderIntegrationProfileVersions.find(
      (version) => version.providerKey === "tcgplayer" && version.profileKey === "pokemon-single-card-product-sku",
    )!;
    const readiness = evaluateCatalogProviderProfileActivationReadiness(
      catalogProviderProfileActivationReadinessInput(activeVersion),
    );
    const policy = evaluateCatalogProviderProfileLifecyclePolicy({
      lifecycle: activeVersion.lifecycle,
      active: activeVersion.active,
      referenceCount: 0,
      activationReadiness: readiness,
    });

    expect(canEditCatalogProviderIngestionUnitProfile(activeVersion.lifecycle)).toBe(false);
    expect(readiness.status).toBe("blocked");
    expect(policy.activation.allowed).toBe(false);
    expect(policy.deprecation.allowed).toBe(true);
    expect(policy.retirement.allowed).toBe(false);
  });

  it("blocks invalid activation and retirement states with focused diagnostics", () => {
    const activeVersion = catalogProviderIntegrationProfileVersions.find(
      (version) => version.providerKey === "tcgdex",
    )!;
    const activeReadiness = evaluateCatalogProviderProfileActivationReadiness(
      catalogProviderProfileActivationReadinessInput(activeVersion),
    );
    const activePolicy = evaluateCatalogProviderProfileLifecyclePolicy({
      lifecycle: activeVersion.lifecycle,
      active: activeVersion.active,
      referenceCount: 3,
      activationReadiness: activeReadiness,
    });

    expect(activeReadiness.status).toBe("blocked");
    expect(activePolicy.activation.allowed).toBe(false);
    expect(activePolicy.deprecation.allowed).toBe(true);
    expect(activePolicy.retirement.allowed).toBe(false);
    expect(activePolicy.retirement.blockers.map((blocker) => blocker.code)).toEqual([
      "retirement-active-profile",
      "retirement-source-observation-references",
    ]);
  });

  it("reports fixture coverage as activation readiness input instead of transport behavior", () => {
    const tcgplayerVersion = catalogProviderIntegrationProfileVersions.find(
      (version) => version.providerKey === "tcgplayer" && version.profileKey === "pokemon-single-card-product-sku",
    )!;
    const version = {
      ...tcgplayerVersion,
      fixtures: {
        ...tcgplayerVersion.fixtures,
        coveredFlows: tcgplayerVersion.fixtures.coveredFlows.filter((flow) => flow !== "unknown-option"),
      },
      executableMappingContract: tcgplayerVersion.executableMappingContract
        ? {
            ...tcgplayerVersion.executableMappingContract,
            fixtures: {
              ...tcgplayerVersion.executableMappingContract.fixtures,
              coveredFlows: tcgplayerVersion.executableMappingContract.fixtures.coveredFlows.filter(
                (flow) => flow !== "unknown-option",
              ),
            },
          }
        : undefined,
    } as CatalogProviderIntegrationProfileVersionRecord;

    const readiness = evaluateCatalogProviderProfileActivationReadiness(
      catalogProviderProfileActivationReadinessInput(version),
    );
    const sections = assembleCatalogProviderIngestionUnitProfileSections(version);

    expect(readiness.status).toBe("blocked");
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        code: "activation-fixture-covered-flow",
        path: "fixtures.coveredFlows.unknown-option",
      }),
    );
    expect(sections.connectorBinding.value.transportOwns).toContain("auth");
    expect(sections.fixtureContract.validation.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "fixture-missing-flow",
        path: "fixtures.coveredFlows.unknown-option",
      }),
    );
  });
});
