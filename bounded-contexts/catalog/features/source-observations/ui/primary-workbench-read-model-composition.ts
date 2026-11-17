import {
  catalogPrimaryWorkbenchContractVersion,
  catalogPrimaryWorkbenchDeploySkewPolicies,
  catalogPrimaryWorkbenchInstrumentationDimensions,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogPrimaryWorkbenchActionReadModel,
  type CatalogPrimaryWorkbenchReadModel,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import { catalogScopeRecordIdFromPath } from "../api/admin/scope-detail-workbench-location";
import {
  buildCatalogPrimaryWorkbenchCore,
  buildCatalogPrimaryWorkbenchCoreSourceOptions,
  type CatalogPrimaryWorkbenchCore,
  type CatalogPrimaryWorkbenchDerived,
} from "./primary-workbench-core-read-model";
import {
  catalogPrimaryWorkbenchDailyFlowFor,
  catalogPrimaryWorkbenchDailyStatusFor,
} from "./primary-workbench-daily-flow";
import type { CatalogPrimaryWorkbenchInput } from "./primary-workbench-read-model-input";
import { buildSurfaceActions } from "./primary-workbench-surface-actions";
import {
  conflictAndLifecycleSlices,
  governanceControlsSlice,
  healthSurfaceSlices,
  healthTriageSlice,
  providersSurfaceSlices,
} from "./primary-workbench-surface-slices";

// Assemble a fully-validated read model for ONE audience surface route, computing
// only the supporting slices that surface renders and substituting cheap default
// slices (no provider-row iteration, no cross-surface inputs) for the rest. The
// daily surface omits heavy supporting slices unless evidenceRef requests audit
// evidence. That demand does not enable governance, lifecycle, or authoring. The health
// surface renders every supporting slice, so calling this with "health" computes
// the complete read model — the reference other surfaces are compared against.
export function buildCatalogPrimaryWorkbenchReadModelForSurface(
  surface: CatalogControlPlaneRouteSurfaceKey,
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchReadModel {
  const { core, derived } = buildCatalogPrimaryWorkbenchCore(input);

  // Provider and Settings reuse their supporting inputs; daily evidence demand
  // enables only audit, not the other supporting slices.
  const wantsProviderSlices = surface === "governance" || surface === "health";
  const wantsHealthTriage = surface === "governance" || surface === "health";
  const scopeHealth =
    surface === "daily" &&
    Boolean(
      core.routeContext.scopeRecordId &&
      catalogScopeRecordIdFromPath(new URL(input.requestUrl).pathname) === core.routeContext.scopeRecordId,
    );
  const wantsGovernanceSlices = surface === "governance" || surface === "health";
  // The Settings page (the "governance" surface) embeds the Evidence drawer, so it
  // also needs the audit-evidence slice computed — not just cited like the
  // observability signal in governanceControlsSlice.
  const wantsAuditEvidence = surface === "health" || surface === "governance" || Boolean(core.routeContext.evidenceRef);

  const sliceInput = (wanted: boolean): CatalogPrimaryWorkbenchInput =>
    wanted ? input : emptyControlPlaneInput(input);
  const providerSliceInput = wantsProviderSlices ? input : emptyProviderSliceInput(input);
  const providerSliceDerived = wantsProviderSlices ? derived : emptyProviderSliceDerived(derived);

  const { profileAuthoring, validationReadiness } = providersSurfaceSlices(
    providerSliceInput,
    core,
    providerSliceDerived,
  );
  const supportingHealthTriage = healthTriageSlice(sliceInput(wantsHealthTriage), core, derived);
  // Scope-member health is not a full-source governance or audit completeness signal.
  const healthTriage = scopeHealth
    ? healthTriageSlice(
        input,
        core,
        derived,
        core.sourceScopeWorkset.selectedScope.hasConcreteScope ? core.sourceScopeWorkset.units : [],
      )
    : supportingHealthTriage;
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
    supportingHealthTriage,
  );
  const { auditEvidence } = healthSurfaceSlices(
    sliceInput(wantsAuditEvidence),
    core,
    derived,
    {
      conflictResolution,
      healthTriage: supportingHealthTriage,
      validationReadiness,
    },
    wantsAuditEvidence,
  );

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
// resolves. It runs only the route selection and source-option step the shared
// core starts from, so the populated slice is byte-identical to what the
// synchronous builder would have produced from the same pages, and it never
// derives, traverses inputs for, or re-emits the rest of the read model —
// keeping the deferred value small and the browser free of the raw baseline
// inputs the slice was computed from.
export function buildCatalogPrimaryWorkbenchDeferredSourceOptions(
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchReadModel["sourceOptions"] {
  return buildCatalogPrimaryWorkbenchCoreSourceOptions(input);
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
    promotionResult: core.promotionResult,
    actions: parts.actions,
    flow: catalogPrimaryWorkbenchDailyFlowFor(core),
    dailyStatus: catalogPrimaryWorkbenchDailyStatusFor({ ...core, actions: parts.actions }),
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
