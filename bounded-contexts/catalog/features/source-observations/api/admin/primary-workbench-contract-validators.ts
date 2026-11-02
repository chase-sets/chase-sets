import type { CatalogPrimaryWorkbenchReadModel } from "./primary-workbench-shared-contracts";
import {
  assertCatalogPrimaryWorkbenchActionState,
  assertPrimaryWorkbenchBlockers,
} from "./primary-workbench-shared-contracts";
import {
  catalogPrimaryWorkbenchContractVersion,
  validatePrimaryWorkbenchRouteContext,
  assertPrimaryWorkbenchSourceOptions,
} from "./primary-workbench-selection-contracts";
import {
  assertPrimaryWorkbenchImportJobs,
  assertPrimaryWorkbenchSourceScopeWorkset,
} from "./primary-workbench-import-sync-contracts";
import {
  assertPrimaryWorkbenchPromotionResult,
  assertPrimaryWorkbenchConflictResolution,
  assertPrimaryWorkbenchPromotionPreview,
  assertPrimaryWorkbenchMergeCandidateReview,
} from "./primary-workbench-promotion-review-contracts";
import {
  assertPrimaryWorkbenchProfileAuthoring,
  assertPrimaryWorkbenchValidationReadiness,
} from "./primary-workbench-profile-readiness-contracts";
import {
  assertPrimaryWorkbenchGovernanceControls,
  assertPrimaryWorkbenchAuditEvidence,
  assertPrimaryWorkbenchHealthTriage,
  assertPrimaryWorkbenchLifecycleRecovery,
} from "./primary-workbench-lifecycle-governance-contracts";

export function validateCatalogPrimaryWorkbenchReadModelContract(
  value: Partial<CatalogPrimaryWorkbenchReadModel>,
): void {
  if (value.schemaVersion !== catalogPrimaryWorkbenchContractVersion) {
    throw new Error("Primary workbench schema version mismatch must fail closed.");
  }
  if (!value.routeContext) {
    throw new Error("Primary workbench route context is required for context preservation.");
  }
  validatePrimaryWorkbenchRouteContext(value.routeContext);
  if (!value.securityPrivacy) {
    throw new Error("Primary workbench security/privacy fields are required and must fail closed when missing.");
  }
  if (!value.deploySkew) {
    throw new Error("Primary workbench deploy-skew policy is required.");
  }
  if (!value.deploySkew.supported) {
    throw new Error("Primary workbench deploy-skew policy is unsupported and must fail closed.");
  }
  if (!value.instrumentation?.redactionSafe) {
    throw new Error("Primary workbench instrumentation must be redaction-safe.");
  }
  assertPrimaryWorkbenchHealthTriage(value.healthTriage);
  for (const actionEntry of value.actions ?? []) {
    assertCatalogPrimaryWorkbenchActionState(actionEntry.state);
    assertPrimaryWorkbenchBlockers(actionEntry.blockers);
  }
  assertPrimaryWorkbenchBlockers(value.readiness?.blockers);
  assertPrimaryWorkbenchBlockers(value.sourceOptions?.refresh.blockers);
  assertPrimaryWorkbenchBlockers(value.sourceOptions?.pages.flatMap((page) => page.blockers));
  assertPrimaryWorkbenchBlockers(
    value.sourceScopeWorkset?.units.flatMap((unit) => [
      ...unit.actions.import.blockers,
      ...unit.actions.previewPromotion.blockers,
      ...unit.actions.reapply.blockers,
    ]),
  );
  assertPrimaryWorkbenchBlockers(value.importJobs?.selectedScope?.readiness.blockers);
  assertPrimaryWorkbenchBlockers(value.importJobs?.jobs.flatMap((job) => job.blockers));
  assertPrimaryWorkbenchImportJobs(value.importJobs);
  assertPrimaryWorkbenchBlockers(
    value.sourceObservationReview?.rows.flatMap((row) => [
      ...row.promotionReadiness.blockers,
      ...row.actions.flatMap((actionEntry) => actionEntry.blockers),
    ]),
  );
  assertPrimaryWorkbenchBlockers(
    value.mergeCandidateReview?.rows.flatMap((row) => [
      ...row.promoteReadiness.blockers,
      ...row.actions.flatMap((actionEntry) => actionEntry.blockers),
    ]),
  );
  assertPrimaryWorkbenchBlockers(
    value.conflictResolution?.rows.flatMap((row) => [...row.blockers, ...row.overrideAction.blockers]),
  );
  assertPrimaryWorkbenchBlockers(value.governanceControls?.controls.flatMap((control) => control.blockers));
  assertPrimaryWorkbenchBlockers(value.governanceControls?.rbacMatrix.flatMap((actionEntry) => actionEntry.blockers));
  assertPrimaryWorkbenchBlockers(value.conflictResolution?.overridePolicy.blockers);
  assertPrimaryWorkbenchBlockers(value.promotionPreview?.blockers);
  assertPrimaryWorkbenchConflictResolution(value.conflictResolution);
  assertPrimaryWorkbenchSourceOptions(value.sourceOptions);
  assertPrimaryWorkbenchSourceScopeWorkset(value.sourceScopeWorkset);
  assertPrimaryWorkbenchMergeCandidateReview(value.mergeCandidateReview);
  assertPrimaryWorkbenchGovernanceControls(value.governanceControls);
  assertPrimaryWorkbenchAuditEvidence(value.auditEvidence);
  assertPrimaryWorkbenchPromotionPreview(value.promotionPreview);
  assertPrimaryWorkbenchPromotionResult(value.promotionResult);
  assertPrimaryWorkbenchProfileAuthoring(value.profileAuthoring);
  assertPrimaryWorkbenchValidationReadiness(value.validationReadiness);
  assertPrimaryWorkbenchLifecycleRecovery(value.lifecycleRecovery);
}
