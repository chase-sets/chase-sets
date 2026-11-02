import type { CatalogAdminControlPlaneFreshnessState } from "./admin-control-plane-read-model-slos";
import type {
  CatalogIntegrationAuditEvidenceCategory,
  CatalogIntegrationAuditEvidenceEventName,
  CatalogIntegrationAuditEvidenceRedactionState,
} from "../governance/catalog-integration-audit-evidence";
import type {
  CatalogAdminControlPlaneQueryKey,
  CatalogAdminControlPlaneDiagnostic,
  CatalogAdminRollbackRetirementImpactSummaryReadModel,
} from "./admin-control-plane-read-model-contracts";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type { CatalogIntegrationProviderUsageBudget } from "./admin-control-plane-overview";
import type {
  CatalogPrimaryWorkbenchCommandKey,
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchActionContract,
  CatalogPrimaryWorkbenchReadModel,
} from "./primary-workbench-shared-contracts";
import type { CatalogPrimaryWorkbenchImportJobsReadModel } from "./primary-workbench-import-sync-contracts";
import {
  assertCatalogPrimaryWorkbenchActionState,
  isSafePrimaryWorkbenchReturnPath,
  isSafePrimaryWorkbenchObservabilityLink,
  assertPrimaryWorkbenchBlockers,
} from "./primary-workbench-shared-contracts";
import { catalogPrimaryWorkbenchActions } from "./primary-workbench-contract-descriptors";

export type CatalogPrimaryWorkbenchHealthTriageStatus = "ready" | "degraded" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchHealthTriageReadModel = Readonly<{
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

export type CatalogPrimaryWorkbenchHealthTriageReadModelState = Readonly<{
  queryKey: CatalogAdminControlPlaneQueryKey;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string | null;
  statusMessage: string;
  ownerMetricKey: string;
}>;

export type CatalogPrimaryWorkbenchHealthTriageUnit = Readonly<{
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

export type CatalogPrimaryWorkbenchHealthTriageProvider = Readonly<{
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

export type CatalogPrimaryWorkbenchLifecycleOperation =
  CatalogAdminRollbackRetirementImpactSummaryReadModel["operation"];

export type CatalogPrimaryWorkbenchLifecycleRecoveryStatus = "ready" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchLifecycleRecoveryReadModel = Readonly<{
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

export type CatalogPrimaryWorkbenchLifecycleOperationReadModel = Readonly<{
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

export type CatalogPrimaryWorkbenchGovernanceControlsStatus = "ready" | "degraded" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchGovernanceControlKind =
  | "staged-rollout"
  | "provider-emergency-stop"
  | "import-kill-switch"
  | "promotion-kill-switch"
  | "reapply-kill-switch"
  | "worker-pause"
  | "legacy-removal";

export type CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey =
  | "option-query-latency"
  | "job-failure-rate"
  | "projection-freshness"
  | "source-observation-quarantine"
  | "data-quarantine"
  | "conflict-spike";

export type CatalogPrimaryWorkbenchGovernanceControlsReadModel = Readonly<{
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

export type CatalogPrimaryWorkbenchAuditEvidenceStatus = "ready" | "partial" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchAuditEvidenceFilterKey =
  | "provider"
  | "unit"
  | "profile-version"
  | "job"
  | "observation"
  | "action-category"
  | "actor"
  | "time";

export type CatalogPrimaryWorkbenchAuditEvidenceTargetType =
  | "provider-profile"
  | "import-job"
  | "source-observation"
  | "catalog-item"
  | "control-plane";

export type CatalogPrimaryWorkbenchAuditEvidenceReadModel = Readonly<{
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

export type CatalogPrimaryWorkbenchAuditEvidenceLink = Readonly<{
  key: string;
  label: string;
  href: string;
  kind: "audit-event" | "diagnostic" | "proof" | "runbook" | "test";
  summary: string;
  redactionState: CatalogIntegrationAuditEvidenceRedactionState;
  sourcePayloadAccess: "not-required";
  profileSnapshotAccess: "not-required";
}>;

export type CatalogPrimaryWorkbenchHealthTriageRolloutControl = Readonly<{
  controlId: string;
  status: "open" | "degraded" | "blocked";
  severity: "info" | "warning" | "error";
  metricKey: string;
  message: string;
  providerKeys: readonly string[];
  unitKeys: readonly string[];
  nextAction: string;
}>;

export type CatalogPrimaryWorkbenchHealthTriageJob = Readonly<{
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

export type CatalogPrimaryWorkbenchHealthTriageAuditPreview = Readonly<{
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

export function assertPrimaryWorkbenchGovernanceControls(
  value: CatalogPrimaryWorkbenchReadModel["governanceControls"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench governance controls contract is required.");
  }
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench governance controls status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench governance controls return link must target the rebuilt workbench.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.auditEvidenceUrl)) {
    throw new Error("Primary workbench governance controls audit link must target the rebuilt workbench.");
  }
  if (value.controls.length === 0) {
    throw new Error("Primary workbench governance controls must expose rollout, worker, and removal evidence.");
  }
  for (const control of value.controls) {
    if (!control.controlId || !control.kind || !control.label || !control.metricKey) {
      throw new Error("Primary workbench governance controls must name control, metric, and label.");
    }
    if (!["open", "degraded", "blocked", "removed"].includes(control.status)) {
      throw new Error("Primary workbench governance control status must be explicit.");
    }
    if (!isSafePrimaryWorkbenchReturnPath(control.evidenceUrl)) {
      throw new Error("Primary workbench governance control evidence link must target the rebuilt workbench.");
    }
  }

  const sensitiveActions = catalogPrimaryWorkbenchActions.filter(
    (actionEntry) => actionEntry.requiredPermission === "catalog.manage" || actionEntry.confirmationRequired,
  );
  const matrixKeys = new Set(value.rbacMatrix.map((entry) => entry.actionKey));
  for (const actionEntry of sensitiveActions) {
    if (!matrixKeys.has(actionEntry.key)) {
      throw new Error(`Primary workbench governance controls must cover sensitive action '${actionEntry.key}'.`);
    }
  }
  for (const entry of value.rbacMatrix) {
    assertCatalogPrimaryWorkbenchActionState(entry.state);
    if (!entry.deniedCopy) {
      throw new Error("Primary workbench governance RBAC matrix must provide denied-state copy.");
    }
    if (entry.confirmationRequired && !entry.destructive) {
      throw new Error("Primary workbench governance destructive confirmation rows must be explicit.");
    }
    if (/legacy|compat|raw-json/i.test(entry.routePattern)) {
      throw new Error("Primary workbench governance RBAC matrix must not preserve retired route patterns.");
    }
  }

  const requiredSignals: readonly CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey[] = [
    "option-query-latency",
    "job-failure-rate",
    "projection-freshness",
    "source-observation-quarantine",
    "data-quarantine",
    "conflict-spike",
  ];
  const signalKeys = new Set(value.observability.signals.map((signal) => signal.key));
  for (const signal of requiredSignals) {
    if (!signalKeys.has(signal)) {
      throw new Error(`Primary workbench governance observability signal '${signal}' is required.`);
    }
  }
  for (const signal of value.observability.signals) {
    if (!["ready", "degraded", "blocked", "unavailable"].includes(signal.status)) {
      throw new Error("Primary workbench governance observability signal status must be explicit.");
    }
    if (signal.alertLinks.length === 0 || signal.runbookLinks.length === 0) {
      throw new Error("Primary workbench governance observability signals require alert and runbook links.");
    }
    for (const link of [...signal.alertLinks, ...signal.runbookLinks]) {
      if (!link.label || !isSafePrimaryWorkbenchObservabilityLink(link.href)) {
        throw new Error("Primary workbench governance alert and runbook links must target approved observability.");
      }
    }
    if (signal.stale && signal.status === "ready") {
      throw new Error("Primary workbench governance stale observability data must be degraded or unavailable.");
    }
  }

  if (value.legacyRemovalEvidence.status !== "removed") {
    throw new Error("Primary workbench governance retired compatibility evidence must be removed.");
  }
  if (value.legacyRemovalEvidence.requiredDisposition !== "complete-removal") {
    throw new Error("Primary workbench governance retired compatibility evidence must require complete removal.");
  }
  for (const surface of [
    "runtime code",
    "product patterns",
    "tests",
    "fixtures",
    "screenshots",
    "documentation",
    "runbooks",
    "operator instructions",
  ] as const) {
    if (!value.legacyRemovalEvidence.removedSurfaces.includes(surface)) {
      throw new Error(`Primary workbench governance retirement evidence must remove '${surface}'.`);
    }
  }
  for (const evidence of value.legacyRemovalEvidence.evidence) {
    if (evidence.status !== "removed" || !isSafePrimaryWorkbenchReturnPath(evidence.evidenceUrl)) {
      throw new Error("Primary workbench governance retirement evidence rows must be removed and linked.");
    }
  }
  const removalText = `${value.legacyRemovalEvidence.evidence.map((evidence) => evidence.detail).join(" ")} ${value.legacyRemovalEvidence.launchBlockerIfPresent.join(
    " ",
  )}`;
  if (/holding area/i.test(removalText)) {
    throw new Error("Primary workbench governance controls must not preserve a compatibility holding area.");
  }
}

export function assertPrimaryWorkbenchAuditEvidence(
  value: CatalogPrimaryWorkbenchReadModel["auditEvidence"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench audit evidence contract is required.");
  }
  if (!["ready", "partial", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench audit evidence status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench audit evidence return link must target the rebuilt workbench.");
  }
  if (value.projectionState.queryKey !== "audit-evidence-timeline") {
    throw new Error("Primary workbench audit evidence projection must use the canonical audit timeline query.");
  }
  if (value.projectionState.missingProjection && value.status !== "unavailable") {
    throw new Error("Primary workbench missing audit projection must be unavailable.");
  }
  if (value.projectionState.partialProjection && value.status === "ready") {
    throw new Error("Primary workbench partial audit projection cannot report ready.");
  }

  const requiredFilterKeys: readonly CatalogPrimaryWorkbenchAuditEvidenceFilterKey[] = [
    "provider",
    "unit",
    "profile-version",
    "job",
    "observation",
    "action-category",
    "actor",
    "time",
  ];
  const filterKeys = new Set(value.filters.map((filter) => filter.key));
  for (const filterKey of requiredFilterKeys) {
    if (!filterKeys.has(filterKey)) {
      throw new Error(`Primary workbench audit evidence filter '${filterKey}' is required.`);
    }
  }

  if (
    value.redactionPolicy.sourcePayloadAccess !== "not-required" ||
    value.redactionPolicy.profileSnapshotAccess !== "not-required"
  ) {
    throw new Error("Primary workbench audit evidence must not require source payload or profile snapshot access.");
  }
  if (value.redactionPolicy.forbiddenEvidenceRequests.length === 0) {
    throw new Error("Primary workbench audit evidence must list forbidden evidence request patterns.");
  }

  const links = [...value.evidenceLinks, ...value.timeline.flatMap((event) => event.evidenceLinks)];
  for (const link of links) {
    assertPrimaryWorkbenchAuditEvidenceLink(link);
  }
  for (const event of value.timeline) {
    if (!event.eventId || !event.occurredAt || !event.eventName || !event.category || !event.targetId) {
      throw new Error("Primary workbench audit timeline rows must name event, time, category, and target.");
    }
    if (event.evidenceLinks.length === 0) {
      throw new Error("Primary workbench audit timeline rows must expose redacted evidence links.");
    }
  }

  const evidenceText = JSON.stringify(value);
  if (/raw\s+json|payload\s+json|profile\s+json|compatibility holding area/i.test(evidenceText)) {
    throw new Error(
      "Primary workbench audit evidence must expose redacted summaries without legacy document workflows.",
    );
  }
}

function assertPrimaryWorkbenchAuditEvidenceLink(link: CatalogPrimaryWorkbenchAuditEvidenceLink): void {
  if (!link.key || !link.label || !link.summary || !isSafePrimaryWorkbenchReturnPath(link.href)) {
    throw new Error("Primary workbench audit evidence links must be named and target rebuilt workbench evidence.");
  }
  if (
    link.sourcePayloadAccess !== "not-required" ||
    link.profileSnapshotAccess !== "not-required" ||
    !["not-needed", "redacted", "excluded"].includes(link.redactionState)
  ) {
    throw new Error("Primary workbench audit evidence links must remain redaction-safe.");
  }
}

export function assertPrimaryWorkbenchHealthTriage(
  value: CatalogPrimaryWorkbenchReadModel["healthTriage"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench health triage contract is required.");
  }
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench health triage status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench health triage return link must target the rebuilt workbench.");
  }
  for (const unit of value.units) {
    if (!unit.providerKey || !unit.unitKey || !unit.ownerMetricKey || !unit.nextAction) {
      throw new Error("Primary workbench health triage units must name provider, unit, owner metric, and next action.");
    }
  }
  for (const provider of value.providers) {
    if (!provider.providerKey || !provider.ownerMetricKey || !provider.nextAction) {
      throw new Error("Primary workbench health triage providers must name provider, owner metric, and next action.");
    }
  }
}

export function assertPrimaryWorkbenchLifecycleRecovery(
  value: CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench lifecycle recovery contract is required.");
  }
  if (!["ready", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench lifecycle recovery status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench lifecycle recovery return link must target the rebuilt workbench.");
  }
  if (value.strictRetirement.requiredDisposition !== "complete-removal") {
    throw new Error("Primary workbench lifecycle recovery must preserve complete-removal retirement semantics.");
  }
  const operations = new Set(value.operations.map((operation) => operation.operation));
  for (const operation of ["activation", "rollback", "deprecate", "retire"] as const) {
    if (!operations.has(operation)) {
      throw new Error(`Primary workbench lifecycle recovery must expose ${operation} evidence.`);
    }
  }
  for (const operation of value.operations) {
    assertCatalogPrimaryWorkbenchActionState(operation.state);
    assertPrimaryWorkbenchBlockers(operation.blockers);
    if (!isSafePrimaryWorkbenchReturnPath(operation.submitHref)) {
      throw new Error("Primary workbench lifecycle recovery submit link must stay in the rebuilt workbench.");
    }
    if (
      (operation.operation === "rollback" || operation.operation === "deprecate" || operation.operation === "retire") &&
      !operation.confirmationRequired
    ) {
      throw new Error("Primary workbench lifecycle recovery destructive lifecycle actions require confirmation.");
    }
    if (operation.operation === "retire" && operation.blockers.includes("profile-retirement-references")) {
      const referenceCount =
        operation.impact.referencedObservationCount +
        operation.impact.sourceProfileReferenceCount +
        operation.impact.promotionProfileReferenceCount;
      if (referenceCount === 0) {
        throw new Error("Primary workbench profile retirement reference blocker must name concrete references.");
      }
    }
  }
}
