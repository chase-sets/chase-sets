import { describe, expect, it } from "vitest";
import {
  catalogAdminControlPlaneQueryContracts,
  catalogAdminControlPlaneQueryContractsByKey,
  catalogAdminControlPlaneQueryKeys,
  getCatalogAdminControlPlaneQueryContract,
  type CatalogAdminControlPlaneQueryKey,
} from "./admin-control-plane-read-model-contracts";

describe("Admin Control Plane read-model contracts", () => {
  it("defines the full #781 Admin query inventory", () => {
    const requiredKeys: readonly CatalogAdminControlPlaneQueryKey[] = [
      "integration-health-summary",
      "provider-transport-readiness-summary",
      "active-profile-version-summary",
      "profile-section-status-summary",
      "adapter-transport-diagnostics",
      "fixture-validation-summary",
      "dry-run-evidence-summary",
      "semantic-version-comparison",
      "activation-readiness-summary",
      "replay-reapply-impact-summary",
      "import-job-progress-summary",
      "source-observation-review-query",
      "promotion-plan-preview",
      "rollback-retirement-impact-summary",
      "audit-evidence-timeline",
    ];

    expect(catalogAdminControlPlaneQueryKeys).toEqual(requiredKeys);
    expect(catalogAdminControlPlaneQueryContracts.map((contract) => contract.key)).toEqual(requiredKeys);
    expect(Object.keys(catalogAdminControlPlaneQueryContractsByKey).sort()).toEqual([...requiredKeys].sort());
  });

  it("documents source inventory, freshness, and operator-facing error states for every contract", () => {
    for (const contract of catalogAdminControlPlaneQueryContracts) {
      expect(contract.readModelName).toMatch(/^CatalogAdmin.+ReadModel$/);
      expect(contract.routeIntent.length).toBeGreaterThan(20);
      expect(contract.sources.length).toBeGreaterThan(0);
      expect(contract.errorStates.length).toBeGreaterThan(0);
      expect(contract.genericProviderSurface).toBe(true);

      for (const source of contract.sources) {
        expect(source.name.length).toBeGreaterThan(0);
        expect(source.notes.length).toBeGreaterThan(0);
      }

      for (const errorState of contract.errorStates) {
        expect(errorState.operatorMessage.length).toBeGreaterThan(20);
      }
    }
  });

  it("separates Catalog semantic readiness by ingestion unit from provider adapter transport readiness", () => {
    expect(getCatalogAdminControlPlaneQueryContract("integration-health-summary")).toMatchObject({
      grouping: "ingestion-unit",
      unitKey: "required",
      freshness: "request-time",
    });
    expect(getCatalogAdminControlPlaneQueryContract("provider-transport-readiness-summary")).toMatchObject({
      grouping: "provider-adapter",
      unitKey: "optional",
      freshness: "request-time",
    });
    expect(getCatalogAdminControlPlaneQueryContract("adapter-transport-diagnostics")).toMatchObject({
      grouping: "provider-adapter",
      unitKey: "optional",
    });
  });

  it("requires ingestion-unit attribution for Catalog-owned profile, job, observation, promotion, impact, and audit models", () => {
    const unitScopedKeys: readonly CatalogAdminControlPlaneQueryKey[] = [
      "integration-health-summary",
      "active-profile-version-summary",
      "profile-section-status-summary",
      "fixture-validation-summary",
      "dry-run-evidence-summary",
      "semantic-version-comparison",
      "activation-readiness-summary",
      "replay-reapply-impact-summary",
      "import-job-progress-summary",
      "source-observation-review-query",
      "promotion-plan-preview",
      "rollback-retirement-impact-summary",
      "audit-evidence-timeline",
    ];

    for (const key of unitScopedKeys) {
      expect(getCatalogAdminControlPlaneQueryContract(key).unitKey).toBe("required");
    }
  });

  it("identifies existing and planned read-model sources without adding provider-specific query branches", () => {
    const allSources = catalogAdminControlPlaneQueryContracts.flatMap((contract) => contract.sources);

    expect(allSources).toContainEqual(
      expect.objectContaining({
        name: "catalog_source_observations",
        kind: "table",
        available: true,
      }),
    );
    expect(allSources).toContainEqual(
      expect.objectContaining({
        name: "catalog_provider_profile_version_sections",
        kind: "projection-table",
        available: true,
      }),
    );
    expect(allSources).toContainEqual(
      expect.objectContaining({
        name: "catalog_admin_audit_evidence_timeline_projection",
        kind: "planned-projection",
        available: false,
      }),
    );

    for (const contract of catalogAdminControlPlaneQueryContracts) {
      expect(contract.key).not.toMatch(/tcgdex|tcgplayer|scryfall|mtg|pokemon/);
      expect(contract.readModelName).not.toMatch(/Tcgdex|Tcgplayer|Scryfall|Mtg|Pokemon/);
    }
  });
});
