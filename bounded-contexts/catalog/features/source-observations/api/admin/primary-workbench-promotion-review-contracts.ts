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

type CatalogPrimaryWorkbenchSourceObservationReviewReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  counts: Readonly<Record<"observed" | "changed" | "promoted" | "rejected" | "blocked" | "eligible", number>>;
  cursor: string | null;
  selectedObservationIds: readonly string[];
  evidenceSummariesRedacted: boolean;
  duplicateConflictCount: number;
  promotionReadyCount: number;
  filters: readonly Readonly<{
    key:
      | "providerKey"
      | "unitKey"
      | "profileVersion"
      | "status"
      | "language"
      | "setId"
      | "observedAfter"
      | "observedBefore";
    label: string;
    value: string | null;
    serverApplied: boolean;
  }>[];
  savedFilters: readonly Readonly<{
    key: string;
    label: string;
    filters: Readonly<Record<string, string>>;
    count: number | null;
  }>[];
  pagination: Readonly<{
    mode: "offset";
    limit: number;
    offset: number;
    total: number;
    nextCursor: string | null;
    previousCursor: string | null;
  }>;
  bulkSelection: Readonly<{
    selectedCount: number;
    eligibleSelectedCount: number;
    actions: readonly CatalogPrimaryWorkbenchSourceObservationRowActionKey[];
  }>;
  rows: readonly CatalogPrimaryWorkbenchSourceObservationReviewRow[];
}>;

// Slim review-row contract. A review row carries ONLY what the dense table
// cell and the per-row action buttons render: identity, status, the first-N fact
// summaries the cell badges show, a duplicate count, the redaction-safe payload
// summary, promotion readiness, command disposition, and the inline `actions[]`
// that drive row buttons and readiness. The full fact/duplicate/conflict/audit
// evidence and the deep KeyValueList fields the SideSheet renders are NOT shipped
// per row; they live in `CatalogPrimaryWorkbenchSourceObservationEvidenceDetail`
// and are lazy-loaded when the evidence sheet opens. This keeps a 25-row review
// page small at first paint instead of serializing every row's deep evidence the
// table never shows.
type CatalogPrimaryWorkbenchSourceObservationReviewRow = Readonly<{
  observationId: string;
  providerKey: string;
  externalKey: string;
  displayName: string;
  status: string;
  statusReason: string | null;
  sourceUpdatedAt: string | null;
  changedAt: string;
  // The first-N normalized fact summaries the dense cell renders as badges. The
  // full list lives on the lazily-fetched evidence detail.
  factSummaryPreview: readonly string[];
  payloadSummary: string;
  redactionSummary: string;
  // The duplicate-evidence COUNT the cell renders as a warning badge. The full
  // duplicate evidence list lives on the lazily-fetched evidence detail.
  duplicateCount: number;
  promotionReadiness: Readonly<{
    state: "eligible" | "blocked" | "already-promoted" | "rejected";
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>;
  commandPreview: Readonly<{
    promotionPlanHash: string | null;
    disposition: CatalogPrimaryWorkbenchPromotionDisposition;
    confirmationRequired: boolean;
  }>;
  detailHref: string;
  actions: readonly Readonly<{
    key: CatalogPrimaryWorkbenchSourceObservationRowActionKey;
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    href: string | null;
  }>[];
}>;

// Deep evidence for a single Source Observation, separated from the review row so
// it ships only when the operator opens the evidence SideSheet. It carries
// the full normalized-fact / duplicate / conflict / audit lists and every
// provenance field the sheet's KeyValueList renders. Composed from the same Source
// Observation the slim row is, so the sheet shows exactly what it showed before —
// only WHEN the data is fetched changes. Fetched via a small evidence endpoint
// keyed by `observationId`.
type CatalogPrimaryWorkbenchSourceObservationEvidenceDetail = Readonly<{
  observationId: string;
  providerKey: string;
  externalKey: string;
  displayName: string;
  languageCode: string;
  sourceUrl: string;
  sourceRecordHash: string;
  sourceUpdatedAt: string | null;
  observedAt: string;
  changedAt: string;
  sourceProfileVersion: string;
  promotionProfileVersion: string | null;
  payloadSummary: string;
  redactionSummary: string;
  normalizedFactSummaries: readonly string[];
  productContentsEvidence: CatalogPrimaryWorkbenchProductContentsEvidenceReview;
  duplicateEvidence: readonly string[];
  conflictEvidence: readonly string[];
  auditTrail: readonly string[];
  promotionReadiness: Readonly<{
    state: "eligible" | "blocked" | "already-promoted" | "rejected";
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>;
  commandPreview: Readonly<{
    promotionPlanHash: string | null;
    disposition: CatalogPrimaryWorkbenchPromotionDisposition;
    confirmationRequired: boolean;
  }>;
}>;

type CatalogPrimaryWorkbenchProductContentsEvidenceState =
  | "none"
  | "reviewable"
  | "unresolved"
  | "promoted"
  | "rejected";

type CatalogPrimaryWorkbenchProductContentsEvidenceReview = Readonly<{
  state: CatalogPrimaryWorkbenchProductContentsEvidenceState;
  summary: string;
  lineCount: number;
  rows: readonly CatalogPrimaryWorkbenchProductContentsEvidenceLine[];
}>;

type CatalogPrimaryWorkbenchProductContentsEvidenceLine = Readonly<{
  lineNumber: number;
  state: "reviewable" | "unresolved" | "promoted" | "rejected";
  contentTypeLabel: string;
  contentTypeId: string | null;
  inclusionPolicyLabel: string | null;
  inclusionPolicyId: string | null;
  quantity: number | null;
  containedCatalogItemId: string | null;
  containedSelectedOptionLabels: readonly string[];
  targetSummary: string;
  provenanceSummary: readonly string[];
}>;

// Response contract for the lazy evidence endpoint the review SideSheet fetches.
// On success `detail` carries the composed deep evidence; on absence or a
// transient failure it is null so the sheet renders its error fallback instead of
// the route boundary throwing. Lives on the feature contract so both the route
// loader (server) and the evidence sheet (client) depend on the feature, not on a
// deployable route module.
type CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData = Readonly<{
  observationId: string;
  detail: CatalogPrimaryWorkbenchSourceObservationEvidenceDetail | null;
}>;

type CatalogPrimaryWorkbenchMergeCandidateActionKey = Extract<
  CatalogPrimaryWorkbenchCommandKey,
  "candidate.promote" | "candidate.split" | "candidate.edit" | "candidate.ignore" | "candidate.defer"
>;

type CatalogPrimaryWorkbenchMergeCandidateReviewReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  counts: Readonly<{
    total: number;
    ready: number;
    conflict: number;
    stale: number;
    deferred: number;
    terminal: number;
    blocked: number;
  }>;
  filters: readonly Readonly<{
    key: "scope" | "status" | "search" | "syncRun";
    label: string;
    value: string | null;
    serverApplied: boolean;
  }>[];
  pagination: Readonly<{
    mode: CatalogAdminControlPlanePaginationMode;
    limit: number;
    offset: number;
    total: number;
  }>;
  rows: readonly CatalogPrimaryWorkbenchMergeCandidateReviewRow[];
}>;

type CatalogPrimaryWorkbenchMergeCandidateReviewRow = Readonly<{
  candidateId: string;
  identityFingerprint: string;
  identityLabel: string;
  sourceCount: number;
  sources: readonly Readonly<{
    providerKey: string;
    observationId: string | null;
    externalKey: string | null;
    sourceProfileVersion: string | null;
  }>[];
  status: "ready" | "has-conflicts" | "stale" | "deferred" | "rejected" | "promoted";
  statusReason: string | null;
  conflicts: Readonly<{
    blocking: number;
    warnings: number;
    messages: readonly string[];
    // Every blocking conflict on this candidate, with enough detail to resolve it
    // inline in the review drawer: requireConflictResolutionsForBlockingConflicts
    // rejects promotion unless every entry here has a matching resolution by code.
    blockingConflicts: readonly Readonly<{
      code: string;
      message: string;
      fieldPath: string | null;
      existingValueDisplay: string;
      proposedValueDisplay: string;
      existingValueJson: string;
      proposedValueJson: string;
      observationIds: readonly string[];
    }>[];
  }>;
  promoteReadiness: Readonly<{
    state: "ready" | "blocked" | "stale" | "deferred" | "terminal";
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>;
  proposedMapping: Readonly<{
    promotionIntent: "create-catalog-item" | "update-catalog-item" | "link-existing-catalog-item";
    catalogItemId: string | null;
    productIds: readonly string[];
    externalCatalogItemReferences: readonly string[];
    externalProductReferences: readonly string[];
  }>;
  sourceComparison: readonly Readonly<{
    fieldPath: string;
    value: string;
    providerKey: string;
    observationId: string;
    confidence: "exact" | "high" | "candidate" | "manual";
  }>[];
  fieldProvenance: readonly Readonly<{
    fieldPath: string;
    providerKey: string;
    sourceProfileVersion: string;
    confidence: "exact" | "high" | "candidate" | "manual";
    evidenceSummary: string;
  }>[];
  proposedFacts: readonly Readonly<{
    key: string;
    value: string;
  }>[];
  actions: readonly Readonly<{
    key: CatalogPrimaryWorkbenchMergeCandidateActionKey;
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    reasonRequired: boolean;
    commandPreview: CatalogMergeCandidateReviewCommandPreview | null;
  }>[];
  // The typed candidate edit surface. `state` gates the inline editor:
  // when it is not `available`, `baseSnapshotJson` is null and the drawer renders
  // the blockers instead of inputs. Operator field corrections submitted from this
  // surface are recorded as `manual` provenance and carried through promotion.
  editForm: CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel;
}>;

type CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride = Readonly<{
  key: string;
  fieldPath: string;
  label: string;
  value: string;
}>;

type CatalogPrimaryWorkbenchMergeCandidateEditReference = Readonly<{
  index: number;
  label: string;
}>;

type CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel = Readonly<{
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  baseSnapshotJson: string | null;
  promotionIntent: "create-catalog-item" | "update-catalog-item" | "link-existing-catalog-item";
  catalogItemId: string | null;
  productIds: readonly string[];
  editableFacts: readonly CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride[];
  externalCatalogItemReferences: readonly CatalogPrimaryWorkbenchMergeCandidateEditReference[];
  externalProductReferences: readonly CatalogPrimaryWorkbenchMergeCandidateEditReference[];
}>;

type CatalogPrimaryWorkbenchConflictResolutionStatus = "ready" | "empty" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchConflictResolutionState = "blocks-promotion" | "requires-review" | "auto-resolved";

type CatalogPrimaryWorkbenchConflictResolutionReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchConflictResolutionStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  returnToPrimaryHref: string;
  auditEvidenceUrl: string;
  selectedObservationIds: readonly string[];
  summary: Readonly<{
    conflictCount: number;
    blockingCount: number;
    autoResolvedCount: number;
    reviewRequiredCount: number;
    overrideAvailableCount: number;
    auditEventCount: number;
  }>;
  rows: readonly CatalogPrimaryWorkbenchConflictResolutionRow[];
  precedenceRules: readonly Readonly<{
    ruleId: string;
    label: string;
    description: string;
    blockingBehavior: "promotion-blocking" | "review-required" | "auto-resolved";
    sourceAuthority: string;
    evidencePaths: readonly string[];
  }>[];
  overridePolicy: Readonly<{
    supported: boolean;
    requiredPermission: "catalog.manage";
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    auditRequired: true;
    reason: string;
  }>;
  recentAuditEvents: readonly Readonly<{
    eventId: string;
    occurredAt: string;
    eventName: string;
    providerKey: string;
    unitKey: CatalogIntegrationUnitKey | null;
    observationId: string | null;
    summary: string;
  }>[];
}>;

type CatalogPrimaryWorkbenchConflictResolutionRow = Readonly<{
  observationId: string;
  displayName: string;
  providerKey: string;
  externalKey: string;
  affectedFact: string;
  factKey: string;
  resolutionState: CatalogPrimaryWorkbenchConflictResolutionState;
  promotionReadinessState: CatalogPrimaryWorkbenchSourceObservationReviewRow["promotionReadiness"]["state"];
  precedenceRuleId: string;
  candidateValues: readonly Readonly<{
    source: string;
    value: string;
    role: "winner" | "loser" | "candidate";
    evidencePath: string;
  }>[];
  evidencePaths: readonly string[];
  diagnostics: readonly string[];
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  auditTrail: readonly string[];
  detailHref: string;
  overrideAction: Readonly<{
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    auditRequired: true;
  }>;
}>;

/**
 * Read-only pre-write validation carried by the current promotion preview.
 * `coverage: "not-previewed"` means no preview token is in play; `"partial"`
 * means only the first `coveredCount` eligible observations (id order) were
 * validated and the rest are validated at execution, never called safe here.
 */
type CatalogPrimaryWorkbenchPromotionValidationReadModel = Readonly<{
  promoteAsDraft: boolean;
  coverage: "complete" | "partial" | "not-previewed";
  coveredCount: number;
  continuation: string | null;
  identityDiagnostics: readonly CatalogPrimaryWorkbenchPromotionIdentityDiagnostic[];
  otherBlockedObservationIds: readonly string[];
}>;

type CatalogPrimaryWorkbenchPromotionIdentityDiagnostic = Readonly<{
  observationId: string;
  /** False only for the degraded identity an explicit draft choice carries visibly. */
  blocking: boolean;
  templateReason: "unresolved-title-tokens" | "no-targeted-template" | "missing-required-fields";
  diagnosticText: string;
  missingTokens: readonly string[];
  templateKey: string | null;
}>;

type CatalogPrimaryWorkbenchPromotionPreviewReadModel = Readonly<{
  previewId: string | null;
  validation: CatalogPrimaryWorkbenchPromotionValidationReadModel;
  freshness: CatalogAdminControlPlaneFreshnessState;
  scope: Readonly<{
    kind: CatalogPrimaryWorkbenchPromotionScopeKind;
    label: string;
    requestedCount: number;
    eligibleCount: number;
    selectedObservationIds: readonly string[];
    filterSummary: readonly string[];
    partialFailureMode: "per-observation";
  }>;
  dispositions: Readonly<Record<CatalogPrimaryWorkbenchPromotionDisposition, number>>;
  outcomeCounts: Readonly<Record<CatalogPrimaryWorkbenchPromotionOutcomeCountKey, number>>;
  commandPlanHash: string | null;
  confirmationRequired: boolean;
  destructiveCount: number;
  executionSafeguards: Readonly<{
    previewRequired: boolean;
    previewFresh: boolean;
    stalePreviewRejected: boolean;
    idempotencyRequired: true;
    doubleSubmitProtection: true;
    rejectsWhenChanged: readonly CatalogPrimaryWorkbenchPromotionStaleProtectionKey[];
    staleReasons: readonly CatalogPrimaryWorkbenchPromotionStaleProtectionKey[];
    overlappingActionBlockers: readonly Extract<
      CatalogPrimaryWorkbenchBlockerCategory,
      "active-job-conflict" | "concurrent-job"
    >[];
  }>;
  reviewDecisions: Readonly<{
    reject: Readonly<{
      reasonRequired: true;
      partialFailureMode: "failed-observations-remain-in-scope";
      auditEvidenceRequired: true;
    }>;
    defer: Readonly<{
      stateChange: "keeps-observation-in-review";
      returnsToReviewWhen: "next-provider-import-or-filter-reset";
      auditEvidenceRequired: true;
    }>;
  }>;
  profileWorkflows: Readonly<{
    reapply: Readonly<{
      profileSemantics: Extract<CatalogPrimaryWorkbenchPromotionProfileSemantics, "current-active-profile">;
      target: "promoted-observations";
      profileVersion: string | null;
    }>;
    replay: Readonly<{
      profileSemantics: Extract<CatalogPrimaryWorkbenchPromotionProfileSemantics, "original-source-profile-version">;
      target: "source-observation-evidence";
      profileVersion: string | null;
    }>;
  }>;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}>;

type CatalogPrimaryWorkbenchPromotionResultReadModel = Readonly<{
  resultId: string;
  jobId: string;
  status: "completed" | "partial" | "failed";
  requestedCount: number;
  promotedCount: number;
  skippedCount: number;
  failedCount: number;
  promotedCatalogItemIds: readonly string[];
  promotedReferenceIds: readonly string[];
  skippedObservationIds: readonly string[];
  failedObservationIds: readonly string[];
  redactedFailureReasons: readonly string[];
  completedAt: string;
  auditEvidenceIds: readonly string[];
}>;

type CatalogPrimaryWorkbenchActionReadModel = Readonly<{
  key: CatalogPrimaryWorkbenchCommandKey;
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  copyKey: CatalogPrimaryWorkbenchCopyKey | null;
}>;

type CatalogPrimaryWorkbenchSecurityPrivacyReadModel = Readonly<{
  redactionApplied: boolean;
  governedDataClasses: readonly string[];
  unsafeEvidenceBlocked: boolean;
  missingSecurityFieldsBlocker: Extract<CatalogPrimaryWorkbenchBlockerCategory, "security-privacy-blocked">;
}>;

type CatalogPrimaryWorkbenchInstrumentationReadModel = Readonly<{
  dimensions: readonly CatalogPrimaryWorkbenchInstrumentationDimension[];
  redactionSafe: boolean;
}>;

export type {
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
};

export function assertPrimaryWorkbenchConflictResolution(
  value: CatalogPrimaryWorkbenchConflictResolutionReadModel | undefined,
): void {
  if (!value) throw new Error("Primary workbench conflict resolution contract is required.");
}
export function assertPrimaryWorkbenchMergeCandidateReview(
  value: CatalogPrimaryWorkbenchMergeCandidateReviewReadModel | undefined,
): void {
  if (!value) throw new Error("Primary workbench merge candidate review contract is required.");
}
export function assertPrimaryWorkbenchPromotionPreview(
  value: CatalogPrimaryWorkbenchPromotionPreviewReadModel | undefined,
): void {
  if (!value) throw new Error("Primary workbench promotion preview contract is required.");
}
export function assertPrimaryWorkbenchPromotionResult(
  value: CatalogPrimaryWorkbenchPromotionResultReadModel | null | undefined,
): void {
  if (value == null) return;
  if (!value.resultId || !value.jobId)
    throw new Error("Primary workbench promotion results require durable outcome identity and timing.");
}
