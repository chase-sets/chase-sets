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
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";

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
    expect(sectionsByProfile["pokemon-tcg-automation-client"].ingestionUnitIdentity.value.unitKey).toBe(
      "tcgplayer:pokemon:single-card:source-observation-import",
    );
    expect(sectionsByProfile["scryfall-card-fixture"].ingestionUnitIdentity.value.unitKey).toBe(
      "scrydex:mtg:single-card:source-observation-import",
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

  it("exposes activation readiness inputs and lifecycle policy decisions", () => {
    const testVersion = catalogProviderIntegrationProfileVersions.find(
      (version) => version.providerKey === "tcgplayer",
    )!;
    const readiness = evaluateCatalogProviderProfileActivationReadiness(
      catalogProviderProfileActivationReadinessInput(testVersion),
    );
    const policy = evaluateCatalogProviderProfileLifecyclePolicy({
      lifecycle: testVersion.lifecycle,
      active: testVersion.active,
      referenceCount: 0,
      activationReadiness: readiness,
    });

    expect(canEditCatalogProviderIngestionUnitProfile(testVersion.lifecycle)).toBe(true);
    expect(readiness.status).toBe("ready");
    expect(policy.activation.allowed).toBe(true);
    expect(policy.deprecation.allowed).toBe(false);
    expect(policy.retirement.allowed).toBe(true);
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
      (version) => version.providerKey === "tcgplayer",
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
