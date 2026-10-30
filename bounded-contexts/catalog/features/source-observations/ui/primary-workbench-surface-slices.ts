import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchReadModel,
} from "../api/primary-workbench-admin-contracts";
import { auditEvidenceFor } from "./primary-workbench-audit-evidence";
import { conflictResolutionFor } from "./primary-workbench-conflict-resolution";
import type { CatalogPrimaryWorkbenchCore, CatalogPrimaryWorkbenchDerived } from "./primary-workbench-core-read-model";
import { governanceControlsFor } from "./primary-workbench-governance-controls";
import { healthTriageFor } from "./primary-workbench-health-triage";
import { lifecycleRecoveryFor } from "./primary-workbench-lifecycle-recovery";
import { profileAuthoringFor } from "./primary-workbench-profile-authoring";
import type { CatalogPrimaryWorkbenchInput } from "./primary-workbench-read-model-input";
import { validationReadinessFor } from "./primary-workbench-validation-readiness";

// Provider profiles + readiness surface slices for the providers route. Built
// only from profile reviews, the optional authoring model, and the control plane
// overview — never from conflict, governance, release, or audit inputs.
export function providersSurfaceSlices(
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
export function conflictAndLifecycleSlices(
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
export function governanceControlsSlice(
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
export function healthTriageSlice(
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
export function healthSurfaceSlices(
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
