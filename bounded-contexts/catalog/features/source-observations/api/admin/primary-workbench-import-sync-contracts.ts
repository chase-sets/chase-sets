import type { CatalogAdminControlPlaneFreshnessState } from "./admin-control-plane-read-model-slos";
import type {
  CatalogAdminJobConsistency,
  CatalogAdminProfileVersionPointer,
} from "./admin-control-plane-read-model-contracts";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type {
  CatalogPrimaryWorkbenchCommandKey,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchActionReadModel,
} from "./primary-workbench-shared-contracts";
import type {
  CatalogPrimaryWorkbenchProviderTransportCategory,
  CatalogPrimaryWorkbenchScopeContext,
  CatalogPrimaryWorkbenchSourceOptionsStatus,
} from "./primary-workbench-selection-contracts";
import {
  assertCatalogPrimaryWorkbenchActionState,
  assertPrimaryWorkbenchBlockers,
} from "./primary-workbench-shared-contracts";

export type CatalogPrimaryWorkbenchCatalogSyncStatus = "scope-required" | "ready" | "blocked" | "degraded";

export type CatalogPrimaryWorkbenchCatalogSyncReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchCatalogSyncStatus;
  generatedAt: string;
  scope: Readonly<{
    scopeVersion: "catalog-sync-scope-v2";
    productDomain: string | null;
    productForm: string | null;
    languageCode: string | null;
    reference: Readonly<{
      kind: "product-line" | "series" | "expansion" | "set" | "catalog-item" | null;
      scopeRecordId: string | null;
    }>;
    label: string;
    hasConcreteScope: boolean;
  }>;
  preview: Readonly<{
    previewVersion: "catalog-sync-provider-participation-preview-v1";
    status: "ready" | "degraded" | "blocked";
    startAllowed: boolean;
    explanation: string;
    estimate: Readonly<{
      totalEstimatedRequestCount: number | null;
      estimateState: "estimated" | "estimate-unavailable";
      estimateReason: string | null;
      creditConsumingProviders: readonly Readonly<{
        providerKey: string;
        displayName: string;
        unitKeys: readonly string[];
      }>[];
    }>;
    blockers: readonly Readonly<{
      code: string;
      severity: "info" | "warning" | "error";
      message: string;
      providerKey: string;
      unitKey: string | null;
    }>[];
    units: readonly CatalogPrimaryWorkbenchCatalogSyncUnitReadModel[];
  }>;
  action: CatalogPrimaryWorkbenchActionReadModel;
}>;

export type CatalogPrimaryWorkbenchCatalogSyncUnitReadModel = Readonly<{
  providerKey: string;
  unitKey: string | null;
  displayName: string;
  profileVersion: string | null;
  productDomain: string | null;
  productForm: string | null;
  role: "primary" | "supplementary" | "reference";
  requirement: "required" | "optional";
  selected: boolean;
  eligibility: "eligible" | "blocked";
  childExecutionScope: Readonly<Record<string, string>> | null;
  estimate: Readonly<{
    estimateState: "estimated" | "estimate-unavailable";
    estimatedRequestCount: number | null;
    estimateReason: string | null;
  }> | null;
  blockers: readonly Readonly<{
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
  }>[];
}>;

export type CatalogPrimaryWorkbenchSourceScopeWorksetStatus =
  | "not-configured"
  | "scope-required"
  | "ready"
  | "blocked"
  | "degraded";

export type CatalogPrimaryWorkbenchSourceScopeWorksetUnitState =
  | "not-imported"
  | "imported"
  | "changed"
  | "promoted"
  | "blocked";

export type CatalogPrimaryWorkbenchSourceScopeWorksetReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchSourceScopeWorksetStatus;
  generatedAt: string;
  selectedScope: Readonly<{
    importScope: string | null;
    label: string;
    hasConcreteScope: boolean;
    scope: CatalogPrimaryWorkbenchScopeContext;
  }>;
  summary: Readonly<{
    unitCount: number;
    readyUnitCount: number;
    blockedUnitCount: number;
    activeImportCount: number;
    changedObservationCount: number;
    promotedObservationCount: number;
  }>;
  units: readonly CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel[];
}>;

export type CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel = Readonly<{
  providerKey: string;
  displayName: string;
  unitKey: CatalogIntegrationUnitKey | null;
  productDomain: string | null;
  productForm: string | null;
  profileVersion: string | null;
  importScope: string | null;
  profileReady: boolean;
  optionQueryState: CatalogPrimaryWorkbenchSourceOptionsStatus;
  state: CatalogPrimaryWorkbenchSourceScopeWorksetUnitState;
  counts: Readonly<{
    observed: number;
    changed: number;
    promoted: number;
    rejected: number;
    eligible: number;
  }>;
  activeJobCount: number;
  lastJobState: CatalogPrimaryWorkbenchImportJobsReadModel["jobs"][number]["state"] | null;
  currentWorkbenchHref: string;
  commandContext: Readonly<{
    providerKey: string;
    productId: string | null;
    unitKey: CatalogIntegrationUnitKey | null;
    importScope: string | null;
    profileVersion: string | null;
    languageCode: string | null;
    productLineId: string | null;
    productLineName: string | null;
    seriesId: string | null;
    seriesName: string | null;
    expansionId: string | null;
    expansionName: string | null;
  }>;
  actions: Readonly<{
    import: CatalogPrimaryWorkbenchActionReadModel;
    previewPromotion: CatalogPrimaryWorkbenchActionReadModel;
    reapply: CatalogPrimaryWorkbenchActionReadModel;
  }>;
}>;

export type CatalogPrimaryWorkbenchImportJobsReadModel = Readonly<{
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

export function assertPrimaryWorkbenchImportJobs(
  value: CatalogPrimaryWorkbenchReadModel["importJobs"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench import jobs contract is required.");
  }
  for (const job of value.jobs) {
    if (!job.result) {
      continue;
    }
    if (!Array.isArray(job.result.redactedFailureReasons)) {
      throw new Error("Primary workbench import job results must expose redacted failure reasons.");
    }
    if (job.result.usage) {
      const counts = Object.values(job.result.usage);
      if (counts.some((count) => count !== null && (!Number.isSafeInteger(count) || count < 0))) {
        throw new Error("Primary workbench import job usage counts must be non-negative integers.");
      }
    }
    for (const reason of job.result.redactedFailureReasons) {
      if (
        typeof reason !== "string" ||
        !reason.trim() ||
        reason.includes("\n") ||
        /\b(api[-_ ]?key|x-api-key|x-team-id|authorization|bearer|token|secret|password)\s*[=:]\s*(?!\[redacted\])/i.test(
          reason,
        )
      ) {
        throw new Error("Primary workbench import job failure reasons must stay redaction-safe.");
      }
    }
  }
}

export function assertPrimaryWorkbenchSourceScopeWorkset(
  value: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench source-scope workset contract is required.");
  }
  if (!["not-configured", "scope-required", "ready", "blocked", "degraded"].includes(value.status)) {
    throw new Error("Primary workbench source-scope workset status must be explicit.");
  }
  if (!value.selectedScope.label) {
    throw new Error("Primary workbench source-scope workset must label the selected scope state.");
  }
  if (value.summary.unitCount !== value.units.length) {
    throw new Error("Primary workbench source-scope workset unit summary must match unit rows.");
  }
  const unitKeys = new Set<string>();
  for (const unit of value.units) {
    const unitIdentity = `${unit.providerKey}:${unit.unitKey ?? "none"}`;
    if (unitKeys.has(unitIdentity)) {
      throw new Error("Primary workbench source-scope workset unit rows must be unique by provider and unit.");
    }
    unitKeys.add(unitIdentity);
    if (
      !unit.providerKey ||
      !unit.displayName ||
      !unit.currentWorkbenchHref ||
      /api\/|raw-json|legacy|compat/i.test(unit.currentWorkbenchHref)
    ) {
      throw new Error("Primary workbench source-scope workset rows must link back to the typed workbench.");
    }
    if (!["not-imported", "imported", "changed", "promoted", "blocked"].includes(unit.state)) {
      throw new Error("Primary workbench source-scope workset row state must be explicit.");
    }
    if (!unit.commandContext.providerKey || unit.commandContext.providerKey !== unit.providerKey) {
      throw new Error("Primary workbench source-scope workset command context must preserve provider identity.");
    }
    if (!value.selectedScope.hasConcreteScope || !unit.importScope) {
      for (const action of [unit.actions.import, unit.actions.previewPromotion, unit.actions.reapply] as const) {
        if (action.state !== "disabled" || !action.blockers.includes("import-scope-required")) {
          throw new Error("Primary workbench source-scope workset must fail closed until a source scope is selected.");
        }
      }
    }
    for (const action of [unit.actions.import, unit.actions.previewPromotion, unit.actions.reapply] as const) {
      assertCatalogPrimaryWorkbenchActionState(action.state);
      assertPrimaryWorkbenchBlockers(action.blockers);
    }
  }
}
