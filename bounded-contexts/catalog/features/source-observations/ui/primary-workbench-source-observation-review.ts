import type { ListResponse } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchProductContentsEvidenceLine,
  CatalogPrimaryWorkbenchProductContentsEvidenceReview,
  CatalogPrimaryWorkbenchPromotionStaleProtectionKey,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchSourceObservationEvidenceDetail,
} from "../api/primary-workbench-admin-contracts";
import type { SourceObservationProductContentsPromotionLine } from "../domain/domain";
import type { SourceObservationIntegrationScope, SourceObservationListItem } from "./contracts";
import { catalogPrimaryWorkbenchHref } from "./primary-workbench-route-context";
import { actionStateForBlockers, setQueryParam } from "./primary-workbench-read-model-support";
import { scopeContextFromRouteContext, scopeContextToObservationFilterScope } from "./primary-workbench-scope-context";

const defaultReviewPageSize = 25;

// How many normalized fact summaries the dense review cell renders as badges. The
// slim row ships only this preview slice; the full list rides the lazily-fetched
// evidence detail.
const reviewFactSummaryPreviewSize = 3;

// In-process pairing of the slim serialized review with the deep evidence index
// keyed by observationId. The evidence index is NEVER serialized into the daily
// list payload — it feeds the server-side conflict-resolution and audit-evidence
// composers (which read full fact/duplicate/conflict/audit evidence) and is the
// source the lazy evidence endpoint serves one row at a time. Splitting it here is
// what keeps the per-row review payload slim while preserving evidence parity
// everywhere the deep arrays are read.
export type CatalogPrimaryWorkbenchSourceObservationReviewComposition = Readonly<{
  review: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
  evidenceByObservationId: ReadonlyMap<string, CatalogPrimaryWorkbenchSourceObservationEvidenceDetail>;
}>;

export function buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(
  context: CatalogPrimaryWorkbenchRouteContext,
  pagination: Readonly<{ limit?: number; offset?: number }> = {},
): string | null {
  if (!context.providerKey) {
    return null;
  }

  const params = new URLSearchParams();
  const scope = scopeContextToObservationFilterScope(
    scopeContextFromRouteContext(context),
    context.sourceObservationFilters,
  );
  params.set("provider", context.providerKey);
  params.set("limit", String(pagination.limit ?? defaultReviewPageSize));
  params.set("offset", String(pagination.offset ?? 0));
  setQueryParam(params, "status", scope.status);
  setQueryParam(params, "language", scope.language);
  setQueryParam(params, "productLineId", scope.productLineId);
  setQueryParam(params, "seriesId", scope.seriesId);
  setQueryParam(params, "expansionId", scope.expansionId);
  setQueryParam(params, "setId", scope.setId);
  setQueryParam(params, "search", scope.search);

  return params.toString();
}

// Compose the Source Observation review wave: the slim serialized review plus the
// in-process deep-evidence index. The slim review is what ships to the browser;
// the evidence index stays server-side for the conflict/audit composers and the
// lazy evidence endpoint.
export function sourceObservationReviewCompositionFor(input: {
  canManage: boolean;
  changed: number;
  eligible: number;
  observed: number;
  promoted: number;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  rejected: number;
  reviewObservations: ListResponse<SourceObservationListItem> | null;
  reviewUnavailable?: boolean;
  reviewPagination: Readonly<{ limit: number; offset: number }> | undefined;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  scopeRows: readonly SourceObservationIntegrationScope[];
}): CatalogPrimaryWorkbenchSourceObservationReviewComposition {
  const limit = input.reviewPagination?.limit ?? defaultReviewPageSize;
  const offset = input.reviewPagination?.offset ?? 0;
  const total = input.reviewObservations?.total ?? 0;
  const observations = input.reviewObservations?.items ?? [];
  const rows = observations.map((observation) =>
    sourceObservationReviewRowFor(observation, {
      canManage: input.canManage,
      routeContext: input.routeContext,
    }),
  );
  const evidenceByObservationId = new Map<string, CatalogPrimaryWorkbenchSourceObservationEvidenceDetail>(
    observations.map((observation) => [
      observation.observation_id,
      sourceObservationEvidenceDetailFor(observation, { canManage: input.canManage }),
    ]),
  );
  const duplicateConflictCount = rows.filter((row) => row.duplicateCount > 0).length;
  const promotionReadyRowCount = rows.filter((row) => row.promotionReadiness.state === "eligible").length;
  const selectedObservationIds = input.routeContext.selectedObservationIds;
  const selectedRows = rows.filter((row) => selectedObservationIds.includes(row.observationId));
  const summaryMissingButReviewLoaded =
    input.scopeRows.length === 0 && Boolean(input.reviewObservations) && input.reviewUnavailable !== true;
  const effectiveEligible =
    summaryMissingButReviewLoaded && promotionReadyRowCount > 0
      ? (input.reviewObservations?.total ?? promotionReadyRowCount)
      : input.eligible;
  const effectiveObserved =
    summaryMissingButReviewLoaded && input.observed === 0 && promotionReadyRowCount > 0
      ? (input.reviewObservations?.total ?? rows.length)
      : input.observed;
  const promotionReadyCount = promotionReadyCountFor({
    eligible: effectiveEligible,
    promotionReadyRowCount,
    reviewObservations: input.reviewObservations,
    reviewUnavailable: input.reviewUnavailable,
    routeContext: input.routeContext,
  });

  return {
    review: {
      freshness: input.reviewUnavailable ? "unavailable" : input.scopeRows.length > 0 ? "fresh" : "partial",
      counts: {
        observed: effectiveObserved,
        changed: input.changed,
        promoted: input.promoted,
        rejected: input.rejected,
        blocked: input.readinessBlockers.length,
        eligible: effectiveEligible,
      },
      cursor: offset > 0 ? `offset:${offset}` : null,
      selectedObservationIds,
      evidenceSummariesRedacted: true,
      duplicateConflictCount,
      promotionReadyCount,
      filters: reviewFiltersFor(input.routeContext),
      savedFilters: savedReviewFiltersFor(input.routeContext, {
        eligible: effectiveEligible,
        changed: input.changed,
        observed: effectiveObserved,
        rejected: input.rejected,
      }),
      pagination: {
        mode: "offset",
        limit,
        offset,
        total,
        nextCursor: offset + limit < total ? `offset:${offset + limit}` : null,
        previousCursor: offset > 0 ? `offset:${Math.max(0, offset - limit)}` : null,
      },
      bulkSelection: {
        selectedCount: selectedObservationIds.length,
        eligibleSelectedCount: selectedRows.filter((row) => row.promotionReadiness.state === "eligible").length,
        actions: ["observation.promote", "observation.reject", "observation.defer"],
      },
      rows,
    },
    evidenceByObservationId,
  };
}

function promotionReadyCountFor(input: {
  eligible: number;
  promotionReadyRowCount: number;
  reviewObservations: ListResponse<SourceObservationListItem> | null;
  reviewUnavailable: boolean | undefined;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): number {
  if (input.reviewUnavailable && !canUseAggregatePromotionReadiness(input.routeContext, input.eligible)) {
    return 0;
  }
  if (input.routeContext.selectedObservationIds.length > 0) {
    return input.promotionReadyRowCount;
  }
  if (!hasNarrowingReviewFilters(input.routeContext)) {
    return input.eligible;
  }

  return input.reviewObservations ? input.promotionReadyRowCount : input.eligible;
}

function canUseAggregatePromotionReadiness(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  eligible: number,
): boolean {
  return (
    eligible > 0 &&
    Boolean(routeContext.importScope) &&
    routeContext.selectedObservationIds.length === 0 &&
    !hasNarrowingReviewFilters(routeContext)
  );
}

function hasNarrowingReviewFilters(routeContext: CatalogPrimaryWorkbenchRouteContext): boolean {
  const scopeOnlyFilters = new Set(["providerKey", "importScope"]);
  return Object.entries(routeContext.sourceObservationFilters).some(
    ([key, value]) => Boolean(value) && !scopeOnlyFilters.has(key),
  );
}

// Convenience wrapper for callers that only need the serialized review slice.
export function sourceObservationReviewFor(
  input: Parameters<typeof sourceObservationReviewCompositionFor>[0],
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"] {
  return sourceObservationReviewCompositionFor(input).review;
}

// Compose the deep evidence detail for one Source Observation: the full normalized
// facts, duplicate and conflict evidence, audit trail, and every provenance field
// the evidence SideSheet's KeyValueList renders. This is the value the lazy
// evidence endpoint serves and the server composers read — kept byte-identical to
// the review row's inline evidence shape so evidence parity is preserved.
export function sourceObservationEvidenceDetailFor(
  observation: SourceObservationListItem,
  input: {
    canManage: boolean;
    productContentsConfig?: ProductContentsEvidenceConfig;
  },
): CatalogPrimaryWorkbenchSourceObservationEvidenceDetail {
  const promotionReadiness = promotionReadinessFor(observation, input.canManage);

  return {
    observationId: observation.observation_id,
    providerKey: observation.provider_key,
    externalKey: observation.external_key,
    displayName: observation.normalized.name,
    languageCode: observation.language_code,
    sourceUrl: observation.source_url,
    sourceRecordHash: observation.source_record_hash,
    sourceUpdatedAt: observation.source_updated_at,
    observedAt: observation.observed_at,
    changedAt: observation.updated_at,
    sourceProfileVersion: observation.source_profile_version,
    promotionProfileVersion: observation.promotion_profile_version,
    payloadSummary: payloadSummaryFor(observation),
    redactionSummary: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.redaction.summary"),
    normalizedFactSummaries: normalizedFactSummariesFor(observation),
    productContentsEvidence: productContentsEvidenceReviewFor(observation, input.productContentsConfig),
    duplicateEvidence: duplicateEvidenceFor(observation),
    conflictEvidence: conflictEvidenceFor(observation),
    auditTrail: auditTrailFor(observation),
    promotionReadiness,
    commandPreview: {
      promotionPlanHash: observation.promotion_plan_fingerprint,
      disposition: promotionDispositionFor(promotionReadiness.state),
      confirmationRequired: promotionReadiness.state === "eligible",
    },
  };
}

export type ProductContentsEvidenceConfig = Readonly<{
  contentTypeLabelsById?: ReadonlyMap<string, string>;
  inclusionPolicyLabelsById?: ReadonlyMap<string, string>;
}>;

function productContentsEvidenceReviewFor(
  observation: SourceObservationListItem,
  config: ProductContentsEvidenceConfig | undefined,
): CatalogPrimaryWorkbenchProductContentsEvidenceReview {
  const promotion = observation.normalized.productContentsPromotion ?? null;
  const hasRetainedEvidence = Boolean(observation.normalized.productContentsEvidence);
  if (!promotion || promotion.lines.length === 0) {
    return hasRetainedEvidence
      ? {
          state: "unresolved",
          summary: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.unresolved"),
          lineCount: 0,
          rows: [],
        }
      : {
          state: "none",
          summary: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.none"),
          lineCount: 0,
          rows: [],
        };
  }

  const terminalState =
    observation.status === "promoted" ? "promoted" : observation.status === "rejected" ? "rejected" : null;
  const rows = promotion.lines.map((line, index) =>
    productContentsEvidenceLineFor({
      line,
      lineNumber: index + 1,
      terminalState,
      config,
    }),
  );
  const unresolvedCount = rows.filter((row) => row.state === "unresolved").length;
  const state = terminalState ?? (unresolvedCount > 0 ? ("unresolved" as const) : ("reviewable" as const));

  return {
    state,
    summary: productContentsEvidenceSummaryFor({ lineCount: rows.length, state, unresolvedCount }),
    lineCount: rows.length,
    rows,
  };
}

function productContentsEvidenceLineFor(input: {
  line: SourceObservationProductContentsPromotionLine;
  lineNumber: number;
  terminalState: "promoted" | "rejected" | null;
  config: ProductContentsEvidenceConfig | undefined;
}): CatalogPrimaryWorkbenchProductContentsEvidenceLine {
  const contentTypeId = resolvedProductContentsContentTypeId(input.line);
  const containedCatalogItemId = resolvedProductContentsContainedCatalogItemId(input.line);
  const unresolved = !contentTypeId || !containedCatalogItemId;
  const state = input.terminalState ?? (unresolved ? "unresolved" : "reviewable");

  return {
    lineNumber: input.lineNumber,
    state,
    contentTypeLabel: contentTypeId
      ? (input.config?.contentTypeLabelsById?.get(contentTypeId) ?? contentTypeId)
      : t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.unresolvedContentType"),
    contentTypeId,
    inclusionPolicyLabel: input.line.inclusionPolicyId
      ? (input.config?.inclusionPolicyLabelsById?.get(input.line.inclusionPolicyId) ?? input.line.inclusionPolicyId)
      : null,
    inclusionPolicyId: input.line.inclusionPolicyId ?? null,
    quantity: typeof input.line.quantity === "number" ? input.line.quantity : null,
    containedCatalogItemId,
    containedSelectedOptionLabels: selectedOptionLabelsFor(input.line.containedSelectedOptions ?? []),
    targetSummary: productContentsTargetSummaryFor(input.line, containedCatalogItemId),
    provenanceSummary: provenanceSummaryFor(input.line.provenance),
  };
}

function resolvedProductContentsContentTypeId(line: SourceObservationProductContentsPromotionLine): string | null {
  const direct = nonEmptyString(line.contentTypeId) ? line.contentTypeId.trim() : null;
  if (direct) {
    return direct;
  }
  const candidates = uniqueStrings(line.candidateContentTypeIds ?? []);
  return candidates.length === 1 ? candidates[0] : null;
}

function resolvedProductContentsContainedCatalogItemId(
  line: SourceObservationProductContentsPromotionLine,
): string | null {
  const direct = nonEmptyString(line.containedCatalogItemId) ? line.containedCatalogItemId.trim() : null;
  if (direct) {
    return direct;
  }
  const candidates = uniqueStrings(line.candidateCatalogItemIds ?? []);
  return candidates.length === 1 ? candidates[0] : null;
}

function selectedOptionLabelsFor(
  selectedOptions: NonNullable<SourceObservationProductContentsPromotionLine["containedSelectedOptions"]>,
): readonly string[] {
  return selectedOptions.map((option) =>
    t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.selectedOption", {
      dimensionId: option.dimensionId,
      optionId: option.optionId,
    }),
  );
}

function productContentsTargetSummaryFor(
  line: SourceObservationProductContentsPromotionLine,
  containedCatalogItemId: string | null,
): string {
  if (containedCatalogItemId) {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.target.resolved", {
      catalogItemId: containedCatalogItemId,
    });
  }
  const candidates = uniqueStrings(line.candidateCatalogItemIds ?? []);
  if (candidates.length > 1) {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.target.ambiguous", {
      count: candidates.length,
    });
  }
  return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.target.unresolved");
}

function provenanceSummaryFor(provenance: unknown): readonly string[] {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    return [];
  }
  return Object.keys(provenance)
    .filter((key) => key.trim().length > 0)
    .filter(isSafeProvenanceKey)
    .sort()
    .map((key) =>
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.provenance.key", { key }),
    );
}

function isSafeProvenanceKey(key: string): boolean {
  return !/(secret|token|credential|password|private|url|payload|raw)/i.test(key);
}

function productContentsEvidenceSummaryFor(input: {
  lineCount: number;
  state: CatalogPrimaryWorkbenchProductContentsEvidenceReview["state"];
  unresolvedCount: number;
}): string {
  if (input.state === "promoted") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.promoted", {
      count: input.lineCount,
    });
  }
  if (input.state === "rejected") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.rejected", {
      count: input.lineCount,
    });
  }
  if (input.state === "unresolved") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.lines.unresolved", {
      count: input.lineCount,
      unresolved: input.unresolvedCount,
    });
  }
  return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.productContents.reviewable", {
    count: input.lineCount,
  });
}

export function promotionPreviewFor(input: {
  activeJobCount: number;
  activeProfileVersion: string | null;
  canManage: boolean;
  failedJobCount: number;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
  // Deep-evidence index keyed by observationId. The slim review row does not
  // carry conflict evidence or the source profile version, so the preview reads
  // those (conflicting-disposition count + the replay profile semantics) from the
  // composed evidence index instead.
  reviewEvidenceByObservationId: ReadonlyMap<string, CatalogPrimaryWorkbenchSourceObservationEvidenceDetail>;
}): CatalogPrimaryWorkbenchReadModel["promotionPreview"] {
  const selectedObservationIds = input.routeContext.selectedObservationIds;
  const selectedIdSet = new Set(selectedObservationIds);
  const hasExplicitRows = selectedObservationIds.length > 0;
  const scopedRows = hasExplicitRows
    ? input.sourceObservationReview.rows.filter((row) => selectedIdSet.has(row.observationId))
    : input.sourceObservationReview.rows;
  const eligibleCount = hasExplicitRows
    ? scopedRows.filter((row) => row.promotionReadiness.state === "eligible").length
    : input.sourceObservationReview.promotionReadyCount;
  const requestedCount = hasExplicitRows
    ? selectedObservationIds.length
    : Math.max(input.sourceObservationReview.pagination.total, eligibleCount);
  const blockedCount =
    scopedRows.length > 0
      ? scopedRows.filter((row) => row.promotionReadiness.state === "blocked").length
      : input.readinessBlockers.length;
  const skippedCount =
    scopedRows.length > 0
      ? scopedRows.filter(
          (row) => row.promotionReadiness.state === "already-promoted" || row.promotionReadiness.state === "rejected",
        ).length
      : hasExplicitRows
        ? Math.max(requestedCount - eligibleCount - blockedCount, 0)
        : input.sourceObservationReview.counts.rejected;
  const conflictingCount =
    scopedRows.length > 0
      ? scopedRows.filter(
          (row) =>
            row.duplicateCount > 0 ||
            (input.reviewEvidenceByObservationId.get(row.observationId)?.conflictEvidence.length ?? 0) > 0,
        ).length
      : input.sourceObservationReview.duplicateConflictCount;
  const scope: CatalogPrimaryWorkbenchReadModel["promotionPreview"]["scope"] = {
    kind: hasExplicitRows ? "explicit-rows" : "matching-filter",
    label: hasExplicitRows
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.command.scope.explicit")
      : t("catalog.features.sourceObservations.ui.primaryWorkbench.command.scope.matching"),
    requestedCount,
    eligibleCount,
    selectedObservationIds,
    filterSummary: promotionFilterSummaryFor(input.sourceObservationReview),
    partialFailureMode: "per-observation",
  };
  const staleReasons = promotionPreviewStaleReasonsFor({
    activeProfileVersion: input.activeProfileVersion,
    canManage: input.canManage,
    routeContext: input.routeContext,
    sourceObservationReview: input.sourceObservationReview,
    readinessBlockers: input.readinessBlockers,
    eligibleCount,
  });
  const overlappingActionBlockers = [
    ...(input.activeJobCount > 0 ? (["active-job-conflict"] as const) : []),
    ...(input.activeJobCount > 1 ? (["concurrent-job"] as const) : []),
  ];
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (eligibleCount <= 0) {
    blockers.add("no-promotion-eligible-observations");
  }
  if (!input.canManage) {
    blockers.add("permission-denied");
  }
  for (const blocker of input.readinessBlockers.filter(isPromotionExecutionReadinessBlocker)) {
    blockers.add(blocker);
  }
  for (const blocker of overlappingActionBlockers) {
    blockers.add(blocker);
  }
  if (scopedRows.some((row) => row.promotionReadiness.blockers.includes("promotion-conflict"))) {
    blockers.add("promotion-conflict");
  }
  if (staleReasons.length > 0) {
    blockers.add("stale-promotion-preview");
  }
  const confirmationRequired = eligibleCount > 0;
  const commandPlanHash = input.routeContext.promotionPreviewId
    ? [
        "preview",
        input.routeContext.promotionPreviewId,
        scope.kind,
        `requested:${scope.requestedCount}`,
        `eligible:${scope.eligibleCount}`,
        `profile:${input.routeContext.profileVersion ?? "none"}`,
      ].join(":")
    : null;

  return {
    previewId: input.routeContext.promotionPreviewId,
    freshness: staleReasons.length > 0 ? "stale" : eligibleCount > 0 ? "fresh" : "partial",
    scope,
    dispositions: {
      eligible: eligibleCount,
      skipped: skippedCount,
      blocked: blockedCount,
      conflicting: conflictingCount,
      destructive: 0,
      "stale-preview": staleReasons.length > 0 ? 1 : 0,
      "confirmation-required": confirmationRequired ? 1 : 0,
    },
    outcomeCounts: {
      eligible: eligibleCount,
      blocked: blockedCount,
      skipped: skippedCount,
      conflicting: conflictingCount,
      failed: input.failedJobCount,
    },
    commandPlanHash,
    confirmationRequired,
    destructiveCount: 0,
    executionSafeguards: {
      previewRequired: true,
      previewFresh: Boolean(input.routeContext.promotionPreviewId) && staleReasons.length === 0,
      stalePreviewRejected: staleReasons.length > 0,
      idempotencyRequired: true,
      doubleSubmitProtection: true,
      rejectsWhenChanged: ["observations", "profile-version", "rollout-state", "permissions", "command-inputs"],
      staleReasons,
      overlappingActionBlockers,
    },
    reviewDecisions: {
      reject: {
        reasonRequired: true,
        partialFailureMode: "failed-observations-remain-in-scope",
        auditEvidenceRequired: true,
      },
      defer: {
        stateChange: "keeps-observation-in-review",
        returnsToReviewWhen: "next-provider-import-or-filter-reset",
        auditEvidenceRequired: true,
      },
    },
    profileWorkflows: {
      reapply: {
        profileSemantics: "current-active-profile",
        target: "promoted-observations",
        profileVersion: input.activeProfileVersion,
      },
      replay: {
        profileSemantics: "original-source-profile-version",
        target: "source-observation-evidence",
        profileVersion:
          (scopedRows[0]
            ? input.reviewEvidenceByObservationId.get(scopedRows[0].observationId)?.sourceProfileVersion
            : null) ?? input.routeContext.profileVersion,
      },
    },
    blockers: [...blockers],
  };
}

function promotionFilterSummaryFor(
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"],
): readonly string[] {
  const activeFilters = sourceObservationReview.filters
    .filter((filterEntry) => filterEntry.value)
    .map((filterEntry) => `${filterEntry.label}: ${filterEntry.value}`);

  return activeFilters.length > 0
    ? activeFilters
    : [t("catalog.features.sourceObservations.ui.primaryWorkbench.command.scope.no.filters")];
}

function promotionPreviewStaleReasonsFor(input: {
  activeProfileVersion: string | null;
  canManage: boolean;
  eligibleCount: number;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
}): readonly CatalogPrimaryWorkbenchPromotionStaleProtectionKey[] {
  if (!input.routeContext.promotionPreviewId) {
    return [];
  }

  const staleReasons = new Set<CatalogPrimaryWorkbenchPromotionStaleProtectionKey>();
  if (
    input.sourceObservationReview.freshness !== "fresh" &&
    !canUseAggregatePromotionReadiness(input.routeContext, input.sourceObservationReview.counts.eligible)
  ) {
    staleReasons.add("observations");
  }
  if (
    input.routeContext.profileVersion &&
    input.activeProfileVersion &&
    input.routeContext.profileVersion !== input.activeProfileVersion
  ) {
    staleReasons.add("profile-version");
  }
  if (input.readinessBlockers.some((blocker) => blocker === "rollout-disabled" || blocker === "kill-switch-active")) {
    staleReasons.add("rollout-state");
  }
  if (!input.canManage || input.readinessBlockers.includes("permission-denied")) {
    staleReasons.add("permissions");
  }
  if (input.eligibleCount <= 0) {
    staleReasons.add("command-inputs");
  }

  return [...staleReasons];
}

function isPromotionExecutionReadinessBlocker(blocker: CatalogPrimaryWorkbenchBlockerCategory): boolean {
  switch (blocker) {
    case "authorization-denied":
    case "deploy-skew-unsupported-version":
    case "kill-switch-active":
    case "missing-active-profile":
    case "permission-denied":
    case "profile-version-missing":
    case "read-model-unavailable":
    case "rollout-disabled":
    case "security-privacy-blocked":
    case "source-projection-stale":
      return true;
    default:
      return false;
  }
}

function sourceObservationReviewRowFor(
  observation: SourceObservationListItem,
  input: { canManage: boolean; routeContext: CatalogPrimaryWorkbenchRouteContext },
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number] {
  const promotionReadiness = promotionReadinessFor(observation, input.canManage);
  const detailHref = catalogPrimaryWorkbenchHref(
    {
      ...input.routeContext,
      selectedObservationIds: [observation.observation_id],
      sourceObservationFilters: {
        ...input.routeContext.sourceObservationFilters,
        providerKey: observation.provider_key,
        status: observation.status,
      },
    },
    "source-observation-review",
  );

  return {
    observationId: observation.observation_id,
    providerKey: observation.provider_key,
    externalKey: observation.external_key,
    displayName: observation.normalized.name,
    status: observation.status,
    statusReason: observation.status_reason,
    sourceUpdatedAt: observation.source_updated_at,
    changedAt: observation.updated_at,
    // Cell-only data: the first-N facts the badges render and the duplicate COUNT
    // the warning badge shows. The full fact/duplicate lists ship lazily with the
    // evidence detail, not per row.
    factSummaryPreview: normalizedFactSummariesFor(observation).slice(0, reviewFactSummaryPreviewSize),
    payloadSummary: payloadSummaryFor(observation),
    redactionSummary: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.redaction.summary"),
    duplicateCount: duplicateEvidenceFor(observation).length,
    promotionReadiness,
    commandPreview: {
      promotionPlanHash: observation.promotion_plan_fingerprint,
      disposition: promotionDispositionFor(promotionReadiness.state),
      confirmationRequired: promotionReadiness.state === "eligible",
    },
    detailHref,
    actions: rowActionsFor(observation, {
      canManage: input.canManage,
      detailHref,
      promotionReadiness,
    }),
  };
}

function promotionDispositionFor(
  state: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]["promotionReadiness"]["state"],
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]["commandPreview"]["disposition"] {
  if (state === "eligible") {
    return "eligible";
  }
  if (state === "already-promoted" || state === "rejected") {
    return "skipped";
  }

  return "blocked";
}

function reviewFiltersFor(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["filters"] {
  const scope = scopeContextToObservationFilterScope(
    scopeContextFromRouteContext(routeContext),
    routeContext.sourceObservationFilters,
  );

  return [
    filter(
      "providerKey",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.provider"),
      routeContext.providerKey,
      Boolean(routeContext.providerKey),
    ),
    filter(
      "unitKey",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.unit"),
      routeContext.unitKey,
      Boolean(routeContext.unitKey),
    ),
    filter(
      "profileVersion",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.profile"),
      routeContext.profileVersion,
      Boolean(routeContext.profileVersion),
    ),
    filter(
      "status",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.status"),
      scope.status ?? null,
      true,
    ),
    filter(
      "language",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.language"),
      scope.language ?? null,
      true,
    ),
    filter(
      "setId",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.set"),
      scope.expansionId ?? scope.setId ?? null,
      true,
    ),
    filter(
      "observedAfter",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.observed.after"),
      routeContext.sourceObservationFilters.observedAfter ?? null,
      false,
    ),
    filter(
      "observedBefore",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.observed.before"),
      routeContext.sourceObservationFilters.observedBefore ?? null,
      false,
    ),
  ];
}

function savedReviewFiltersFor(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  counts: { eligible: number; changed: number; observed: number; rejected: number },
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["savedFilters"] {
  const providerFilter: Record<string, string> = {};
  if (routeContext.providerKey) {
    providerFilter.providerKey = routeContext.providerKey;
  }

  return [
    {
      key: "ready-for-promotion",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.saved.ready"),
      filters: providerFilter,
      count: counts.eligible,
    },
    {
      key: "new-observations",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.saved.new"),
      filters: { ...providerFilter, status: "observed" },
      count: counts.observed,
    },
    {
      key: "changed-since-last-pull",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.saved.changed"),
      filters: { ...providerFilter, status: "changed" },
      count: counts.changed,
    },
    {
      key: "rejected-audit",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.saved.rejected"),
      filters: { ...providerFilter, status: "rejected" },
      count: counts.rejected,
    },
  ];
}

function filter(
  key: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["filters"][number]["key"],
  label: string,
  value: string | null,
  serverApplied: boolean,
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["filters"][number] {
  return { key, label, value, serverApplied };
}

function normalizedFactSummariesFor(observation: SourceObservationListItem): readonly string[] {
  const normalized = observation.normalized;
  const facts = [
    normalized.kind,
    normalized.name,
    normalized.expansionName ?? normalized.setName,
    normalized.cardNumber,
    "providerProductId" in normalized ? normalized.providerProductId : null,
    "productLineName" in normalized ? normalized.productLineName : null,
    "productCategoryName" in normalized ? normalized.productCategoryName : null,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return [...new Set(facts)].slice(0, 5);
}

function payloadSummaryFor(observation: SourceObservationListItem): string {
  const imageCount = observation.normalized.imageUrls.length;
  const externalReferenceCount =
    (observation.normalized.externalCatalogItemReferences?.length ?? 0) +
    (observation.normalized.externalProductReferences?.length ?? 0) +
    (observation.normalized.kind === "provider-product" ? observation.normalized.skuReferences.length : 0);

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.review.payload.summary", {
    kind: observation.normalized.kind,
    imageCount,
    externalReferenceCount,
  });
}

function duplicateEvidenceFor(observation: SourceObservationListItem): readonly string[] {
  const evidence = new Set<string>();
  const mergeIdentity = observation.normalized.mergeIdentity;
  if (mergeIdentity) {
    evidence.add(
      [
        mergeIdentity.tcg,
        mergeIdentity.productLineName,
        mergeIdentity.setName,
        mergeIdentity.printedProductName,
        mergeIdentity.collectorNumber,
        mergeIdentity.languageCode,
        mergeIdentity.productForm,
        mergeIdentity.barcode,
      ]
        .filter(Boolean)
        .join(" / "),
    );
  }
  for (const reference of observation.normalized.externalCatalogItemReferences ?? []) {
    evidence.add(
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.duplicate.catalog.reference", {
        provider: reference.providerKey,
        external: reference.externalKey,
      }),
    );
  }
  for (const reference of observation.normalized.externalProductReferences ?? []) {
    evidence.add(
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.duplicate.product.reference", {
        provider: reference.providerKey,
        external: reference.externalKey,
      }),
    );
  }

  return [...evidence].filter(Boolean).slice(0, 4);
}

function conflictEvidenceFor(observation: SourceObservationListItem): readonly string[] {
  const evidence: string[] = [];
  if (observation.status === "changed") {
    evidence.push(t("catalog.features.sourceObservations.ui.primaryWorkbench.review.conflict.changed"));
  }
  if (observation.status_reason) {
    evidence.push(observation.status_reason);
  }
  if (observation.promoted_catalog_item_id && observation.status !== "promoted") {
    evidence.push(
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.conflict.linked.catalog.item", {
        itemId: observation.promoted_catalog_item_id,
      }),
    );
  }

  return evidence;
}

function promotionReadinessFor(
  observation: SourceObservationListItem,
  canManage: boolean,
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]["promotionReadiness"] {
  if (observation.status === "promoted") {
    return { state: "already-promoted", blockers: ["no-promotion-eligible-observations"] };
  }
  if (observation.status === "rejected") {
    return { state: "rejected", blockers: ["no-promotion-eligible-observations"] };
  }
  if (observation.promoted_catalog_item_id && observation.status !== "promoted") {
    return { state: "blocked", blockers: ["promotion-conflict"] };
  }
  if (!canManage) {
    return { state: "blocked", blockers: ["permission-denied"] };
  }

  return { state: "eligible", blockers: [] };
}

function rowActionsFor(
  observation: SourceObservationListItem,
  input: {
    canManage: boolean;
    detailHref: string;
    promotionReadiness: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]["promotionReadiness"];
  },
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]["actions"] {
  const manageState: CatalogPrimaryWorkbenchActionReadModel["state"] = input.canManage ? "available" : "denied";
  const manageBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] = input.canManage
    ? []
    : ["permission-denied"];
  const promotionBlockers = input.promotionReadiness.blockers;
  const promotionState =
    promotionBlockers.length > 0
      ? input.promotionReadiness.state === "blocked"
        ? "blocked"
        : "disabled"
      : manageState;
  const replayBlockers =
    observation.status !== "promoted"
      ? (["no-promotion-eligible-observations"] as readonly CatalogPrimaryWorkbenchBlockerCategory[])
      : hasOriginalSourceProfileEvidence(observation)
        ? manageBlockers
        : (["profile-version-missing"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const replayState = actionStateForBlockers(replayBlockers, manageState);

  return [
    { key: "view-source-observation", state: "available", blockers: [], href: input.detailHref },
    { key: "observation.promote", state: promotionState, blockers: promotionBlockers, href: input.detailHref },
    {
      key: "observation.reject",
      state: observation.status === "observed" || observation.status === "changed" ? manageState : "disabled",
      blockers:
        observation.status === "observed" || observation.status === "changed"
          ? manageBlockers
          : ["no-promotion-eligible-observations"],
      href: input.detailHref,
    },
    {
      key: "observation.defer",
      state: observation.status === "observed" || observation.status === "changed" ? manageState : "disabled",
      blockers:
        observation.status === "observed" || observation.status === "changed"
          ? manageBlockers
          : ["no-promotion-eligible-observations"],
      href: input.detailHref,
    },
    {
      key: "observation.reapply",
      state: observation.status === "promoted" ? manageState : "disabled",
      blockers: observation.status === "promoted" ? manageBlockers : ["no-promotion-eligible-observations"],
      href: input.detailHref,
    },
    {
      key: "observation.replay",
      state: replayState,
      blockers: replayBlockers,
      href: input.detailHref,
    },
  ];
}

function hasOriginalSourceProfileEvidence(observation: SourceObservationListItem): boolean {
  const sourceProfileKey = observation.source_profile_key.trim();
  const sourceProfileVersion = observation.source_profile_version.trim();
  return sourceProfileKey.length > 0 && sourceProfileVersion.length > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function auditTrailFor(observation: SourceObservationListItem): readonly string[] {
  return [
    t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.observed", {
      observedAt: observation.observed_at,
    }),
    observation.source_updated_at
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.provider.changed", {
          changedAt: observation.source_updated_at,
        })
      : null,
    t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.source.profile", {
      profileKey: observation.source_profile_key,
      profileVersion: observation.source_profile_version,
    }),
    observation.promotion_profile_version
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.promotion.profile", {
          profileKey:
            observation.promotion_profile_key ??
            t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.unknown"),
          profileVersion: observation.promotion_profile_version,
        })
      : null,
    observation.promoted_at
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.review.audit.promoted", {
          promotedAt: observation.promoted_at,
        })
      : null,
  ].filter((value): value is string => Boolean(value));
}
