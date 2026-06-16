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
import { defineCatalogIntegrationUnitKey, type CatalogIntegrationUnitKey } from "../api/integration-unit";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import type { CatalogProviderProfileVersionReview, SourceObservationIntegrationScope } from "./contracts";
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
  sum,
} from "./primary-workbench-read-model-support";
import { profileAuthoringFor } from "./primary-workbench-profile-authoring";
import { healthTriageFor } from "./primary-workbench-health-triage";
import { validationReadinessFor } from "./primary-workbench-validation-readiness";
import { lifecycleRecoveryFor, type LifecycleOperationRow } from "./primary-workbench-lifecycle-recovery";
import { importJobsFor, selectedImportScopeFor } from "./primary-workbench-import-jobs";
import { promotionPreviewFor, sourceObservationReviewFor } from "./primary-workbench-source-observation-review";
import { conflictResolutionFor } from "./primary-workbench-conflict-resolution";
import { governanceControlsFor } from "./primary-workbench-governance-controls";
import { auditEvidenceFor } from "./primary-workbench-audit-evidence";
import { cleanResetReleaseFor } from "./primary-workbench-clean-reset-release";
import { buildCatalogPrimaryWorkbenchSourceOptions } from "./primary-workbench-source-options";

// The slices the metric strip and grouped navigation render on EVERY surface
// route, plus the route context and base scalars. Every per-route read model
// is assembled from this shared core so the cross-surface workbench chrome is
// identical regardless of which audience surface is active.
type CatalogPrimaryWorkbenchCore = Readonly<{
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  providerScope: CatalogPrimaryWorkbenchReadModel["providerScope"];
  sourceOptions: CatalogPrimaryWorkbenchReadModel["sourceOptions"];
  readiness: CatalogPrimaryWorkbenchReadModel["readiness"];
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"];
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
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
// governance, clean-reset, audit, health); those are surface-specific and built
// independently by the per-surface slice builders below.
function buildCatalogPrimaryWorkbenchCore(
  input: CatalogPrimaryWorkbenchInput,
): Readonly<{ core: CatalogPrimaryWorkbenchCore; derived: CatalogPrimaryWorkbenchDerived }> {
  const parsedContext = parseCatalogPrimaryWorkbenchRouteContext(input.requestUrl);
  const providerKey = parsedContext.providerKey ?? inferProviderKey(input);
  const activeProfile = findActiveProfile(input.profileReviews.items, providerKey);
  const selectedProfile = findSelectedProfile(
    input.profileReviews.items,
    providerKey,
    parsedContext.profileVersion,
    activeProfile,
  );
  const unitKey = parsedContext.unitKey ?? inferUnitKey(input, providerKey, activeProfile);
  const importScope = parsedContext.importScope ?? inferImportScope(input.scopes.items, providerKey);
  const profileVersion = parsedContext.profileVersion ?? activeProfile?.profileVersion ?? null;
  const routeContext: CatalogPrimaryWorkbenchRouteContext = {
    ...parsedContext,
    providerKey,
    unitKey,
    importScope,
    profileVersion,
    sourceObservationFilters: {
      ...parsedContext.sourceObservationFilters,
      ...(providerKey ? { providerKey } : {}),
      ...(importScope ? { importScope } : {}),
    },
  };
  const providerScopeRows = providerKey
    ? input.scopes.items.filter((scope) => scope.provider_key === providerKey)
    : input.scopes.items;
  const scopeRows = importScope
    ? providerScopeRows.filter((scope) => importScopeMatchesProviderScope(importScope, scope))
    : providerScopeRows;
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
  const importJobRows = importJobsFor(input.controlPlaneOverview, routeContext);
  const activeJobCount = importJobRows.filter((job) => job.state === "queued" || job.state === "running").length;
  const failedJobCount = importJobRows.filter((job) => job.state === "failed").length;
  const canManage = input.canManageCatalog;
  const generatedAt = input.controlPlaneOverview?.generatedAt ?? new Date().toISOString();
  const sourceObservationReview = sourceObservationReviewFor({
    canManage,
    changed,
    eligible,
    observed,
    promoted,
    readinessBlockers,
    rejected,
    reviewObservations: input.reviewObservations ?? null,
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

  return {
    core: {
      routeContext,
      providerScope: {
        providers: providerScopeProviders(input, providerKey, activeProfile, routeContext),
      },
      sourceOptions,
      readiness: {
        freshness: input.controlPlaneOverview ? "fresh" : "partial",
        blockers: readinessBlockers,
        providerTransport,
        rolloutEnabled,
        rbacAllowed: input.canManageCatalog,
        auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(routeContext, "audit-evidence"),
      },
      importJobs: {
        freshness: input.controlPlaneOverview ? "fresh" : "partial",
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
      promotionPreview,
      securityPrivacy,
      generatedAt,
    },
    derived: {
      providerKey,
      unitKey,
      importScope,
      activeProfile,
      selectedProfile,
      requestedProfileVersion: parsedContext.profileVersion,
      readinessBlockers,
      rolloutEnabled,
      activeJobCount,
      failedJobCount,
      importJobRows,
      canManage,
    },
  };
}

// Provider profiles + readiness surface slices (#1739 providers route). Built
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

// Health-triage slice (#1739 release route renders it alongside release
// evidence). Derived purely from the control plane overview and the core import
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

// Release evidence surface slices (#1739 release route). Audit evidence folds in
// the governance, conflict, lifecycle, and validation slices it cites, so they
// are passed in; clean reset release in turn cites audit evidence.
function releaseSurfaceSlices(
  input: CatalogPrimaryWorkbenchInput,
  core: CatalogPrimaryWorkbenchCore,
  derived: CatalogPrimaryWorkbenchDerived,
  cited: Readonly<{
    conflictResolution: CatalogPrimaryWorkbenchReadModel["conflictResolution"];
    governanceControls: CatalogPrimaryWorkbenchReadModel["governanceControls"];
    healthTriage: CatalogPrimaryWorkbenchReadModel["healthTriage"];
    lifecycleRecovery: CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"];
    validationReadiness: CatalogPrimaryWorkbenchReadModel["validationReadiness"];
  }>,
): Readonly<{
  auditEvidence: CatalogPrimaryWorkbenchReadModel["auditEvidence"];
  cleanResetRelease: CatalogPrimaryWorkbenchReadModel["cleanResetRelease"];
}> {
  const auditEvidence = auditEvidenceFor({
    conflictResolution: cited.conflictResolution,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt: core.generatedAt,
    governanceControls: cited.governanceControls,
    healthTriage: cited.healthTriage,
    importJobs: derived.importJobRows,
    lifecycleRecovery: cited.lifecycleRecovery,
    promotionPreview: core.promotionPreview,
    routeContext: core.routeContext,
    securityPrivacy: core.securityPrivacy,
    sourceObservationReview: core.sourceObservationReview,
    validationReadiness: cited.validationReadiness,
  });
  const cleanResetRelease = cleanResetReleaseFor({
    auditEvidence,
    cleanResetEvidence: input.cleanResetEvidence ?? null,
    generatedAt: core.generatedAt,
    importJobs: derived.importJobRows,
    routeContext: core.routeContext,
    sourceObservationReview: core.sourceObservationReview,
    temporaryReleaseScaffolding: input.temporaryReleaseScaffolding ?? null,
  });

  return { auditEvidence, cleanResetRelease };
}

// Assemble a fully-validated read model from the shared core and every surface
// slice. Used by the legacy single-page workbench (#1749) and the view-only
// re-derivation, both of which render the complete workspace registry.
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
  const { auditEvidence, cleanResetRelease } = releaseSurfaceSlices(input, core, derived, {
    conflictResolution,
    governanceControls,
    healthTriage,
    lifecycleRecovery,
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
    cleanResetRelease,
  });
}

// Assemble a fully-validated read model for ONE audience surface route, computing
// only the supporting slices that surface renders and substituting cheap default
// slices (no provider-row iteration, no cross-surface inputs) for the rest. The
// daily surface therefore never computes governance, lifecycle, release, or audit
// sub-models; providers never computes governance/release; and so on. Behavior is
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
  // governance, release, or audit data. Providers cites nothing downstream;
  // governance and release cite the upstream slices they fold into their evidence.
  const wantsProviderSlices = surface === "providers" || surface === "governance" || surface === "release";
  const wantsHealthTriage = surface === "governance" || surface === "release";
  const wantsGovernanceSlices = surface === "governance" || surface === "release";
  const wantsReleaseSlices = surface === "release";

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
  const { auditEvidence, cleanResetRelease } = releaseSurfaceSlices(sliceInput(wantsReleaseSlices), core, derived, {
    conflictResolution,
    governanceControls,
    healthTriage,
    lifecycleRecovery,
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
    cleanResetRelease,
  });
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
    cleanResetEvidence: null,
    temporaryReleaseScaffolding: null,
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
    cleanResetRelease: CatalogPrimaryWorkbenchReadModel["cleanResetRelease"];
  }>,
): CatalogPrimaryWorkbenchReadModel {
  const { core } = parts;
  const readModel: CatalogPrimaryWorkbenchReadModel = {
    schemaVersion: catalogPrimaryWorkbenchContractVersion,
    generatedAt: core.generatedAt,
    routeContext: core.routeContext,
    providerScope: core.providerScope,
    readiness: core.readiness,
    healthTriage: parts.healthTriage,
    profileAuthoring: parts.profileAuthoring,
    validationReadiness: parts.validationReadiness,
    lifecycleRecovery: parts.lifecycleRecovery,
    governanceControls: parts.governanceControls,
    cleanResetRelease: parts.cleanResetRelease,
    auditEvidence: parts.auditEvidence,
    importJobs: core.importJobs,
    sourceObservationReview: core.sourceObservationReview,
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
  return buildActions({
    canManage: derived.canManage,
    providerKey: derived.providerKey,
    unitKey: derived.unitKey,
    importScope: derived.importScope,
    activeProfileReady: Boolean(derived.activeProfile),
    eligible: core.promotionPreview.outcomeCounts.eligible,
    reviewable: core.sourceObservationReview.counts.observed + core.sourceObservationReview.counts.changed,
    activeJobCount: derived.activeJobCount,
    blockers: derived.readinessBlockers,
    activationBlockers: slices.validationReadiness.activationDecision.blockers,
    cloneProfileBlockers: slices.profileAuthoring.cloneDraft.blockers,
    lifecycleOperations: slices.lifecycleRecovery.operations,
    promotionBlockers: core.promotionPreview.blockers,
  });
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
  const overviewUnit = input.controlPlaneOverview?.readiness.units.find((unit) => unit.providerKey === providerKey);
  if (overviewUnit) {
    return overviewUnit.unitKey;
  }
  if (!providerKey) {
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
): CatalogProviderProfileVersionReview | null {
  if (providerKey) {
    return profiles.find((profile) => profile.providerKey === providerKey && profile.active) ?? null;
  }

  return profiles.find((profile) => profile.active) ?? null;
}

function findSelectedProfile(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string | null,
  requestedProfileVersion: string | null,
  activeProfile: CatalogProviderProfileVersionReview | null,
): CatalogProviderProfileVersionReview | null {
  const providerProfiles = providerKey ? profiles.filter((profile) => profile.providerKey === providerKey) : profiles;
  if (requestedProfileVersion) {
    return (
      providerProfiles.find((profile) => profile.profileVersion === requestedProfileVersion) ??
      profiles.find((profile) => profile.profileVersion === requestedProfileVersion && !providerKey) ??
      null
    );
  }

  return activeProfile ?? providerProfiles[0] ?? (providerKey ? null : (profiles[0] ?? null));
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
  activeJobCount: number;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  activationBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  cloneProfileBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  lifecycleOperations: readonly LifecycleOperationRow[];
  promotionBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}): readonly CatalogPrimaryWorkbenchActionReadModel[] {
  const manageState = input.canManage ? "available" : "denied";
  const importBlockers = importBlockersForSelectedScope(input);
  const previewBlockers =
    input.eligible > 0
      ? []
      : (["no-promotion-eligible-observations"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const promotionBlockers = input.promotionBlockers;
  const promotionState = actionStateForBlockers(promotionBlockers, manageState);
  const reviewDecisionBlockers =
    input.reviewable > 0 ? [] : (["selection-empty"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const reviewDecisionState = actionStateForBlockers(reviewDecisionBlockers, manageState);
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
      state: previewBlockers.length > 0 ? "disabled" : manageState,
      blockers: previewBlockers,
      copyKey: previewBlockers.length > 0 ? "catalog.primary.review.empty" : null,
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
      copyKey: reviewDecisionBlockers.length > 0 ? "catalog.primary.review.empty" : null,
    },
    {
      key: "defer-source-observations",
      state: reviewDecisionState,
      blockers: reviewDecisionBlockers,
      copyKey: reviewDecisionBlockers.length > 0 ? "catalog.primary.review.empty" : null,
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
  if (blockers.every((blocker) => blocker === "selection-empty" || blocker === "no-promotion-eligible-observations")) {
    return "disabled";
  }
  if (blockers.includes("security-privacy-blocked")) {
    return "unsafe";
  }

  return "blocked";
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
    providerKeys.add(provider.providerKey);
  }
  if (selectedProviderKey) {
    providerKeys.add(selectedProviderKey);
  }

  return [...providerKeys].sort().map((providerKey) => {
    const profile =
      providerKey === selectedProviderKey
        ? selectedProfile
        : findActiveProfile(input.profileReviews.items, providerKey);
    const providerScopes = input.scopes.items.filter((scope) => scope.provider_key === providerKey);
    const providerReadiness = input.controlPlaneOverview?.providerReadiness.providers.find(
      (provider) => provider.providerKey === providerKey,
    );
    const readinessUnit =
      input.controlPlaneOverview?.readiness.units.find(
        (unit) =>
          unit.providerKey === providerKey &&
          (!providerReadiness ||
            providerReadiness.unitKeys.length === 0 ||
            providerReadiness.unitKeys.includes(unit.unitKey)),
      ) ?? input.controlPlaneOverview?.readiness.units.find((unit) => unit.providerKey === providerKey);
    const unitKey = inferUnitKey(input, providerKey, profile) ?? readinessUnit?.unitKey ?? null;
    const [profileProductDomain, profileProductForm] = profile?.supportedScopes[0]?.split("/") ?? [];

    return {
      providerKey,
      displayName: profile?.displayName ?? readinessUnit?.displayName ?? providerKey,
      units: [
        {
          unitKey:
            unitKey ??
            defineCatalogIntegrationUnitKey({
              providerKey,
              productDomain: "catalog",
              productForm: "source-observation",
              ingestionPurpose: "import",
            }),
          productDomain: profileProductDomain ?? readinessUnit?.productDomain ?? "catalog",
          productForm: profileProductForm ?? readinessUnit?.productForm ?? "source-observation",
          importScopes: providerImportScopes(providerScopes, routeContext.importScope, providerKey),
          activeProfile: profilePointerForProfile(profile),
        },
      ],
    };
  });
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
