import type { CatalogMergeCandidateReviewCommandPreview } from "../promotion/catalog-merge-candidate-review-command-payloads";
import type {
  CatalogAdminControlPlaneFreshnessState,
  CatalogAdminControlPlanePaginationMode,
} from "./admin-control-plane-read-model-slos";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type {
  CatalogPrimaryWorkbenchCommandKey,
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "./primary-workbench-shared-contracts";
import {
  assertCatalogPrimaryWorkbenchActionState,
  isSafePrimaryWorkbenchReturnPath,
  assertPrimaryWorkbenchBlockers,
} from "./primary-workbench-shared-contracts";

export type CatalogPrimaryWorkbenchSourceObservationRowActionKey =
  | "view-source-observation"
  | "observation.promote"
  | "observation.reject"
  | "observation.defer"
  | "observation.reapply"
  | "observation.replay";

export type CatalogPrimaryWorkbenchPromotionDisposition =
  | "eligible"
  | "skipped"
  | "blocked"
  | "conflicting"
  | "destructive"
  | "stale-preview"
  | "confirmation-required";

export type CatalogPrimaryWorkbenchPromotionScopeKind = "explicit-rows" | "matching-filter";

export type CatalogPrimaryWorkbenchPromotionOutcomeCountKey =
  | "eligible"
  | "blocked"
  | "skipped"
  | "conflicting"
  | "failed";

export type CatalogPrimaryWorkbenchPromotionStaleProtectionKey =
  | "observations"
  | "profile-version"
  | "rollout-state"
  | "permissions"
  | "command-inputs";

export type CatalogPrimaryWorkbenchPromotionProfileSemantics =
  | "current-active-profile"
  | "original-source-profile-version";

export type CatalogPrimaryWorkbenchSourceObservationReviewReadModel = Readonly<{
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
export type CatalogPrimaryWorkbenchSourceObservationReviewRow = Readonly<{
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
export type CatalogPrimaryWorkbenchSourceObservationEvidenceDetail = Readonly<{
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

export type CatalogPrimaryWorkbenchProductContentsEvidenceState =
  | "none"
  | "reviewable"
  | "unresolved"
  | "promoted"
  | "rejected";

export type CatalogPrimaryWorkbenchProductContentsEvidenceReview = Readonly<{
  state: CatalogPrimaryWorkbenchProductContentsEvidenceState;
  summary: string;
  lineCount: number;
  rows: readonly CatalogPrimaryWorkbenchProductContentsEvidenceLine[];
}>;

export type CatalogPrimaryWorkbenchProductContentsEvidenceLine = Readonly<{
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
export type CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData = Readonly<{
  observationId: string;
  detail: CatalogPrimaryWorkbenchSourceObservationEvidenceDetail | null;
}>;

export type CatalogPrimaryWorkbenchMergeCandidateActionKey = Extract<
  CatalogPrimaryWorkbenchCommandKey,
  "candidate.promote" | "candidate.split" | "candidate.edit" | "candidate.ignore" | "candidate.defer"
>;

export type CatalogPrimaryWorkbenchMergeCandidateReviewReadModel = Readonly<{
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

export type CatalogPrimaryWorkbenchMergeCandidateReviewRow = Readonly<{
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

export type CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride = Readonly<{
  key: string;
  fieldPath: string;
  label: string;
  value: string;
}>;

export type CatalogPrimaryWorkbenchMergeCandidateEditReference = Readonly<{
  index: number;
  label: string;
}>;

export type CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel = Readonly<{
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

export type CatalogPrimaryWorkbenchConflictResolutionStatus = "ready" | "empty" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchConflictResolutionState = "blocks-promotion" | "requires-review" | "auto-resolved";

export type CatalogPrimaryWorkbenchConflictResolutionReadModel = Readonly<{
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

export type CatalogPrimaryWorkbenchConflictResolutionRow = Readonly<{
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
export type CatalogPrimaryWorkbenchPromotionValidationReadModel = Readonly<{
  promoteAsDraft: boolean;
  coverage: "complete" | "partial" | "not-previewed";
  coveredCount: number;
  continuation: string | null;
  identityDiagnostics: readonly CatalogPrimaryWorkbenchPromotionIdentityDiagnostic[];
  otherBlockedObservationIds: readonly string[];
}>;

export type CatalogPrimaryWorkbenchPromotionIdentityDiagnostic = Readonly<{
  observationId: string;
  /** False only for the degraded identity an explicit draft choice carries visibly. */
  blocking: boolean;
  templateReason: "unresolved-title-tokens" | "no-targeted-template" | "missing-required-fields";
  diagnosticText: string;
  missingTokens: readonly string[];
  templateKey: string | null;
}>;

export type CatalogPrimaryWorkbenchPromotionPreviewReadModel = Readonly<{
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

export type CatalogPrimaryWorkbenchPromotionResultReadModel = Readonly<{
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

export function assertPrimaryWorkbenchPromotionResult(
  value: CatalogPrimaryWorkbenchReadModel["promotionResult"] | undefined,
): void {
  if (value == null) {
    return;
  }
  if (!value.resultId || !value.jobId || !value.completedAt) {
    throw new Error("Primary workbench promotion results require durable outcome identity and timing.");
  }
  if (!["completed", "partial", "failed"].includes(value.status)) {
    throw new Error("Primary workbench promotion results require an explicit terminal status.");
  }
  const counts = [value.requestedCount, value.promotedCount, value.skippedCount, value.failedCount];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("Primary workbench promotion result counts must be non-negative integers.");
  }
  if (value.promotedCount + value.skippedCount + value.failedCount !== value.requestedCount) {
    throw new Error("Primary workbench promotion result counts must reconcile to the requested count.");
  }
  if (!Array.isArray(value.redactedFailureReasons)) {
    throw new Error("Primary workbench promotion results must expose redacted failure reasons.");
  }
  for (const reason of value.redactedFailureReasons) {
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.includes("\n") ||
      /\b(api[-_ ]?key|x-api-key|x-team-id|authorization|bearer|token|secret|password)\s*[=:]\s*(?!\[redacted\])/i.test(
        reason,
      )
    ) {
      throw new Error("Primary workbench promotion failure reasons must stay redaction-safe.");
    }
  }
}

export function assertPrimaryWorkbenchConflictResolution(
  value: CatalogPrimaryWorkbenchReadModel["conflictResolution"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench conflict resolution contract is required.");
  }
  if (!["ready", "empty", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench conflict resolution status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench conflict resolution return link must target the rebuilt workbench.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.auditEvidenceUrl)) {
    throw new Error("Primary workbench conflict resolution audit link must target the rebuilt workbench.");
  }
  if (value.rows.length > 0 && value.precedenceRules.length === 0) {
    throw new Error("Primary workbench conflict resolution rows require precedence rule evidence.");
  }
  if (value.overridePolicy.supported && value.overridePolicy.state === "available") {
    throw new Error("Primary workbench conflict overrides need a rebuilt backend command before becoming available.");
  }
  assertCatalogPrimaryWorkbenchActionState(value.overridePolicy.state);
  for (const row of value.rows) {
    if (!row.observationId || !row.affectedFact || !row.precedenceRuleId) {
      throw new Error("Primary workbench conflict resolution rows must name observation, fact, and precedence rule.");
    }
    if (!["blocks-promotion", "requires-review", "auto-resolved"].includes(row.resolutionState)) {
      throw new Error("Primary workbench conflict resolution row state must be explicit.");
    }
    if (row.candidateValues.length < 2) {
      throw new Error("Primary workbench conflict resolution rows must show winning and losing candidate values.");
    }
    if (row.evidencePaths.length === 0 || row.diagnostics.length === 0) {
      throw new Error("Primary workbench conflict resolution rows must expose evidence paths and diagnostics.");
    }
    assertCatalogPrimaryWorkbenchActionState(row.overrideAction.state);
  }
}

export function assertPrimaryWorkbenchPromotionPreview(
  value: CatalogPrimaryWorkbenchReadModel["promotionPreview"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench promotion preview contract is required.");
  }
  if (!value.scope) {
    throw new Error("Primary workbench promotion preview scope is required.");
  }
  if (value.scope.partialFailureMode !== "per-observation") {
    throw new Error("Primary workbench promotion preview must preserve per-observation partial failure scope.");
  }
  if (!value.validation || !["complete", "partial", "not-previewed"].includes(value.validation.coverage)) {
    throw new Error("Primary workbench promotion preview validation coverage must be explicit.");
  }
  if (typeof value.validation.promoteAsDraft !== "boolean") {
    throw new Error("Primary workbench promotion preview must state the explicit promote-as-draft choice.");
  }
  for (const key of ["eligible", "blocked", "skipped", "conflicting", "failed"] as const) {
    if (typeof value.outcomeCounts?.[key] !== "number") {
      throw new Error(`Primary workbench promotion outcome count '${key}' is required.`);
    }
  }
  if (!value.executionSafeguards?.idempotencyRequired || !value.executionSafeguards.doubleSubmitProtection) {
    throw new Error(
      "Primary workbench promotion execution safeguards must include idempotency and double-submit protection.",
    );
  }
  for (const staleProtection of [
    "observations",
    "profile-version",
    "rollout-state",
    "permissions",
    "command-inputs",
  ] as const) {
    if (!value.executionSafeguards.rejectsWhenChanged.includes(staleProtection)) {
      throw new Error(`Primary workbench promotion execution must reject stale ${staleProtection} previews.`);
    }
  }
  assertPrimaryWorkbenchBlockers(value.executionSafeguards.overlappingActionBlockers);
  if (!value.reviewDecisions?.reject.reasonRequired) {
    throw new Error("Primary workbench rejection decisions must require a reason.");
  }
  if (value.reviewDecisions.defer.stateChange !== "keeps-observation-in-review") {
    throw new Error("Primary workbench defer decisions must preserve review return semantics.");
  }
  if (value.profileWorkflows?.reapply.profileSemantics !== "current-active-profile") {
    throw new Error("Primary workbench reapply must use current active profile semantics.");
  }
  if (value.profileWorkflows.replay.profileSemantics !== "original-source-profile-version") {
    throw new Error("Primary workbench replay must use original source profile version semantics.");
  }
}

export function assertPrimaryWorkbenchMergeCandidateReview(
  value: CatalogPrimaryWorkbenchReadModel["mergeCandidateReview"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench merge candidate review contract is required.");
  }
  if (!["fresh", "partial", "stale", "unavailable"].includes(value.freshness)) {
    throw new Error("Primary workbench merge candidate review freshness must be explicit.");
  }
  for (const countKey of ["total", "ready", "conflict", "stale", "deferred", "terminal", "blocked"] as const) {
    if (typeof value.counts[countKey] !== "number") {
      throw new Error(`Primary workbench merge candidate count '${countKey}' is required.`);
    }
  }
  for (const row of value.rows) {
    if (!row.candidateId || !row.identityFingerprint || !row.identityLabel) {
      throw new Error("Primary workbench merge candidate rows must expose identity.");
    }
    if (row.sourceCount < 1 || row.sources.length < 1) {
      throw new Error("Primary workbench merge candidate rows must expose contributing sources.");
    }
    if (row.promoteReadiness.state === "ready" && row.promoteReadiness.blockers.length > 0) {
      throw new Error("Primary workbench ready merge candidates cannot carry promotion blockers.");
    }
    if (!row.proposedMapping.promotionIntent) {
      throw new Error("Primary workbench merge candidate detail must expose proposed Catalog mapping.");
    }
    if (row.fieldProvenance.length === 0 || row.sourceComparison.length === 0) {
      throw new Error("Primary workbench merge candidate detail must expose source comparison and field provenance.");
    }
    if (row.conflicts.blockingConflicts.length !== row.conflicts.blocking) {
      throw new Error(
        "Primary workbench merge candidate blocking conflict count must match its resolvable conflict detail.",
      );
    }
    const actions = new Set(row.actions.map((actionEntry) => actionEntry.key));
    for (const actionKey of [
      "candidate.promote",
      "candidate.split",
      "candidate.edit",
      "candidate.ignore",
      "candidate.defer",
    ] as const) {
      if (!actions.has(actionKey)) {
        throw new Error(`Primary workbench merge candidate rows must expose '${actionKey}'.`);
      }
    }
    for (const actionEntry of row.actions) {
      assertCatalogPrimaryWorkbenchActionState(actionEntry.state);
      assertPrimaryWorkbenchBlockers(actionEntry.blockers);
      if (
        (actionEntry.key === "candidate.split" || actionEntry.key === "candidate.edit") &&
        (actionEntry.state === "available" || actionEntry.state === "degraded") &&
        !actionEntry.commandPreview
      ) {
        throw new Error("Primary workbench split/update merge candidate actions require typed command previews.");
      }
    }
  }
}
