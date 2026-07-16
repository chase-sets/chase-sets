import { t } from "@chase-sets/localization";
import type { CatalogAdminRollbackRetirementImpactSummaryReadModel } from "../api/admin-control-plane-read-model-contracts";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import {
  catalogPrimaryWorkbenchRetirementPolicy,
  type CatalogPrimaryWorkbenchBlockerCategory,
  type CatalogPrimaryWorkbenchLifecycleOperation,
  type CatalogPrimaryWorkbenchReadModel,
  type CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationControlPlaneOverview, CatalogProviderProfileVersionReview } from "./contracts";
import {
  catalogPrimaryWorkbenchReturnPath,
  catalogPrimaryWorkbenchSupportingHref,
} from "./primary-workbench-route-context";
import { catalogProviderDetailHref } from "./admin-control-plane/provider-detail/provider-detail-links";
import { actionStateForBlockers } from "./primary-workbench-read-model-support";
import type { ValidationReadiness } from "./primary-workbench-validation-readiness";

export type LifecycleRecovery = CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"];
export type LifecycleOperationRow = LifecycleRecovery["operations"][number];

export function lifecycleRecoveryFor(input: {
  activeJobCount: number;
  activeProfile: CatalogProviderProfileVersionReview | null;
  canManage: boolean;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  lifecycleImpacts: Partial<
    Record<CatalogPrimaryWorkbenchLifecycleOperation, CatalogAdminRollbackRetirementImpactSummaryReadModel>
  > | null;
  profiles: readonly CatalogProviderProfileVersionReview[];
  providerKey: string | null;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  selectedProfile: CatalogProviderProfileVersionReview | null;
  validationReadiness: ValidationReadiness;
}): LifecycleRecovery {
  const providerProfiles = input.providerKey
    ? input.profiles.filter((profile) => profile.providerKey === input.providerKey)
    : input.profiles;
  const selectedProfile = input.selectedProfile;
  const operations: readonly LifecycleOperationRow[] = (["activation", "rollback", "deprecate", "retire"] as const).map(
    (operation) =>
      lifecycleOperationFor({
        activeJobCount: input.activeJobCount,
        activeProfile: input.activeProfile,
        canManage: input.canManage,
        impact: input.lifecycleImpacts?.[operation] ?? null,
        operation,
        routeContext: input.routeContext,
        selectedProfile,
        validationReadiness: input.validationReadiness,
      }),
  );
  const recentAuditEvents =
    input.controlPlaneOverview?.auditLifecycle.entries
      .filter((entry) => {
        if (entry.providerKey !== (selectedProfile?.providerKey ?? input.providerKey ?? entry.providerKey)) {
          return false;
        }
        return (
          entry.eventName === "profile-created" ||
          entry.eventName === "profile-section-edited" ||
          entry.eventName === "profile-activated" ||
          entry.eventName === "profile-deprecated" ||
          entry.eventName === "profile-rolled-back" ||
          entry.eventName === "profile-retired"
        );
      })
      .slice(0, 8)
      .map((entry) => ({
        eventId: entry.eventId,
        occurredAt: entry.occurredAt,
        eventName: entry.eventName,
        category: entry.category,
        providerKey: entry.providerKey,
        unitKey: entry.unitKey as CatalogIntegrationUnitKey | null,
        profileVersion: entry.profileVersion,
        summary: entry.summary,
      })) ?? [];
  const uniqueBlockerCount = new Set(operations.flatMap((operation) => operation.blockers)).size;
  const status: LifecycleRecovery["status"] = !selectedProfile
    ? "unavailable"
    : uniqueBlockerCount > 0
      ? "blocked"
      : "ready";

  return {
    status,
    freshness: input.controlPlaneOverview ? "fresh" : selectedProfile ? "partial" : "unavailable",
    generatedAt: input.generatedAt,
    selectedProviderKey: selectedProfile?.providerKey ?? input.routeContext.providerKey ?? null,
    selectedProfileVersion: selectedProfile?.profileVersion ?? input.routeContext.profileVersion ?? null,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence"),
    summary: {
      activeJobs: input.activeJobCount,
      affectedReferences: Math.max(
        selectedProfile?.referenceCount ?? 0,
        ...operations.map((operation) => operation.impact.referencedObservationCount),
      ),
      downstreamProfileReferences: Math.max(
        0,
        ...operations.map(
          (operation) => operation.impact.sourceProfileReferenceCount + operation.impact.promotionProfileReferenceCount,
        ),
      ),
      impactedCatalogItems: Math.max(0, ...operations.map((operation) => operation.impact.impactedCatalogItemCount)),
      blockers: uniqueBlockerCount,
      recentLifecycleEvents: recentAuditEvents.length,
    },
    profiles: providerProfiles.map((profile) => ({
      providerKey: profile.providerKey,
      profileKey: profile.profileKey,
      profileVersion: profile.profileVersion,
      displayName: profile.displayName,
      lifecycle: profile.lifecycle,
      active: profile.active,
      referenceCount: profile.referenceCount,
      href: catalogProviderDetailHref(profile.providerKey, { profileVersion: profile.profileVersion }),
    })),
    operations,
    recentAuditEvents,
    strictRetirement: {
      requiredDisposition: catalogPrimaryWorkbenchRetirementPolicy.requiredDisposition,
      forbiddenSupportPaths: catalogPrimaryWorkbenchRetirementPolicy.forbiddenOutcomes.map((outcome) =>
        outcome === "raw JSON escape hatch" ? "payload escape hatch" : outcome,
      ),
      summary: t("catalog.features.sourceObservations.ui.lifecycleRecovery.strictRetirement.summary"),
    },
  };
}

function lifecycleOperationFor(input: {
  activeJobCount: number;
  activeProfile: CatalogProviderProfileVersionReview | null;
  canManage: boolean;
  impact: CatalogAdminRollbackRetirementImpactSummaryReadModel | null;
  operation: CatalogPrimaryWorkbenchLifecycleOperation;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  selectedProfile: CatalogProviderProfileVersionReview | null;
  validationReadiness: ValidationReadiness;
}): LifecycleOperationRow {
  const profile = input.selectedProfile;
  const impactAllowed = input.impact?.allowed ?? (input.operation !== "retire" || (profile?.referenceCount ?? 0) === 0);
  const impact = lifecycleImpactFor(profile, input.impact, input.activeJobCount);
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!profile) {
    blockers.add("profile-version-missing");
  }
  if (!input.canManage) {
    blockers.add("permission-denied");
  }
  if (input.activeJobCount > 0 || impact.impactedJobCount > 0) {
    blockers.add("active-job-conflict");
  }
  if (input.activeJobCount > 1 || impact.impactedJobCount > 1) {
    blockers.add("concurrent-job");
  }
  for (const impactBlocker of impact.blockers) {
    blockers.add(lifecycleBlockerCategoryForDiagnostic(impactBlocker.code));
  }

  if (input.operation === "activation") {
    for (const blocker of input.validationReadiness.activationDecision.blockers) {
      blockers.add(blocker);
    }
  }
  if (input.operation === "rollback" && profile?.active) {
    blockers.add("profile-lifecycle-conflict");
  }
  if (input.operation === "deprecate" && (!profile?.active || profile.lifecycle !== "active")) {
    blockers.add("profile-lifecycle-conflict");
  }
  if (input.operation === "retire") {
    if (profile?.active || profile?.lifecycle === "retired") {
      blockers.add("profile-lifecycle-conflict");
    }
    if (
      (profile?.referenceCount ?? 0) > 0 ||
      impact.referencedObservationCount > 0 ||
      impact.sourceProfileReferenceCount > 0 ||
      impact.promotionProfileReferenceCount > 0
    ) {
      blockers.add("profile-retirement-references");
    }
  }

  const blockerList = [...blockers];
  const commandKey = lifecycleCommandKey(input.operation);
  const operationHref = catalogProviderDetailHref(profile?.providerKey ?? input.routeContext.providerKey ?? null, {
    profileVersion: profile?.profileVersion ?? input.routeContext.profileVersion,
  });
  const supportHref = input.operation === "activation" ? operationHref : null;
  const submitHref = operationHref;

  return {
    operation: input.operation,
    label: lifecycleOperationLabel(input.operation),
    description: lifecycleOperationDescription(input.operation),
    commandKey,
    providerKey: profile?.providerKey ?? input.routeContext.providerKey ?? null,
    profileVersion: profile?.profileVersion ?? input.routeContext.profileVersion ?? null,
    lifecycle: profile?.lifecycle ?? null,
    active: Boolean(profile?.active),
    state: actionStateForBlockers(blockerList, input.canManage ? "available" : "denied"),
    blockers: blockerList,
    confirmationRequired: input.operation !== "activation",
    allowed: blockerList.length === 0 && impactAllowed,
    submitHref,
    supportHref,
    impact,
    auditConsequences: {
      auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence"),
      eventName: lifecycleAuditEventName(input.operation),
      summary: lifecycleAuditSummary(input.operation),
    },
    nextSteps: lifecycleNextSteps(input.operation, blockerList),
  };
}

function lifecycleImpactFor(
  profile: CatalogProviderProfileVersionReview | null,
  impact: CatalogAdminRollbackRetirementImpactSummaryReadModel | null,
  activeJobCount: number,
): LifecycleOperationRow["impact"] {
  if (impact) {
    return {
      generatedAt: impact.generatedAt,
      referencedObservationCount: impact.referencedObservationCount,
      sourceProfileReferenceCount: impact.sourceProfileReferenceCount,
      promotionProfileReferenceCount: impact.promotionProfileReferenceCount,
      impactedCatalogItemCount: impact.impactedCatalogItemCount,
      impactedCatalogItemIds: impact.impactedCatalogItemIds,
      externalReferenceCount: impact.externalReferenceCount,
      sampleObservationIds: impact.sampleObservationIds,
      impactedJobCount: impact.impactedJobCount,
      blockers: impact.blockers,
    };
  }

  return {
    generatedAt: null,
    referencedObservationCount: profile?.referenceCount ?? 0,
    sourceProfileReferenceCount: 0,
    promotionProfileReferenceCount: 0,
    impactedCatalogItemCount: 0,
    impactedCatalogItemIds: [],
    externalReferenceCount: 0,
    sampleObservationIds: [],
    impactedJobCount: activeJobCount,
    blockers: [],
  };
}

function lifecycleCommandKey(
  operation: CatalogPrimaryWorkbenchLifecycleOperation,
): LifecycleOperationRow["commandKey"] {
  switch (operation) {
    case "activation":
      return "provider-profile.activate";
    case "rollback":
      return "provider-profile.rollback";
    case "deprecate":
      return "provider-profile.deprecate";
    case "retire":
      return "provider-profile.retire";
  }
}

function lifecycleOperationLabel(operation: CatalogPrimaryWorkbenchLifecycleOperation): string {
  switch (operation) {
    case "activation":
      return "Activation recovery";
    case "rollback":
      return "Rollback profile";
    case "deprecate":
      return "Deprecate profile";
    case "retire":
      return "Retire profile";
  }
}

function lifecycleOperationDescription(operation: CatalogPrimaryWorkbenchLifecycleOperation): string {
  switch (operation) {
    case "activation":
      return "Open validation readiness when a profile needs activation evidence before returning to provider import.";
    case "rollback":
      return "Restore a previous validated profile version after reviewing reference, job, and replay impact.";
    case "deprecate":
      return "Mark the active profile out of normal use while keeping audit and replay readability clear.";
    case "retire":
      return "Remove the profile from supported use only when active references, jobs, and downstream profile links are gone.";
  }
}

function lifecycleAuditEventName(operation: CatalogPrimaryWorkbenchLifecycleOperation): string {
  switch (operation) {
    case "activation":
      return "profile-activated";
    case "rollback":
      return "profile-rolled-back";
    case "deprecate":
      return "profile-deprecated";
    case "retire":
      return "profile-retired";
  }
}

function lifecycleAuditSummary(operation: CatalogPrimaryWorkbenchLifecycleOperation): string {
  switch (operation) {
    case "activation":
      return "Activation audit evidence is recorded from validation readiness.";
    case "rollback":
      return "Rollback records the restored profile version, affected references, and replay implications.";
    case "deprecate":
      return "Deprecation records lifecycle intent without preserving old code paths or old documentation.";
    case "retire":
      return "Retirement records complete-removal evidence and cannot preserve compatibility support paths.";
  }
}

function lifecycleNextSteps(
  operation: CatalogPrimaryWorkbenchLifecycleOperation,
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly string[] {
  if (blockers.includes("permission-denied")) {
    return ["Resolve catalog.manage permission in governance controls before running profile lifecycle actions."];
  }
  if (blockers.includes("active-job-conflict") || blockers.includes("concurrent-job")) {
    return ["Let active import, reapply, replay, or review jobs finish before changing profile lifecycle state."];
  }
  if (blockers.includes("profile-retirement-references")) {
    return [
      "Remove active Source Observation references and downstream profile references before profile retirement.",
      "Do not keep compatibility routes, shims, fallback branches, old tests, fixtures, screenshots, or documentation.",
    ];
  }
  if (blockers.includes("profile-lifecycle-conflict")) {
    return operation === "rollback"
      ? ["Select a previous inactive validated profile version as the rollback target."]
      : operation === "deprecate"
        ? ["Select the current active profile before deprecation."]
        : ["Select an inactive, referenced-by-nothing profile that has not already been retired."];
  }
  if (operation === "activation") {
    return ["Use validation readiness to resolve activation blockers and record migration evidence."];
  }

  return ["Review impact evidence, confirm the lifecycle action, and verify audit evidence after completion."];
}

function lifecycleBlockerCategoryForDiagnostic(code: string): CatalogPrimaryWorkbenchBlockerCategory {
  if (code === "profile-lifecycle-active-jobs") {
    return "active-job-conflict";
  }
  if (code === "profile-retirement-referenced-observations") {
    return "profile-retirement-references";
  }

  return "profile-lifecycle-conflict";
}
