import type { CatalogIntegrationDataVerificationReport } from "../../bounded-contexts/catalog/features/source-observations/api/governance/catalog-integration-data-verification";

export type CatalogIntegrationLegacyCleanupSurfaceKind = "data-surface" | "bootstrap-path";

export type CatalogIntegrationLegacyCleanupAction =
  | "verify-preserved-profile-version"
  | "rebuild-from-profile-version"
  | "retain-with-explicit-exception";

export type CatalogIntegrationLegacyCleanupSurface = Readonly<{
  key: string;
  kind: CatalogIntegrationLegacyCleanupSurfaceKind;
  action: CatalogIntegrationLegacyCleanupAction;
  owner: "catalog-source-observations";
  implementationReference: string;
  reason: string;
  releaseExpectation: string;
}>;

export type CatalogIntegrationRetainedLegacyPath = Readonly<{
  key: string;
  ownerIssue: number;
  owner: "catalog-source-observations";
  reason: string;
  removalDate: string;
  removalCriteria: string;
  launchGate: string;
}>;

export type CatalogIntegrationEditableSectionSummary = Readonly<{
  section: string;
  rawJsonBacked: boolean;
}>;

export type CatalogIntegrationLegacyCleanupReadinessInput = Readonly<{
  report: CatalogIntegrationDataVerificationReport;
  editableSections: readonly CatalogIntegrationEditableSectionSummary[];
}>;

export type CatalogIntegrationLegacyCleanupReadinessFinding = Readonly<{
  code:
    | "legacy-source-observation-references"
    | "seeded-profiles-missing"
    | "profile-sections-missing"
    | "raw-json-section-editor";
  severity: "p1" | "p2";
  releaseCheck: string;
}>;

export type CatalogIntegrationLegacyCleanupReadinessReport = Readonly<{
  launchReady: boolean;
  findings: readonly CatalogIntegrationLegacyCleanupReadinessFinding[];
}>;

export const catalogIntegrationLegacyCleanupSurfaces: readonly CatalogIntegrationLegacyCleanupSurface[] = [
  {
    key: "provider-profile-version-json-snapshot",
    kind: "data-surface",
    action: "verify-preserved-profile-version",
    owner: "catalog-source-observations",
    implementationReference:
      "bounded-contexts/catalog/features/source-observations/api/provider-integration-profile-store.ts",
    reason: "Seeded and admin-authored Provider Integration Profile versions are preserved.",
    releaseExpectation:
      "The persisted profile version store keeps retained Provider Integration Profile versions readable.",
  },
  {
    key: "profile-section-projections",
    kind: "data-surface",
    action: "rebuild-from-profile-version",
    owner: "catalog-source-observations",
    implementationReference:
      "bounded-contexts/catalog/features/source-observations/api/provider-profile-section-projection.ts",
    reason: "Section projections are derived read models, not legacy profile truth.",
    releaseExpectation:
      "Profile section rows and diagnostics can be regenerated from retained or seeded profile versions.",
  },
  {
    key: "profile-section-diagnostics",
    kind: "data-surface",
    action: "rebuild-from-profile-version",
    owner: "catalog-source-observations",
    implementationReference:
      "bounded-contexts/catalog/features/source-observations/api/provider-profile-section-projection.ts",
    reason: "Section diagnostics are derived from profile validation and fixture evidence.",
    releaseExpectation: "Diagnostics rebuild with profile section projections after seeded profile bootstrap.",
  },
  {
    key: "fixture-contract-metadata-and-payloads",
    kind: "data-surface",
    action: "retain-with-explicit-exception",
    owner: "catalog-source-observations",
    implementationReference:
      "bounded-contexts/catalog/features/source-observations/api/provider-profile-contract-harness.ts",
    reason:
      "Fixture metadata remains with profile versions; raw fixture payload retention follows Catalog Integration Data Governance.",
    releaseExpectation:
      "Fixture payload bodies are retained only when governance and #804 retained-data evidence allow it.",
  },
  {
    key: "section-scoped-profile-commands",
    kind: "bootstrap-path",
    action: "retain-with-explicit-exception",
    owner: "catalog-source-observations",
    implementationReference:
      "bounded-contexts/catalog/features/source-observations/api/provider-profile-section-registry.ts",
    reason: "Section-scoped commands are the supported typed authoring path and replace raw JSON editing.",
    releaseExpectation: "Editable section metadata stays rawJsonBacked false for every normal operator section.",
  },
] as const;

export const catalogIntegrationRetainedLegacyPaths: readonly CatalogIntegrationRetainedLegacyPath[] = [] as const;

export function evaluateCatalogIntegrationLegacyCleanupReadiness(
  input: CatalogIntegrationLegacyCleanupReadinessInput,
): CatalogIntegrationLegacyCleanupReadinessReport {
  const findings: CatalogIntegrationLegacyCleanupReadinessFinding[] = [];
  const { report } = input;

  if (report.legacySourceObservationReferences > 0) {
    findings.push({
      code: "legacy-source-observation-references",
      severity: "p1",
      releaseCheck: "Legacy Source Observation profile markers must be zero before launch.",
    });
  }

  if (report.activeProviderProfiles <= 0) {
    findings.push({
      code: "seeded-profiles-missing",
      severity: "p1",
      releaseCheck: "Fresh bootstrap must recreate at least one active seeded Provider Integration Profile.",
    });
  }

  if (report.providerProfileVersions > 0 && report.profileSections <= 0) {
    findings.push({
      code: "profile-sections-missing",
      severity: "p1",
      releaseCheck: "Provider profile section projections must rebuild from retained or seeded profile versions.",
    });
  }

  for (const section of input.editableSections) {
    if (section.rawJsonBacked) {
      findings.push({
        code: "raw-json-section-editor",
        severity: "p1",
        releaseCheck: `Editable section ${section.section} is raw JSON backed and cannot be a normal operator workflow.`,
      });
    }
  }

  return {
    launchReady: findings.length === 0,
    findings,
  };
}

export function catalogIntegrationLegacyCleanupReleaseChecklist(): readonly string[] {
  return [
    "Capture a read-only report of retained Catalog integration data and job status for release evidence.",
    "Verify legacy Source Observation profile references are zero.",
    "Verify seeded active TCGdex, TCGplayer, and Scrydex profile versions are present after bootstrap.",
    "Verify profile section projections and diagnostics rebuilt from retained or seeded profile versions.",
    "Verify every editable Provider Integration Profile section reports rawJsonBacked=false.",
    "Verify unsupported profile authoring compatibility code, controls, fixtures, seeds, and durable documentation are absent.",
  ];
}

export function catalogIntegrationLegacyCleanupVerificationQueries(): readonly string[] {
  return [
    "SELECT COUNT(*) AS legacy_source_observation_references FROM catalog_source_observations WHERE source_profile_version = 'legacy' OR source_mapping_fingerprint = 'legacy' OR promotion_profile_version = 'legacy';",
    "SELECT COUNT(*) AS source_observations FROM catalog_source_observations;",
    "SELECT COUNT(*) AS integration_jobs FROM catalog_source_observation_integration_durable_jobs;",
    "SELECT COUNT(*) AS integration_work_units FROM catalog_source_observation_integration_work_units;",
    "SELECT COUNT(*) AS bulk_review_jobs FROM catalog_source_observation_bulk_review_jobs;",
    "SELECT COUNT(*) AS bulk_review_work_units FROM catalog_source_observation_bulk_review_work_units;",
    "SELECT provider_key, profile_version, lifecycle FROM catalog_provider_integration_profile_versions WHERE active = true AND lifecycle = 'active';",
    "SELECT COUNT(*) AS profile_sections FROM catalog_provider_profile_version_sections;",
    "SELECT COUNT(*) AS profile_section_diagnostics FROM catalog_provider_profile_version_section_diagnostics;",
    "SELECT COUNT(*) AS provider_rate_limits_above_floor FROM catalog_tcgplayer_automation_domain_rate_limits WHERE effective_request_delay_ms <> min_request_delay_ms OR effective_learned_min_delay_ms <> min_request_delay_ms OR shared_success_streak <> 0;",
  ];
}
