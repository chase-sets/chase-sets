import type {
  CatalogControlPlaneTelemetryBlockerCategory,
  CatalogControlPlaneTelemetryEventInput,
  CatalogControlPlaneTelemetryPromotionResult,
} from "../api/catalog-integration-observability";
import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import { CATALOG_CONTROL_PLANE_WORKSPACES } from "./admin-control-plane/information-architecture";

export type CatalogPrimaryWorkbenchCommandTelemetryResult =
  | "job-queued"
  | "job-cancelled"
  | "preview-ready"
  | "draft-created"
  | "profile-activated"
  | "profile-rolled-back"
  | "profile-deprecated"
  | "profile-retired"
  | "section-saved"
  | "section-conflict"
  | "section-invalid"
  | "lifecycle-conflict"
  | "confirmation-required"
  | "preview-required"
  | "job-required"
  | "reason-required"
  | "catalog-sync-blocked"
  | "unsupported-command"
  | "invalid-intent"
  | "command-failed";

export type CatalogPrimaryWorkbenchCommandTelemetryInput = Readonly<{
  context: CatalogPrimaryWorkbenchRouteContext;
  intent: string;
  status: "success" | "error";
  result: CatalogPrimaryWorkbenchCommandTelemetryResult;
  commandSection?: string;
}>;

export type CatalogControlPlaneTelemetryApi = Readonly<{
  recordCatalogControlPlaneEvent?: <T>(event: CatalogControlPlaneTelemetryEventInput) => Promise<T>;
}>;

export async function recordCatalogControlPlaneEvents(
  api: CatalogControlPlaneTelemetryApi,
  events: readonly CatalogControlPlaneTelemetryEventInput[],
): Promise<void> {
  if (!api.recordCatalogControlPlaneEvent || events.length === 0) {
    return;
  }

  await Promise.allSettled(events.map((event) => api.recordCatalogControlPlaneEvent?.(event)));
}

export function loaderTelemetryEvents(
  readModel: CatalogPrimaryWorkbenchReadModel,
): readonly CatalogControlPlaneTelemetryEventInput[] {
  const events: CatalogControlPlaneTelemetryEventInput[] = [
    {
      eventName: "catalog_control_plane.primary_workbench_viewed",
      ...telemetryBaseFromReadModel(readModel),
    },
  ];

  if (readModel.routeContext.providerKey && readModel.routeContext.unitKey && readModel.routeContext.importScope) {
    events.push({
      eventName: "catalog_control_plane.provider_scope_selected",
      ...telemetryBaseFromReadModel(readModel),
    });
  }

  if (
    readModel.routeContext.section === "source-observation-review" ||
    readModel.sourceObservationReview.rows.length > 0
  ) {
    events.push({
      eventName: "catalog_control_plane.observation_review_opened",
      ...telemetryBaseFromReadModel(readModel),
      observationStatus: observationStatusForReadModel(readModel),
      observationCount: readModel.sourceObservationReview.pagination.total,
    });
  }

  if (readModel.routeContext.selectedObservationIds.length > 0) {
    events.push({
      eventName: "catalog_control_plane.observation_evidence_opened",
      ...telemetryBaseFromReadModel(readModel),
      observationStatus: "selected",
      observationCount: readModel.routeContext.selectedObservationIds.length,
    });
  }

  if (readModel.routeContext.promotionPreviewId || readModel.routeContext.section === "promotion-preview") {
    events.push({
      eventName: "catalog_control_plane.promotion_preview_opened",
      ...telemetryBaseFromReadModel(readModel),
      promotionResult: "preview-ready",
      promotionCount: readModel.promotionPreview.outcomeCounts.eligible,
    });
  }

  const blockerCategory = firstBlockerCategory(readModel);
  if (blockerCategory) {
    events.push({
      eventName: "catalog_control_plane.blocker_hit",
      ...telemetryBaseFromReadModel(readModel),
      blockerCategory,
    });
  }

  const detourTarget = detourTargetForSection(readModel.routeContext.section);
  if (detourTarget) {
    events.push({
      eventName: "catalog_control_plane.supporting_workflow_detour_opened",
      ...telemetryBaseFromReadModel(readModel),
      detourTarget,
      detourOutcome: "opened",
    });
  }

  if (readModel.routeContext.section === "import-to-promotion" && readModel.routeContext.returnPath) {
    events.push({
      eventName: "catalog_control_plane.returned_to_primary_path",
      ...telemetryBaseFromReadModel(readModel),
      detourOutcome: "returned",
    });
  }

  return events;
}

export function commandTelemetryEvents(
  input: CatalogPrimaryWorkbenchCommandTelemetryInput,
): readonly CatalogControlPlaneTelemetryEventInput[] {
  const base = telemetryBaseFromContext(input.context);
  const events: CatalogControlPlaneTelemetryEventInput[] = [];
  const promotionResult = promotionTelemetryResult(input.result);

  if (input.intent === "scope.import" || input.intent === "job.retry" || input.intent === "job.resume") {
    events.push({
      eventName:
        input.status === "success" ? "catalog_control_plane.import_started" : "catalog_control_plane.import_failed",
      ...base,
      promotionResult,
      jobRefState: input.context.jobId ? "present" : "none",
      blockerCategory: input.status === "error" ? blockerCategoryForCommandResult(input.result) : null,
    });
  }

  if (input.intent === "observation.promote" && input.status === "success" && input.result === "preview-ready") {
    events.push({
      eventName: "catalog_control_plane.promotion_preview_opened",
      ...base,
      promotionResult,
      promotionCount: input.context.selectedObservationIds.length || null,
    });
  }

  if (input.intent === "provider-profile.clone" && input.status === "success") {
    events.push({
      eventName: "catalog_control_plane.profile_draft_created",
      ...base,
      promotionResult,
      detourTarget: "profile-authoring",
      detourOutcome: "returned",
    });
  }

  if (input.intent === "provider-profile.activate") {
    events.push({
      eventName:
        input.status === "success" ? "catalog_control_plane.profile_activated" : "catalog_control_plane.blocker_hit",
      ...base,
      promotionResult,
      detourTarget: "validation-readiness",
      detourOutcome: input.status === "success" ? "returned" : "blocked",
      blockerCategory: input.status === "error" ? blockerCategoryForCommandResult(input.result) : null,
    });
  }

  if (
    input.intent === "provider-profile.rollback" ||
    input.intent === "provider-profile.deprecate" ||
    input.intent === "provider-profile.retire"
  ) {
    events.push({
      eventName:
        input.status === "success" ? lifecycleTelemetryEventName(input.intent) : "catalog_control_plane.blocker_hit",
      ...base,
      promotionResult,
      detourTarget: "lifecycle-recovery",
      detourOutcome: input.status === "success" ? "returned" : "blocked",
      blockerCategory: input.status === "error" ? blockerCategoryForCommandResult(input.result) : null,
    });
  }

  if (input.intent === "provider-profile.edit-section") {
    const detourTarget =
      input.commandSection === "migration-evidence" && input.context.section === "validation-readiness"
        ? "validation-readiness"
        : "profile-authoring";

    events.push({
      eventName:
        input.status === "success"
          ? "catalog_control_plane.profile_section_saved"
          : "catalog_control_plane.blocker_hit",
      ...base,
      promotionResult,
      detourTarget,
      detourOutcome: input.status === "success" ? "returned" : "blocked",
      blockerCategory: input.status === "error" ? blockerCategoryForCommandResult(input.result) : null,
    });
  }

  if (input.intent === "observation.promote" && input.status === "error") {
    events.push({
      eventName: "catalog_control_plane.blocker_hit",
      ...base,
      promotionResult,
      blockerCategory: blockerCategoryForCommandResult(input.result),
    });
  }

  if (input.intent === "observation.reject") {
    events.push({
      eventName: "catalog_control_plane.observation_rejected",
      ...base,
      observationStatus: "rejected",
      observationCount: input.context.selectedObservationIds.length || null,
      promotionResult,
      blockerCategory: input.status === "error" ? blockerCategoryForCommandResult(input.result) : null,
    });
  }

  if (input.intent === "observation.defer") {
    events.push({
      eventName: "catalog_control_plane.observation_deferred",
      ...base,
      observationStatus: "deferred",
      observationCount: input.context.selectedObservationIds.length || null,
      promotionResult,
      blockerCategory: input.status === "error" ? blockerCategoryForCommandResult(input.result) : null,
    });
  }

  if (input.intent === "observation.reapply" || input.intent === "observation.replay") {
    events.push({
      eventName: "catalog_control_plane.reapply_replay_started",
      ...base,
      observationCount: input.context.selectedObservationIds.length || null,
      promotionResult,
      jobRefState: input.context.jobId ? "present" : "none",
      blockerCategory: input.status === "error" ? blockerCategoryForCommandResult(input.result) : null,
    });
  }

  if (
    input.status === "error" &&
    input.intent !== "observation.promote" &&
    input.intent !== "scope.import" &&
    input.intent !== "job.retry" &&
    input.intent !== "job.resume" &&
    input.intent !== "provider-profile.rollback" &&
    input.intent !== "provider-profile.deprecate" &&
    input.intent !== "provider-profile.retire"
  ) {
    events.push({
      eventName: "catalog_control_plane.blocker_hit",
      ...base,
      promotionResult,
      blockerCategory: blockerCategoryForCommandResult(input.result),
    });
  }

  return events;
}

function telemetryBaseFromReadModel(
  readModel: CatalogPrimaryWorkbenchReadModel,
): Omit<CatalogControlPlaneTelemetryEventInput, "eventName"> {
  return {
    ...telemetryBaseFromContext(readModel.routeContext),
    observationStatus: observationStatusForReadModel(readModel),
    observationCount: readModel.sourceObservationReview.pagination.total,
    promotionResult: readModel.routeContext.promotionPreviewId ? "preview-ready" : "eligible",
    promotionCount: readModel.promotionPreview.outcomeCounts.eligible,
    roleBucket: !readModel.readiness.rbacAllowed
      ? "view-only"
      : !readModel.readiness.rolloutEnabled
        ? "rollout-stopped"
        : "operator",
    readModelFreshness: readModel.readiness.freshness,
  };
}

function telemetryBaseFromContext(
  context: CatalogPrimaryWorkbenchRouteContext,
): Omit<CatalogControlPlaneTelemetryEventInput, "eventName"> {
  return {
    providerKey: context.providerKey,
    unitKey: context.unitKey,
    scopeId: context.importScope,
    profileRef:
      context.providerKey && context.profileVersion ? `${context.providerKey}:${context.profileVersion}` : null,
    jobRefState: context.jobId ? "present" : "none",
    observationStatus: context.selectedObservationIds.length > 0 ? "selected" : "none",
    observationCount: context.selectedObservationIds.length || null,
    promotionResult: context.promotionPreviewId ? "preview-ready" : "none",
    promotionCount: null,
    detourTarget: detourTargetForSection(context.section) ?? null,
    detourOutcome: "not-applicable",
    roleBucket: "unknown",
  };
}

function observationStatusForReadModel(
  readModel: CatalogPrimaryWorkbenchReadModel,
): CatalogControlPlaneTelemetryEventInput["observationStatus"] {
  if (readModel.routeContext.selectedObservationIds.length > 0) {
    return "selected";
  }
  const counts = readModel.sourceObservationReview.counts;
  if (counts.changed > 0 && counts.promoted === 0 && counts.rejected === 0) {
    return "changed";
  }
  if (counts.promoted > 0 && counts.changed === 0) {
    return "promoted";
  }
  if (counts.rejected > 0 && counts.changed === 0) {
    return "rejected";
  }
  if (counts.observed > 0 || counts.changed > 0 || counts.promoted > 0 || counts.rejected > 0) {
    return "mixed";
  }
  return "none";
}

function firstBlockerCategory(
  readModel: CatalogPrimaryWorkbenchReadModel,
): CatalogControlPlaneTelemetryBlockerCategory | null {
  const blocker =
    readModel.readiness.blockers[0] ??
    readModel.importJobs.selectedScope?.readiness.blockers[0] ??
    readModel.promotionPreview.blockers[0];

  return blocker ? telemetryBlockerCategory(blocker) : null;
}

function telemetryBlockerCategory(
  blocker: CatalogPrimaryWorkbenchBlockerCategory,
): CatalogControlPlaneTelemetryBlockerCategory {
  if (blocker.includes("permission") || blocker.includes("authorization") || blocker.includes("rbac")) {
    return "permission";
  }
  if (blocker.includes("rollout") || blocker.includes("kill-switch")) {
    return "rollout";
  }
  if (blocker.includes("active-job") || blocker.includes("concurrent-job")) {
    return "active-job";
  }
  if (blocker.includes("profile")) {
    return "missing-profile";
  }
  if (blocker.includes("fixture")) {
    return "missing-fixture";
  }
  if (blocker.includes("provider-transport") || blocker.includes("provider-credential")) {
    return "provider-transport";
  }
  if (blocker.includes("promotion") || blocker.includes("duplicate")) {
    return "promotion-conflict";
  }
  if (blocker.includes("stale") || blocker.includes("replay") || blocker.includes("idempotency")) {
    return "stale-context";
  }
  if (blocker.includes("read-model") || blocker.includes("projection") || blocker.includes("readiness")) {
    return "readiness";
  }
  return "unknown";
}

function blockerCategoryForCommandResult(
  result: CatalogPrimaryWorkbenchCommandTelemetryResult,
): CatalogControlPlaneTelemetryBlockerCategory {
  if (result === "preview-required") {
    return "stale-context";
  }
  if (result === "job-required") {
    return "active-job";
  }
  if (
    result === "reason-required" ||
    result === "catalog-sync-blocked" ||
    result === "unsupported-command" ||
    result === "invalid-intent" ||
    result === "section-invalid" ||
    result === "confirmation-required"
  ) {
    return "readiness";
  }
  if (result === "section-conflict") {
    return "stale-context";
  }
  if (result === "lifecycle-conflict") {
    return "active-job";
  }
  if (result === "command-failed") {
    return "unknown";
  }
  return "unknown";
}

function promotionTelemetryResult(
  result: CatalogPrimaryWorkbenchCommandTelemetryResult,
): CatalogControlPlaneTelemetryPromotionResult {
  switch (result) {
    case "job-queued":
    case "job-cancelled":
    case "preview-ready":
    case "draft-created":
    case "profile-activated":
    case "profile-rolled-back":
    case "profile-deprecated":
    case "profile-retired":
    case "section-saved":
    case "section-conflict":
    case "section-invalid":
    case "lifecycle-conflict":
    case "confirmation-required":
    case "preview-required":
    case "reason-required":
    case "catalog-sync-blocked":
    case "unsupported-command":
    case "invalid-intent":
    case "command-failed":
      return result;
    case "job-required":
      return "blocked";
  }
}

function lifecycleTelemetryEventName(
  intent: string,
): Extract<
  CatalogControlPlaneTelemetryEventInput["eventName"],
  | "catalog_control_plane.profile_rolled_back"
  | "catalog_control_plane.profile_deprecated"
  | "catalog_control_plane.profile_retired"
> {
  if (intent === "provider-profile.rollback") {
    return "catalog_control_plane.profile_rolled_back";
  }
  if (intent === "provider-profile.deprecate") {
    return "catalog_control_plane.profile_deprecated";
  }

  return "catalog_control_plane.profile_retired";
}

function detourTargetForSection(
  section: string | null | undefined,
): CatalogControlPlaneTelemetryEventInput["detourTarget"] | null {
  const workspace = CATALOG_CONTROL_PLANE_WORKSPACES.find(
    (candidate) => candidate.key === section || candidate.routeSegment === section,
  );

  return workspace?.primaryPathRole === "supporting-detour" ? workspace.key : null;
}
