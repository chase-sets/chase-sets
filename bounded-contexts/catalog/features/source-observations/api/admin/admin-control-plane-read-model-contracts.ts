import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type {
  CatalogIntegrationSchemaCompatibilitySurfaceKey,
  CatalogIntegrationWireSchemaVersion,
} from "../governance/catalog-integration-schema-compatibility";
import type { CatalogIntegrationGovernedDataClassKey } from "../governance/catalog-integration-data-governance";
import type {
  CatalogProviderCredentialReadinessState,
  CatalogProviderCredentialRequirement,
} from "../governance/catalog-integration-credential-readiness";
import type { CatalogIntegrationAuditEvidenceTimelineEntry } from "../governance/catalog-integration-audit-evidence";
import type {
  CatalogProviderProfileSectionDiagnostic,
  CatalogProviderProfileSectionKey,
} from "../providers/provider-profile-sections";
import type { CatalogIntegrationDiagnosticBlockingBehavior } from "../governance/catalog-integration-diagnostic-taxonomy";
import type { CatalogProviderProfileSectionStatus } from "../providers/provider-profile-review";

export type CatalogAdminControlPlaneQueryKey =
  | "integration-health-summary"
  | "provider-transport-readiness-summary"
  | "provider-source-options"
  | "active-profile-version-summary"
  | "profile-section-status-summary"
  | "adapter-transport-diagnostics"
  | "fixture-validation-summary"
  | "dry-run-evidence-summary"
  | "semantic-version-comparison"
  | "activation-readiness-summary"
  | "replay-reapply-impact-summary"
  | "import-job-progress-summary"
  | "source-observation-review-query"
  | "promotion-plan-preview"
  | "rollback-retirement-impact-summary"
  | "audit-evidence-timeline";

export type CatalogAdminControlPlaneReadModelName =
  | "CatalogAdminIntegrationHealthSummaryReadModel"
  | "CatalogAdminProviderTransportReadinessSummaryReadModel"
  | "CatalogAdminProviderSourceOptionsReadModel"
  | "CatalogAdminActiveProfileVersionSummaryReadModel"
  | "CatalogAdminProfileSectionStatusSummaryReadModel"
  | "CatalogAdminAdapterTransportDiagnosticsReadModel"
  | "CatalogAdminFixtureValidationSummaryReadModel"
  | "CatalogAdminDryRunEvidenceSummaryReadModel"
  | "CatalogAdminSemanticVersionComparisonReadModel"
  | "CatalogAdminActivationReadinessSummaryReadModel"
  | "CatalogAdminReplayReapplyImpactSummaryReadModel"
  | "CatalogAdminImportJobProgressSummaryReadModel"
  | "CatalogAdminSourceObservationReviewReadModel"
  | "CatalogAdminPromotionPlanPreviewReadModel"
  | "CatalogAdminRollbackRetirementImpactSummaryReadModel"
  | "CatalogAdminAuditEvidenceTimelineReadModel";

export type CatalogAdminControlPlaneGrouping =
  | "ingestion-unit"
  | "provider-adapter"
  | "provider"
  | "profile-version"
  | "job"
  | "observation"
  | "timeline";

export type CatalogAdminControlPlaneUnitKeyRequirement = "required" | "optional" | "not-applicable";

export type CatalogAdminControlPlaneFreshnessExpectation =
  | "request-time"
  | "transactional-projection"
  | "durable-job-checkpoint"
  | "eventual-projection";

export type CatalogAdminControlPlaneSourceKind =
  | "runtime-service"
  | "table"
  | "projection-table"
  | "durable-job-table"
  | "event-store"
  | "planned-projection";

export type CatalogAdminControlPlaneErrorCode =
  | "adapter_unavailable"
  | "credential_unavailable"
  | "provider_option_query_unavailable"
  | "provider_option_query_rollout_blocked"
  | "provider_option_parent_required"
  | "source_projection_stale"
  | "profile_version_missing"
  | "profile_section_projection_missing"
  | "fixture_validation_blocked"
  | "dry_run_blocked"
  | "semantic_diff_unavailable"
  | "activation_blocked"
  | "impact_projection_unavailable"
  | "job_not_found"
  | "observation_not_found"
  | "promotion_plan_unavailable"
  | "audit_projection_unavailable"
  | "permission_denied";

export type CatalogAdminControlPlaneSource = Readonly<{
  name: string;
  kind: CatalogAdminControlPlaneSourceKind;
  ownerContext: "catalog" | "platform";
  available: boolean;
  notes: string;
}>;

export type CatalogAdminControlPlaneErrorState = Readonly<{
  code: CatalogAdminControlPlaneErrorCode;
  severity: "blocked" | "degraded" | "empty";
  operatorMessage: string;
}>;

export type CatalogAdminControlPlaneQueryContract = Readonly<{
  key: CatalogAdminControlPlaneQueryKey;
  readModelName: CatalogAdminControlPlaneReadModelName;
  routeIntent: string;
  grouping: CatalogAdminControlPlaneGrouping;
  unitKey: CatalogAdminControlPlaneUnitKeyRequirement;
  freshness: CatalogAdminControlPlaneFreshnessExpectation;
  sources: readonly CatalogAdminControlPlaneSource[];
  errorStates: readonly CatalogAdminControlPlaneErrorState[];
  genericProviderSurface: boolean;
}>;

export const catalogAdminControlPlaneQueryKeys = [
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
] as const satisfies readonly CatalogAdminControlPlaneQueryKey[];

export const catalogAdminControlPlaneQueryContracts = [
  contract({
    key: "integration-health-summary",
    readModelName: "CatalogAdminIntegrationHealthSummaryReadModel",
    routeIntent: "Summarize Catalog semantic health for each ingestion unit.",
    grouping: "ingestion-unit",
    unitKey: "required",
    freshness: "request-time",
    sources: [
      runtimeSource("ProviderAdapterRegistry.listIntegrationUnits/getTransportDiagnostics/getCredentialReadiness"),
      runtimeSource("CatalogIntegrationEngine.getCatalogIntegrationControlPlaneReadiness"),
      tableSource("catalog_provider_integration_profile_versions"),
      projectionSource("catalog_provider_profile_version_sections"),
      projectionSource("catalog_provider_profile_version_section_diagnostics"),
    ],
    errorStates: [
      errorState("adapter_unavailable", "blocked", "Provider adapter did not report integration units."),
      errorState("credential_unavailable", "blocked", "Provider credential readiness is unavailable."),
      errorState(
        "profile_version_missing",
        "blocked",
        "No active profile version is available for the ingestion unit.",
      ),
      errorState("source_projection_stale", "degraded", "Readiness projections are behind the profile source."),
    ],
  }),
  contract({
    key: "provider-transport-readiness-summary",
    readModelName: "CatalogAdminProviderTransportReadinessSummaryReadModel",
    routeIntent:
      "Summarize provider/adapter transport and credential readiness separately from Catalog semantic readiness.",
    grouping: "provider-adapter",
    unitKey: "optional",
    freshness: "request-time",
    sources: [runtimeSource("ProviderAdapterRegistry.getTransportDiagnostics/getCredentialReadiness")],
    errorStates: [
      errorState("adapter_unavailable", "blocked", "Provider adapter transport diagnostics are unavailable."),
      errorState("credential_unavailable", "blocked", "Provider credential readiness is unavailable."),
      errorState("permission_denied", "blocked", "Operator lacks permission to inspect provider transport readiness."),
    ],
  }),
  contract({
    key: "provider-source-options",
    readModelName: "CatalogAdminProviderSourceOptionsReadModel",
    routeIntent:
      "Compose active-profile provider source option kinds, parent requirements, cached pages, and refresh affordances.",
    grouping: "provider",
    unitKey: "optional",
    freshness: "request-time",
    sources: [
      runtimeSource("ProviderOptionQueryServices.queryIntegrationOptions"),
      tableSource("catalog_provider_integration_profile_versions"),
      tableSource("catalog_provider_option_query_cache"),
    ],
    errorStates: [
      errorState("provider_option_query_unavailable", "degraded", "Provider option cache or transport is unavailable."),
      errorState(
        "provider_option_query_rollout_blocked",
        "blocked",
        "Provider option queries are blocked by rollout controls.",
      ),
      errorState("provider_option_parent_required", "empty", "A parent source option must be selected first."),
      errorState("profile_version_missing", "empty", "No active profile version declares source option kinds."),
      errorState("permission_denied", "blocked", "Operator lacks permission to inspect provider source options."),
    ],
  }),
  contract({
    key: "active-profile-version-summary",
    readModelName: "CatalogAdminActiveProfileVersionSummaryReadModel",
    routeIntent: "Show active provider/profile versions and the ingestion units they govern.",
    grouping: "ingestion-unit",
    unitKey: "required",
    freshness: "transactional-projection",
    sources: [
      tableSource("catalog_provider_integration_profile_versions"),
      projectionSource("catalog_provider_profile_version_sections"),
    ],
    errorStates: [
      errorState(
        "profile_version_missing",
        "empty",
        "No active profile version exists for the provider or ingestion unit.",
      ),
      errorState(
        "source_projection_stale",
        "degraded",
        "Profile section projection does not match the active version.",
      ),
    ],
  }),
  contract({
    key: "profile-section-status-summary",
    readModelName: "CatalogAdminProfileSectionStatusSummaryReadModel",
    routeIntent: "List profile section validation, diagnostics, and stale-edit fingerprints by ingestion unit.",
    grouping: "ingestion-unit",
    unitKey: "required",
    freshness: "transactional-projection",
    sources: [
      projectionSource("catalog_provider_profile_version_sections"),
      projectionSource("catalog_provider_profile_version_section_diagnostics"),
    ],
    errorStates: [
      errorState("profile_section_projection_missing", "blocked", "Profile section projection rows are missing."),
      errorState(
        "source_projection_stale",
        "degraded",
        "Profile section projection is stale for the requested profile version.",
      ),
    ],
  }),
  contract({
    key: "adapter-transport-diagnostics",
    readModelName: "CatalogAdminAdapterTransportDiagnosticsReadModel",
    routeIntent: "Expose provider adapter diagnostics with optional ingestion-unit attribution.",
    grouping: "provider-adapter",
    unitKey: "optional",
    freshness: "request-time",
    sources: [runtimeSource("ProviderAdapterRegistry.getTransportDiagnostics/getCredentialReadiness")],
    errorStates: [
      errorState("adapter_unavailable", "blocked", "Provider adapter diagnostics are unavailable."),
      errorState("permission_denied", "blocked", "Operator lacks permission to inspect provider diagnostics."),
    ],
  }),
  contract({
    key: "fixture-validation-summary",
    readModelName: "CatalogAdminFixtureValidationSummaryReadModel",
    routeIntent: "Report fixture coverage and validation results by ingestion unit and profile version.",
    grouping: "ingestion-unit",
    unitKey: "required",
    freshness: "transactional-projection",
    sources: [
      tableSource("catalog_provider_integration_profile_versions"),
      projectionSource("catalog_provider_profile_version_sections"),
      projectionSource("catalog_provider_profile_version_section_diagnostics"),
    ],
    errorStates: [
      errorState("fixture_validation_blocked", "blocked", "Fixture coverage or validation has blocking diagnostics."),
      errorState("profile_version_missing", "blocked", "Profile version is required for fixture validation."),
    ],
  }),
  contract({
    key: "dry-run-evidence-summary",
    readModelName: "CatalogAdminDryRunEvidenceSummaryReadModel",
    routeIntent: "Summarize dry-run evidence, diagnostics, and redaction state by ingestion unit.",
    grouping: "ingestion-unit",
    unitKey: "required",
    freshness: "request-time",
    sources: [
      runtimeSource("CatalogIntegrationEngine dry-run harness"),
      plannedProjectionSource("catalog_admin_dry_run_evidence_projection"),
    ],
    errorStates: [
      errorState("dry_run_blocked", "blocked", "Dry run could not produce safe Source Observation evidence."),
      errorState("permission_denied", "blocked", "Operator lacks permission to inspect dry-run evidence."),
    ],
  }),
  contract({
    key: "semantic-version-comparison",
    readModelName: "CatalogAdminSemanticVersionComparisonReadModel",
    routeIntent: "Compare candidate and active profile semantics by ingestion unit.",
    grouping: "ingestion-unit",
    unitKey: "required",
    freshness: "request-time",
    sources: [
      tableSource("catalog_provider_integration_profile_versions"),
      plannedProjectionSource("catalog_admin_profile_semantic_diff_projection"),
    ],
    errorStates: [
      errorState(
        "semantic_diff_unavailable",
        "blocked",
        "Semantic comparison could not be built for the profile pair.",
      ),
      errorState("profile_version_missing", "blocked", "Candidate or active profile version is missing."),
    ],
  }),
  contract({
    key: "activation-readiness-summary",
    readModelName: "CatalogAdminActivationReadinessSummaryReadModel",
    routeIntent: "Show activation readiness and blocked checks by ingestion unit.",
    grouping: "ingestion-unit",
    unitKey: "required",
    freshness: "request-time",
    sources: [
      runtimeSource("evaluateCatalogProviderProfileActivationReadiness"),
      projectionSource("catalog_provider_profile_version_sections"),
      projectionSource("catalog_provider_profile_version_section_diagnostics"),
    ],
    errorStates: [
      errorState("activation_blocked", "blocked", "Activation has one or more blocking checks."),
      errorState("profile_version_missing", "blocked", "Profile version is required for activation readiness."),
    ],
  }),
  contract({
    key: "replay-reapply-impact-summary",
    readModelName: "CatalogAdminReplayReapplyImpactSummaryReadModel",
    routeIntent: "Preview replay and reapply impact by ingestion unit before enqueueing work.",
    grouping: "ingestion-unit",
    unitKey: "required",
    freshness: "request-time",
    sources: [
      tableSource("catalog_source_observations"),
      plannedProjectionSource("catalog_admin_replay_reapply_impact_projection"),
    ],
    errorStates: [
      errorState("impact_projection_unavailable", "degraded", "Replay/reapply impact projection is unavailable."),
      errorState("profile_version_missing", "blocked", "Profile version is required for replay/reapply impact."),
    ],
  }),
  contract({
    key: "import-job-progress-summary",
    readModelName: "CatalogAdminImportJobProgressSummaryReadModel",
    routeIntent: "Track integration import/reapply jobs and work-unit progress with ingestion-unit attribution.",
    grouping: "job",
    unitKey: "required",
    freshness: "durable-job-checkpoint",
    sources: [
      durableJobSource("catalog_source_observation_integration_durable_jobs"),
      durableJobSource("catalog_source_observation_integration_work_units"),
      durableJobSource("catalog_source_observation_bulk_review_jobs"),
      durableJobSource("catalog_source_observation_bulk_review_work_units"),
    ],
    errorStates: [
      errorState("job_not_found", "empty", "No matching integration or review job exists."),
      errorState(
        "source_projection_stale",
        "degraded",
        "Job checkpoint has not yet reflected the latest work-unit state.",
      ),
    ],
  }),
  contract({
    key: "source-observation-review-query",
    readModelName: "CatalogAdminSourceObservationReviewReadModel",
    routeIntent: "Query Source Observations by provider, ingestion unit, profile, scope, and review status.",
    grouping: "observation",
    unitKey: "required",
    freshness: "transactional-projection",
    sources: [tableSource("catalog_source_observations")],
    errorStates: [
      errorState("observation_not_found", "empty", "No Source Observations match the requested review scope."),
      errorState("source_projection_stale", "degraded", "Source Observation projection is behind recent writes."),
    ],
  }),
  contract({
    key: "promotion-plan-preview",
    readModelName: "CatalogAdminPromotionPlanPreviewReadModel",
    routeIntent: "Preview promotion commands and blocked checks by ingestion unit before applying Catalog writes.",
    grouping: "ingestion-unit",
    unitKey: "required",
    freshness: "request-time",
    sources: [
      runtimeSource("planCatalogProviderPromotionCommands"),
      tableSource("catalog_provider_integration_profile_versions"),
      tableSource("catalog_source_observations"),
    ],
    errorStates: [
      errorState(
        "promotion_plan_unavailable",
        "blocked",
        "Promotion plan cannot be built for the selected profile/scope.",
      ),
      errorState(
        "observation_not_found",
        "empty",
        "No promotion-eligible Source Observations match the requested scope.",
      ),
    ],
  }),
  contract({
    key: "rollback-retirement-impact-summary",
    readModelName: "CatalogAdminRollbackRetirementImpactSummaryReadModel",
    routeIntent: "Summarize rollback, deprecation, and retirement impact by ingestion unit and profile version.",
    grouping: "ingestion-unit",
    unitKey: "required",
    freshness: "request-time",
    sources: [
      tableSource("catalog_provider_integration_profile_versions"),
      tableSource("catalog_source_observations"),
      plannedProjectionSource("catalog_admin_profile_lifecycle_impact_projection"),
    ],
    errorStates: [
      errorState("impact_projection_unavailable", "degraded", "Lifecycle impact projection is unavailable."),
      errorState(
        "profile_version_missing",
        "blocked",
        "Profile version is required for rollback or retirement impact.",
      ),
    ],
  }),
  contract({
    key: "audit-evidence-timeline",
    readModelName: "CatalogAdminAuditEvidenceTimelineReadModel",
    routeIntent: "Project profile, job, review, and lifecycle evidence into an ingestion-unit timeline.",
    grouping: "timeline",
    unitKey: "required",
    freshness: "eventual-projection",
    sources: [
      eventStoreSource("catalog.source-observation-*"),
      tableSource("catalog_provider_integration_profile_versions"),
      durableJobSource("catalog_source_observation_integration_durable_jobs"),
      plannedProjectionSource("catalog_admin_audit_evidence_timeline_projection"),
    ],
    errorStates: [
      errorState("audit_projection_unavailable", "degraded", "Audit/evidence timeline projection is unavailable."),
      errorState("permission_denied", "blocked", "Operator lacks permission to inspect audit evidence."),
    ],
  }),
] as const satisfies readonly CatalogAdminControlPlaneQueryContract[];

export const catalogAdminControlPlaneQueryContractsByKey: Readonly<
  Record<CatalogAdminControlPlaneQueryKey, CatalogAdminControlPlaneQueryContract>
> = Object.fromEntries(catalogAdminControlPlaneQueryContracts.map((entry) => [entry.key, entry])) as Readonly<
  Record<CatalogAdminControlPlaneQueryKey, CatalogAdminControlPlaneQueryContract>
>;

export function getCatalogAdminControlPlaneQueryContract(
  key: CatalogAdminControlPlaneQueryKey,
): CatalogAdminControlPlaneQueryContract {
  return catalogAdminControlPlaneQueryContractsByKey[key];
}

export const catalogAdminControlPlaneQueryGovernanceDataClasses = {
  "integration-health-summary": ["dry-run-output-evidence", "engine-diagnostic", "provider-credential-readiness"],
  "provider-transport-readiness-summary": ["provider-transport-diagnostic", "provider-credential-readiness"],
  "provider-source-options": ["engine-diagnostic", "provider-transport-diagnostic"],
  "active-profile-version-summary": ["audit-evidence"],
  "profile-section-status-summary": ["engine-diagnostic", "audit-evidence"],
  "adapter-transport-diagnostics": ["provider-transport-diagnostic", "provider-credential-readiness"],
  "fixture-validation-summary": ["fixture-payload", "engine-diagnostic"],
  "dry-run-evidence-summary": ["dry-run-input-payload", "dry-run-output-evidence", "engine-diagnostic"],
  "semantic-version-comparison": ["dry-run-output-evidence", "audit-evidence"],
  "activation-readiness-summary": ["engine-diagnostic", "fixture-payload", "audit-evidence"],
  "replay-reapply-impact-summary": ["audit-evidence", "job-progress-summary"],
  "import-job-progress-summary": [
    "job-progress-summary",
    "provider-transport-diagnostic",
    "provider-credential-readiness",
  ],
  "source-observation-review-query": ["raw-provider-payload", "audit-evidence"],
  "promotion-plan-preview": ["dry-run-output-evidence", "audit-evidence"],
  "rollback-retirement-impact-summary": ["audit-evidence", "job-progress-summary"],
  "audit-evidence-timeline": ["audit-evidence"],
} as const satisfies Readonly<
  Record<CatalogAdminControlPlaneQueryKey, readonly CatalogIntegrationGovernedDataClassKey[]>
>;

export type CatalogAdminReadinessState = "ready" | "blocked" | "degraded" | "unknown";
export type CatalogAdminJobState = "queued" | "running" | "completed" | "failed" | "cancelled";
export type CatalogAdminJobOperatorStatus =
  | "queued"
  | "running"
  | "stale"
  | "retried"
  | "partial"
  | "failed"
  | "cancelled"
  | "completed";
export type CatalogAdminJobConsistency = Readonly<{
  schemaVersion: Extract<CatalogIntegrationWireSchemaVersion, "catalog-integration-durable-job-v1">;
  compatibilityPolicy: Extract<CatalogIntegrationSchemaCompatibilitySurfaceKey, "integration-durable-job">;
  duplicateSubmissionPolicy: "reuse-active-job";
  profileSnapshotPolicy: "snapshotted-at-enqueue";
  retryResumePolicy: "skip-completed-outcomes";
  partialFailurePolicy: "mixed-outcomes";
  workUnitClaimPolicy: "leased-job-turns" | "leased-work-units";
}>;

export type CatalogAdminControlPlaneDiagnostic = Readonly<{
  code: string;
  severity: "info" | "warning" | "error";
  diagnosticText: string;
  path: string;
  providerKey: string | null;
  adapterKey: string | null;
  unitKey: CatalogIntegrationUnitKey | null;
  source: "catalog" | "provider-adapter" | "platform";
}>;

export type CatalogAdminProfileSectionDiagnostic = CatalogProviderProfileSectionDiagnostic &
  Readonly<{
    unitKey: CatalogIntegrationUnitKey;
  }>;

export type CatalogAdminIngestionUnitIdentity = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  providerKey: string;
  productDomain: string;
  productForm: string;
  ingestionPurpose: string | null;
  displayName: string;
}>;

export type CatalogAdminProfileVersionPointer = Readonly<{
  schemaVersion: Extract<CatalogIntegrationWireSchemaVersion, "catalog-provider-profile-version-v1">;
  compatibilityPolicy: Extract<CatalogIntegrationSchemaCompatibilitySurfaceKey, "provider-profile-version">;
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  lifecycle: "draft" | "test" | "active" | "deprecated" | "retired" | string;
  active: boolean;
  connectorKind: string | null;
  connectorSourceVersion: string | null;
  sourceMappingFingerprint: string | null;
}>;

export type CatalogAdminIntegrationHealthSummaryReadModel = Readonly<{
  generatedAt: string;
  units: readonly (CatalogAdminIngestionUnitIdentity &
    Readonly<{
      activeProfile: CatalogAdminProfileVersionPointer | null;
      semanticReadiness: CatalogAdminReadinessState;
      credentialReadiness: CatalogAdminReadinessState;
      credentialReadinessState: CatalogProviderCredentialReadinessState;
      credentialRequirement: CatalogProviderCredentialRequirement;
      transportReadiness: CatalogAdminReadinessState;
      fixtureValidationStatus: CatalogAdminReadinessState;
      dryRunStatus: "completed" | "blocked" | "not-run";
      observationFacts: number;
      diagnostics: readonly CatalogAdminControlPlaneDiagnostic[];
    }>)[];
}>;

export type CatalogAdminProviderTransportReadinessSummaryReadModel = Readonly<{
  generatedAt: string;
  providers: readonly Readonly<{
    providerKey: string;
    adapterKey: string;
    readiness: CatalogAdminReadinessState;
    credentialReadiness: CatalogAdminReadinessState;
    credentialReadinessState: CatalogProviderCredentialReadinessState;
    credentialRequirement: CatalogProviderCredentialRequirement;
    unitKeys: readonly CatalogIntegrationUnitKey[];
    diagnostics: readonly CatalogAdminControlPlaneDiagnostic[];
  }>[];
}>;

export type CatalogAdminActiveProfileVersionSummaryReadModel = Readonly<{
  generatedAt: string;
  units: readonly Readonly<{
    unit: CatalogAdminIngestionUnitIdentity;
    providerActiveProfile: CatalogAdminProfileVersionPointer | null;
    unitActiveProfile: CatalogAdminProfileVersionPointer | null;
    profileSource: "provider-active" | "unit-active" | "none";
  }>[];
}>;

export type CatalogAdminProfileSectionStatusSummaryReadModel = Readonly<{
  generatedAt: string;
  unitKey: CatalogIntegrationUnitKey;
  profile: CatalogAdminProfileVersionPointer;
  sections: readonly Readonly<{
    sectionKey: CatalogProviderProfileSectionKey;
    domainConcept: string;
    editable: boolean;
    validationStatus: "valid" | "invalid";
    sectionStatus: CatalogProviderProfileSectionStatus;
    sectionFingerprint: string;
    lastEditedAt: string | null;
    diagnostics: readonly CatalogAdminProfileSectionDiagnostic[];
    readinessCheckKeys: readonly string[];
    semanticChangePaths: readonly string[];
  }>[];
}>;

export type CatalogAdminAdapterTransportDiagnosticsReadModel = Readonly<{
  generatedAt: string;
  providerKey: string;
  adapterKey: string;
  diagnostics: readonly CatalogAdminControlPlaneDiagnostic[];
}>;

export type CatalogAdminFixtureValidationSummaryReadModel = Readonly<{
  generatedAt: string;
  unitKey: CatalogIntegrationUnitKey;
  profile: CatalogAdminProfileVersionPointer;
  fixtureRoot: string;
  coveredFlows: readonly string[];
  requiredFlows: readonly string[];
  liveProviderCallsAllowed: boolean;
  validationStatus: "valid" | "invalid";
  diagnostics: readonly CatalogAdminControlPlaneDiagnostic[];
}>;

export type CatalogAdminDryRunEvidenceSummaryReadModel = Readonly<{
  generatedAt: string;
  unitKey: CatalogIntegrationUnitKey;
  profile: CatalogAdminProfileVersionPointer;
  status: "completed" | "blocked";
  redactionSummary: Readonly<Record<string, number>>;
  diagnosticLinks: readonly Readonly<{
    code: string;
    path: string;
    sectionKey: CatalogProviderProfileSectionKey;
    domainConcept: string;
    fixtureFlow: string | null;
  }>[];
  evidence: readonly Readonly<{
    path: string;
    owner: "catalog" | "provider-adapter";
    uses: readonly string[];
    value: JsonValue;
    diagnostics: readonly CatalogAdminControlPlaneDiagnostic[];
  }>[];
}>;

export type CatalogAdminSemanticVersionComparisonReadModel = Readonly<{
  generatedAt: string;
  unitKey: CatalogIntegrationUnitKey;
  candidateProfile: CatalogAdminProfileVersionPointer;
  activeProfile: CatalogAdminProfileVersionPointer | null;
  changes: readonly Readonly<{
    sectionKey: CatalogProviderProfileSectionKey;
    domainConcept: string;
    path: string;
    label: string;
    candidate: JsonValue;
    active: JsonValue;
    changed: boolean;
    severity: "info" | "warning" | "error";
    activationImpact: string;
  }>[];
  sections: readonly Readonly<{
    sectionKey: CatalogProviderProfileSectionKey;
    domainConcept: string;
    status: Exclude<CatalogProviderProfileSectionStatus, "blocked">;
    changePaths: readonly string[];
  }>[];
}>;

export type CatalogAdminActivationReadinessSummaryReadModel = Readonly<{
  generatedAt: string;
  unitKey: CatalogIntegrationUnitKey;
  profile: CatalogAdminProfileVersionPointer;
  status: "ready" | "blocked";
  checks: readonly Readonly<{
    checkKey: string;
    code: string;
    sectionKey: CatalogProviderProfileSectionKey;
    domainConcept: string;
    status: "passed" | "blocked";
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
    remediation: string;
    blockingBehavior: CatalogIntegrationDiagnosticBlockingBehavior;
    flow?: string;
  }>[];
  groups: readonly Readonly<{
    domainConcept: string;
    status: "ready" | "blocked";
    checkKeys: readonly string[];
  }>[];
}>;

export type CatalogAdminReplayReapplyImpactSummaryReadModel = Readonly<{
  generatedAt: string;
  unitKey: CatalogIntegrationUnitKey;
  profile: CatalogAdminProfileVersionPointer;
  matchedObservations: number;
  eligibleObservations: number;
  blockedObservations: number;
  impactedCatalogItemCount: number;
  impactedCatalogItemIds: readonly string[];
  externalReferenceCount: number;
  externalReferenceSamples: readonly Readonly<{
    observationId: string;
    referenceKind: "catalog-item-reference" | "product-reference";
    providerKey: string;
    externalKey: string;
    catalogItemId: string | null;
  }>[];
  sampleObservationIds: readonly string[];
  activeJobCount: number;
  activeJobSamples: readonly Readonly<{
    jobId: string;
    jobKind: "integration" | "bulk-review";
    action: "import" | "reapply" | "promote" | "reject" | "defer";
    status: string;
    providerKey: string | null;
    profileVersion: string | null;
  }>[];
  diagnostics: readonly CatalogAdminControlPlaneDiagnostic[];
}>;

export type CatalogAdminImportJobProgressSummaryReadModel = Readonly<{
  generatedAt: string;
  jobs: readonly Readonly<{
    jobId: string;
    action: "import" | "reapply" | "promote" | "reject" | "defer";
    state: CatalogAdminJobState;
    operatorStatus: CatalogAdminJobOperatorStatus;
    unitKey: CatalogIntegrationUnitKey;
    providerKey: string;
    profile: CatalogAdminProfileVersionPointer | null;
    reapplyProfileMode: "original-source-profile" | "current-active-profile" | null;
    consistency: CatalogAdminJobConsistency;
    completed: number;
    total: number;
    currentName: string | null;
    failed: number;
    skipped: number;
    workUnits: Readonly<{
      total: number;
      queued: number;
      running: number;
      completed: number;
      failed: number;
      skipped: number;
    }>;
    diagnostics: readonly CatalogAdminControlPlaneDiagnostic[];
  }>[];
}>;

export type CatalogAdminSourceObservationReviewReadModel = Readonly<{
  generatedAt: string;
  observations: readonly Readonly<{
    observationId: string;
    unitKey: CatalogIntegrationUnitKey;
    providerKey: string;
    externalKey: string;
    languageCode: string;
    sourceProfileKey: string;
    sourceProfileVersion: string;
    sourceMappingFingerprint: string;
    status: "observed" | "changed" | "promoted" | "rejected" | string;
    observedAt: string;
    updatedAt: string;
    normalizedSummary: Readonly<Record<string, string>>;
  }>[];
}>;

export type CatalogAdminPromotionPlanPreviewReadModel = Readonly<{
  generatedAt: string;
  unitKey: CatalogIntegrationUnitKey;
  profile: CatalogAdminProfileVersionPointer;
  observationScope: Readonly<Record<string, string>>;
  commands: readonly Readonly<{
    commandName: string;
    requiresReview: boolean;
    inputs: readonly Readonly<{ path: string; owner: string; uses: readonly string[] }>[];
  }>[];
  diagnostics: readonly CatalogAdminControlPlaneDiagnostic[];
}>;

export type CatalogAdminRollbackRetirementImpactSummaryReadModel = Readonly<{
  generatedAt: string;
  unitKey: CatalogIntegrationUnitKey;
  profile: CatalogAdminProfileVersionPointer;
  operation: "activation" | "rollback" | "deprecate" | "retire";
  referencedObservationCount: number;
  sourceProfileReferenceCount: number;
  promotionProfileReferenceCount: number;
  impactedCatalogItemCount: number;
  impactedCatalogItemIds: readonly string[];
  externalReferenceCount: number;
  externalReferenceSamples: readonly Readonly<{
    observationId: string;
    referenceKind: "catalog-item-reference" | "product-reference";
    providerKey: string;
    externalKey: string;
    catalogItemId: string | null;
  }>[];
  sampleObservationIds: readonly string[];
  impactedJobCount: number;
  allowed: boolean;
  blockers: readonly CatalogAdminControlPlaneDiagnostic[];
}>;

export type CatalogAdminAuditEvidenceTimelineReadModel = Readonly<{
  generatedAt: string;
  unitKey: CatalogIntegrationUnitKey;
  entries: readonly CatalogIntegrationAuditEvidenceTimelineEntry[];
}>;

function contract(
  input: Omit<CatalogAdminControlPlaneQueryContract, "genericProviderSurface"> &
    Partial<Pick<CatalogAdminControlPlaneQueryContract, "genericProviderSurface">>,
): CatalogAdminControlPlaneQueryContract {
  return {
    ...input,
    genericProviderSurface: input.genericProviderSurface ?? true,
  };
}

function runtimeSource(name: string): CatalogAdminControlPlaneSource {
  return {
    name,
    kind: "runtime-service",
    ownerContext: "catalog",
    available: true,
    notes: "Resolved at request time through the Source Observations runtime facet.",
  };
}

function tableSource(name: string): CatalogAdminControlPlaneSource {
  return {
    name,
    kind: "table",
    ownerContext: "catalog",
    available: true,
    notes: "Existing Catalog-owned persistence source.",
  };
}

function projectionSource(name: string): CatalogAdminControlPlaneSource {
  return {
    name,
    kind: "projection-table",
    ownerContext: "catalog",
    available: true,
    notes: "Existing Catalog-owned read projection.",
  };
}

function durableJobSource(name: string): CatalogAdminControlPlaneSource {
  return {
    name,
    kind: "durable-job-table",
    ownerContext: "platform",
    available: true,
    notes: "Platform durable-job storage interpreted through Catalog job read models.",
  };
}

function eventStoreSource(name: string): CatalogAdminControlPlaneSource {
  return {
    name,
    kind: "event-store",
    ownerContext: "catalog",
    available: true,
    notes: "Catalog event stream source used to project audit/evidence timeline facts.",
  };
}

function plannedProjectionSource(name: string): CatalogAdminControlPlaneSource {
  return {
    name,
    kind: "planned-projection",
    ownerContext: "catalog",
    available: false,
    notes: "Contracted by #781 for follow-on projection/API implementation.",
  };
}

function errorState(
  code: CatalogAdminControlPlaneErrorCode,
  severity: CatalogAdminControlPlaneErrorState["severity"],
  operatorMessage: string,
): CatalogAdminControlPlaneErrorState {
  return {
    code,
    severity,
    operatorMessage,
  };
}
