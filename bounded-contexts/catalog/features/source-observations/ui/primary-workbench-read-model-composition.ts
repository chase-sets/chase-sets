import {
  catalogPrimaryWorkbenchContractVersion,
  catalogPrimaryWorkbenchDeploySkewPolicies,
  catalogPrimaryWorkbenchInstrumentationDimensions,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogPrimaryWorkbenchActionReadModel,
  type CatalogPrimaryWorkbenchBlockerCategory,
  type CatalogPrimaryWorkbenchCommandKey,
  type CatalogPrimaryWorkbenchLifecycleOperation,
  type CatalogPrimaryWorkbenchProviderTransportCategory,
  type CatalogPrimaryWorkbenchReadModel,
  type CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import { defineCatalogIntegrationUnitKey, type CatalogIntegrationUnitKey } from "../api/integration-unit";
import type { CatalogProviderProfileVersionReview, SourceObservationIntegrationScope } from "./contracts";
import {
  catalogPrimaryWorkbenchSupportingHref,
  parseCatalogPrimaryWorkbenchRouteContext,
} from "./primary-workbench-route-context";
import type { CatalogPrimaryWorkbenchInput } from "./primary-workbench-read-model-input";
import {
  credentialBlockerFor,
  normalizeUnitSegment,
  profilePointerForProfile,
  providerTransportBlockerFor,
  providerTransportFor,
  scopeKey,
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

export function buildCatalogPrimaryWorkbenchReadModel(
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchReadModel {
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
  const scopeRows = providerKey
    ? input.scopes.items.filter((scope) => scope.provider_key === providerKey)
    : input.scopes.items;
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
  const healthTriage = healthTriageFor({
    overview: input.controlPlaneOverview,
    routeContext,
    importJobs: importJobRows,
  });
  const profileAuthoring = profileAuthoringFor({
    activeJobCount,
    activeProfile,
    canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    profiles: input.profileReviews.items,
    providerKey,
    requestedProfileVersion: parsedContext.profileVersion,
    requestUrl: input.requestUrl,
    routeContext,
    selectedProfile,
    scopes: input.scopes.items,
  });
  const validationReadiness = validationReadinessFor({
    activeJobCount,
    authoringModel: input.profileAuthoringModel ?? null,
    canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    profileAuthoring,
    routeContext,
    selectedProfile,
  });
  const lifecycleRecovery = lifecycleRecoveryFor({
    activeJobCount,
    activeProfile,
    canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    lifecycleImpacts: input.lifecycleImpacts ?? null,
    profiles: input.profileReviews.items,
    providerKey,
    routeContext,
    selectedProfile,
    validationReadiness,
  });
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
  const conflictResolution = conflictResolutionFor({
    canManage,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    promotionPreview,
    routeContext,
    sourceObservationReview,
  });
  const actions = buildActions({
    canManage,
    providerSelected: Boolean(providerKey && unitKey && importScope),
    activeProfileReady: Boolean(activeProfile),
    eligible: promotionPreview.outcomeCounts.eligible,
    reviewable: sourceObservationReview.counts.observed + sourceObservationReview.counts.changed,
    activeJobCount,
    blockers: readinessBlockers,
    activationBlockers: validationReadiness.activationDecision.blockers,
    cloneProfileBlockers: profileAuthoring.cloneDraft.blockers,
    lifecycleOperations: lifecycleRecovery.operations,
    promotionBlockers: promotionPreview.blockers,
  });
  const governanceControls = governanceControlsFor({
    actions,
    canManage,
    conflictResolution,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    healthTriage,
    importJobs: importJobRows,
    readinessBlockers,
    rolloutEnabled,
    routeContext,
    sourceObservationReview,
  });
  const securityPrivacy = {
    redactionApplied: true,
    governedDataClasses: ["provider payload", "operator identity", "external source URLs"],
    unsafeEvidenceBlocked: false,
    missingSecurityFieldsBlocker: "security-privacy-blocked",
  } satisfies CatalogPrimaryWorkbenchReadModel["securityPrivacy"];
  const auditEvidence = auditEvidenceFor({
    conflictResolution,
    controlPlaneOverview: input.controlPlaneOverview,
    generatedAt,
    governanceControls,
    healthTriage,
    importJobs: importJobRows,
    lifecycleRecovery,
    promotionPreview,
    routeContext,
    securityPrivacy,
    sourceObservationReview,
    validationReadiness,
  });
  const cleanResetRelease = cleanResetReleaseFor({
    auditEvidence,
    cleanResetEvidence: input.cleanResetEvidence ?? null,
    generatedAt,
    importJobs: importJobRows,
    routeContext,
    sourceObservationReview,
    temporaryReleaseScaffolding: input.temporaryReleaseScaffolding ?? null,
  });

  const readModel: CatalogPrimaryWorkbenchReadModel = {
    schemaVersion: catalogPrimaryWorkbenchContractVersion,
    generatedAt,
    routeContext,
    providerScope: {
      providers: providerScopeProviders(input, providerKey, activeProfile),
    },
    readiness: {
      freshness: input.controlPlaneOverview ? "fresh" : "partial",
      blockers: readinessBlockers,
      providerTransport,
      rolloutEnabled,
      rbacAllowed: input.canManageCatalog,
      auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(routeContext, "audit-evidence"),
    },
    healthTriage,
    profileAuthoring,
    validationReadiness,
    lifecycleRecovery,
    governanceControls,
    cleanResetRelease,
    auditEvidence,
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
        rolloutEnabled,
        unitKey,
      }),
      jobs: importJobRows,
    },
    sourceObservationReview,
    conflictResolution,
    promotionPreview,
    promotionResult: null,
    actions,
    deploySkew: catalogPrimaryWorkbenchDeploySkewPolicies[0],
    securityPrivacy,
    instrumentation: {
      dimensions: catalogPrimaryWorkbenchInstrumentationDimensions,
      redactionSafe: true,
    },
  };

  validateCatalogPrimaryWorkbenchReadModelContract(readModel);

  return readModel;
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
  return (
    profiles.find((profile) => profile.providerKey === providerKey && profile.active) ??
    profiles.find((profile) => profile.active) ??
    null
  );
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

  return activeProfile ?? providerProfiles[0] ?? profiles[0] ?? null;
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
  providerSelected: boolean;
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
  const importBlockers = input.canManage
    ? input.providerSelected && input.activeProfileReady
      ? [
          ...input.blockers,
          ...(input.activeJobCount > 0 ? (["active-job-conflict"] as const) : []),
          ...(input.activeJobCount > 1 ? (["concurrent-job"] as const) : []),
        ]
      : ["missing-active-profile" as const]
    : ["permission-denied" as const];
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
      copyKey: importBlockers.length > 0 ? "catalog.primary.import.blocked" : null,
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
): CatalogPrimaryWorkbenchReadModel["providerScope"]["providers"] {
  const providerKeys = new Set<string>();
  for (const scope of input.scopes.items) {
    providerKeys.add(scope.provider_key);
  }
  for (const profile of input.profileReviews.items) {
    providerKeys.add(profile.providerKey);
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
    const unitKey = inferUnitKey(input, providerKey, profile);

    return {
      providerKey,
      displayName: profile?.displayName ?? providerKey,
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
          productDomain: profile?.supportedScopes[0]?.split("/")[0] ?? "catalog",
          productForm: profile?.supportedScopes[0]?.split("/")[1] ?? "source-observation",
          importScopes: providerScopes.map((scope) =>
            [scope.language_code, scope.product_line_id, scope.series_id, scope.expansion_id].filter(Boolean).join(":"),
          ),
          activeProfile: profilePointerForProfile(profile),
        },
      ],
    };
  });
}
