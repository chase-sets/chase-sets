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
} from "./primary-workbench-lifecycle-governance-contracts";
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

type CatalogPrimaryWorkbenchReadinessReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[];
  rolloutEnabled: boolean;
  rbacAllowed: boolean;
  auditEvidenceUrl: string | null;
}>;

type CatalogPrimaryWorkbenchHealthTriageStatus = "ready" | "degraded" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchValidationFixtureFlowStatus = "ready" | "warning" | "blocked" | "not-covered";

type CatalogPrimaryWorkbenchValidationReadinessReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchValidationReadinessStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  selectedProviderKey: string | null;
  selectedUnitKey: CatalogIntegrationUnitKey | null;
  selectedProfileVersion: string | null;
  selectedFixtureFlow: string | null;
  returnToPrimaryHref: string;
  summary: Readonly<{
    readyFixtureFlows: number;
    totalFixtureFlows: number;
    blockedFixtureFlows: number;
    dryRunEvidenceCount: number;
    semanticChangeCount: number;
    unchangedSectionCount: number;
    blockingReadinessChecks: number;
    auditEvidenceCount: number;
  }>;
  fixtureFlows: readonly Readonly<{
    flow: string;
    label: string;
    status: CatalogPrimaryWorkbenchValidationFixtureFlowStatus;
    payloadFile: string | null;
    payloadPath: string | null;
    expectedStatus: string | null;
    expectedDiagnosticPaths: readonly string[];
    expectedHashEvidencePaths: readonly string[];
    expectedMergeEvidencePaths: readonly string[];
    expectedPromotionCommands: readonly string[];
    samplePayloadAvailable: boolean;
    diagnostics: readonly Readonly<{
      path: string;
      diagnosticText: string;
      severity: "error" | "warning";
    }>[];
    actionState: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>[];
  dryRunEvidence: readonly Readonly<{
    externalKey: string;
    sourceUrl: string | null;
    sourceHash: string | null;
    status: "completed" | "blocked" | "not-run";
    normalizedFacts: readonly Readonly<{ key: string; value: string }>[];
    redactionSummary: readonly Readonly<{ label: string; value: string }>[];
    duplicateCandidates: readonly CatalogPrimaryWorkbenchValidationEvidenceRow[];
    selectedOptions: readonly CatalogPrimaryWorkbenchValidationEvidenceRow[];
    promotionCommandPreview: readonly Readonly<{
      commandName: string;
      inputs: readonly CatalogPrimaryWorkbenchValidationEvidenceRow[];
    }>[];
    diagnostics: readonly Readonly<{
      code: string;
      path: string;
      sectionKey: string;
      domainConcept: string;
      diagnosticText: string;
      severity: "error" | "warning";
      fixtureFlow: string | null;
    }>[];
    auditEvidence: readonly string[];
  }>[];
  semanticCompare: Readonly<{
    mappingFingerprint: Readonly<{
      candidate: string | null;
      active: string | null;
      changed: boolean;
    }>;
    activationImpact: readonly string[];
    fixtureCoverage: readonly Readonly<{
      flow: string;
      status: CatalogPrimaryWorkbenchValidationFixtureFlowStatus;
    }>[];
    sections: readonly Readonly<{
      sectionKey: string;
      domainConcept: string;
      status: "valid" | "warning" | "error";
      changeCount: number;
      changes: readonly Readonly<{
        path: string;
        label: string;
        candidateSummary: string;
        activeSummary: string;
        changed: boolean;
        severity: "info" | "warning" | "error";
        activationImpact: string;
      }>[];
    }>[];
    unchangedSections: readonly Readonly<{
      sectionKey: string;
      domainConcept: string;
    }>[];
  }>;
  activationReadiness: Readonly<{
    status: "ready" | "blocked";
    requiresMigrationEvidence: boolean;
    referenceCount: number;
    groups: readonly Readonly<{
      domainConcept: string;
      status: "ready" | "blocked";
      checks: readonly Readonly<{
        checkKey: string;
        code: string;
        sectionKey: string;
        status: "passed" | "blocked";
        path: string;
        diagnosticText: string;
        severity: "error" | "warning";
        remediation: string;
        blockingBehavior: string;
        flow: string | null;
      }>[];
    }>[];
  }>;
  activationDecision: Readonly<{
    status: "ready" | "blocked" | "unavailable";
    actionState: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    saveEvidenceState: CatalogPrimaryWorkbenchActionState;
    saveEvidenceBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    activationCommandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.activate">;
    evidenceCommandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.edit-section">;
    workspaceHref: string;
    providerKey: string | null;
    profileVersion: string | null;
    lifecycle: string | null;
    importEligibility: "eligible" | "blocked" | "not-selected";
    affectedReferences: Readonly<{
      referenceCount: number;
      requiresMigrationEvidence: boolean;
      replayImplications: readonly string[];
    }>;
    migrationEvidence: Readonly<{
      state: "recorded" | "required" | "not-required";
      evidenceText: string;
      fixtureRunId: string | null;
      mappingFingerprintBefore: string | null;
      mappingFingerprintAfter: string | null;
      recordedAt: string | null;
      recordedByUserId: string | null;
    }>;
    auditConsequences: Readonly<{
      auditEvidenceUrl: string;
      eventNames: readonly string[];
      summary: string;
    }>;
  }>;
}>;

type CatalogPrimaryWorkbenchValidationEvidenceRow = Readonly<{
  key: string;
  label: string;
  path: string;
  summary: string;
  owner: string | null;
  uses: readonly string[];
  diagnostics: readonly Readonly<{
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
  }>[];
}>;

type CatalogPrimaryWorkbenchProfileAuthoringStatus = "ready" | "missing-profile" | "stale-selection";

type CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode =
  | "draft-editable"
  | "test-editable"
  | "active-clone-required"
  | "deprecated-clone-required"
  | "retired-read-only"
  | "missing-profile"
  | "stale-selection";

type CatalogPrimaryWorkbenchProfileImmutableFactKey =
  | "provider-key"
  | "profile-key"
  | "source-contract-owner"
  | "source-contract-repository"
  | "connector-kind"
  | "supported-scopes";

type CatalogPrimaryWorkbenchProfileImmutableFact = Readonly<{
  key: CatalogPrimaryWorkbenchProfileImmutableFactKey;
  label: string;
  value: string;
}>;

type CatalogPrimaryWorkbenchProfileLifecycleRestriction = Readonly<{
  code: CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode;
  label: string;
  description: string;
  severity: "info" | "warning" | "blocked";
}>;

type CatalogPrimaryWorkbenchProfileOption = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  lifecycle: string;
  active: boolean;
  status: string;
  href: string;
}>;

type CatalogPrimaryWorkbenchProfileOverview = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  lifecycle: string;
  active: boolean;
  status: string;
  connectorKind: string;
  capabilities: readonly string[];
  supportedScopes: readonly string[];
  languageOptions: readonly string[];
  mappingOutputKind: string;
  hasExecutableMappingContract: boolean;
  mappingFingerprint: string | null;
  referenceCount: number;
  sourceContract: Readonly<{
    owner: string;
    repository: string | null;
    commit: string | null;
    documentPath: string;
    fixtureSetVersion: string;
  }>;
  fixtures: Readonly<{
    fixtureRoot: string;
    coveredFlows: readonly string[];
    liveProviderCallsAllowed: boolean;
  }>;
  validation: Readonly<{
    status: "valid" | "invalid";
    diagnosticCount: number;
    latestDiagnosticText: string | null;
  }>;
  migrationEvidence: Readonly<{
    state: "recorded" | "not-recorded";
    recordedAt: string | null;
    fixtureRunId: string | null;
    mappingFingerprintBefore: string | null;
    mappingFingerprintAfter: string | null;
  }>;
  authoringAudit: Readonly<{
    createdAt: string | null;
    createdByUserId: string | null;
    createdForAccountId: string | null;
    updatedAt: string | null;
    updatedByUserId: string | null;
    updatedForAccountId: string | null;
  }>;
  immutableIdentityFacts: readonly CatalogPrimaryWorkbenchProfileImmutableFact[];
}>;

type CatalogPrimaryWorkbenchProfileSectionGroupKey =
  | "profile-foundation"
  | "provider-acquisition"
  | "observation-mapping"
  | "catalog-promotion"
  | "evidence-lifecycle";

type CatalogPrimaryWorkbenchProfileSectionSaveOutcome = "not-submitted" | "saved" | "conflict" | "invalid" | "failed";

type CatalogPrimaryWorkbenchProfileSectionFieldControl = "text" | "textarea" | "select" | "checkbox" | "tags";

type CatalogPrimaryWorkbenchProfileSectionField = Readonly<{
  key: string;
  label: string;
  value: string;
  control: CatalogPrimaryWorkbenchProfileSectionFieldControl;
  required: boolean;
  disabled: boolean;
  helpText: string | null;
  options: readonly Readonly<{ value: string; label: string }>[];
}>;

type CatalogPrimaryWorkbenchProfileOptionQueryDetail = Readonly<{
  queryKind: string;
  queryKeySynonyms: readonly string[];
  displayName: string;
  scope: string;
  parentScope: string | null;
  parentRequired: boolean;
  parentValueKind: string | null;
  parentDiagnosticText: string | null;
  operation: string;
  outputMappings: readonly Readonly<{
    key: string;
    label: string;
    path: string;
  }>[];
  cacheState: Readonly<{
    status: "ready" | "degraded" | "blocked" | "unknown";
    label: string;
    description: string;
    diagnosticCodes: readonly string[];
    freshTtlMinutes: number;
    staleTtlHours: number;
    cacheOnly: boolean;
  }>;
}>;

type CatalogPrimaryWorkbenchProfileImportScopeControl = Readonly<{
  scope: string;
  label: string;
  state: "selected" | "available" | "unavailable";
  reason: string | null;
  href: string | null;
  importScope: string | null;
  expectedObservationCount: number;
  observedCount: number;
  changedCount: number;
  promotedCount: number;
  rejectedCount: number;
}>;

type CatalogPrimaryWorkbenchProfileMappingRow = Readonly<{
  key: string;
  label: string;
  path: string;
  summary: string;
  owner: string | null;
  redaction: string | null;
  uses: readonly string[];
  diagnostics: readonly Readonly<{
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
  }>[];
  previewAvailable: boolean;
  affordances: Readonly<{
    duplicate: boolean;
    reorder: boolean;
    remove: boolean;
    inlineDiagnostics: boolean;
    longPathSafe: boolean;
  }>;
}>;

type CatalogPrimaryWorkbenchProfileSectionWorkspace = Readonly<{
  sectionKey: CatalogProviderProfileEditableSectionKey;
  displayName: string;
  group: CatalogPrimaryWorkbenchProfileSectionGroupKey;
  groupLabel: string;
  description: string;
  domainConcept: string;
  status: "valid" | "warning" | "error" | "blocked";
  editable: boolean;
  actionState: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  dirtyState: "clean";
  staleState: "fresh" | "stale" | "conflict";
  saveOutcome: CatalogPrimaryWorkbenchProfileSectionSaveOutcome;
  submitHref: string;
  commandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.edit-section">;
  fields: readonly CatalogPrimaryWorkbenchProfileSectionField[];
  optionQueries: readonly CatalogPrimaryWorkbenchProfileOptionQueryDetail[];
  importScopeControls: readonly CatalogPrimaryWorkbenchProfileImportScopeControl[];
  mappingRows: readonly CatalogPrimaryWorkbenchProfileMappingRow[];
  diagnostics: readonly Readonly<{
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
  }>[];
  semanticChangeCount: number;
  readinessCheckCount: number;
  anchorId: string;
}>;

type CatalogPrimaryWorkbenchProfileCloneDraftReadModel = Readonly<{
  commandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.clone">;
  sourceProviderKey: string | null;
  sourceProfileVersion: string | null;
  targetProfileVersion: string | null;
  targetLifecycle: "draft";
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  submitHref: string;
  lifecycleRestrictions: readonly CatalogPrimaryWorkbenchProfileLifecycleRestriction[];
  immutableIdentityFacts: readonly CatalogPrimaryWorkbenchProfileImmutableFact[];
}>;

type CatalogPrimaryWorkbenchProfileAuthoringReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchProfileAuthoringStatus;
  generatedAt: string;
  selectedProfile: CatalogPrimaryWorkbenchProfileOverview | null;
  activeProfile: CatalogPrimaryWorkbenchProfileOption | null;
  availableProfiles: readonly CatalogPrimaryWorkbenchProfileOption[];
  returnToPrimaryHref: string;
  sectionGroups: readonly Readonly<{
    key: CatalogPrimaryWorkbenchProfileSectionGroupKey;
    label: string;
    sections: readonly CatalogProviderProfileEditableSectionKey[];
  }>[];
  sectionWorkspaces: readonly CatalogPrimaryWorkbenchProfileSectionWorkspace[];
  cloneDraft: CatalogPrimaryWorkbenchProfileCloneDraftReadModel;
}>;

type CatalogPrimaryWorkbenchImportJobsReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  activeJobCount: number;
  failedJobCount: number;
  selectedScope: Readonly<{
    providerKey: string;
    unitKey: CatalogIntegrationUnitKey | null;
    scope: CatalogPrimaryWorkbenchScopeContext;
    importScope: string;
    profileVersion: string | null;
    profileSnapshot: CatalogAdminProfileVersionPointer | null;
    expectedObservationVolume: number;
    observedCount: number;
    changedCount: number;
    promotedCount: number;
    rejectedCount: number;
    readiness: Readonly<{
      adapterReadiness: "ready" | "blocked" | "degraded" | "unknown";
      credentialReadiness: "ready" | "blocked" | "not-required" | "unknown";
      rolloutEnabled: boolean;
      providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[];
      blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    }>;
  }> | null;
  jobs: readonly Readonly<{
    jobId: string;
    action: Extract<CatalogPrimaryWorkbenchCommandKey, "scope.import" | "observation.reapply" | "observation.replay">;
    state: "queued" | "running" | "completed" | "failed" | "cancelled";
    operatorStatus: "queued" | "running" | "stale" | "retried" | "partial" | "failed" | "cancelled" | "completed";
    summary: string;
    completed: number;
    total: number;
    progressPercent: number;
    unitKey: CatalogIntegrationUnitKey | null;
    providerKey: string;
    importScope: string | null;
    profileVersion: string | null;
    profileSnapshot: CatalogAdminProfileVersionPointer | null;
    scopeMatchesRoute: boolean;
    createdAt: string;
    startedAt: string | null;
    consistency: CatalogAdminJobConsistency;
    failureGroups: readonly Readonly<{
      key: string;
      label: string;
      count: number;
      severity: "warning" | "error";
    }>[];
    retryAvailable: boolean;
    resumeAvailable: boolean;
    cancelAvailable: boolean;
    sourceObservationReviewHref: string;
    auditEvidenceUrl: string;
    observationLinks: readonly string[];
    result: Readonly<{
      requestedScope: CatalogPrimaryWorkbenchScopeContext;
      requestedCount: number;
      importedSetCount: number;
      observedCount: number;
      reappliedCount: number;
      skippedCount: number;
      failedCount: number;
      redactedFailureReasons: readonly string[];
      usage: Readonly<{
        actualRequestCount: number | null;
        pageCount: number | null;
        cacheHitCount: number | null;
        cacheMissCount: number | null;
      }> | null;
      replayOrReapplyState:
        | "not-applicable"
        | "reapply-current-active-profile"
        | "replay-original-source-profile"
        | "unknown";
    }> | null;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>[];
}>;

export type {
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
};

export function assertPrimaryWorkbenchProfileAuthoring(
  value: CatalogPrimaryWorkbenchProfileAuthoringReadModel | undefined,
): void {
  if (!value) throw new Error("Primary workbench profile authoring contract is required.");
}
export function assertPrimaryWorkbenchValidationReadiness(
  value: CatalogPrimaryWorkbenchValidationReadinessReadModel | undefined,
): void {
  if (!value) throw new Error("Primary workbench validation readiness contract is required.");
}
