import {
  catalogPrimaryWorkbenchContractVersion,
  catalogPrimaryWorkbenchDeploySkewPolicies,
  catalogPrimaryWorkbenchInstrumentationDimensions,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogPrimaryWorkbenchActionReadModel,
  type CatalogPrimaryWorkbenchBlockerCategory,
  type CatalogPrimaryWorkbenchReadModel,
  type CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import {
  defineCatalogIntegrationUnitKey,
  parseCatalogIntegrationUnitKey,
  type CatalogIntegrationUnitKey,
} from "../api/integration-unit";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import type {
  CatalogIntegrationControlPlaneUnitReadiness,
  CatalogIntegrationProviderReadiness,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
} from "./contracts";
import {
  catalogPrimaryWorkbenchSupportingHref,
  parseCatalogPrimaryWorkbenchRouteContext,
} from "./primary-workbench-route-context";
import type { CatalogPrimaryWorkbenchInput } from "./primary-workbench-read-model-input";
import {
  comparableImportScopeKey,
  credentialBlockerFor,
  importScopeMatchesProviderScope,
  normalizeUnitSegment,
  profilePointerForProfile,
  providerTransportBlockerFor,
  providerTransportFor,
  sourceOptionKindsForProfile,
  sum,
} from "./primary-workbench-read-model-support";
import {
  compactExpansionRouteScopeMatchesProviderScope,
  importScopeFromScopeContext,
} from "./primary-workbench-scope-context";
import { profileAuthoringFor } from "./primary-workbench-profile-authoring";
import { healthTriageFor } from "./primary-workbench-health-triage";
import { validationReadinessFor } from "./primary-workbench-validation-readiness";
import { lifecycleRecoveryFor, type LifecycleOperationRow } from "./primary-workbench-lifecycle-recovery";
import { importJobsFor, selectedImportScopeFor } from "./primary-workbench-import-jobs";
import {
  promotionPreviewFor,
  sourceObservationReviewCompositionFor,
} from "./primary-workbench-source-observation-review";
import type { CatalogPrimaryWorkbenchSourceObservationEvidenceDetail } from "../api/primary-workbench-admin-contracts";
import { conflictResolutionFor } from "./primary-workbench-conflict-resolution";
import { governanceControlsFor } from "./primary-workbench-governance-controls";
import { auditEvidenceFor } from "./primary-workbench-audit-evidence";
import { buildCatalogPrimaryWorkbenchSourceOptions } from "./primary-workbench-source-options";
import { sourceScopeWorksetFor } from "./primary-workbench-source-scope-workset";
import { catalogSyncFor } from "./primary-workbench-catalog-sync";
import { mergeCandidateReviewFor } from "./primary-workbench-merge-candidate-review";

// The slices the metric strip and grouped navigation render on EVERY surface
// route, plus the route context and base scalars. Every per-route read model
// is assembled from this shared core so the cross-surface workbench chrome is
// identical regardless of which audience surface is active.
type CatalogPrimaryWorkbenchCore = Readonly<{
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
  generatedAt: string;
}>;

// Intermediate values derived once from the loader input and reused by both the
// core and every surface slice builder. Keeping them on one object means each
// surface slice builder is a pure function of (core, derived, input) and never
// re-derives provider scope, blockers, or counts.
type CatalogPrimaryWorkbenchDerived = Readonly<{
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

// Build the shared core every surface renders. This does NOT compute any of the
// supporting-surface slices (profile authoring, validation, conflict, lifecycle,
// governance, audit, health); those are surface-specific and built
// independently by the per-surface slice builders below.
function buildCatalogPrimaryWorkbenchCore(
  input: CatalogPrimaryWorkbenchInput,
): Readonly<{ core: CatalogPrimaryWorkbenchCore; derived: CatalogPrimaryWorkbenchDerived }> {
  const parsedContext = parseCatalogPrimaryWorkbenchRouteContext(input.requestUrl);
  const providerKey = parsedContext.providerKey ?? inferProviderKey(input);
  const normalizedRouteUnitKey = normalizeSelectedUnitKey(parsedContext.unitKey, providerKey);
  const activeProfile = findActiveProfile(input.profileReviews.items, providerKey, normalizedRouteUnitKey);
  const selectedProfile = findSelectedProfile(
    input.profileReviews.items,
    providerKey,
    parsedContext.profileVersion,
    normalizedRouteUnitKey,
    activeProfile,
  );
  const sourceOptionIntent = requestHasSourceOptionIntent(input.requestUrl);
  const useActiveProfileForSourceOptions =
    sourceOptionIntent && Boolean(parsedContext.profileVersion) && !selectedProfile && Boolean(activeProfile);
  const sourceOptionNormalizationProfile = sourceOptionIntent ? (selectedProfile ?? activeProfile) : activeProfile;
  const explicitStructuredScope = requestHasStructuredImportScopeSelection(input.requestUrl);
  const explicitLanguageScope = requestHasExplicitLanguageScopeSelection(input.requestUrl);
  const unitContextMismatch = Boolean(parsedContext.unitKey && providerKey && !normalizedRouteUnitKey);
  const unitKey = normalizedRouteUnitKey ?? inferUnitKey(input, providerKey, activeProfile);
  const providerUnitSelectionAmbiguous = Boolean(
    providerKey &&
    !normalizedRouteUnitKey &&
    providerHasMultipleActiveProfileUnits(input.profileReviews.items, providerKey),
  );
  const legacyImportScopeMismatch = legacyImportScopeConflictsWithSelectedProvider({
    requestUrl: input.requestUrl,
    importScope: parsedContext.importScope,
    scope: parsedContext.scope,
    providerKey,
    unitKey: normalizedRouteUnitKey,
    activeProfile: sourceOptionNormalizationProfile,
    scopes: input.scopes.items,
    explicitStructuredScope,
    unitContextMismatch,
  });
  const discardParsedImportScope = unitContextMismatch || legacyImportScopeMismatch;
  const routeScope =
    discardParsedImportScope && legacyImportScopeMismatch && explicitStructuredScope
      ? sanitizeScopeForSourceOptionProfile(
          parsedContext.scope,
          sourceOptionNormalizationProfile,
          providerKey,
          explicitLanguageScope,
        )
      : discardParsedImportScope
        ? providerOnlyScopeContext(providerKey)
        : structuredScopeWithProfileLanguage(
            parsedContext.scope,
            sourceOptionNormalizationProfile,
            input.scopes.items,
            explicitStructuredScope,
          );
  const parsedImportScope = discardParsedImportScope
    ? null
    : structuredSelectionImportScope(parsedContext.importScope, routeScope, explicitStructuredScope);
  const structuredImportScope = explicitStructuredScope ? importScopeFromScopeContext(routeScope) : null;
  const unitRouteWithoutExplicitScope = Boolean(
    parsedContext.unitKey && !parsedContext.importScope && !explicitStructuredScope,
  );
  const inferredImportScope =
    explicitStructuredScope ||
    legacyImportScopeMismatch ||
    unitRouteWithoutExplicitScope ||
    providerUnitSelectionAmbiguous
      ? null
      : inferImportScope(input.scopes.items, providerKey);
  const importScope = unitContextMismatch ? null : (parsedImportScope ?? structuredImportScope ?? inferredImportScope);
  const discardParsedImportScopeFilters = discardParsedImportScope || unitRouteWithoutExplicitScope;
  const profileVersion =
    unitContextMismatch || useActiveProfileForSourceOptions
      ? (activeProfile?.profileVersion ?? null)
      : (parsedContext.profileVersion ?? activeProfile?.profileVersion ?? null);
  const routeSelectedProfile = useActiveProfileForSourceOptions ? activeProfile : selectedProfile;
  const routeRequestedProfileVersion = useActiveProfileForSourceOptions ? profileVersion : parsedContext.profileVersion;
  const routeContext: CatalogPrimaryWorkbenchRouteContext = {
    ...parsedContext,
    providerKey,
    unitKey,
    scope: routeScope,
    importScope,
    profileVersion,
    sourceObservationFilters: sourceObservationFiltersForRouteContext({
      parsedFilters: parsedContext.sourceObservationFilters,
      providerKey,
      importScope,
      explicitStructuredScope,
      discardParsedImportScope: discardParsedImportScopeFilters,
    }),
  };
  const providerScopeRows = providerKey
    ? input.scopes.items.filter((scope) => scope.provider_key === providerKey)
    : input.scopes.items;
  const scopeRows = selectedProviderScopeRows({
    explicitStructuredScope,
    importScope,
    providerScopeRows,
    routeScope,
  });
  const observed = sum(scopeRows, (scope) => scope.observed_observations);
  const changed = sum(scopeRows, (scope) => scope.changed_observations);
  const promoted = sum(scopeRows, (scope) => scope.promoted_observations);
  const rejected = sum(scopeRows, (scope) => scope.rejected_observations);
  const eligible = Math.max(observed + changed, 0);
  const providerTransport = providerTransportFor(input.controlPlaneOverview, providerKey);
  const readinessBlockers = readinessBlockersFor(input, providerKey, activeProfile);
  const rolloutEnabled =
    input.controlPlaneOverview?.readiness.rolloutControls.controls.every((control) => control.status !== "blocked") ??
    true;
  const importJobRows = importJobsFor(input.controlPlaneOverview, routeContext, input.scopes.items);
  const activeJobCount = importJobRows.filter((job) => job.state === "queued" || job.state === "running").length;
  const failedJobCount = importJobRows.filter((job) => job.state === "failed").length;
  const canManage = input.canManageCatalog;
  const generatedAt = input.controlPlaneOverview?.generatedAt ?? new Date().toISOString();
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
  const sourceOptions = buildCatalogPrimaryWorkbenchSourceOptions({
    activeProfile,
    canManage,
    generatedAt,
    profiles: input.profileReviews.items,
    readinessBlockers,
    routeContext,
    scopes: input.scopes.items,
    sourceOptionPages: input.sourceOptionPages ?? null,
  });
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
      generatedAt,
    },
    derived: {
      providerKey,
      unitKey,
      importScope,
      activeProfile,
      selectedProfile: routeSelectedProfile,
      requestedProfileVersion: routeRequestedProfileVersion,
      readinessBlockers,
      rolloutEnabled,
      activeJobCount,
      failedJobCount,
      importJobRows,
      canManage,
    },
  };
}

// Provider profiles + readiness surface slices for the providers route. Built
// only from profile reviews, the optional authoring model, and the control plane
// overview — never from conflict, governance, release, or audit inputs.
function providersSurfaceSlices(
  input: CatalogPrimaryWorkbenchInput,
  core: CatalogPrimaryWorkbenchCore,
  derived: CatalogPrimaryWorkbenchDerived,
): Readonly<{
  profileAuthoring: CatalogPrimaryWorkbenchReadModel["profileAuthoring"];
  validationReadiness: CatalogPrimaryWorkbenchReadModel["validationReadiness"];
}> {
  const profileAuthoring = profileAuthoringFor({
    activeJobCount: derived.activeJobCount,
    activeProfile: derived.activeProfile,
    canManage: derived.canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt: core.generatedAt,
    profiles: input.profileReviews.items,
    providerKey: derived.providerKey,
    requestedProfileVersion: derived.requestedProfileVersion,
    requestUrl: input.requestUrl,
    routeContext: core.routeContext,
    selectedProfile: derived.selectedProfile,
    scopes: input.scopes.items,
  });
  const validationReadiness = validationReadinessFor({
    activeJobCount: derived.activeJobCount,
    authoringModel: input.profileAuthoringModel ?? null,
    canManage: derived.canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt: core.generatedAt,
    profileAuthoring,
    routeContext: core.routeContext,
    selectedProfile: derived.selectedProfile,
  });

  return { profileAuthoring, validationReadiness };
}

// Conflict resolution + lifecycle recovery: the two govern-and-recover slices
// that the action array depends on (lifecycle operation states feed the action
// blockers). Computed before actions in both builders so the dependency order
// mirrors the original single composition. Lifecycle recovery folds in the
// validation readiness slice it shares with the providers surface.
function conflictAndLifecycleSlices(
  input: CatalogPrimaryWorkbenchInput,
  core: CatalogPrimaryWorkbenchCore,
  derived: CatalogPrimaryWorkbenchDerived,
  validationReadiness: CatalogPrimaryWorkbenchReadModel["validationReadiness"],
): Readonly<{
  conflictResolution: CatalogPrimaryWorkbenchReadModel["conflictResolution"];
  lifecycleRecovery: CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"];
}> {
  const conflictResolution = conflictResolutionFor({
    canManage: derived.canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt: core.generatedAt,
    promotionPreview: core.promotionPreview,
    routeContext: core.routeContext,
    sourceObservationReview: core.sourceObservationReview,
    reviewEvidenceByObservationId: core.reviewEvidenceByObservationId,
  });
  const lifecycleRecovery = lifecycleRecoveryFor({
    activeJobCount: derived.activeJobCount,
    activeProfile: derived.activeProfile,
    canManage: derived.canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt: core.generatedAt,
    lifecycleImpacts: input.lifecycleImpacts ?? null,
    profiles: input.profileReviews.items,
    providerKey: derived.providerKey,
    routeContext: core.routeContext,
    selectedProfile: derived.selectedProfile,
    validationReadiness,
  });

  return { conflictResolution, lifecycleRecovery };
}

// Governance controls slice. Built after the action array because the RBAC
// matrix is derived from the resolved action states.
function governanceControlsSlice(
  input: CatalogPrimaryWorkbenchInput,
  core: CatalogPrimaryWorkbenchCore,
  derived: CatalogPrimaryWorkbenchDerived,
  conflictResolution: CatalogPrimaryWorkbenchReadModel["conflictResolution"],
  actions: readonly CatalogPrimaryWorkbenchActionReadModel[],
  healthTriage: CatalogPrimaryWorkbenchReadModel["healthTriage"],
): CatalogPrimaryWorkbenchReadModel["governanceControls"] {
  return governanceControlsFor({
    actions,
    canManage: derived.canManage,
    conflictResolution,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt: core.generatedAt,
    healthTriage,
    importJobs: derived.importJobRows,
    readinessBlockers: derived.readinessBlockers,
    rolloutEnabled: derived.rolloutEnabled,
    routeContext: core.routeContext,
    sourceObservationReview: core.sourceObservationReview,
  });
}

// Health-triage slice (the health route renders it alongside the audit
// timeline). Derived purely from the control plane overview and the core import
// job rows.
function healthTriageSlice(
  input: CatalogPrimaryWorkbenchInput,
  core: CatalogPrimaryWorkbenchCore,
  derived: CatalogPrimaryWorkbenchDerived,
): CatalogPrimaryWorkbenchReadModel["healthTriage"] {
  return healthTriageFor({
    overview: input.controlPlaneOverview,
    routeContext: core.routeContext,
    importJobs: derived.importJobRows,
  });
}

// Audit timeline surface slice (health route). The audit timeline folds in the
// conflict and validation slices whose real events it surfaces, so they are
// passed in.
function healthSurfaceSlices(
  input: CatalogPrimaryWorkbenchInput,
  core: CatalogPrimaryWorkbenchCore,
  derived: CatalogPrimaryWorkbenchDerived,
  cited: Readonly<{
    conflictResolution: CatalogPrimaryWorkbenchReadModel["conflictResolution"];
    healthTriage: CatalogPrimaryWorkbenchReadModel["healthTriage"];
    validationReadiness: CatalogPrimaryWorkbenchReadModel["validationReadiness"];
  }>,
): Readonly<{
  auditEvidence: CatalogPrimaryWorkbenchReadModel["auditEvidence"];
}> {
  const auditEvidence = auditEvidenceFor({
    conflictResolution: cited.conflictResolution,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt: core.generatedAt,
    healthTriage: cited.healthTriage,
    importJobs: derived.importJobRows,
    promotionPreview: core.promotionPreview,
    routeContext: core.routeContext,
    securityPrivacy: core.securityPrivacy,
    sourceObservationReview: core.sourceObservationReview,
    reviewEvidenceByObservationId: core.reviewEvidenceByObservationId,
    validationReadiness: cited.validationReadiness,
  });

  return { auditEvidence };
}

// Assemble a fully-validated read model from the shared core and every surface
// slice, rendering the complete workspace registry. Re-exported from
// primary-workbench-read-model.ts; as of this writing its only callers are
// tests, not a live surface route — confirm before deleting.
export function buildCatalogPrimaryWorkbenchReadModel(
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchReadModel {
  const { core, derived } = buildCatalogPrimaryWorkbenchCore(input);
  const { profileAuthoring, validationReadiness } = providersSurfaceSlices(input, core, derived);
  const healthTriage = healthTriageSlice(input, core, derived);
  const { conflictResolution, lifecycleRecovery } = conflictAndLifecycleSlices(
    input,
    core,
    derived,
    validationReadiness,
  );
  const actions = buildSurfaceActions(core, derived, {
    profileAuthoring,
    validationReadiness,
    lifecycleRecovery,
  });
  const governanceControls = governanceControlsSlice(input, core, derived, conflictResolution, actions, healthTriage);
  const { auditEvidence } = healthSurfaceSlices(input, core, derived, {
    conflictResolution,
    healthTriage,
    validationReadiness,
  });

  return assembleReadModel({
    core,
    actions,
    profileAuthoring,
    validationReadiness,
    healthTriage,
    conflictResolution,
    lifecycleRecovery,
    governanceControls,
    auditEvidence,
  });
}

// Assemble a fully-validated read model for ONE audience surface route, computing
// only the supporting slices that surface renders and substituting cheap default
// slices (no provider-row iteration, no cross-surface inputs) for the rest. The
// daily surface therefore never computes governance, lifecycle, or audit
// sub-models; providers never computes governance/health; and so on. Behavior is
// preserved because each non-rendered slice is identical to what the full builder
// would produce from the same absent inputs.
export function buildCatalogPrimaryWorkbenchReadModelForSurface(
  surface: CatalogControlPlaneRouteSurfaceKey,
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchReadModel {
  const { core, derived } = buildCatalogPrimaryWorkbenchCore(input);

  // Surfaces that fully render (or cite) each supporting slice. The daily surface
  // renders none of them, so it computes every supporting slice from the
  // empty-input defaults below — never iterating provider readiness, lifecycle,
  // governance, health, or audit data. Providers cites nothing downstream;
  // governance and health cite the upstream slices they fold into their evidence.
  const wantsProviderSlices = surface === "providers" || surface === "governance" || surface === "health";
  const wantsHealthTriage = surface === "governance" || surface === "health";
  const wantsGovernanceSlices = surface === "governance" || surface === "health";
  const wantsHealthSlices = surface === "health";

  const sliceInput = (wanted: boolean): CatalogPrimaryWorkbenchInput =>
    wanted ? input : emptyControlPlaneInput(input);
  const providerSliceInput = wantsProviderSlices ? input : emptyProviderSliceInput(input);
  const providerSliceDerived = wantsProviderSlices ? derived : emptyProviderSliceDerived(derived);

  const { profileAuthoring, validationReadiness } = providersSurfaceSlices(
    providerSliceInput,
    core,
    providerSliceDerived,
  );
  const healthTriage = healthTriageSlice(sliceInput(wantsHealthTriage), core, derived);
  const { conflictResolution, lifecycleRecovery } = conflictAndLifecycleSlices(
    sliceInput(wantsGovernanceSlices),
    core,
    derived,
    validationReadiness,
  );
  const actions = buildSurfaceActions(core, derived, {
    profileAuthoring,
    validationReadiness,
    lifecycleRecovery,
  });
  const governanceControls = governanceControlsSlice(
    sliceInput(wantsGovernanceSlices),
    core,
    derived,
    conflictResolution,
    actions,
    healthTriage,
  );
  const { auditEvidence } = healthSurfaceSlices(sliceInput(wantsHealthSlices), core, derived, {
    conflictResolution,
    healthTriage,
    validationReadiness,
  });

  return assembleReadModel({
    core,
    actions,
    profileAuthoring,
    validationReadiness,
    healthTriage,
    conflictResolution,
    lifecycleRecovery,
    governanceControls,
    auditEvidence,
  });
}

// Build ONLY the source-options slice from the same baseline inputs the full
// read model derives from, plus the (now resolved) source-option fan-out pages.
// The daily loader streams this slice behind a Suspense boundary so the shell,
// metric strip, and 3-stage flow paint before the ~150–250 KB option fan-out
// resolves. It reuses the shared core derivation so the populated slice
// is byte-identical to what the synchronous builder would have produced from the
// same pages, and it never re-derives or re-emits the rest of the read model —
// keeping the deferred value small and the browser free of the raw baseline
// inputs the slice was computed from.
export function buildCatalogPrimaryWorkbenchDeferredSourceOptions(
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchReadModel["sourceOptions"] {
  return buildCatalogPrimaryWorkbenchCore(input).core.sourceOptions;
}

// The inputs that are absent on a surface which does not render a slice. With no
// control plane overview, authoring model, lifecycle impacts, or release
// scaffolding present, the supporting slice builders collapse to constant-cost
// defaults that still satisfy the read-model contract — so the daily surface
// assembles a valid read model without ever iterating provider readiness rows for
// governance, lifecycle, release, or audit.
function emptyControlPlaneInput(input: CatalogPrimaryWorkbenchInput): CatalogPrimaryWorkbenchInput {
  return {
    ...input,
    controlPlaneOverview: null,
    profileAuthoringModel: null,
    lifecycleImpacts: null,
  };
}

function emptyProviderSliceInput(input: CatalogPrimaryWorkbenchInput): CatalogPrimaryWorkbenchInput {
  return {
    ...emptyControlPlaneInput(input),
    scopes: { ...input.scopes, items: [], total: 0, count: 0 },
    profileReviews: { ...input.profileReviews, items: [], total: 0, count: 0 },
    reviewObservations: null,
    sourceOptionPages: null,
  };
}

function emptyProviderSliceDerived(derived: CatalogPrimaryWorkbenchDerived): CatalogPrimaryWorkbenchDerived {
  return {
    ...derived,
    activeProfile: null,
    selectedProfile: null,
    requestedProfileVersion: null,
  };
}

function assembleReadModel(
  parts: Readonly<{
    core: CatalogPrimaryWorkbenchCore;
    actions: readonly CatalogPrimaryWorkbenchActionReadModel[];
    profileAuthoring: CatalogPrimaryWorkbenchReadModel["profileAuthoring"];
    validationReadiness: CatalogPrimaryWorkbenchReadModel["validationReadiness"];
    healthTriage: CatalogPrimaryWorkbenchReadModel["healthTriage"];
    conflictResolution: CatalogPrimaryWorkbenchReadModel["conflictResolution"];
    lifecycleRecovery: CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"];
    governanceControls: CatalogPrimaryWorkbenchReadModel["governanceControls"];
    auditEvidence: CatalogPrimaryWorkbenchReadModel["auditEvidence"];
  }>,
): CatalogPrimaryWorkbenchReadModel {
  const { core } = parts;
  const readModel: CatalogPrimaryWorkbenchReadModel = {
    schemaVersion: catalogPrimaryWorkbenchContractVersion,
    generatedAt: core.generatedAt,
    routeContext: core.routeContext,
    providerScope: core.providerScope,
    readiness: core.readiness,
    catalogSync: core.catalogSync,
    sourceScopeWorkset: core.sourceScopeWorkset,
    healthTriage: parts.healthTriage,
    profileAuthoring: parts.profileAuthoring,
    validationReadiness: parts.validationReadiness,
    lifecycleRecovery: parts.lifecycleRecovery,
    governanceControls: parts.governanceControls,
    auditEvidence: parts.auditEvidence,
    importJobs: core.importJobs,
    sourceObservationReview: core.sourceObservationReview,
    mergeCandidateReview: core.mergeCandidateReview,
    conflictResolution: parts.conflictResolution,
    promotionPreview: core.promotionPreview,
    promotionResult: null,
    actions: parts.actions,
    sourceOptions: core.sourceOptions,
    deploySkew: catalogPrimaryWorkbenchDeploySkewPolicies[0],
    securityPrivacy: core.securityPrivacy,
    instrumentation: {
      dimensions: catalogPrimaryWorkbenchInstrumentationDimensions,
      redactionSafe: true,
    },
  };

  validateCatalogPrimaryWorkbenchReadModelContract(readModel);

  return readModel;
}

function buildSurfaceActions(
  core: CatalogPrimaryWorkbenchCore,
  derived: CatalogPrimaryWorkbenchDerived,
  slices: Readonly<{
    profileAuthoring: CatalogPrimaryWorkbenchReadModel["profileAuthoring"];
    validationReadiness: CatalogPrimaryWorkbenchReadModel["validationReadiness"];
    lifecycleRecovery: CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"];
  }>,
): readonly CatalogPrimaryWorkbenchActionReadModel[] {
  return [
    core.catalogSync.action,
    ...buildActions({
      canManage: derived.canManage,
      providerKey: derived.providerKey,
      unitKey: derived.unitKey,
      importScope: derived.importScope,
      activeProfileReady: Boolean(derived.activeProfile),
      eligible: core.promotionPreview.outcomeCounts.eligible,
      reviewable: core.sourceObservationReview.counts.observed + core.sourceObservationReview.counts.changed,
      reviewFreshness: core.sourceObservationReview.freshness,
      mergeCandidateReviewFreshness: core.mergeCandidateReview.freshness,
      mergeCandidateRows: core.mergeCandidateReview.counts.total,
      activeJobCount: derived.activeJobCount,
      blockers: derived.readinessBlockers,
      activationBlockers: slices.validationReadiness.activationDecision.blockers,
      cloneProfileBlockers: slices.profileAuthoring.cloneDraft.blockers,
      lifecycleOperations: slices.lifecycleRecovery.operations,
      promotionBlockers: core.promotionPreview.blockers,
    }),
  ];
}

function inferProviderKey(input: CatalogPrimaryWorkbenchInput): string | null {
  return (
    input.scopes.items[0]?.provider_key ??
    input.profileReviews.items.find((profile) => profile.active)?.providerKey ??
    input.profileReviews.items[0]?.providerKey ??
    null
  );
}

function inferUnitKey(
  input: CatalogPrimaryWorkbenchInput,
  providerKey: string | null,
  activeProfile: CatalogProviderProfileVersionReview | null,
): CatalogIntegrationUnitKey | null {
  if (activeProfile?.ingestionUnitKey) {
    return activeProfile.ingestionUnitKey as CatalogIntegrationUnitKey;
  }

  const overviewUnits =
    input.controlPlaneOverview?.readiness.units.filter((unit) => unit.providerKey === providerKey) ?? [];
  if (overviewUnits.length === 1) {
    return overviewUnits[0]?.unitKey ?? null;
  }
  if (overviewUnits.length > 1) {
    return null;
  }
  if (!providerKey) {
    return null;
  }
  const providerProfiles = input.profileReviews.items.filter((profile) => profile.providerKey === providerKey);
  const profileUnitKeys = uniqueProfileUnitKeys(providerProfiles);
  if (profileUnitKeys.size > 1) {
    return null;
  }
  const supportedScope = activeProfile?.supportedScopes[0] ?? "catalog/source-observation";
  const [productDomain = "catalog", productForm = "source-observation"] = supportedScope.split("/");

  return defineCatalogIntegrationUnitKey({
    providerKey,
    productDomain: normalizeUnitSegment(productDomain),
    productForm: normalizeUnitSegment(productForm),
    ingestionPurpose: "import",
  });
}

function normalizeSelectedUnitKey(
  unitKey: CatalogIntegrationUnitKey | null,
  providerKey: string | null,
): CatalogIntegrationUnitKey | null {
  if (!unitKey) {
    return null;
  }
  if (!providerKey) {
    return unitKey;
  }

  try {
    return parseCatalogIntegrationUnitKey(unitKey).providerKey === providerKey ? unitKey : null;
  } catch {
    return null;
  }
}

function providerOnlyScopeContext(providerKey: string | null): CatalogPrimaryWorkbenchRouteContext["scope"] {
  return {
    providerKey,
    languageCode: null,
    productLineId: null,
    productLineName: null,
    seriesId: null,
    seriesName: null,
    expansionId: null,
    expansionName: null,
    status: null,
  };
}

function requestHasStructuredImportScopeSelection(requestUrl: string | URL): boolean {
  const searchParams = new URL(requestUrl, "https://admin.example").searchParams;
  const structuredScopeKeys = [
    "language",
    "languageCode",
    "productLineId",
    "productLineName",
    "seriesId",
    "seriesName",
    "expansionId",
    "expansionName",
    "setId",
    "setName",
  ];

  return structuredScopeKeys.some((key) => Boolean(searchParams.get(key)?.trim()));
}

function requestHasExplicitLanguageScopeSelection(requestUrl: string | URL): boolean {
  const searchParams = new URL(requestUrl, "https://admin.example").searchParams;
  return Boolean(searchParams.get("language")?.trim() || searchParams.get("languageCode")?.trim());
}

function selectedProviderScopeRows(input: {
  explicitStructuredScope: boolean;
  importScope: string | null;
  providerScopeRows: readonly SourceObservationIntegrationScope[];
  routeScope: CatalogPrimaryWorkbenchRouteContext["scope"];
}): readonly SourceObservationIntegrationScope[] {
  if (!input.importScope) {
    return input.providerScopeRows;
  }

  const compactExpansionImportScope = input.importScope.split(":").filter(Boolean).length === 2;
  return input.providerScopeRows.filter(
    (scope) =>
      importScopeMatchesProviderScope(input.importScope, scope) ||
      (compactExpansionImportScope && input.explicitStructuredScope && input.routeScope
        ? compactExpansionRouteScopeMatchesProviderScope(input.routeScope, scope)
        : false),
  );
}

function structuredSelectionImportScope(
  importScope: string | null,
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
  explicitStructuredScope: boolean,
): string | null {
  if (!explicitStructuredScope || !importScope || importScopeMatchesStructuredSelection(importScope, scope)) {
    return importScope;
  }

  return importScopeFromScopeContext(scope);
}

function structuredScopeWithProfileLanguage(
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
  activeProfile: CatalogProviderProfileVersionReview | null,
  providerScopeRows: readonly SourceObservationIntegrationScope[],
  explicitStructuredScope: boolean,
): CatalogPrimaryWorkbenchRouteContext["scope"] {
  const structuredSetScope = Boolean(!scope?.seriesId && (scope?.expansionId || scope?.expansionName));
  const includesProductLineParent = Boolean(scope?.productLineId || scope?.productLineName);
  const sourceOptionScopes = new Set(sourceOptionKindsForProfile(activeProfile).map((kind) => kind.scope));
  const canSelectStructuredSet =
    sourceOptionScopes.size === 0 || sourceOptionScopes.has("expansion") || sourceOptionScopes.has("set-name");
  if (
    !explicitStructuredScope ||
    !scope ||
    scope.languageCode ||
    !structuredSetScope ||
    (!includesProductLineParent && !canSelectStructuredSet)
  ) {
    return scope;
  }
  const languageCode =
    providerScopeLanguageForStructuredSet(scope, providerScopeRows) ??
    (activeProfile?.languageOptions.length === 1 ? (activeProfile.languageOptions[0]?.trim() ?? null) : null);
  if (!languageCode) {
    return scope;
  }

  return { ...scope, languageCode };
}

function providerScopeLanguageForStructuredSet(
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
  providerScopeRows: readonly SourceObservationIntegrationScope[],
): string | null {
  if (!scope) {
    return null;
  }

  const languages = new Set(
    providerScopeRows
      .filter((row) => providerScopeMatchesStructuredSet(row, scope))
      .map((row) => row.language_code.trim())
      .filter(Boolean),
  );

  return languages.size === 1 ? (Array.from(languages)[0] ?? null) : null;
}

function providerScopeMatchesStructuredSet(
  row: SourceObservationIntegrationScope,
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
): boolean {
  if (!scope || row.provider_key !== scope.providerKey) {
    return false;
  }

  return (
    optionalScopeSegmentMatches(row.product_line_id, scope.productLineId) &&
    optionalScopeSegmentMatches(row.product_line_name, scope.productLineName) &&
    optionalScopeSegmentMatches(row.series_id, scope.seriesId) &&
    optionalScopeSegmentMatches(row.series_name, scope.seriesName) &&
    pairedScopeSegmentMatches(row.expansion_id, row.expansion_name, scope.expansionId, scope.expansionName)
  );
}

function optionalScopeSegmentMatches(rowValue: string, selectedValue: string | null | undefined): boolean {
  return !selectedValue || normalizedScopeSegment(rowValue) === normalizedScopeSegment(selectedValue);
}

function pairedScopeSegmentMatches(
  rowId: string,
  rowName: string,
  selectedId: string | null | undefined,
  selectedName: string | null | undefined,
): boolean {
  const rowSegments = new Set([rowId, rowName].map(normalizedScopeSegment).filter(Boolean));
  return Boolean(
    (selectedId && rowSegments.has(normalizedScopeSegment(selectedId))) ||
    (selectedName && rowSegments.has(normalizedScopeSegment(selectedName))),
  );
}

function legacyImportScopeConflictsWithSelectedProvider(input: {
  requestUrl: string | URL;
  importScope: string | null;
  scope: CatalogPrimaryWorkbenchRouteContext["scope"];
  providerKey: string | null;
  unitKey: CatalogIntegrationUnitKey | null;
  activeProfile: CatalogProviderProfileVersionReview | null;
  scopes: readonly SourceObservationIntegrationScope[];
  explicitStructuredScope: boolean;
  unitContextMismatch: boolean;
}): boolean {
  if (input.unitContextMismatch || !input.providerKey || (!input.importScope && !input.explicitStructuredScope)) {
    return false;
  }

  const hasSourceOptionIntent = requestHasSourceOptionIntent(input.requestUrl);
  if (!hasSourceOptionIntent) {
    return false;
  }

  // A source-option refresh for an explicit unit must never keep an old
  // provider-level importScope when the matching option profile cannot drive
  // source-option scope selection. That scope is only legacy route state;
  // preserving it leaks a previous product line into review queries before the
  // operator can pick a fresh guided scope.
  if (!input.activeProfile || sourceOptionKindsForProfile(input.activeProfile).length === 0) {
    return Boolean(input.unitKey && input.importScope);
  }

  if (
    input.importScope &&
    !input.explicitStructuredScope &&
    legacyImportScopeConflictsWithSelectedProviderScope({
      importScope: input.importScope,
      providerKey: input.providerKey,
      unitKey: input.unitKey,
      scopes: input.scopes,
    })
  ) {
    return true;
  }

  return sourceOptionProfileCannotSelectScope(input.activeProfile, input.scope);
}

function requestHasSourceOptionIntent(requestUrl: string | URL): boolean {
  return Boolean(new URL(requestUrl, "https://admin.example").searchParams.get("sourceOptionAction")?.trim());
}

function legacyImportScopeConflictsWithSelectedProviderScope(input: {
  importScope: string;
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey | null;
  scopes: readonly SourceObservationIntegrationScope[];
}): boolean {
  const matchingScopes = input.scopes.filter(
    (scope) => scope.provider_key === input.providerKey && importScopeMatchesProviderScope(input.importScope, scope),
  );
  if (matchingScopes.length === 0) {
    return true;
  }
  if (!input.unitKey) {
    return false;
  }
  const unitKey = input.unitKey;

  return !matchingScopes.some((scope) => !sourceObservationScopeProductLineConflictsWithUnit(scope, unitKey));
}

function sourceObservationScopeProductLineConflictsWithUnit(
  scope: SourceObservationIntegrationScope,
  unitKey: CatalogIntegrationUnitKey,
): boolean {
  const unitProductDomain = productDomainFromIntegrationUnitKey(unitKey);
  const scopeProductDomain = productDomainFromIntegrationScope(scope);

  return Boolean(unitProductDomain && scopeProductDomain && unitProductDomain !== scopeProductDomain);
}

function productDomainFromIntegrationUnitKey(unitKey: CatalogIntegrationUnitKey): string | null {
  try {
    return normalizeDomainSegment(parseCatalogIntegrationUnitKey(unitKey).productDomain);
  } catch {
    return null;
  }
}

function productDomainFromIntegrationScope(scope: SourceObservationIntegrationScope): string | null {
  return (
    tcgplayerProductLineDomain(scope.product_line_id) ??
    productDomainFromProductLineName(scope.product_line_name) ??
    productDomainFromProductLineId(scope.product_line_id)
  );
}

function tcgplayerProductLineDomain(productLineId: string): string | null {
  switch (productLineId.trim()) {
    case "1":
      return "mtg";
    case "2":
      return "yugioh";
    case "3":
      return "pokemon";
    default:
      return null;
  }
}

function productDomainFromProductLineName(productLineName: string): string | null {
  const normalized = productLineName.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("pokemon")) {
    return "pokemon";
  }
  if (normalized.includes("magic") || normalized.includes("mtg")) {
    return "mtg";
  }
  if (normalized.includes("yu-gi-oh") || normalized.includes("yugioh")) {
    return "yugioh";
  }

  return null;
}

function productDomainFromProductLineId(productLineId: string): string | null {
  const normalized = normalizeDomainSegment(productLineId);
  if (!normalized || /^\d+$/.test(normalized)) {
    return null;
  }

  return productDomainFromProductLineName(normalized) ?? normalized;
}

function normalizeDomainSegment(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function sourceOptionProfileCannotSelectScope(
  profile: CatalogProviderProfileVersionReview | null,
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
): boolean {
  if (!profile || !scope) {
    return false;
  }

  const selectableScopes = new Set(sourceOptionKindsForProfile(profile).map((kind) => kind.scope));
  if (selectableScopes.size === 0) {
    return false;
  }

  return (
    (Boolean(scope.productLineId || scope.productLineName) && !selectableScopes.has("product-line/category")) ||
    (Boolean(scope.seriesId || scope.seriesName) && !selectableScopes.has("series")) ||
    (Boolean(scope.expansionId || scope.expansionName) &&
      !selectableScopes.has("expansion") &&
      !selectableScopes.has("set-name"))
  );
}

function sanitizeScopeForSourceOptionProfile(
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
  profile: CatalogProviderProfileVersionReview | null,
  providerKey: string | null,
  explicitLanguageScope: boolean,
): CatalogPrimaryWorkbenchRouteContext["scope"] {
  if (!profile || !scope || sourceOptionKindsForProfile(profile).length === 0) {
    return providerOnlyScopeContext(providerKey);
  }

  const selectableScopes = new Set(sourceOptionKindsForProfile(profile).map((kind) => kind.scope));
  const supportsSetName = selectableScopes.has("set-name");
  const expansionIdIsSetNameSelection = supportsSetName && !scope.expansionName && !scope.seriesId && !scope.seriesName;

  return {
    providerKey,
    languageCode: explicitLanguageScope ? (scope.languageCode ?? null) : null,
    productLineId:
      selectableScopes.has("product-line/category") || supportsSetName ? (scope.productLineId ?? null) : null,
    productLineName:
      selectableScopes.has("product-line/category") || supportsSetName ? (scope.productLineName ?? null) : null,
    seriesId: selectableScopes.has("series") ? (scope.seriesId ?? null) : null,
    seriesName: selectableScopes.has("series") ? (scope.seriesName ?? null) : null,
    expansionId:
      selectableScopes.has("expansion") || expansionIdIsSetNameSelection ? (scope.expansionId ?? null) : null,
    expansionName: selectableScopes.has("expansion") || supportsSetName ? (scope.expansionName ?? null) : null,
    status: scope.status ?? null,
  };
}

function importScopeMatchesStructuredSelection(
  importScope: string,
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
): boolean {
  const segments = new Set(importScope.split(":").map(normalizedScopeSegment).filter(Boolean));
  const optionalSegmentMatches = (value: string | null | undefined) =>
    !value || segments.has(normalizedScopeSegment(value));
  const requiredSegmentMatches = (value: string | null | undefined) =>
    Boolean(value && segments.has(normalizedScopeSegment(value)));
  const pairMatches = (left: string | null | undefined, right: string | null | undefined) =>
    !left && !right ? true : requiredSegmentMatches(left) || requiredSegmentMatches(right);

  if (!optionalSegmentMatches(scope?.languageCode)) {
    return false;
  }
  if (scope?.expansionId || scope?.expansionName) {
    return pairMatches(scope.expansionId, scope.expansionName);
  }
  if (scope?.seriesId || scope?.seriesName) {
    return pairMatches(scope.seriesId, scope.seriesName);
  }
  if (scope?.productLineId || scope?.productLineName) {
    return pairMatches(scope.productLineId, scope.productLineName);
  }

  return true;
}

function normalizedScopeSegment(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function sourceObservationFiltersForRouteContext(input: {
  parsedFilters: Readonly<Record<string, string>>;
  providerKey: string | null;
  importScope: string | null;
  explicitStructuredScope: boolean;
  discardParsedImportScope: boolean;
}): Readonly<Record<string, string>> {
  const filters = { ...input.parsedFilters };
  if (input.importScope || input.explicitStructuredScope || input.discardParsedImportScope) {
    delete filters.importScope;
  }
  if (input.providerKey) {
    filters.providerKey = input.providerKey;
  }
  if (input.importScope) {
    filters.importScope = input.importScope;
  }

  return filters;
}

function inferImportScope(
  scopes: readonly SourceObservationIntegrationScope[],
  providerKey: string | null,
): string | null {
  const scope = scopes.find((candidate) => !providerKey || candidate.provider_key === providerKey) ?? scopes[0];
  if (!scope) {
    return null;
  }

  return [scope.language_code, scope.product_line_id, scope.series_id, scope.expansion_id].filter(Boolean).join(":");
}

function findActiveProfile(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string | null,
  unitKey: CatalogIntegrationUnitKey | null = null,
): CatalogProviderProfileVersionReview | null {
  const providerProfiles = providerKey ? profiles.filter((profile) => profile.providerKey === providerKey) : profiles;
  const activeProfiles = providerProfiles.filter(
    (profile) => profile.active && profileMatchesUnit(profile, unitKey, providerProfiles),
  );

  if (!unitKey && uniqueProfileUnitKeys(activeProfiles).size > 1) {
    return null;
  }

  return activeProfiles[0] ?? null;
}

function providerHasMultipleActiveProfileUnits(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string,
): boolean {
  const activeProfiles = profiles.filter((profile) => profile.providerKey === providerKey && profile.active);
  return uniqueProfileUnitKeys(activeProfiles).size > 1;
}

function findSelectedProfile(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string | null,
  requestedProfileVersion: string | null,
  unitKey: CatalogIntegrationUnitKey | null,
  activeProfile: CatalogProviderProfileVersionReview | null,
): CatalogProviderProfileVersionReview | null {
  const providerProfiles = providerKey ? profiles.filter((profile) => profile.providerKey === providerKey) : profiles;
  if (requestedProfileVersion) {
    return (
      providerProfiles.find(
        (profile) =>
          profile.profileVersion === requestedProfileVersion && profileMatchesUnit(profile, unitKey, providerProfiles),
      ) ??
      profiles.find(
        (profile) =>
          profile.profileVersion === requestedProfileVersion &&
          !providerKey &&
          profileMatchesUnit(profile, unitKey, profiles),
      ) ??
      null
    );
  }

  return activeProfile ?? providerProfiles[0] ?? (providerKey ? null : (profiles[0] ?? null));
}

function profileMatchesUnit(
  profile: CatalogProviderProfileVersionReview,
  unitKey: CatalogIntegrationUnitKey | null,
  providerProfiles: readonly CatalogProviderProfileVersionReview[],
): boolean {
  if (!unitKey || profile.ingestionUnitKey === unitKey) {
    return true;
  }

  const normalizedProviderKey = profile.providerKey.trim().toLowerCase();
  const unitIdentities = new Set(
    providerProfiles
      .filter((candidate) => candidate.providerKey.trim().toLowerCase() === normalizedProviderKey)
      .map((candidate) => candidate.ingestionUnitKey.trim().toLowerCase()),
  );

  return unitIdentities.size <= 1 && unitKey.trim().toLowerCase().startsWith(`${normalizedProviderKey}:`);
}

function uniqueProfileUnitKeys(profiles: readonly CatalogProviderProfileVersionReview[]): ReadonlySet<string> {
  return new Set(
    profiles.map((profile) => profile.ingestionUnitKey.trim().toLowerCase()).filter((unitKey) => unitKey.length > 0),
  );
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

function buildActions(input: {
  canManage: boolean;
  providerKey: string | null;
  unitKey: string | null;
  importScope: string | null;
  activeProfileReady: boolean;
  eligible: number;
  reviewable: number;
  reviewFreshness: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["freshness"];
  mergeCandidateReviewFreshness: CatalogPrimaryWorkbenchReadModel["mergeCandidateReview"]["freshness"];
  mergeCandidateRows: number;
  activeJobCount: number;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  activationBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  cloneProfileBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  lifecycleOperations: readonly LifecycleOperationRow[];
  promotionBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}): readonly CatalogPrimaryWorkbenchActionReadModel[] {
  const manageState = input.canManage ? "available" : "denied";
  const importBlockers = importBlockersForSelectedScope(input);
  const reviewReadModelBlockers = reviewReadModelBlockersFor(input.reviewFreshness);
  const previewBlockers =
    reviewReadModelBlockers.length > 0
      ? reviewReadModelBlockers
      : input.eligible > 0
        ? []
        : (["no-promotion-eligible-observations"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const previewState = actionStateForBlockers(previewBlockers, manageState);
  const promotionBlockers = input.promotionBlockers;
  const promotionState = actionStateForBlockers(promotionBlockers, manageState);
  const reviewDecisionBlockers =
    reviewReadModelBlockers.length > 0
      ? reviewReadModelBlockers
      : input.reviewable > 0
        ? []
        : (["selection-empty"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const reviewDecisionState = actionStateForBlockers(reviewDecisionBlockers, manageState);
  const mergeCandidateCommandBlockers = mergeCandidateCommandBlockersFor(
    input.mergeCandidateReviewFreshness,
    input.mergeCandidateRows,
  );
  const mergeCandidateCommandState = actionStateForBlockers(mergeCandidateCommandBlockers, manageState);
  const reapplyBlockers = input.activeProfileReady
    ? []
    : (["profile-version-missing"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const reapplyState = actionStateForBlockers(reapplyBlockers, manageState);
  const replayBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] = [];
  const replayState = actionStateForBlockers(replayBlockers, manageState);
  const cloneProfileState = actionStateForBlockers(input.cloneProfileBlockers, manageState);
  const activationState = actionStateForBlockers(input.activationBlockers, manageState);
  const lifecycleOperationByCommand = new Map(
    input.lifecycleOperations.map((operation) => [operation.commandKey, operation]),
  );

  return [
    {
      key: "select-provider-scope",
      state: "available",
      blockers: [],
      copyKey: null,
    },
    {
      key: "start-provider-import",
      state: importBlockers.length > 0 ? "blocked" : manageState,
      blockers: importBlockers,
      copyKey:
        importBlockers.length > 0
          ? importBlockers.some(isProviderScopeBlocker)
            ? "catalog.primary.providerScope.required"
            : "catalog.primary.import.blocked"
          : null,
    },
    {
      key: "select-source-observations",
      state: "available",
      blockers: [],
      copyKey: null,
    },
    {
      key: "clone-provider-profile",
      state: cloneProfileState,
      blockers: input.cloneProfileBlockers,
      copyKey:
        input.cloneProfileBlockers.length > 0
          ? input.cloneProfileBlockers.includes("permission-denied")
            ? "catalog.primary.import.denied"
            : input.cloneProfileBlockers.includes("profile-version-missing")
              ? "catalog.primary.reapply.originalProfileMissing"
              : "catalog.primary.import.blocked"
          : null,
    },
    {
      key: "activate-provider-profile",
      state: activationState,
      blockers: input.activationBlockers,
      copyKey: input.activationBlockers.length > 0 ? "catalog.primary.import.blocked" : null,
    },
    lifecycleAction("rollback-provider-profile", lifecycleOperationByCommand, manageState),
    lifecycleAction("deprecate-provider-profile", lifecycleOperationByCommand, manageState),
    lifecycleAction("retire-provider-profile", lifecycleOperationByCommand, manageState),
    {
      key: "preview-promotion",
      state: previewState,
      blockers: previewBlockers,
      copyKey:
        previewBlockers.length > 0
          ? previewBlockers.some(isReviewReadModelBlocker)
            ? "catalog.primary.review.blocked"
            : "catalog.primary.review.empty"
          : null,
    },
    {
      key: "execute-promotion",
      state: promotionState,
      blockers: promotionBlockers,
      copyKey: promotionBlockers.length > 0 ? "catalog.primary.promotion.previewRequired" : null,
    },
    {
      key: "reject-source-observations",
      state: reviewDecisionState,
      blockers: reviewDecisionBlockers,
      copyKey:
        reviewDecisionBlockers.length > 0
          ? reviewDecisionBlockers.some(isReviewReadModelBlocker)
            ? "catalog.primary.review.blocked"
            : "catalog.primary.review.empty"
          : null,
    },
    {
      key: "defer-source-observations",
      state: reviewDecisionState,
      blockers: reviewDecisionBlockers,
      copyKey:
        reviewDecisionBlockers.length > 0
          ? reviewDecisionBlockers.some(isReviewReadModelBlocker)
            ? "catalog.primary.review.blocked"
            : "catalog.primary.review.empty"
          : null,
    },
    {
      key: "promote-merge-candidate",
      state: mergeCandidateCommandState,
      blockers: mergeCandidateCommandBlockers,
      copyKey: mergeCandidateCommandBlockers.length > 0 ? "catalog.primary.review.blocked" : null,
    },
    {
      key: "split-merge-candidate",
      state: mergeCandidateCommandState,
      blockers: mergeCandidateCommandBlockers,
      copyKey: mergeCandidateCommandBlockers.length > 0 ? "catalog.primary.review.blocked" : null,
    },
    {
      key: "update-merge-candidate",
      state: mergeCandidateCommandState,
      blockers: mergeCandidateCommandBlockers,
      copyKey: mergeCandidateCommandBlockers.length > 0 ? "catalog.primary.review.blocked" : null,
    },
    {
      key: "ignore-merge-candidate",
      state: mergeCandidateCommandState,
      blockers: mergeCandidateCommandBlockers,
      copyKey: mergeCandidateCommandBlockers.length > 0 ? "catalog.primary.review.blocked" : null,
    },
    {
      key: "defer-merge-candidate",
      state: mergeCandidateCommandState,
      blockers: mergeCandidateCommandBlockers,
      copyKey: mergeCandidateCommandBlockers.length > 0 ? "catalog.primary.review.blocked" : null,
    },
    {
      key: "start-reapply",
      state: reapplyState,
      blockers: reapplyBlockers,
      copyKey: reapplyBlockers.length > 0 ? "catalog.primary.reapply.originalProfileMissing" : null,
    },
    {
      key: "start-replay",
      state: replayState,
      blockers: replayBlockers,
      copyKey: null,
    },
  ];
}

function importBlockersForSelectedScope(input: {
  canManage: boolean;
  providerKey: string | null;
  unitKey: string | null;
  importScope: string | null;
  activeProfileReady: boolean;
  activeJobCount: number;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!input.canManage) {
    blockers.add("permission-denied");
    return [...blockers];
  }

  if (!input.providerKey) {
    blockers.add("provider-selection-required");
  }
  if (!input.unitKey) {
    blockers.add("unit-selection-required");
  }
  if (!input.importScope) {
    blockers.add("import-scope-required");
  }
  if (!input.activeProfileReady) {
    blockers.add("missing-active-profile");
  }

  if (blockers.size === 0) {
    for (const blocker of input.blockers) {
      blockers.add(blocker);
    }
    if (input.activeJobCount > 0) {
      blockers.add("active-job-conflict");
    }
    if (input.activeJobCount > 1) {
      blockers.add("concurrent-job");
    }
  }

  return [...blockers];
}

function isProviderScopeBlocker(blocker: CatalogPrimaryWorkbenchBlockerCategory): boolean {
  return (
    blocker === "provider-selection-required" ||
    blocker === "unit-selection-required" ||
    blocker === "import-scope-required"
  );
}

function lifecycleAction(
  key: Extract<
    CatalogPrimaryWorkbenchActionReadModel["key"],
    "rollback-provider-profile" | "deprecate-provider-profile" | "retire-provider-profile"
  >,
  operations: ReadonlyMap<LifecycleOperationRow["commandKey"], LifecycleOperationRow>,
  manageState: CatalogPrimaryWorkbenchActionReadModel["state"],
): CatalogPrimaryWorkbenchActionReadModel {
  const operation = operations.get(key);
  const blockers = operation?.blockers ?? (["profile-version-missing"] as const);

  return {
    key,
    state: operation?.state ?? actionStateForBlockers(blockers, manageState),
    blockers,
    copyKey: blockers.length > 0 ? "catalog.primary.reapply.originalProfileMissing" : null,
  };
}

function actionStateForBlockers(
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
  stateWhenUnblocked: CatalogPrimaryWorkbenchActionReadModel["state"],
): CatalogPrimaryWorkbenchActionReadModel["state"] {
  if (blockers.length === 0) {
    return stateWhenUnblocked;
  }
  if (blockers.includes("permission-denied") || blockers.includes("authorization-denied")) {
    return "denied";
  }
  if (blockers.includes("read-model-unavailable")) {
    return "unavailable";
  }
  if (blockers.every((blocker) => blocker === "selection-empty" || blocker === "no-promotion-eligible-observations")) {
    return "disabled";
  }
  if (blockers.includes("security-privacy-blocked")) {
    return "unsafe";
  }

  return "blocked";
}

function reviewReadModelBlockersFor(
  freshness: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["freshness"],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  switch (freshness) {
    case "unavailable":
      return ["read-model-unavailable"];
    case "fresh":
    case "stale":
    case "lagging":
    case "partial":
      return [];
  }
}

function mergeCandidateCommandBlockersFor(
  freshness: CatalogPrimaryWorkbenchReadModel["mergeCandidateReview"]["freshness"],
  rowCount: number,
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  if (freshness === "unavailable") {
    return ["read-model-unavailable"];
  }

  return rowCount > 0 ? [] : ["selection-empty"];
}

function isReviewReadModelBlocker(blocker: CatalogPrimaryWorkbenchBlockerCategory): boolean {
  return (
    blocker === "read-model-unavailable" || blocker === "read-model-partial" || blocker === "source-projection-stale"
  );
}

function providerScopeProviders(
  input: CatalogPrimaryWorkbenchInput,
  selectedProviderKey: string | null,
  selectedProfile: CatalogProviderProfileVersionReview | null,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): CatalogPrimaryWorkbenchReadModel["providerScope"]["providers"] {
  const providerKeys = new Set<string>();
  for (const scope of input.scopes.items) {
    providerKeys.add(scope.provider_key);
  }
  for (const profile of input.profileReviews.items) {
    providerKeys.add(profile.providerKey);
  }
  for (const provider of input.controlPlaneOverview?.providerReadiness.providers ?? []) {
    if (providerReadinessHasImportUnit(provider, input.controlPlaneOverview?.readiness.units ?? [])) {
      providerKeys.add(provider.providerKey);
    }
  }
  if (selectedProviderKey) {
    providerKeys.add(selectedProviderKey);
  }

  return [...providerKeys].sort().map((providerKey) => {
    const providerProfiles = input.profileReviews.items.filter((profile) => profile.providerKey === providerKey);
    const profile =
      providerKey === selectedProviderKey ? selectedProfile : findActiveProfile(providerProfiles, providerKey);
    const providerScopes = input.scopes.items.filter((scope) => scope.provider_key === providerKey);
    const providerReadiness = input.controlPlaneOverview?.providerReadiness.providers.find(
      (provider) => provider.providerKey === providerKey,
    );
    const readinessUnits = (
      input.controlPlaneOverview?.readiness.units.filter(
        (unit) =>
          unit.providerKey === providerKey &&
          (!providerReadiness ||
            providerReadiness.unitKeys.length === 0 ||
            providerReadiness.unitKeys.includes(unit.unitKey)),
      ) ?? []
    ).filter((unit) => unit.ingestionPurpose !== "source-observation-proof");
    const visibleProfiles = uniqueProfilesByUnit([...providerProfiles, ...(profile ? [profile] : [])]);
    const unitsByKey = new Map<
      string,
      CatalogPrimaryWorkbenchReadModel["providerScope"]["providers"][number]["units"][number]
    >();

    for (const unitProfile of visibleProfiles) {
      const unitKey = unitProfile.ingestionUnitKey as CatalogIntegrationUnitKey;
      const readinessUnit = readinessUnits.find((unit) => unit.unitKey === unitKey) ?? null;
      const unitShape = integrationUnitShape(unitKey, unitProfile, readinessUnit);
      unitsByKey.set(unitKey, {
        unitKey,
        productDomain: unitShape.productDomain,
        productForm: unitShape.productForm,
        importScopes: providerImportScopes(providerScopes, routeContext.importScope, providerKey),
        activeProfile: profilePointerForProfile(unitProfile),
      });
    }

    for (const readinessUnit of readinessUnits) {
      if (!unitsByKey.has(readinessUnit.unitKey)) {
        unitsByKey.set(readinessUnit.unitKey, {
          unitKey: readinessUnit.unitKey,
          productDomain: readinessUnit.productDomain,
          productForm: readinessUnit.productForm,
          importScopes: providerImportScopes(providerScopes, routeContext.importScope, providerKey),
          activeProfile: profilePointerForProfile(
            visibleProfiles.find((candidate) => candidate.ingestionUnitKey === readinessUnit.unitKey) ?? null,
          ),
        });
      }
    }

    if (unitsByKey.size === 0) {
      const unitKey =
        inferUnitKey(input, providerKey, profile) ??
        defineCatalogIntegrationUnitKey({
          providerKey,
          productDomain: "catalog",
          productForm: "source-observation",
          ingestionPurpose: "import",
        });
      const unitShape = integrationUnitShape(unitKey, profile, null);
      unitsByKey.set(unitKey, {
        unitKey,
        productDomain: unitShape.productDomain,
        productForm: unitShape.productForm,
        importScopes: providerImportScopes(providerScopes, routeContext.importScope, providerKey),
        activeProfile: profilePointerForProfile(profile),
      });
    }

    return {
      providerKey,
      displayName: providerDisplayName(providerKey, providerProfiles, profile, readinessUnits),
      units: [...unitsByKey.values()].sort((left, right) => left.unitKey.localeCompare(right.unitKey)),
    };
  });
}

function uniqueProfilesByUnit(
  profiles: readonly CatalogProviderProfileVersionReview[],
): readonly CatalogProviderProfileVersionReview[] {
  const byUnit = new Map<string, CatalogProviderProfileVersionReview>();
  for (const profile of profiles) {
    byUnit.set(profile.ingestionUnitKey, profile);
  }

  return [...byUnit.values()];
}

function integrationUnitShape(
  unitKey: CatalogIntegrationUnitKey,
  profile: CatalogProviderProfileVersionReview | null,
  readinessUnit: CatalogIntegrationControlPlaneUnitReadiness | null,
): Readonly<{ productDomain: string; productForm: string }> {
  try {
    const parsed = parseCatalogIntegrationUnitKey(unitKey);
    return { productDomain: parsed.productDomain, productForm: parsed.productForm };
  } catch {
    const [profileProductDomain, profileProductForm] = profile?.supportedScopes[0]?.split("/") ?? [];
    return {
      productDomain: readinessUnit?.productDomain ?? profileProductDomain ?? "catalog",
      productForm: readinessUnit?.productForm ?? profileProductForm ?? "source-observation",
    };
  }
}

function providerDisplayName(
  providerKey: string,
  providerProfiles: readonly CatalogProviderProfileVersionReview[],
  selectedProfile: CatalogProviderProfileVersionReview | null,
  readinessUnits: readonly CatalogIntegrationControlPlaneUnitReadiness[],
): string {
  const activeProfiles = providerProfiles.filter((profile) => profile.active);
  if (activeProfiles.length <= 1) {
    return (
      selectedProfile?.displayName ??
      activeProfiles[0]?.displayName ??
      providerProfiles[0]?.displayName ??
      readinessUnits[0]?.displayName ??
      providerBaseDisplayName(providerKey)
    );
  }

  return providerBaseDisplayName(providerKey);
}

function providerBaseDisplayName(providerKey: string): string {
  const names = new Map([
    ["mtgjson", "MTGJSON"],
    ["scryfall", "Scryfall"],
    ["scrydex", "Scrydex"],
    ["tcgdex", "TCGdex"],
    ["tcgplayer", "TCGplayer"],
  ]);

  return names.get(providerKey) ?? providerKey;
}

function providerReadinessHasImportUnit(
  provider: CatalogIntegrationProviderReadiness,
  units: readonly CatalogIntegrationControlPlaneUnitReadiness[],
): boolean {
  return units.some(
    (unit) =>
      unit.providerKey === provider.providerKey &&
      (unit.ingestionPurpose === "import" || unit.ingestionPurpose === "source-observation-import") &&
      (provider.unitKeys.length === 0 || provider.unitKeys.includes(unit.unitKey)),
  );
}

function providerImportScopes(
  scopes: readonly SourceObservationIntegrationScope[],
  selectedImportScope: string | null,
  providerKey: string | null,
): readonly string[] {
  const maxProviderScopeOptions = 25;
  const selectedComparable = comparableImportScopeKey(selectedImportScope, providerKey);
  const selected = scopes.find(
    (scope) => comparableImportScopeKey(providerScopeValue(scope), providerKey) === selectedComparable,
  );
  const values = [
    ...(selectedImportScope ? [selectedImportScope] : []),
    ...(selected ? [providerScopeValue(selected)] : []),
    ...scopes.map(providerScopeValue),
  ];

  return [...new Set(values.filter(Boolean))].slice(0, maxProviderScopeOptions);
}

function providerScopeValue(scope: SourceObservationIntegrationScope): string {
  return [scope.language_code, scope.product_line_id, scope.series_id, scope.expansion_id].filter(Boolean).join(":");
}
