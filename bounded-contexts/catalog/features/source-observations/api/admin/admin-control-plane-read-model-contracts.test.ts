import { describe, expect, it } from "vitest";
import {
  catalogAdminControlPlaneQueryGovernanceDataClasses,
  catalogAdminControlPlaneQueryContracts,
  catalogAdminControlPlaneQueryContractsByKey,
  catalogAdminControlPlaneQueryKeys,
  getCatalogAdminControlPlaneQueryContract,
  type CatalogAdminActivationReadinessSummaryReadModel,
  type CatalogAdminIntegrationHealthSummaryReadModel,
  type CatalogAdminProviderTransportReadinessSummaryReadModel,
  type CatalogAdminDryRunEvidenceSummaryReadModel,
  type CatalogAdminImportJobProgressSummaryReadModel,
  type CatalogAdminAuditEvidenceTimelineReadModel,
  type CatalogAdminProfileSectionStatusSummaryReadModel,
  type CatalogAdminSemanticVersionComparisonReadModel,
  type CatalogAdminControlPlaneQueryKey,
} from "./admin-control-plane-read-model-contracts";
import { catalogIntegrationDataGovernancePoliciesByKey } from "../governance/catalog-integration-data-governance";

describe("Admin Control Plane read-model contracts", () => {
  it("defines the full #781 Admin query inventory", () => {
    const requiredKeys: readonly CatalogAdminControlPlaneQueryKey[] = [
      "integration-health-summary",
      "provider-transport-readiness-summary",
      "provider-source-options",
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
      sources: [
        expect.objectContaining({
          name: "ProviderAdapterRegistry.getTransportDiagnostics/getCredentialReadiness",
        }),
      ],
    });
    expect(getCatalogAdminControlPlaneQueryContract("adapter-transport-diagnostics")).toMatchObject({
      grouping: "provider-adapter",
      unitKey: "optional",
    });
    expect(getCatalogAdminControlPlaneQueryContract("provider-source-options")).toMatchObject({
      grouping: "provider",
      unitKey: "optional",
      freshness: "request-time",
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

  it("pins section-scoped diagnostics, readiness, compare, and dry-run DTO fields for #768", () => {
    const profile = {
      schemaVersion: "catalog-provider-profile-version-v1",
      compatibilityPolicy: "provider-profile-version",
      providerKey: "tcgdex",
      profileKey: "pokemon-tcg",
      profileVersion: "2026.06.04",
      lifecycle: "draft",
      active: false,
      connectorKind: "tcgdex-json",
      connectorSourceVersion: null,
      sourceMappingFingerprint: "fingerprint",
    } as const;
    const sectionSummary = {
      generatedAt: "2026-06-06T00:00:00.000Z",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      profile,
      sections: [
        {
          sectionKey: "migration-evidence",
          domainConcept: "Migration Evidence",
          editable: true,
          validationStatus: "valid",
          sectionStatus: "blocked",
          sectionFingerprint: "section-fingerprint",
          lastEditedAt: null,
          diagnostics: [],
          readinessCheckKeys: ["migration-evidence"],
          semanticChangePaths: ["migrationEvidence"],
        },
      ],
    } satisfies CatalogAdminProfileSectionStatusSummaryReadModel;
    const semanticCompare = {
      generatedAt: sectionSummary.generatedAt,
      unitKey: sectionSummary.unitKey,
      candidateProfile: profile,
      activeProfile: null,
      changes: [
        {
          sectionKey: "duplicate-prevention",
          domainConcept: "Duplicate Prevention",
          path: "executableMappingContract.duplicatePrevention",
          label: "Duplicate Prevention",
          candidate: {},
          active: null,
          changed: true,
          severity: "error",
          activationImpact: "Changes duplicate candidate order.",
        },
      ],
      sections: [
        {
          sectionKey: "duplicate-prevention",
          domainConcept: "Duplicate Prevention",
          status: "error",
          changePaths: ["executableMappingContract.duplicatePrevention"],
        },
      ],
    } satisfies CatalogAdminSemanticVersionComparisonReadModel;
    const readiness = {
      generatedAt: sectionSummary.generatedAt,
      unitKey: sectionSummary.unitKey,
      profile,
      status: "blocked",
      checks: [
        {
          checkKey: "migration-evidence",
          code: "activation-migration-evidence",
          sectionKey: "migration-evidence",
          domainConcept: "Migration Evidence",
          status: "blocked",
          path: "migrationEvidence.evidenceText",
          diagnosticText: "Migration evidence is required.",
          severity: "error",
          remediation: "Record migration evidence for mapping fingerprint changes.",
          blockingBehavior: "activation-blocking",
        },
      ],
      groups: [
        {
          domainConcept: "Migration Evidence",
          status: "blocked",
          checkKeys: ["migration-evidence"],
        },
      ],
    } satisfies CatalogAdminActivationReadinessSummaryReadModel;
    const dryRun = {
      generatedAt: sectionSummary.generatedAt,
      unitKey: sectionSummary.unitKey,
      profile,
      status: "blocked",
      redactionSummary: {},
      diagnosticLinks: [
        {
          code: "missing-required-path",
          path: "normalizedObservation.externalKey",
          sectionKey: "normalized-observation",
          domainConcept: "Normalized Observation",
          fixtureFlow: "normal",
        },
      ],
      evidence: [],
    } satisfies CatalogAdminDryRunEvidenceSummaryReadModel;

    expect(sectionSummary.sections[0].sectionStatus).toBe("blocked");
    expect(semanticCompare.sections[0].changePaths).toEqual(["executableMappingContract.duplicatePrevention"]);
    expect(readiness.groups[0].checkKeys).toEqual(["migration-evidence"]);
    expect(dryRun.diagnosticLinks[0].sectionKey).toBe("normalized-observation");
  });

  it("pins credential readiness separately from semantic and transport readiness", () => {
    const health = {
      generatedAt: "2026-06-06T00:00:00.000Z",
      units: [
        {
          unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
          providerKey: "tcgplayer",
          productDomain: "pokemon",
          productForm: "single-card",
          ingestionPurpose: "source-observation-import",
          displayName: "TCGplayer Pokemon single-card Source Observation import",
          activeProfile: null,
          semanticReadiness: "ready",
          credentialReadiness: "blocked",
          credentialReadinessState: "missing",
          credentialRequirement: "required",
          transportReadiness: "ready",
          fixtureValidationStatus: "ready",
          dryRunStatus: "completed",
          observationFacts: 1,
          diagnostics: [],
        },
      ],
    } satisfies CatalogAdminIntegrationHealthSummaryReadModel;
    const providerSummary = {
      generatedAt: health.generatedAt,
      providers: [
        {
          providerKey: "tcgplayer",
          adapterKey: "tcgplayer",
          readiness: "blocked",
          credentialReadiness: "blocked",
          credentialReadinessState: "missing",
          credentialRequirement: "required",
          unitKeys: ["tcgplayer:pokemon:single-card:source-observation-import"],
          diagnostics: [],
        },
      ],
    } satisfies CatalogAdminProviderTransportReadinessSummaryReadModel;

    expect(health.units[0].semanticReadiness).toBe("ready");
    expect(health.units[0].credentialReadiness).toBe("blocked");
    expect(providerSummary.providers[0].credentialReadinessState).toBe("missing");
  });

  it("pins job consistency DTO fields for #791", () => {
    const summary = {
      generatedAt: "2026-06-06T00:00:00.000Z",
      jobs: [
        {
          jobId: "job_reapply",
          action: "reapply",
          state: "completed",
          operatorStatus: "partial",
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          providerKey: "tcgdex",
          profile: {
            schemaVersion: "catalog-provider-profile-version-v1",
            compatibilityPolicy: "provider-profile-version",
            providerKey: "tcgdex",
            profileKey: "pokemon-tcg",
            profileVersion: "2026.06.04",
            lifecycle: "active",
            active: true,
            connectorKind: "tcgdex-json",
            connectorSourceVersion: null,
            sourceMappingFingerprint: "fingerprint",
          },
          reapplyProfileMode: "current-active-profile",
          consistency: {
            schemaVersion: "catalog-integration-durable-job-v1",
            compatibilityPolicy: "integration-durable-job",
            duplicateSubmissionPolicy: "reuse-active-job",
            profileSnapshotPolicy: "snapshotted-at-enqueue",
            retryResumePolicy: "skip-completed-outcomes",
            partialFailurePolicy: "mixed-outcomes",
            workUnitClaimPolicy: "leased-work-units",
          },
          completed: 9,
          total: 10,
          currentName: null,
          failed: 1,
          skipped: 0,
          workUnits: {
            total: 10,
            queued: 0,
            running: 0,
            completed: 9,
            failed: 1,
            skipped: 0,
          },
          diagnostics: [],
        },
      ],
    } satisfies CatalogAdminImportJobProgressSummaryReadModel;

    expect(summary.jobs[0].operatorStatus).toBe("partial");
    expect(summary.jobs[0].consistency.schemaVersion).toBe("catalog-integration-durable-job-v1");
    expect(summary.jobs[0].consistency.profileSnapshotPolicy).toBe("snapshotted-at-enqueue");
    expect(summary.jobs[0].profile?.compatibilityPolicy).toBe("provider-profile-version");
    expect(summary.jobs[0].profile?.connectorKind).toBe("tcgdex-json");
  });

  it("pins canonical audit/evidence timeline DTO fields for #783", () => {
    const timeline = {
      generatedAt: "2026-06-06T00:00:00.000Z",
      unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
      entries: [
        {
          schemaVersion: "catalog-audit-evidence-record-v1",
          compatibilityPolicy: "audit-evidence-record",
          eventId: "aud_001",
          occurredAt: "2026-06-06T00:00:00.000Z",
          eventName: "provider-credential-readiness-changed",
          category: "adapter-readiness",
          actorUserId: "usr_admin",
          accountId: "acc_ops",
          providerKey: "tcgplayer",
          unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
          profile: {
            schemaVersion: "catalog-provider-profile-version-v1",
            compatibilityPolicy: "provider-profile-version",
            providerKey: "tcgplayer",
            profileKey: "pokemon-tcg",
            profileVersion: "2026.06.06",
            lifecycle: "active",
            active: true,
            connectorKind: "tcgplayer-automation",
            connectorSourceVersion: null,
            sourceMappingFingerprint: "fingerprint",
          },
          sectionKey: null,
          evidenceSummary: "Credential readiness changed to missing.",
          evidence: [
            {
              dataClass: "provider-credential-readiness",
              summary: "Credential readiness changed to missing.",
              redactionState: "redacted",
              path: "credentialReadiness",
              owner: "provider-adapter",
            },
          ],
          diagnosticCodes: ["credential-missing"],
          relatedJobId: null,
          relatedObservationId: null,
          relatedCatalogItemId: null,
          promotionPlanId: null,
          reapplyRunId: null,
        },
      ],
    } satisfies CatalogAdminAuditEvidenceTimelineReadModel;

    expect(timeline.entries[0]).toMatchObject({
      schemaVersion: "catalog-audit-evidence-record-v1",
      compatibilityPolicy: "audit-evidence-record",
      eventName: "provider-credential-readiness-changed",
      category: "adapter-readiness",
      diagnosticCodes: ["credential-missing"],
    });
  });

  it("links every Admin query contract to governed provider-data classes", () => {
    expect(Object.keys(catalogAdminControlPlaneQueryGovernanceDataClasses).sort()).toEqual(
      [...catalogAdminControlPlaneQueryKeys].sort(),
    );

    for (const [queryKey, dataClasses] of Object.entries(catalogAdminControlPlaneQueryGovernanceDataClasses)) {
      expect(dataClasses.length, queryKey).toBeGreaterThan(0);
      for (const dataClass of dataClasses) {
        expect(catalogIntegrationDataGovernancePoliciesByKey[dataClass], `${queryKey}:${dataClass}`).toBeDefined();
      }
    }

    expect(catalogAdminControlPlaneQueryGovernanceDataClasses["dry-run-evidence-summary"]).toEqual([
      "dry-run-input-payload",
      "dry-run-output-evidence",
      "engine-diagnostic",
    ]);
    expect(catalogAdminControlPlaneQueryGovernanceDataClasses["adapter-transport-diagnostics"]).toEqual([
      "provider-transport-diagnostic",
      "provider-credential-readiness",
    ]);
    expect(catalogAdminControlPlaneQueryGovernanceDataClasses["audit-evidence-timeline"]).toEqual(["audit-evidence"]);
  });
});
