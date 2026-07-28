import type { CatalogProviderOptionQueryCacheStatus } from "../providers/provider-option-query-cache";

export const catalogControlPlaneTelemetryEventNames = [
  "catalog_control_plane.primary_workbench_viewed",
  "catalog_control_plane.provider_scope_selected",
  "catalog_control_plane.import_started",
  "catalog_control_plane.import_completed",
  "catalog_control_plane.import_failed",
  "catalog_control_plane.observation_review_opened",
  "catalog_control_plane.observation_evidence_opened",
  "catalog_control_plane.promotion_preview_opened",
  "catalog_control_plane.promotion_completed",
  "catalog_control_plane.promotion_failed",
  "catalog_control_plane.observation_rejected",
  "catalog_control_plane.observation_deferred",
  "catalog_control_plane.profile_draft_created",
  "catalog_control_plane.profile_activated",
  "catalog_control_plane.profile_rolled_back",
  "catalog_control_plane.profile_deprecated",
  "catalog_control_plane.profile_retired",
  "catalog_control_plane.profile_section_saved",
  "catalog_control_plane.reapply_replay_started",
  "catalog_control_plane.blocker_hit",
  "catalog_control_plane.supporting_workflow_detour_opened",
  "catalog_control_plane.returned_to_primary_path",
] as const;

export type CatalogControlPlaneTelemetryEventName = (typeof catalogControlPlaneTelemetryEventNames)[number];

export const catalogControlPlaneTelemetryBlockerCategories = [
  "permission",
  "rollout",
  "readiness",
  "active-job",
  "missing-profile",
  "missing-fixture",
  "provider-transport",
  "promotion-conflict",
  "stale-context",
  "unknown",
] as const;

export type CatalogControlPlaneTelemetryBlockerCategory =
  (typeof catalogControlPlaneTelemetryBlockerCategories)[number];

export const catalogControlPlaneTelemetryDetourTargets = [
  "health-triage",
  "profile-authoring",
  "validation-readiness",
  "adapter-readiness",
  "conflict-resolution",
  "lifecycle-recovery",
  "governance-controls",
  "clean-reset-release",
  "audit-evidence",
  "none",
] as const;

export type CatalogControlPlaneTelemetryDetourTarget = (typeof catalogControlPlaneTelemetryDetourTargets)[number];

export const catalogControlPlaneTelemetryDetourOutcomes = [
  "opened",
  "returned",
  "blocked",
  "abandoned",
  "not-applicable",
] as const;

export type CatalogControlPlaneTelemetryDetourOutcome = (typeof catalogControlPlaneTelemetryDetourOutcomes)[number];

export const catalogControlPlaneTelemetryRoleBuckets = [
  "view-only",
  "operator",
  "admin",
  "denied",
  "rollout-stopped",
  "unknown",
] as const;

export type CatalogControlPlaneTelemetryRoleBucket = (typeof catalogControlPlaneTelemetryRoleBuckets)[number];

export const catalogControlPlaneTelemetryObservationStatuses = [
  "observed",
  "changed",
  "promoted",
  "rejected",
  "deferred",
  "selected",
  "mixed",
  "none",
  "unknown",
] as const;

export type CatalogControlPlaneTelemetryObservationStatus =
  (typeof catalogControlPlaneTelemetryObservationStatuses)[number];

export const catalogControlPlaneTelemetryPromotionResults = [
  "eligible",
  "blocked",
  "skipped",
  "conflicting",
  "completed",
  "failed",
  "preview-ready",
  "preview-required",
  "job-queued",
  "job-cancelled",
  "draft-created",
  "profile-activated",
  "profile-rolled-back",
  "profile-deprecated",
  "profile-retired",
  "section-saved",
  "section-conflict",
  "section-invalid",
  "lifecycle-conflict",
  "confirmation-required",
  "reason-required",
  "catalog-sync-blocked",
  "unsupported-command",
  "invalid-intent",
  "command-failed",
  "none",
  "unknown",
] as const;

export type CatalogControlPlaneTelemetryPromotionResult = (typeof catalogControlPlaneTelemetryPromotionResults)[number];

export const catalogControlPlaneTelemetryCountBuckets = [
  "0",
  "1",
  "2-10",
  "11-100",
  "101-1000",
  "1001+",
  "unknown",
] as const;

export type CatalogControlPlaneTelemetryCountBucket = (typeof catalogControlPlaneTelemetryCountBuckets)[number];

export const catalogControlPlaneTelemetryJobRefStates = ["present", "none"] as const;

export type CatalogControlPlaneTelemetryJobRefState = (typeof catalogControlPlaneTelemetryJobRefStates)[number];

export type CatalogControlPlaneTelemetryEventInput = Readonly<{
  eventName: CatalogControlPlaneTelemetryEventName;
  providerKey?: string | null;
  unitKey?: string | null;
  scopeId?: string | null;
  profileRef?: string | null;
  jobRefState?: CatalogControlPlaneTelemetryJobRefState | null;
  observationStatus?: CatalogControlPlaneTelemetryObservationStatus | null;
  observationCount?: number | null;
  promotionResult?: CatalogControlPlaneTelemetryPromotionResult | null;
  promotionCount?: number | null;
  blockerCategory?: CatalogControlPlaneTelemetryBlockerCategory | null;
  detourTarget?: CatalogControlPlaneTelemetryDetourTarget | null;
  detourOutcome?: CatalogControlPlaneTelemetryDetourOutcome | null;
  roleBucket?: CatalogControlPlaneTelemetryRoleBucket | null;
  readModelFreshness?: string | null;
}>;

export type CatalogControlPlaneTelemetryEvent = Readonly<{
  eventName: CatalogControlPlaneTelemetryEventName;
  providerKey: string;
  unitKey: string;
  scopeId: string;
  profileRef: string;
  jobRefState: CatalogControlPlaneTelemetryJobRefState;
  observationStatus: CatalogControlPlaneTelemetryObservationStatus;
  observationCountBucket: CatalogControlPlaneTelemetryCountBucket;
  promotionResult: CatalogControlPlaneTelemetryPromotionResult;
  promotionCountBucket: CatalogControlPlaneTelemetryCountBucket;
  blockerCategory: CatalogControlPlaneTelemetryBlockerCategory;
  detourTarget: CatalogControlPlaneTelemetryDetourTarget;
  detourOutcome: CatalogControlPlaneTelemetryDetourOutcome;
  roleBucket: CatalogControlPlaneTelemetryRoleBucket;
  readModelFreshness: string;
}>;

export type CatalogIntegrationOptionQueryTelemetryEvent = Readonly<{
  providerKey: string;
  queryKind: string;
  cacheStatus: CatalogProviderOptionQueryCacheStatus | "error";
  cacheSource: "cache" | "live" | "none";
  result: "success" | "failure";
  degraded: boolean;
  cacheOnly: boolean;
  forceRefresh: boolean;
}>;

export type CatalogIntegrationJobTelemetryEvent = Readonly<{
  jobKind: "import" | "reapply" | "promote" | "reject" | "defer";
  result: "completed" | "failed" | "skipped" | "cancelled" | "released" | "reconciled";
}>;

export type SourceObservationTelemetry = Readonly<{
  recordProviderOptionQuery?: (event: CatalogIntegrationOptionQueryTelemetryEvent) => void;
  recordIntegrationJob?: (event: CatalogIntegrationJobTelemetryEvent) => void;
  recordBulkReviewWorkUnit?: (event: CatalogIntegrationJobTelemetryEvent) => void;
  recordControlPlaneEvent?: (event: CatalogControlPlaneTelemetryEvent) => void;
}>;

export function normalizeCatalogControlPlaneTelemetryEvent(
  input: CatalogControlPlaneTelemetryEventInput,
): CatalogControlPlaneTelemetryEvent {
  return {
    eventName: input.eventName,
    providerKey: safeTelemetryDimension(input.providerKey),
    unitKey: safeTelemetryDimension(input.unitKey),
    scopeId: safeTelemetryDimension(input.scopeId),
    profileRef: safeTelemetryDimension(input.profileRef),
    jobRefState: allowedValue(input.jobRefState, catalogControlPlaneTelemetryJobRefStates, "none"),
    observationStatus: allowedValue(input.observationStatus, catalogControlPlaneTelemetryObservationStatuses, "none"),
    observationCountBucket: telemetryCountBucket(input.observationCount),
    promotionResult: allowedValue(input.promotionResult, catalogControlPlaneTelemetryPromotionResults, "none"),
    promotionCountBucket: telemetryCountBucket(input.promotionCount),
    blockerCategory: allowedValue(input.blockerCategory, catalogControlPlaneTelemetryBlockerCategories, "unknown"),
    detourTarget: allowedValue(input.detourTarget, catalogControlPlaneTelemetryDetourTargets, "none"),
    detourOutcome: allowedValue(input.detourOutcome, catalogControlPlaneTelemetryDetourOutcomes, "not-applicable"),
    roleBucket: allowedValue(input.roleBucket, catalogControlPlaneTelemetryRoleBuckets, "unknown"),
    readModelFreshness: safeTelemetryDimension(input.readModelFreshness),
  };
}

export function isCatalogControlPlaneTelemetryEventName(
  value: unknown,
): value is CatalogControlPlaneTelemetryEventName {
  return (
    typeof value === "string" &&
    catalogControlPlaneTelemetryEventNames.includes(value as CatalogControlPlaneTelemetryEventName)
  );
}

function telemetryCountBucket(value: number | null | undefined): CatalogControlPlaneTelemetryCountBucket {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "unknown";
  }
  const count = Math.floor(value);
  if (count === 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 10) {
    return "2-10";
  }
  if (count <= 100) {
    return "11-100";
  }
  if (count <= 1000) {
    return "101-1000";
  }
  return "1001+";
}

function safeTelemetryDimension(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "none";
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 96 || !/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
    return "none";
  }
  return trimmed;
}

function allowedValue<const T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}
