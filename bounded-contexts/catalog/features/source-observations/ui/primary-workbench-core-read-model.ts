import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchSourceObservationEvidenceDetail,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import { redactedCatalogJobFailureReason } from "../api/admin-control-plane-overview";
import type { CatalogProviderProfileVersionReview } from "./contracts";
import { catalogSyncFor } from "./primary-workbench-catalog-sync";
import { importJobsFor, selectedImportScopeFor } from "./primary-workbench-import-jobs";
import { mergeCandidateReviewFor } from "./primary-workbench-merge-candidate-review";
import { providerScopeProviders } from "./primary-workbench-provider-scope";
import type { CatalogPrimaryWorkbenchInput } from "./primary-workbench-read-model-input";
import {
  credentialBlockerFor,
  providerTransportBlockerFor,
  providerTransportFor,
  sum,
} from "./primary-workbench-read-model-support";
import { catalogPrimaryWorkbenchSupportingHref } from "./primary-workbench-route-context";
import {
  resolveCatalogPrimaryWorkbenchRouteSelection,
  selectedProviderScopeRows,
} from "./primary-workbench-route-selection";
import {
  promotionPreviewFor,
  sourceObservationReviewCompositionFor,
} from "./primary-workbench-source-observation-review";
import { buildCatalogPrimaryWorkbenchSourceOptions } from "./primary-workbench-source-options";
import { selectedSourceScope, sourceScopeWorksetFor } from "./primary-workbench-source-scope-workset";

// The slices the metric strip and grouped navigation render on EVERY surface
// route, plus the route context and base scalars. Every per-route read model
// is assembled from this shared core so the cross-surface workbench chrome is
// identical regardless of which audience surface is active.
export type CatalogPrimaryWorkbenchCore = Readonly<{
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  providerScope: CatalogPrimaryWorkbenchReadModel["providerScope"];
  sourceOptions: CatalogPrimaryWorkbenchReadModel["sourceOptions"];
  catalogSync: CatalogPrimaryWorkbenchReadModel["catalogSync"];
  sourceScopeWorkset: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"];
  readiness: CatalogPrimaryWorkbenchReadModel["readiness"];
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"];
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
  mergeCandidateReview: CatalogPrimaryWorkbenchReadModel["mergeCandidateReview"];
  // Deep-evidence index keyed by observationId. NOT serialized into the read model
  // — it stays in-process to feed the conflict-resolution and audit-evidence
  // composers (which read full fact/duplicate/conflict/audit evidence) without
  // shipping that evidence on every review row.
  reviewEvidenceByObservationId: ReadonlyMap<string, CatalogPrimaryWorkbenchSourceObservationEvidenceDetail>;
  promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  securityPrivacy: CatalogPrimaryWorkbenchReadModel["securityPrivacy"];
  promotionResult: CatalogPrimaryWorkbenchReadModel["promotionResult"];
  generatedAt: string;
}>;

// Intermediate values derived once from the loader input and reused by both the
// core and every surface slice builder. Keeping them on one object means each
// surface slice builder is a pure function of (core, derived, input) and never
// re-derives provider scope, blockers, or counts.
export type CatalogPrimaryWorkbenchDerived = Readonly<{
  providerKey: string | null;
  unitKey: CatalogIntegrationUnitKey | null;
  importScope: string | null;
  activeProfile: CatalogProviderProfileVersionReview | null;
  selectedProfile: CatalogProviderProfileVersionReview | null;
  requestedProfileVersion: string | null;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  rolloutEnabled: boolean;
  activeJobCount: number;
  failedJobCount: number;
  importJobRows: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  canManage: boolean;
}>;

// The route selection plus the readiness blockers and source options derived
// from it alone. The deferred source-options builder stops here; the core
// continues from these same values, so the streamed slice is byte-identical to
// the synchronous one without touching review, candidate, sync, promotion or
// job-activity inputs.
function selectionWithSourceOptions(input: CatalogPrimaryWorkbenchInput) {
  const selection = resolveCatalogPrimaryWorkbenchRouteSelection(input);
  const readinessBlockers = readinessBlockersFor(input, selection.providerKey, selection.activeProfile);
  const generatedAt = input.controlPlaneOverview?.generatedAt ?? new Date().toISOString();
  const sourceOptions = buildCatalogPrimaryWorkbenchSourceOptions({
    activeProfile: selection.activeProfile,
    canManage: input.canManageCatalog,
    generatedAt,
    profiles: input.profileReviews.items,
    readinessBlockers,
    routeContext: selection.routeContext,
    scopes: input.scopes.items,
    sourceOptionPages: input.sourceOptionPages ?? null,
  });

  return { selection, readinessBlockers, generatedAt, sourceOptions };
}

export function buildCatalogPrimaryWorkbenchCoreSourceOptions(
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchReadModel["sourceOptions"] {
  return selectionWithSourceOptions(input).sourceOptions;
}

// Build the shared core every surface renders. This does NOT compute any of the
// supporting-surface slices (profile authoring, validation, conflict, lifecycle,
// governance, audit, health); those are surface-specific and built
// independently by primary-workbench-surface-slices.
export function buildCatalogPrimaryWorkbenchCore(
  input: CatalogPrimaryWorkbenchInput,
): Readonly<{ core: CatalogPrimaryWorkbenchCore; derived: CatalogPrimaryWorkbenchDerived }> {
  const { selection, readinessBlockers, generatedAt, sourceOptions } = selectionWithSourceOptions(input);
  const { routeContext, providerKey, unitKey, importScope, routeScope, explicitStructuredScope, activeProfile } =
    selection;
  const canManage = input.canManageCatalog;
  const selectedScope = selectedSourceScope({
    profiles: input.profileReviews.items,
    routeContext,
    scopes: input.scopes.items,
    sourceOptions,
  });
  const providerScopeRows = providerKey
    ? input.scopes.items.filter((scope) => scope.provider_key === providerKey)
    : input.scopes.items;
  const scopeRows = selectedProviderScopeRows({
    explicitStructuredScope,
    importScope,
    providerScopeRows,
    routeScope,
    selectedScope: selectedScope.scope,
  });
  const observed = sum(scopeRows, (scope) => scope.observed_observations);
  const changed = sum(scopeRows, (scope) => scope.changed_observations);
  const promoted = sum(scopeRows, (scope) => scope.promoted_observations);
  const rejected = sum(scopeRows, (scope) => scope.rejected_observations);
  const eligible = Math.max(observed + changed, 0);
  const providerTransport = providerTransportFor(input.controlPlaneOverview, providerKey);
  const rolloutEnabled =
    input.controlPlaneOverview?.readiness.rolloutControls.controls.every((control) => control.status !== "blocked") ??
    true;
  const importJobRows = importJobsFor(input.controlPlaneOverview, routeContext, input.scopes.items);
  const activeJobCount = importJobRows.filter((job) => job.state === "queued" || job.state === "running").length;
  const failedJobCount = importJobRows.filter((job) => job.state === "failed").length;
  const reviewUnavailable = input.readModelFailures?.includes("source-observation-review") ?? false;
  const mergeCandidateReviewUnavailable = input.readModelFailures?.includes("merge-candidate-review") ?? false;
  const controlPlaneFreshness = input.readModelFailures?.includes("control-plane-overview")
    ? "unavailable"
    : input.controlPlaneOverview
      ? "fresh"
      : "partial";
  const { review: sourceObservationReview, evidenceByObservationId: reviewEvidenceByObservationId } =
    sourceObservationReviewCompositionFor({
      canManage,
      changed,
      eligible,
      observed,
      promoted,
      readinessBlockers,
      rejected,
      reviewObservations: input.reviewObservations ?? null,
      reviewUnavailable,
      reviewPagination: input.reviewPagination,
      routeContext,
      scopeRows,
    });
  const promotionPreview = promotionPreviewFor({
    activeJobCount,
    activeProfileVersion: activeProfile?.profileVersion ?? null,
    canManage,
    failedJobCount,
    readinessBlockers,
    routeContext,
    sourceObservationReview,
    reviewEvidenceByObservationId,
    promotionValidation: input.promotionValidation ?? null,
  });
  const mergeCandidateReview = mergeCandidateReviewFor({
    canManage,
    generatedAt,
    mergeCandidates: input.mergeCandidates ?? null,
    mergeCandidateReviewUnavailable,
    routeContext,
  });
  const securityPrivacy = {
    redactionApplied: true,
    governedDataClasses: ["provider payload", "operator identity", "external source URLs"],
    unsafeEvidenceBlocked: false,
    missingSecurityFieldsBlocker: "security-privacy-blocked",
  } satisfies CatalogPrimaryWorkbenchReadModel["securityPrivacy"];
  const sourceScopeWorkset = sourceScopeWorksetFor({
    canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    importJobs: {
      freshness: controlPlaneFreshness,
      activeJobCount,
      failedJobCount,
      selectedScope: null,
      jobs: importJobRows,
    },
    profiles: input.profileReviews.items,
    readinessBlockers,
    routeContext,
    scopes: input.scopes.items,
    sourceOptions,
  });
  const catalogSync = catalogSyncFor({
    canManage,
    generatedAt,
    catalogSyncPreview: input.catalogSyncPreview ?? null,
    readinessBlockers,
    routeContext,
    sourceScopeWorkset,
  });

  return {
    core: {
      routeContext,
      providerScope: {
        providers: providerScopeProviders(input, providerKey, activeProfile, routeContext),
      },
      sourceOptions,
      catalogSync,
      sourceScopeWorkset,
      readiness: {
        freshness: controlPlaneFreshness,
        blockers: readinessBlockers,
        providerTransport,
        rolloutEnabled,
        rbacAllowed: input.canManageCatalog,
        auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(routeContext, "audit-evidence"),
      },
      importJobs: {
        freshness: controlPlaneFreshness,
        activeJobCount,
        failedJobCount,
        selectedScope: selectedImportScopeFor({
          activeProfile,
          activeJobCount,
          blockers: readinessBlockers,
          input,
          importScope,
          providerKey,
          providerTransport,
          routeContext,
          rolloutEnabled,
          unitKey,
        }),
        jobs: importJobRows,
      },
      sourceObservationReview,
      mergeCandidateReview,
      reviewEvidenceByObservationId,
      promotionPreview,
      securityPrivacy,
      promotionResult: promotionResultFromOutcome(input.promotionOutcome ?? null),
      generatedAt,
    },
    derived: {
      providerKey,
      unitKey,
      importScope,
      activeProfile,
      selectedProfile: selection.selectedProfile,
      requestedProfileVersion: selection.requestedProfileVersion,
      readinessBlockers,
      rolloutEnabled,
      activeJobCount,
      failedJobCount,
      importJobRows,
      canManage,
    },
  };
}

function readinessBlockersFor(
  input: CatalogPrimaryWorkbenchInput,
  providerKey: string | null,
  activeProfile: CatalogProviderProfileVersionReview | null,
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!input.canManageCatalog) {
    blockers.add("permission-denied");
  }
  if (!activeProfile) {
    blockers.add("missing-active-profile");
  }
  for (const control of input.controlPlaneOverview?.readiness.rolloutControls.controls ?? []) {
    const appliesToProvider =
      !providerKey || control.providerKeys.length === 0 || control.providerKeys.includes(providerKey);
    if (appliesToProvider && control.status === "blocked") {
      blockers.add(control.defaultState === "quarantined" ? "kill-switch-active" : "rollout-disabled");
    }
  }
  for (const unit of input.controlPlaneOverview?.readiness.units ?? []) {
    if (providerKey && unit.providerKey !== providerKey) {
      continue;
    }
    if (unit.credentialReadiness === "blocked") {
      blockers.add(credentialBlockerFor(unit.credentialReadinessState));
    }
    if (unit.transportReadiness === "blocked") {
      blockers.add("provider-transport-degraded");
    }
    if (unit.fixtureValidationStatus === "blocked") {
      blockers.add("missing-fixture-coverage");
    }
  }
  for (const category of providerTransportFor(input.controlPlaneOverview, providerKey)) {
    blockers.add(providerTransportBlockerFor(category));
  }

  return [...blockers];
}

function promotionResultFromOutcome(
  outcome: CatalogPrimaryWorkbenchInput["promotionOutcome"],
): CatalogPrimaryWorkbenchReadModel["promotionResult"] {
  if (!outcome) {
    return null;
  }

  return {
    resultId: outcome.outcomeId,
    jobId: outcome.jobId,
    status: outcome.terminalState,
    requestedCount: outcome.requested,
    promotedCount: outcome.promoted,
    skippedCount: outcome.skipped,
    failedCount: outcome.failed,
    promotedCatalogItemIds: uniqueStrings(
      outcome.outcomes.flatMap((item) => (item.catalogItemId ? [item.catalogItemId] : [])),
    ),
    promotedReferenceIds: uniqueStrings(
      outcome.outcomes.flatMap((item) => (item.referenceRecordId ? [item.referenceRecordId] : [])),
    ),
    skippedObservationIds: outcome.outcomes
      .filter((item) => item.status === "skipped")
      .map((item) => item.observationId),
    failedObservationIds: outcome.outcomes.filter((item) => item.status === "failed").map((item) => item.observationId),
    redactedFailureReasons: uniqueStrings(
      outcome.outcomes.flatMap((item) => {
        if (item.status !== "failed") {
          return [];
        }
        const reason = redactedCatalogJobFailureReason(item.reason);
        return reason ? [reason] : [];
      }),
    ).slice(0, 3),
    completedAt: outcome.recordedAt,
    auditEvidenceIds: [outcome.outcomeId],
  };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
