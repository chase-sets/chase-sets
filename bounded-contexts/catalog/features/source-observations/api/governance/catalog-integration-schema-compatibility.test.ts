import { describe, expect, it } from "vitest";
import {
  catalogIntegrationSchemaCompatibilityGovernanceDataClasses,
  catalogIntegrationSchemaCompatibilityPolicies,
  catalogIntegrationSchemaCompatibilityPoliciesByKey,
  getCatalogIntegrationSchemaCompatibilityPolicy,
  type CatalogIntegrationSchemaCompatibilitySurfaceKey,
} from "./catalog-integration-schema-compatibility";
import { catalogIntegrationDataGovernancePoliciesByKey } from "./catalog-integration-data-governance";

describe("Catalog integration schema compatibility policy", () => {
  it("defines the #793 compatibility surface inventory", () => {
    const requiredKeys: readonly CatalogIntegrationSchemaCompatibilitySurfaceKey[] = [
      "provider-adapter-contract",
      "provider-payload-provenance-envelope",
      "provider-profile-version",
      "profile-section-command",
      "executable-mapping-contract",
      "catalog-integration-engine-io",
      "diagnostic-record",
      "fixture-contract",
      "admin-control-plane-read-model",
      "source-observation-record",
      "integration-durable-job",
      "integration-work-unit",
      "audit-evidence-record",
    ];

    expect(catalogIntegrationSchemaCompatibilityPolicies.map((policy) => policy.key)).toEqual(requiredKeys);
    expect(Object.keys(catalogIntegrationSchemaCompatibilityPoliciesByKey).sort()).toEqual([...requiredKeys].sort());
  });

  it("requires every policy to name version markers, ownership, test coverage, and launch impact", () => {
    for (const policy of catalogIntegrationSchemaCompatibilityPolicies) {
      expect(policy.displayName.length).toBeGreaterThan(10);
      expect(policy.wireSchemaVersion).toMatch(/^catalog-.+-v1$/);
      expect(policy.semanticVersionMarkers.length).toBeGreaterThan(0);
      expect(policy.compatibilityScope.length).toBeGreaterThan(60);
      expect(policy.testExpectation.length).toBeGreaterThan(40);
      expect(policy.launchBlocking).toBe(true);
    }
  });

  it("keeps pre-launch payload and fixture bodies resettable unless a retained-data exception exists", () => {
    const resettablePolicies = catalogIntegrationSchemaCompatibilityPolicies.filter(
      (policy) => policy.retainedDataPolicy === "resettable-pre-launch",
    );

    expect(resettablePolicies.map((policy) => policy.key)).toEqual([
      "provider-payload-provenance-envelope",
      "profile-section-command",
      "catalog-integration-engine-io",
      "fixture-contract",
    ]);
    expect(getCatalogIntegrationSchemaCompatibilityPolicy("provider-payload-provenance-envelope")).toMatchObject({
      resetExceptionRequired: true,
      adapterOwner: "provider-adapter",
    });
    expect(getCatalogIntegrationSchemaCompatibilityPolicy("fixture-contract")).toMatchObject({
      resetExceptionRequired: true,
      adapterOwner: "catalog-source-observations-api",
    });
  });

  it("preserves referenced profiles, observations, jobs, and work units through deploy skew", () => {
    expect(getCatalogIntegrationSchemaCompatibilityPolicy("provider-profile-version")).toMatchObject({
      retainedDataPolicy: "retain-when-referenced",
      deploySkewPolicy: "read-old-write-current",
    });
    expect(getCatalogIntegrationSchemaCompatibilityPolicy("source-observation-record")).toMatchObject({
      retainedDataPolicy: "retain-when-referenced",
      deploySkewPolicy: "read-old-write-current",
    });
    expect(getCatalogIntegrationSchemaCompatibilityPolicy("integration-durable-job")).toMatchObject({
      retainedDataPolicy: "retain-when-referenced",
      deploySkewPolicy: "snapshot-at-enqueue",
    });
    expect(getCatalogIntegrationSchemaCompatibilityPolicy("integration-work-unit")).toMatchObject({
      retainedDataPolicy: "retain-when-referenced",
      deploySkewPolicy: "snapshot-at-enqueue",
    });
  });

  it("treats mapping fingerprints and diagnostic codes as stable semantic compatibility markers", () => {
    expect(
      getCatalogIntegrationSchemaCompatibilityPolicy("executable-mapping-contract").semanticVersionMarkers,
    ).toEqual(["providerKey", "profileKey", "profileVersion", "sourceMappingFingerprint"]);
    expect(getCatalogIntegrationSchemaCompatibilityPolicy("diagnostic-record").semanticVersionMarkers).toEqual([
      "code",
      "severity",
      "blockingBehavior",
      "visibility",
    ]);
  });

  it("maps every schema surface that may carry provider evidence to governed data classes", () => {
    expect(Object.keys(catalogIntegrationSchemaCompatibilityGovernanceDataClasses).sort()).toEqual(
      catalogIntegrationSchemaCompatibilityPolicies.map((policy) => policy.key).sort(),
    );

    for (const [surfaceKey, dataClasses] of Object.entries(
      catalogIntegrationSchemaCompatibilityGovernanceDataClasses,
    )) {
      expect(dataClasses.length, surfaceKey).toBeGreaterThan(0);
      for (const dataClass of dataClasses) {
        expect(catalogIntegrationDataGovernancePoliciesByKey[dataClass], `${surfaceKey}:${dataClass}`).toBeDefined();
      }
    }

    expect(catalogIntegrationSchemaCompatibilityGovernanceDataClasses["provider-payload-provenance-envelope"]).toEqual([
      "raw-provider-payload",
      "sampled-provider-payload",
    ]);
    expect(catalogIntegrationSchemaCompatibilityGovernanceDataClasses["fixture-contract"]).toEqual(
      expect.arrayContaining(["fixture-payload", "sampled-provider-payload"]),
    );
  });
});
