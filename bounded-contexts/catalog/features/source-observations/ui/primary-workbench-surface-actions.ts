import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogPrimaryWorkbenchCore, CatalogPrimaryWorkbenchDerived } from "./primary-workbench-core-read-model";
import type { LifecycleOperationRow } from "./primary-workbench-lifecycle-recovery";

// The workbench command states every surface renders, derived from the core and
// the profile-authoring, validation and lifecycle slices whose blockers gate them.
export function buildSurfaceActions(
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

function buildActions(input: {
  canManage: boolean;
  providerKey: string | null;
  unitKey: string | null;
  importScope: string | null;
  activeProfileReady: boolean;
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
    input.promotionBlockers.length === 0
      ? []
      : reviewReadModelBlockers.length > 0
        ? reviewReadModelBlockers
        : input.promotionBlockers;
  const previewState = actionStateForBlockers(previewBlockers, manageState);
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
      key: "scope.sync",
      state: manageState,
      blockers: [],
      copyKey: null,
    },
    {
      key: "scope.import",
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
      key: "provider-profile.clone",
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
      key: "provider-profile.activate",
      state: activationState,
      blockers: input.activationBlockers,
      copyKey: input.activationBlockers.length > 0 ? "catalog.primary.import.blocked" : null,
    },
    lifecycleAction("provider-profile.rollback", lifecycleOperationByCommand, manageState),
    lifecycleAction("provider-profile.deprecate", lifecycleOperationByCommand, manageState),
    lifecycleAction("provider-profile.retire", lifecycleOperationByCommand, manageState),
    {
      key: "observation.promote",
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
      key: "observation.reject",
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
      key: "observation.defer",
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
      key: "candidate.promote",
      state: mergeCandidateCommandState,
      blockers: mergeCandidateCommandBlockers,
      copyKey: mergeCandidateCommandBlockers.length > 0 ? "catalog.primary.review.blocked" : null,
    },
    {
      key: "candidate.split",
      state: mergeCandidateCommandState,
      blockers: mergeCandidateCommandBlockers,
      copyKey: mergeCandidateCommandBlockers.length > 0 ? "catalog.primary.review.blocked" : null,
    },
    {
      key: "candidate.edit",
      state: mergeCandidateCommandState,
      blockers: mergeCandidateCommandBlockers,
      copyKey: mergeCandidateCommandBlockers.length > 0 ? "catalog.primary.review.blocked" : null,
    },
    {
      key: "candidate.ignore",
      state: mergeCandidateCommandState,
      blockers: mergeCandidateCommandBlockers,
      copyKey: mergeCandidateCommandBlockers.length > 0 ? "catalog.primary.review.blocked" : null,
    },
    {
      key: "candidate.defer",
      state: mergeCandidateCommandState,
      blockers: mergeCandidateCommandBlockers,
      copyKey: mergeCandidateCommandBlockers.length > 0 ? "catalog.primary.review.blocked" : null,
    },
    {
      key: "observation.reapply",
      state: reapplyState,
      blockers: reapplyBlockers,
      copyKey: reapplyBlockers.length > 0 ? "catalog.primary.reapply.originalProfileMissing" : null,
    },
    {
      key: "observation.replay",
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
    "provider-profile.rollback" | "provider-profile.deprecate" | "provider-profile.retire"
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
