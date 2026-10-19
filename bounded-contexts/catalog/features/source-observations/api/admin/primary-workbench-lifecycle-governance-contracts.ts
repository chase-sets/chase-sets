import {
  isSafePrimaryWorkbenchReturnPath,
  isSafePrimaryWorkbenchObservabilityLink,
} from "./primary-workbench-shared-contracts";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogMergeCandidateReviewCommandPreview } from "../promotion/catalog-merge-candidate-review-command-payloads";
import type {
  CatalogAdminControlPlaneFreshnessState,
  CatalogAdminControlPlanePaginationMode,
  CatalogAdminControlPlaneQueryKey,
  CatalogAdminControlPlaneDiagnostic,
  CatalogAdminRollbackRetirementImpactSummaryReadModel,
  CatalogAdminJobConsistency,
  CatalogAdminProfileVersionPointer,
} from "./admin-control-plane-read-model-contracts";
import type {
  CatalogIntegrationAuditEvidenceCategory,
  CatalogIntegrationAuditEvidenceEventName,
  CatalogIntegrationAuditEvidenceRedactionState,
} from "../governance/catalog-integration-audit-evidence";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type { CatalogIntegrationProviderUsageBudget } from "./admin-control-plane-overview";
import type { CatalogProviderProfileEditableSectionKey } from "../providers/provider-profile-section-registry";
import type { CatalogControlPlaneActionId } from "../../ui/admin-control-plane/information-architecture-v2";
import type {
  CatalogPrimaryWorkbenchContractVersion,
  CatalogPrimaryWorkbenchSectionKey,
  CatalogPrimaryWorkbenchCommandKey,
  CatalogPrimaryWorkbenchSourceObservationRowActionKey,
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchProviderTransportCategory,
  CatalogPrimaryWorkbenchPromotionDisposition,
  CatalogPrimaryWorkbenchPromotionScopeKind,
  CatalogPrimaryWorkbenchPromotionOutcomeCountKey,
  CatalogPrimaryWorkbenchPromotionStaleProtectionKey,
  CatalogPrimaryWorkbenchPromotionProfileSemantics,
  CatalogPrimaryWorkbenchRouteContextKey,
  CatalogPrimaryWorkbenchCopyKey,
  CatalogPrimaryWorkbenchInstrumentationDimension,
  CatalogPrimaryWorkbenchDeploySkewMode,
  CatalogPrimaryWorkbenchDeploySkewPolicy,
  CatalogPrimaryWorkbenchRetirementPolicy,
  CatalogPrimaryWorkbenchBlockerContract,
  CatalogPrimaryWorkbenchSectionContract,
  CatalogPrimaryWorkbenchActionContract,
  CatalogPrimaryWorkbenchDownstreamIssueKey,
  CatalogPrimaryWorkbenchDownstreamContract,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchScopeContext,
  CatalogPrimaryWorkbenchProviderScopeReadModel,
  CatalogPrimaryWorkbenchSourceOptionsStatus,
  CatalogPrimaryWorkbenchSourceOptionPageState,
  CatalogPrimaryWorkbenchSourceOptionKindReadModel,
  CatalogPrimaryWorkbenchSourceOptionPageReadModel,
  CatalogPrimaryWorkbenchSourceOptionsReadModel,
} from "./primary-workbench-selection-contracts";
import type {
  CatalogPrimaryWorkbenchCatalogSyncStatus,
  CatalogPrimaryWorkbenchCatalogSyncReadModel,
  CatalogPrimaryWorkbenchCatalogSyncUnitReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetStatus,
  CatalogPrimaryWorkbenchSourceScopeWorksetUnitState,
  CatalogPrimaryWorkbenchSourceScopeWorksetReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel,
} from "./primary-workbench-import-sync-contracts";
import type {
  CatalogPrimaryWorkbenchReadinessReadModel,
  CatalogPrimaryWorkbenchHealthTriageStatus,
  CatalogPrimaryWorkbenchValidationFixtureFlowStatus,
  CatalogPrimaryWorkbenchValidationReadinessReadModel,
  CatalogPrimaryWorkbenchValidationEvidenceRow,
  CatalogPrimaryWorkbenchProfileAuthoringStatus,
  CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode,
  CatalogPrimaryWorkbenchProfileImmutableFactKey,
  CatalogPrimaryWorkbenchProfileImmutableFact,
  CatalogPrimaryWorkbenchProfileLifecycleRestriction,
  CatalogPrimaryWorkbenchProfileOption,
  CatalogPrimaryWorkbenchProfileOverview,
  CatalogPrimaryWorkbenchProfileSectionGroupKey,
  CatalogPrimaryWorkbenchProfileSectionSaveOutcome,
  CatalogPrimaryWorkbenchProfileSectionFieldControl,
  CatalogPrimaryWorkbenchProfileSectionField,
  CatalogPrimaryWorkbenchProfileOptionQueryDetail,
  CatalogPrimaryWorkbenchProfileImportScopeControl,
  CatalogPrimaryWorkbenchProfileMappingRow,
  CatalogPrimaryWorkbenchProfileSectionWorkspace,
  CatalogPrimaryWorkbenchProfileCloneDraftReadModel,
  CatalogPrimaryWorkbenchProfileAuthoringReadModel,
  CatalogPrimaryWorkbenchImportJobsReadModel,
} from "./primary-workbench-profile-readiness-contracts";
import type {
  CatalogPrimaryWorkbenchSourceObservationReviewReadModel,
  CatalogPrimaryWorkbenchSourceObservationReviewRow,
  CatalogPrimaryWorkbenchSourceObservationEvidenceDetail,
  CatalogPrimaryWorkbenchProductContentsEvidenceState,
  CatalogPrimaryWorkbenchProductContentsEvidenceReview,
  CatalogPrimaryWorkbenchProductContentsEvidenceLine,
  CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData,
  CatalogPrimaryWorkbenchMergeCandidateActionKey,
  CatalogPrimaryWorkbenchMergeCandidateReviewReadModel,
  CatalogPrimaryWorkbenchMergeCandidateReviewRow,
  CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride,
  CatalogPrimaryWorkbenchMergeCandidateEditReference,
  CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel,
  CatalogPrimaryWorkbenchConflictResolutionStatus,
  CatalogPrimaryWorkbenchConflictResolutionState,
  CatalogPrimaryWorkbenchConflictResolutionReadModel,
  CatalogPrimaryWorkbenchConflictResolutionRow,
  CatalogPrimaryWorkbenchPromotionValidationReadModel,
  CatalogPrimaryWorkbenchPromotionIdentityDiagnostic,
  CatalogPrimaryWorkbenchPromotionPreviewReadModel,
  CatalogPrimaryWorkbenchPromotionResultReadModel,
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchSecurityPrivacyReadModel,
  CatalogPrimaryWorkbenchInstrumentationReadModel,
} from "./primary-workbench-promotion-review-contracts";

type CatalogPrimaryWorkbenchHealthTriageReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchHealthTriageStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  selectedProviderKey: string | null;
  selectedUnitKey: CatalogIntegrationUnitKey | null;
  returnToPrimaryHref: string;
  summary: Readonly<{
    readyUnits: number;
    totalUnits: number;
    blockedUnits: number;
    degradedProviders: number;
    activeJobs: number;
    rolloutStops: number;
    auditEntries: number;
  }>;
  readModels: readonly CatalogPrimaryWorkbenchHealthTriageReadModelState[];
  units: readonly CatalogPrimaryWorkbenchHealthTriageUnit[];
  providers: readonly CatalogPrimaryWorkbenchHealthTriageProvider[];
  rolloutControls: readonly CatalogPrimaryWorkbenchHealthTriageRolloutControl[];
  recentJobs: readonly CatalogPrimaryWorkbenchHealthTriageJob[];
  auditPreview: CatalogPrimaryWorkbenchHealthTriageAuditPreview;
}>;

type CatalogPrimaryWorkbenchHealthTriageReadModelState = Readonly<{
  queryKey: CatalogAdminControlPlaneQueryKey;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string | null;
  statusMessage: string;
  ownerMetricKey: string;
}>;

type CatalogPrimaryWorkbenchHealthTriageUnit = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  providerKey: string;
  displayName: string;
  productDomain: string;
  productForm: string;
  ingestionPurpose: string | null;
  profileVersion: string | null;
  status: CatalogPrimaryWorkbenchHealthTriageStatus;
  semanticReadiness: "ready" | "blocked";
  credentialReadiness: "ready" | "blocked" | "not-required";
  credentialReadinessState: string;
  transportReadiness: "ready" | "blocked";
  fixtureValidationStatus: "ready" | "blocked";
  dryRunStatus: "completed" | "blocked";
  observationFacts: number;
  diagnosticCounts: Readonly<Record<"info" | "warning" | "error", number>>;
  diagnosticCodes: readonly string[];
  latestDiagnosticText: string | null;
  affectedPrimaryAction: "pull-provider-data" | "review-source-observations" | "observation.promote";
  ownerMetricKey: string;
  nextAction: string;
}>;

type CatalogPrimaryWorkbenchHealthTriageProvider = Readonly<{
  providerKey: string;
  adapterKey: string;
  status: CatalogPrimaryWorkbenchHealthTriageStatus;
  readiness: "ready" | "blocked" | "degraded";
  credentialReadiness: "ready" | "blocked" | "not-required";
  credentialReadinessState: string;
  unitKeys: readonly CatalogIntegrationUnitKey[];
  apiReachability: string;
  optionQueryHealth: string;
  rateLimitStatus: string;
  payloadAcquisition: string;
  usageBudget: CatalogIntegrationProviderUsageBudget | null;
  countSpend?: readonly import("../../../scope-sync-batches/domain/count-acquisition").CountSpend[];
  diagnosticCodes: readonly string[];
  latestDiagnosticText: string | null;
  ownerMetricKey: string;
  nextAction: string;
}>;

type CatalogPrimaryWorkbenchValidationReadinessStatus = "ready" | "degraded" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchLifecycleOperation = CatalogAdminRollbackRetirementImpactSummaryReadModel["operation"];

type CatalogPrimaryWorkbenchLifecycleRecoveryStatus = "ready" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchLifecycleRecoveryReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchLifecycleRecoveryStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  selectedProviderKey: string | null;
  selectedProfileVersion: string | null;
  returnToPrimaryHref: string;
  auditEvidenceUrl: string;
  summary: Readonly<{
    activeJobs: number;
    affectedReferences: number;
    downstreamProfileReferences: number;
    impactedCatalogItems: number;
    blockers: number;
    recentLifecycleEvents: number;
  }>;
  profiles: readonly Readonly<{
    providerKey: string;
    profileKey: string;
    profileVersion: string;
    displayName: string;
    lifecycle: string;
    active: boolean;
    referenceCount: number;
    href: string;
  }>[];
  operations: readonly CatalogPrimaryWorkbenchLifecycleOperationReadModel[];
  recentAuditEvents: readonly Readonly<{
    eventId: string;
    occurredAt: string;
    eventName: string;
    category: string;
    providerKey: string;
    unitKey: CatalogIntegrationUnitKey | null;
    profileVersion: string | null;
    summary: string;
  }>[];
  strictRetirement: Readonly<{
    requiredDisposition: "complete-removal";
    forbiddenSupportPaths: readonly string[];
    summary: string;
  }>;
}>;

type CatalogPrimaryWorkbenchLifecycleOperationReadModel = Readonly<{
  operation: CatalogPrimaryWorkbenchLifecycleOperation;
  label: string;
  description: string;
  commandKey: Extract<
    CatalogPrimaryWorkbenchCommandKey,
    "provider-profile.activate" | "provider-profile.rollback" | "provider-profile.deprecate" | "provider-profile.retire"
  >;
  providerKey: string | null;
  profileVersion: string | null;
  lifecycle: string | null;
  active: boolean;
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  confirmationRequired: boolean;
  allowed: boolean;
  submitHref: string;
  supportHref: string | null;
  impact: Readonly<{
    generatedAt: string | null;
    referencedObservationCount: number;
    sourceProfileReferenceCount: number;
    promotionProfileReferenceCount: number;
    impactedCatalogItemCount: number;
    impactedCatalogItemIds: readonly string[];
    externalReferenceCount: number;
    sampleObservationIds: readonly string[];
    impactedJobCount: number;
    blockers: readonly CatalogAdminControlPlaneDiagnostic[];
  }>;
  auditConsequences: Readonly<{
    auditEvidenceUrl: string;
    eventName: string;
    summary: string;
  }>;
  nextSteps: readonly string[];
}>;

type CatalogPrimaryWorkbenchGovernanceControlsStatus = "ready" | "degraded" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchGovernanceControlKind =
  | "staged-rollout"
  | "provider-emergency-stop"
  | "import-kill-switch"
  | "promotion-kill-switch"
  | "reapply-kill-switch"
  | "worker-pause"
  | "legacy-removal";

type CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey =
  | "option-query-latency"
  | "job-failure-rate"
  | "projection-freshness"
  | "source-observation-quarantine"
  | "data-quarantine"
  | "conflict-spike";

type CatalogPrimaryWorkbenchGovernanceControlsReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchGovernanceControlsStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  returnToPrimaryHref: string;
  auditEvidenceUrl: string;
  summary: Readonly<{
    activeRolloutStops: number;
    deniedCommands: number;
    blockedCommands: number;
    degradedSignals: number;
    alertCount: number;
    deletionEvidenceCount: number;
  }>;
  rolloutMode: Readonly<{
    label: string;
    state: "open" | "staged" | "stopped" | "degraded";
    rolloutEnabled: boolean;
    workerState: "running" | "paused" | "unknown";
    providerEmergencyStopCount: number;
    importKillSwitchActive: boolean;
    promotionKillSwitchActive: boolean;
    reapplyKillSwitchActive: boolean;
  }>;
  controls: readonly Readonly<{
    controlId: string;
    kind: CatalogPrimaryWorkbenchGovernanceControlKind;
    label: string;
    status: "open" | "degraded" | "blocked" | "removed";
    metricKey: string;
    evidenceUrl: string;
    commandKeys: readonly CatalogPrimaryWorkbenchCommandKey[];
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    providerKeys: readonly string[];
    unitKeys: readonly string[];
    message: string;
  }>[];
  rbacMatrix: readonly Readonly<{
    actionKey: CatalogPrimaryWorkbenchCommandKey;
    requiredPermission: CatalogPrimaryWorkbenchActionContract["requiredPermission"];
    routePattern: string;
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    confirmationRequired: boolean;
    destructive: boolean;
    deniedCopy: string;
  }>[];
  observability: Readonly<{
    status: CatalogPrimaryWorkbenchGovernanceControlsStatus;
    generatedAt: string | null;
    signals: readonly Readonly<{
      key: CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey;
      label: string;
      status: "ready" | "degraded" | "blocked" | "unavailable";
      value: string;
      threshold: string;
      ownerMetricKey: string;
      evidenceUrl: string;
      stale: boolean;
      alertLinks: readonly Readonly<{ label: string; href: string }>[];
      runbookLinks: readonly Readonly<{ label: string; href: string }>[];
    }>[];
  }>;
  legacyRemovalEvidence: Readonly<{
    status: "removed";
    requiredDisposition: "complete-removal";
    removedSurfaces: readonly string[];
    forbiddenSupportPaths: readonly string[];
    evidence: readonly Readonly<{
      key: string;
      label: string;
      status: "removed";
      evidenceUrl: string;
      detail: string;
    }>[];
    launchBlockerIfPresent: readonly string[];
  }>;
}>;

type CatalogPrimaryWorkbenchAuditEvidenceStatus = "ready" | "partial" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchAuditEvidenceFilterKey =
  | "provider"
  | "unit"
  | "profile-version"
  | "job"
  | "observation"
  | "action-category"
  | "actor"
  | "time";

type CatalogPrimaryWorkbenchAuditEvidenceTargetType =
  | "provider-profile"
  | "import-job"
  | "source-observation"
  | "catalog-item"
  | "control-plane";

type CatalogPrimaryWorkbenchAuditEvidenceReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchAuditEvidenceStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  returnToPrimaryHref: string;
  summary: Readonly<{
    timelineEvents: number;
    redactedEvidenceLinks: number;
    partialProjectionCount: number;
  }>;
  filters: readonly Readonly<{
    key: CatalogPrimaryWorkbenchAuditEvidenceFilterKey;
    label: string;
    value: string | null;
    options: readonly string[];
    active: boolean;
  }>[];
  projectionState: Readonly<{
    queryKey: Extract<CatalogAdminControlPlaneQueryKey, "audit-evidence-timeline">;
    freshness: CatalogAdminControlPlaneFreshnessState;
    generatedAt: string | null;
    statusMessage: string;
    missingProjection: boolean;
    partialProjection: boolean;
  }>;
  redactionPolicy: Readonly<{
    sourcePayloadAccess: "not-required";
    profileSnapshotAccess: "not-required";
    unsafeEvidenceBlocked: boolean;
    governedDataClasses: readonly string[];
    forbiddenEvidenceRequests: readonly string[];
    summary: string;
  }>;
  timeline: readonly Readonly<{
    eventId: string;
    occurredAt: string;
    eventName: CatalogIntegrationAuditEvidenceEventName;
    category: CatalogIntegrationAuditEvidenceCategory;
    actorLabel: string;
    targetType: CatalogPrimaryWorkbenchAuditEvidenceTargetType;
    targetId: string;
    providerKey: string | null;
    unitKey: CatalogIntegrationUnitKey | null;
    profileVersion: string | null;
    jobId: string | null;
    observationId: string | null;
    catalogItemId: string | null;
    summary: string;
    diagnosticCodes: readonly string[];
    redactionState: CatalogIntegrationAuditEvidenceRedactionState;
    evidenceLinks: readonly CatalogPrimaryWorkbenchAuditEvidenceLink[];
  }>[];
  evidenceLinks: readonly CatalogPrimaryWorkbenchAuditEvidenceLink[];
}>;

type CatalogPrimaryWorkbenchAuditEvidenceLink = Readonly<{
  key: string;
  label: string;
  href: string;
  kind: "audit-event" | "diagnostic" | "proof" | "runbook" | "test";
  summary: string;
  redactionState: CatalogIntegrationAuditEvidenceRedactionState;
  sourcePayloadAccess: "not-required";
  profileSnapshotAccess: "not-required";
}>;

type CatalogPrimaryWorkbenchHealthTriageRolloutControl = Readonly<{
  controlId: string;
  status: "open" | "degraded" | "blocked";
  severity: "info" | "warning" | "error";
  metricKey: string;
  message: string;
  providerKeys: readonly string[];
  unitKeys: readonly string[];
  nextAction: string;
}>;

type CatalogPrimaryWorkbenchHealthTriageJob = Readonly<{
  jobId: string;
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey | null;
  operatorStatus: CatalogPrimaryWorkbenchImportJobsReadModel["jobs"][number]["operatorStatus"];
  phase: CatalogPrimaryWorkbenchImportJobsReadModel["jobs"][number]["state"];
  progressLabel: string;
  summary: string;
  ownerMetricKey: string;
  nextAction: string;
}>;

type CatalogPrimaryWorkbenchHealthTriageAuditPreview = Readonly<{
  generatedAt: string | null;
  projectionStatus: "partial" | "unavailable";
  statusMessage: string;
  entries: readonly Readonly<{
    eventId: string;
    occurredAt: string;
    eventName: string;
    category: string;
    providerKey: string;
    unitKey: CatalogIntegrationUnitKey | null;
    summary: string;
  }>[];
}>;

export type {
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchHealthTriageReadModelState,
  CatalogPrimaryWorkbenchHealthTriageUnit,
  CatalogPrimaryWorkbenchHealthTriageProvider,
  CatalogPrimaryWorkbenchValidationReadinessStatus,
  CatalogPrimaryWorkbenchLifecycleOperation,
  CatalogPrimaryWorkbenchLifecycleRecoveryStatus,
  CatalogPrimaryWorkbenchLifecycleRecoveryReadModel,
  CatalogPrimaryWorkbenchLifecycleOperationReadModel,
  CatalogPrimaryWorkbenchGovernanceControlsStatus,
  CatalogPrimaryWorkbenchGovernanceControlKind,
  CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey,
  CatalogPrimaryWorkbenchGovernanceControlsReadModel,
  CatalogPrimaryWorkbenchAuditEvidenceStatus,
  CatalogPrimaryWorkbenchAuditEvidenceFilterKey,
  CatalogPrimaryWorkbenchAuditEvidenceTargetType,
  CatalogPrimaryWorkbenchAuditEvidenceReadModel,
  CatalogPrimaryWorkbenchAuditEvidenceLink,
  CatalogPrimaryWorkbenchHealthTriageRolloutControl,
  CatalogPrimaryWorkbenchHealthTriageJob,
  CatalogPrimaryWorkbenchHealthTriageAuditPreview,
};

export function assertPrimaryWorkbenchHealthTriage(
  value: CatalogPrimaryWorkbenchHealthTriageReadModel | undefined,
): void {
  if (!value) throw new Error("Primary workbench health triage contract is required.");
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status))
    throw new Error("Primary workbench health triage status must be explicit.");
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref))
    throw new Error("Primary workbench health triage return link must target the rebuilt workbench.");
  for (const unit of value.units)
    if (!unit.providerKey || !unit.unitKey || !unit.ownerMetricKey || !unit.nextAction)
      throw new Error("Primary workbench health triage units must name provider, unit, owner metric, and next action.");
  for (const provider of value.providers)
    if (!provider.providerKey || !provider.ownerMetricKey || !provider.nextAction)
      throw new Error("Primary workbench health triage providers must name provider, owner metric, and next action.");
}

export function assertPrimaryWorkbenchGovernanceControls(
  value: CatalogPrimaryWorkbenchGovernanceControlsReadModel | undefined,
): void {
  if (!value) throw new Error("Primary workbench governance controls contract is required.");
  for (const signal of value.observability?.signals ?? []) {
    for (const link of signal.alertLinks ?? []) {
      if (!isSafePrimaryWorkbenchObservabilityLink(link.href)) {
        throw new Error("Primary workbench governance alert and runbook links must target approved observability.");
      }
    }
  }
}
export function assertPrimaryWorkbenchAuditEvidence(
  value: CatalogPrimaryWorkbenchAuditEvidenceReadModel | undefined,
): void {
  if (!value) throw new Error("Primary workbench audit evidence contract is required.");
}
export function assertPrimaryWorkbenchLifecycleRecovery(
  value: CatalogPrimaryWorkbenchLifecycleRecoveryReadModel | undefined,
): void {
  if (!value) throw new Error("Primary workbench lifecycle recovery contract is required.");
}
