import { describe, expect, it } from "vitest";
import {
  buildCatalogIntegrationFixtureRepositoryRecords,
  buildCatalogIntegrationFixtureValidationInputs,
  catalogIntegrationFixtureCoverageRequirements,
  createCatalogIntegrationFixtureRepositoryRecord,
  evaluateCatalogIntegrationFixtureCoverage,
} from "./catalog-integration-fixture-lifecycle";
import { catalogProviderRequiredFixtureFlows } from "../providers/provider-integration-mapping-contract";
import {
  catalogProviderIntegrationProfileVersions,
  validateCatalogProviderIntegrationProfileVersion,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";
import { catalogProviderProfileFixtureCases } from "../providers/provider-profile-fixture-cases";

const tcgdexUnitKey = "tcgdex:pokemon:single-card:source-observation-import";

describe("Catalog integration fixture lifecycle", () => {
  it("publishes required coverage rules from the provider fixture flow inventory", () => {
    expect(catalogIntegrationFixtureCoverageRequirements()).toEqual(
      catalogProviderRequiredFixtureFlows.map((flow) => ({
        flow,
        required: true,
        minimumFixtureCount: 1,
        acceptedProvenance: ["generated", "manual", "sampled-provider"],
      })),
    );
  });

  it("derives repository records from existing profile fixture cases without moving payload files", () => {
    const version = requireVersion("tcgdex");
    const records = buildCatalogIntegrationFixtureRepositoryRecords({
      version,
      unitKey: tcgdexUnitKey,
      fixtureCases: catalogProviderProfileFixtureCases(),
      payloadPreviewByFlow: {
        normal: { name: "Sprigatito", price: 1.23, inventoryQuantity: 9 },
      },
    });

    expect(records).toHaveLength(catalogProviderRequiredFixtureFlows.length);
    expect(records[0]).toMatchObject({
      schemaVersion: "catalog-fixture-repository-record-v1",
      fixtureId: "tcgdex:2026.06.03:normal",
      providerKey: "tcgdex",
      unitKey: tcgdexUnitKey,
      flow: "normal",
      payload: {
        kind: "repository-path",
        value: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex/normal.json",
      },
      payloadPolicy: {
        dataClass: "fixture-payload",
        redactionState: "redacted",
        retainsBody: false,
        redactedPreview: { name: "Sprigatito", price: "<redacted>", inventoryQuantity: "<redacted>" },
      },
      provenance: {
        sourceKind: "generated",
        policyLegalSignoff: false,
        retainedDataExceptionIssue: null,
      },
      compatibility: {
        providerKey: "tcgdex",
        profileKey: "pokemon-tcg",
        profileVersion: "2026.06.03",
        fixtureSetVersion: "tcgdex-pokemon-executable-v1",
      },
    });
  });

  it("detects missing fixture coverage and forbidden live provider calls", () => {
    const version = requireVersion("tcgdex");
    const evaluation = evaluateCatalogIntegrationFixtureCoverage({
      providerKey: version.providerKey,
      profileKey: version.profileKey,
      profileVersion: version.profileVersion,
      unitKey: tcgdexUnitKey,
      fixtureContract: {
        fixtureRoot: version.fixtures.fixtureRoot,
        coveredFlows: ["normal"],
        liveProviderCallsAllowed: true,
      },
      requiredFlows: ["normal", "partial"],
    });

    expect(evaluation.status).toBe("blocked");
    expect(evaluation.coveredFlows).toEqual(["normal"]);
    expect(evaluation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "fixture-live-provider-calls",
      "fixture-missing-flow",
    ]);
    expect(evaluation.diagnostics[1]).toMatchObject({
      flow: "partial",
      blockingBehavior: "activation-blocking",
      path: "fixtures.coveredFlows.partial",
    });
  });

  it("constructs deterministic validation inputs in required flow order", () => {
    const version = requireVersion("tcgdex");
    const records = buildCatalogIntegrationFixtureRepositoryRecords({
      version,
      unitKey: tcgdexUnitKey,
      fixtureCases: catalogProviderProfileFixtureCases(),
    });

    const inputs = buildCatalogIntegrationFixtureValidationInputs({
      records: [records[1], records[0]],
      providerKey: "TCGDEX",
      profileVersion: version.profileVersion,
      unitKey: tcgdexUnitKey,
      requiredFlows: ["normal", "partial"],
    });

    expect(inputs.map((input) => input.flow)).toEqual(["normal", "partial"]);
    expect(inputs.map((input) => input.payload.value)).toEqual([
      "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex/normal.json",
      "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex/partial.json",
    ]);
  });

  it("blocks retained sampled-provider fixtures without signoff and retained-data exception evidence", () => {
    const version = requireVersion("tcgdex");
    const record = createCatalogIntegrationFixtureRepositoryRecord({
      providerKey: version.providerKey,
      unitKey: tcgdexUnitKey,
      profileKey: version.profileKey,
      profileVersion: version.profileVersion,
      fixtureSetVersion: version.sourceContract.fixtureSetVersion,
      flow: "normal",
      payload: { kind: "sample-id", value: "sample_tcgdx_1" },
      provenance: { sourceKind: "sampled-provider" },
      retainedBody: true,
    });

    const evaluation = evaluateCatalogIntegrationFixtureCoverage({
      providerKey: version.providerKey,
      profileKey: version.profileKey,
      profileVersion: version.profileVersion,
      unitKey: tcgdexUnitKey,
      fixtureContract: { ...version.fixtures, coveredFlows: ["normal"] },
      records: [record],
      requiredFlows: ["normal"],
    });

    expect(evaluation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "fixture-governance-signoff-required",
      "fixture-retained-data-exception-required",
    ]);
  });

  it("routes profile activation validation through the fixture lifecycle coverage check", () => {
    const version = requireVersion("tcgdex");
    const executableMappingContract = version.executableMappingContract;
    if (!executableMappingContract) {
      throw new Error("TCGdex profile version must carry an executable mapping contract.");
    }
    const diagnostics = validateCatalogProviderIntegrationProfileVersion({
      ...version,
      fixtures: {
        fixtureRoot: version.fixtures.fixtureRoot,
        coveredFlows: ["normal"],
        liveProviderCallsAllowed: true,
      },
      executableMappingContract: {
        ...executableMappingContract,
        fixtures: {
          fixtureRoot: version.fixtures.fixtureRoot,
          coveredFlows: ["normal"],
          liveProviderCallsAllowed: true,
        },
      },
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["fixture-live-provider-calls", "missing-profile-fixture-flow"]),
    );
  });
});

function requireVersion(providerKey: string): CatalogProviderIntegrationProfileVersionRecord {
  const version = catalogProviderIntegrationProfileVersions.find((candidate) => candidate.providerKey === providerKey);
  if (!version) {
    throw new Error(`Missing ${providerKey} profile version.`);
  }
  return version;
}
