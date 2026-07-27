import type {
  CatalogIntegrationDataSurfaceKey,
  CatalogIntegrationDataVerificationReport,
} from "./catalog-integration-data-migration-reset";

export type CatalogIntegrationLegacyCleanupSurfaceKind = "data-surface" | "bootstrap-path";

export type CatalogIntegrationLegacyCleanupAction =
  | "wipe"
  | "wipe-and-rebuild"
  | "rebuild-from-profile-version"
  | "retain-with-explicit-exception";

export type CatalogIntegrationLegacyCleanupSurface = Readonly<{
  key: string;
  kind: CatalogIntegrationLegacyCleanupSurfaceKind;
  action: CatalogIntegrationLegacyCleanupAction;
  owner: "catalog-source-observations";
  implementationReference: string;
  resetSurfaceKey?: CatalogIntegrationDataSurfaceKey;
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
    | "source-observations-not-reset"
    | "legacy-source-observation-references"
    | "integration-jobs-not-reset"
    | "bulk-review-jobs-not-reset"
    | "provider-option-query-cache-not-reset"
    | "provider-option-rate-limits-not-reset"
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
    action: "wipe-and-rebuild",
    owner: "catalog-source-observations",
    implementationReference:
      "bounded-contexts/catalog/features/source-observations/api/provider-integration-profile-store.ts",
    resetSurfaceKey: "provider-profile-version",
    reason:
      "Pre-launch profile JSON rows are replaced by seeded or admin-authored Provider Integration Profile versions.",
    releaseExpectation:
      "Seeded TCGdex, TCGplayer, and Scrydex profiles rebuild through the persisted profile version store.",
  },
  {
    key: "profile-section-projections",
    kind: "data-surface",
    action: "rebuild-from-profile-version",
    owner: "catalog-source-observations",
    implementationReference:
      "bounded-contexts/catalog/features/source-observations/api/provider-profile-section-projection.ts",
    resetSurfaceKey: "profile-section-projection",
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
    resetSurfaceKey: "profile-section-diagnostic",
    reason: "Section diagnostics are derived from profile validation and fixture evidence.",
    releaseExpectation: "Diagnostics rebuild with profile section projections after seeded profile bootstrap.",
  },
  {
    key: "source-observation-profile-references",
    kind: "data-surface",
    action: "wipe",
    owner: "catalog-source-observations",
    implementationReference: "bounded-contexts/catalog/features/source-observations/read-model/projection.ts",
    resetSurfaceKey: "source-observation",
    reason: "Pre-launch Source Observations can be re-imported under current profile and mapping fingerprints.",
    releaseExpectation: "Clean release reset leaves zero Source Observations and zero legacy profile references.",
  },
  {
    key: "integration-durable-jobs",
    kind: "data-surface",
    action: "wipe",
    owner: "catalog-source-observations",
    implementationReference: "bounded-contexts/catalog/features/source-observations/api/runtime.ts",
    resetSurfaceKey: "integration-durable-job",
    reason: "Queued, running, and completed pre-launch jobs are execution state, not Catalog truth.",
    releaseExpectation: "Integration durable job rows are empty before launch verification.",
  },
  {
    key: "integration-job-events",
    kind: "data-surface",
    action: "wipe",
    owner: "catalog-source-observations",
    implementationReference: "bounded-contexts/catalog/features/source-observations/api/runtime.ts",
    resetSurfaceKey: "integration-job-event",
    reason: "Pre-launch integration job events are execution evidence for data that is wiped and rebuilt.",
    releaseExpectation: "Integration job event rows are empty before launch verification.",
  },
  {
    key: "integration-work-units",
    kind: "data-surface",
    action: "wipe",
    owner: "catalog-source-observations",
    implementationReference: "bounded-contexts/catalog/features/source-observations/api/runtime.ts",
    resetSurfaceKey: "integration-work-unit",
    reason: "Pre-launch work units are retry state for jobs that are cancelled or wiped before launch.",
    releaseExpectation: "Integration work-unit rows are empty before launch verification.",
  },
  {
    key: "bulk-review-jobs",
    kind: "data-surface",
    action: "wipe",
    owner: "catalog-source-observations",
    implementationReference: "bounded-contexts/catalog/features/source-observations/api/runtime.ts",
    resetSurfaceKey: "bulk-review-job",
    reason: "Pre-launch bulk review jobs are operator workflow state, not Catalog truth.",
    releaseExpectation: "Bulk review job rows are empty before launch verification.",
  },
  {
    key: "bulk-review-job-events",
    kind: "data-surface",
    action: "wipe",
    owner: "catalog-source-observations",
    implementationReference: "bounded-contexts/catalog/features/source-observations/api/runtime.ts",
    resetSurfaceKey: "bulk-review-job-event",
    reason: "Pre-launch bulk review events describe jobs whose target observations are wiped and rebuilt.",
    releaseExpectation: "Bulk review job event rows are empty before launch verification.",
  },
  {
    key: "bulk-review-work-units",
    kind: "data-surface",
    action: "wipe",
    owner: "catalog-source-observations",
    implementationReference: "bounded-contexts/catalog/features/source-observations/api/runtime.ts",
    resetSurfaceKey: "bulk-review-work-unit",
    reason: "Pre-launch bulk review work units are execution state tied to wipeable Source Observations.",
    releaseExpectation: "Bulk review work-unit rows are empty before launch verification.",
  },
  {
    key: "provider-option-query-cache",
    kind: "data-surface",
    action: "wipe",
    owner: "catalog-source-observations",
    implementationReference: "bounded-contexts/catalog/features/source-observations/api/provider-option-query-cache.ts",
    resetSurfaceKey: "provider-option-query-cache",
    reason: "Provider option query results are operational cache and must not carry launch semantics.",
    releaseExpectation: "Provider option query cache rows are zero after pre-launch reset.",
  },
  {
    key: "learned-provider-option-rate-limits",
    kind: "data-surface",
    action: "wipe",
    owner: "catalog-source-observations",
    implementationReference:
      "bounded-contexts/catalog/features/source-observations/integrations/tcgplayer-automation-client",
    resetSurfaceKey: "provider-option-rate-limit",
    reason: "Learned throttling state is operational cache and must not carry launch semantics.",
    releaseExpectation: "Provider option rate limit rows are zero after pre-launch reset.",
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

  if (report.sourceObservations > 0) {
    findings.push({
      code: "source-observations-not-reset",
      severity: "p1",
      releaseCheck: "Clean pre-launch reset expects zero Source Observations before launch verification.",
    });
  }

  if (report.legacySourceObservationReferences > 0) {
    findings.push({
      code: "legacy-source-observation-references",
      severity: "p1",
      releaseCheck: "Legacy Source Observation profile markers must be zero before launch.",
    });
  }

  if (report.integrationDurableJobs > 0 || report.integrationWorkUnits > 0) {
    findings.push({
      code: "integration-jobs-not-reset",
      severity: "p1",
      releaseCheck: "Integration durable jobs and work units must be empty after pre-launch wipe/rebuild.",
    });
  }

  if (report.bulkReviewJobs > 0 || report.bulkReviewWorkUnits > 0) {
    findings.push({
      code: "bulk-review-jobs-not-reset",
      severity: "p1",
      releaseCheck: "Bulk review jobs and work units must be empty after pre-launch wipe/rebuild.",
    });
  }

  if (report.providerOptionRateLimits > 0) {
    findings.push({
      code: "provider-option-rate-limits-not-reset",
      severity: "p2",
      releaseCheck: "Learned provider option rate-limit cache must not be carried into launch.",
    });
  }

  if (report.providerOptionQueryCacheEntries > 0) {
    findings.push({
      code: "provider-option-query-cache-not-reset",
      severity: "p2",
      releaseCheck: "Provider option query cache rows must not be carried into launch.",
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
    "Run the pre-launch wipe/rebuild reset and keep the before/after verification report with release evidence.",
    "Verify Source Observations, integration jobs, bulk review jobs, work units, and learned provider rate limits are empty.",
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
  ];
}
