import type { ListResponse } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import {
  catalogPrimaryWorkbenchContractVersion,
  catalogPrimaryWorkbenchDeploySkewPolicies,
  catalogPrimaryWorkbenchInstrumentationDimensions,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogPrimaryWorkbenchActionReadModel,
  type CatalogPrimaryWorkbenchBlockerCategory,
  type CatalogPrimaryWorkbenchProviderTransportCategory,
  type CatalogPrimaryWorkbenchPromotionStaleProtectionKey,
  type CatalogPrimaryWorkbenchReadModel,
  type CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import { defineCatalogIntegrationUnitKey, type CatalogIntegrationUnitKey } from "../api/integration-unit";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogProviderProfileVersionReview,
  SourceObservationListItem,
  SourceObservationIntegrationScope,
} from "./contracts";
import {
  catalogPrimaryWorkbenchHref,
  catalogPrimaryWorkbenchSupportingHref,
  parseCatalogPrimaryWorkbenchRouteContext,
} from "./primary-workbench-route-context";

export type CatalogPrimaryWorkbenchInput = Readonly<{
  requestUrl: string | URL;
  scopes: ListResponse<SourceObservationIntegrationScope>;
  profileReviews: ListResponse<CatalogProviderProfileVersionReview>;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  reviewObservations?: ListResponse<SourceObservationListItem> | null;
  reviewPagination?: Readonly<{ limit: number; offset: number }>;
  canManageCatalog: boolean;
}>;

type CatalogIntegrationRecentJobReadModel =
  CatalogIntegrationControlPlaneOverview["unitActivity"]["units"][number]["recentJobs"][number];

const defaultReviewPageSize = 25;

export function buildCatalogPrimaryWorkbenchReadModel(
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchReadModel {
  const parsedContext = parseCatalogPrimaryWorkbenchRouteContext(input.requestUrl);
  const providerKey = parsedContext.providerKey ?? inferProviderKey(input);
  const activeProfile = findActiveProfile(input.profileReviews.items, providerKey);
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
  const eligible = Math.max(changed - rejected, 0);
  const providerTransport = providerTransportFor(input.controlPlaneOverview, providerKey);
  const readinessBlockers = readinessBlockersFor(input, providerKey, activeProfile);
  const rolloutEnabled =
    input.controlPlaneOverview?.readiness.rolloutControls.controls.every((control) => control.status !== "blocked") ??
    true;
  const importJobRows = importJobsFor(input.controlPlaneOverview, routeContext);
  const activeJobCount = importJobRows.filter((job) => job.state === "queued" || job.state === "running").length;
  const failedJobCount = importJobRows.filter((job) => job.state === "failed").length;
  const canManage = input.canManageCatalog;
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
  const actions = buildActions({
    canManage,
    providerSelected: Boolean(providerKey && unitKey && importScope),
    activeProfileReady: Boolean(activeProfile),
    eligible: promotionPreview.outcomeCounts.eligible,
    activeJobCount,
    blockers: readinessBlockers,
    promotionBlockers: promotionPreview.blockers,
  });

  const readModel: CatalogPrimaryWorkbenchReadModel = {
    schemaVersion: catalogPrimaryWorkbenchContractVersion,
    generatedAt: input.controlPlaneOverview?.generatedAt ?? new Date().toISOString(),
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
    importJobs: {
      freshness: input.controlPlaneOverview ? "fresh" : "partial",
      activeJobCount,
      failedJobCount,
      selectedScope: selectedImportScopeFor({
        activeProfile,
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
    promotionPreview,
    promotionResult: null,
    actions,
    deploySkew: catalogPrimaryWorkbenchDeploySkewPolicies[0],
    securityPrivacy: {
      redactionApplied: true,
      governedDataClasses: ["provider payload", "operator identity", "external source URLs"],
      unsafeEvidenceBlocked: false,
      missingSecurityFieldsBlocker: "security-privacy-blocked",
    },
    instrumentation: {
      dimensions: catalogPrimaryWorkbenchInstrumentationDimensions,
      redactionSafe: true,
    },
  };

  validateCatalogPrimaryWorkbenchReadModelContract(readModel);

  return readModel;
}

export function buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(
  context: CatalogPrimaryWorkbenchRouteContext,
  pagination: Readonly<{ limit?: number; offset?: number }> = {},
): string | null {
  if (!context.providerKey) {
    return null;
  }

  const params = new URLSearchParams();
  params.set("provider", context.providerKey);
  params.set("limit", String(pagination.limit ?? defaultReviewPageSize));
  params.set("offset", String(pagination.offset ?? 0));
  setQueryParam(params, "status", context.sourceObservationFilters.status);
  setQueryParam(
    params,
    "language",
    context.sourceObservationFilters.language ?? importScopeSegment(context.importScope, 0),
  );
  setQueryParam(params, "setId", context.sourceObservationFilters.setId ?? importScopeSegment(context.importScope, 3));
  setQueryParam(params, "search", context.sourceObservationFilters.search);

  return params.toString();
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

function providerTransportFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  providerKey: string | null,
): readonly CatalogPrimaryWorkbenchProviderTransportCategory[] {
  const categories = new Set<CatalogPrimaryWorkbenchProviderTransportCategory>();
  for (const unit of overview?.readiness.units ?? []) {
    if (providerKey && unit.providerKey !== providerKey) {
      continue;
    }
    for (const diagnostic of unit.diagnostics) {
      if (diagnostic.source === "provider-adapter" && diagnostic.severity !== "info") {
        categories.add(providerTransportCategoryFor(diagnostic.code, diagnostic.message, diagnostic.retryAfterSeconds));
      }
    }
  }
  for (const provider of overview?.providerReadiness.providers ?? []) {
    if (providerKey && provider.providerKey !== providerKey) {
      continue;
    }
    for (const capability of [
      provider.apiReachability,
      provider.optionQueryHealth,
      provider.rateLimitStatus,
      provider.payloadAcquisition,
    ]) {
      if (capability.status === "blocked" || capability.status === "degraded") {
        for (const code of capability.diagnosticCodes) {
          categories.add(providerTransportCategoryFor(code, capability.message, null));
        }
      }
    }
    for (const diagnostic of provider.diagnostics) {
      if (diagnostic.severity !== "info") {
        categories.add(providerTransportCategoryFor(diagnostic.code, diagnostic.message, diagnostic.retryAfterSeconds));
      }
    }
  }

  return [...categories];
}

function selectedImportScopeFor(input: {
  activeProfile: CatalogProviderProfileVersionReview | null;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  input: CatalogPrimaryWorkbenchInput;
  importScope: string | null;
  providerKey: string | null;
  providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[];
  rolloutEnabled: boolean;
  unitKey: CatalogIntegrationUnitKey | null;
}): CatalogPrimaryWorkbenchReadModel["importJobs"]["selectedScope"] {
  if (!input.providerKey || !input.importScope) {
    return null;
  }

  const providerReadiness = input.input.controlPlaneOverview?.providerReadiness.providers.find(
    (provider) => provider.providerKey === input.providerKey,
  );
  const unitReadiness = input.input.controlPlaneOverview?.readiness.units.find(
    (unit) => unit.unitKey === input.unitKey || unit.providerKey === input.providerKey,
  );
  const matchingRows = input.input.scopes.items.filter(
    (scope) => scope.provider_key === input.providerKey && scopeKey(scope) === input.importScope,
  );
  const rows =
    matchingRows.length > 0
      ? matchingRows
      : input.input.scopes.items.filter((scope) => scope.provider_key === input.providerKey);
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>(input.blockers);
  for (const category of input.providerTransport) {
    blockers.add(providerTransportBlockerFor(category));
  }

  return {
    providerKey: input.providerKey,
    unitKey: input.unitKey,
    importScope: input.importScope,
    profileVersion: input.activeProfile?.profileVersion ?? null,
    expectedObservationVolume: sum(rows, (scope) => scope.total_observations),
    observedCount: sum(rows, (scope) => scope.observed_observations),
    changedCount: sum(rows, (scope) => scope.changed_observations),
    promotedCount: sum(rows, (scope) => scope.promoted_observations),
    rejectedCount: sum(rows, (scope) => scope.rejected_observations),
    readiness: {
      adapterReadiness: providerReadiness?.readiness ?? unitReadiness?.semanticReadiness ?? "unknown",
      credentialReadiness: providerReadiness?.credentialReadiness ?? unitReadiness?.credentialReadiness ?? "unknown",
      rolloutEnabled: input.rolloutEnabled,
      providerTransport: input.providerTransport,
      blockers: [...blockers],
    },
  };
}

function importJobsFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"] {
  const providerTransport = providerTransportFor(overview, routeContext.providerKey);
  const unitActivity = overview?.unitActivity.units.find(
    (unit) => !routeContext.unitKey || unit.unitKey === routeContext.unitKey,
  );
  return (unitActivity?.recentJobs ?? []).slice(0, 3).map((job) => ({
    jobId: job.jobId,
    action: job.action === "reapply" ? "start-reapply" : "start-provider-import",
    state:
      job.operatorStatus === "cancelled"
        ? "cancelled"
        : job.phase === "completed"
          ? "completed"
          : job.phase === "failed"
            ? "failed"
            : job.phase === "enqueued"
              ? "queued"
              : "running",
    operatorStatus: job.operatorStatus,
    summary: job.summary,
    completed: job.completed,
    total: job.total,
    progressPercent: progressPercent(job.completed, job.total),
    providerKey: job.providerKey,
    profileVersion: job.profileVersion,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    consistency: {
      schemaVersion: "catalog-integration-durable-job-v1",
      compatibilityPolicy: "integration-durable-job",
      duplicateSubmissionPolicy: "reuse-active-job",
      profileSnapshotPolicy: "snapshotted-at-enqueue",
      retryResumePolicy: "skip-completed-outcomes",
      partialFailurePolicy: "mixed-outcomes",
      workUnitClaimPolicy: job.action === "reapply" ? "leased-work-units" : "leased-job-turns",
    },
    failureGroups: failureGroupsFor(job, providerTransport),
    retryAvailable:
      job.operatorStatus === "failed" ||
      job.operatorStatus === "partial" ||
      job.operatorStatus === "stale" ||
      job.operatorStatus === "cancelled",
    resumeAvailable: job.operatorStatus === "stale" || job.operatorStatus === "retried",
    cancelAvailable: job.phase === "enqueued" || job.phase === "fetching" || job.phase === "processing",
    sourceObservationReviewHref: sourceObservationReviewHrefFor(routeContext, job),
    auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref({ ...routeContext, jobId: job.jobId }, "audit-evidence"),
    observationLinks: [sourceObservationReviewHrefFor(routeContext, job)],
    blockers: job.operatorStatus === "stale" ? ["stale-replay"] : [],
  }));
}

function sourceObservationReviewFor(input: {
  canManage: boolean;
  changed: number;
  eligible: number;
  observed: number;
  promoted: number;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  rejected: number;
  reviewObservations: ListResponse<SourceObservationListItem> | null;
  reviewPagination: Readonly<{ limit: number; offset: number }> | undefined;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  scopeRows: readonly SourceObservationIntegrationScope[];
}): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"] {
  const limit = input.reviewPagination?.limit ?? defaultReviewPageSize;
  const offset = input.reviewPagination?.offset ?? 0;
  const total = input.reviewObservations?.total ?? 0;
  const rows = (input.reviewObservations?.items ?? []).map((observation) =>
    sourceObservationReviewRowFor(observation, {
      canManage: input.canManage,
      routeContext: input.routeContext,
    }),
  );
  const duplicateConflictCount = rows.filter((row) => row.duplicateEvidence.length > 0).length;
  const promotionReadyRowCount = rows.filter((row) => row.promotionReadiness.state === "eligible").length;
  const promotionReadyCount = input.reviewObservations ? promotionReadyRowCount : input.eligible;
  const selectedObservationIds = input.routeContext.selectedObservationIds;
  const selectedRows = rows.filter((row) => selectedObservationIds.includes(row.observationId));

  return {
    freshness: input.scopeRows.length > 0 ? "fresh" : "partial",
    counts: {
      observed: input.observed,
      changed: input.changed,
      promoted: input.promoted,
      rejected: input.rejected,
      blocked: input.readinessBlockers.length,
      eligible: input.eligible,
    },
    cursor: offset > 0 ? `offset:${offset}` : null,
    selectedObservationIds,
    evidenceSummariesRedacted: true,
    duplicateConflictCount,
    promotionReadyCount,
    filters: reviewFiltersFor(input.routeContext),
    savedFilters: savedReviewFiltersFor(input.routeContext, {
      eligible: input.eligible,
      changed: input.changed,
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
      actions: ["preview-promotion", "reject-source-observations", "defer-source-observations"],
    },
    rows,
  };
}

function promotionPreviewFor(input: {
  activeJobCount: number;
  activeProfileVersion: string | null;
  canManage: boolean;
  failedJobCount: number;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
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
      ? scopedRows.filter((row) => row.duplicateEvidence.length > 0 || row.conflictEvidence.length > 0).length
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
        profileVersion: scopedRows[0]?.sourceProfileVersion ?? input.routeContext.profileVersion,
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
  if (input.sourceObservationReview.freshness !== "fresh") {
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
  const duplicateEvidence = duplicateEvidenceFor(observation);
  const conflictEvidence = conflictEvidenceFor(observation);
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
    languageCode: observation.language_code,
    sourceUrl: observation.source_url,
    sourceRecordHash: observation.source_record_hash,
    sourceUpdatedAt: observation.source_updated_at,
    observedAt: observation.observed_at,
    changedAt: observation.updated_at,
    sourceProfileVersion: observation.source_profile_version,
    promotionProfileVersion: observation.promotion_profile_version,
    normalizedFactSummaries: normalizedFactSummariesFor(observation),
    payloadSummary: payloadSummaryFor(observation),
    redactionSummary: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.redaction.summary"),
    duplicateEvidence,
    conflictEvidence,
    promotionReadiness,
    commandPreview: {
      promotionPlanHash: observation.promotion_plan_fingerprint,
      disposition: promotionDispositionFor(promotionReadiness.state),
      confirmationRequired: promotionReadiness.state === "eligible",
    },
    auditTrail: auditTrailFor(observation),
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
      routeContext.sourceObservationFilters.status ?? null,
      true,
    ),
    filter(
      "language",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.language"),
      routeContext.sourceObservationFilters.language ?? importScopeSegment(routeContext.importScope, 0),
      true,
    ),
    filter(
      "setId",
      t("catalog.features.sourceObservations.ui.primaryWorkbench.review.filter.set"),
      routeContext.sourceObservationFilters.setId ?? importScopeSegment(routeContext.importScope, 3),
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
  counts: { eligible: number; changed: number; rejected: number },
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["savedFilters"] {
  const providerFilter: Record<string, string> = {};
  if (routeContext.providerKey) {
    providerFilter.providerKey = routeContext.providerKey;
  }

  return [
    {
      key: "ready-for-promotion",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.review.saved.ready"),
      filters: { ...providerFilter, status: "changed" },
      count: counts.eligible,
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

  return [
    { key: "view-source-observation", state: "available", blockers: [], href: input.detailHref },
    { key: "preview-promotion", state: promotionState, blockers: promotionBlockers, href: input.detailHref },
    {
      key: "reject-source-observations",
      state: observation.status === "observed" || observation.status === "changed" ? manageState : "disabled",
      blockers:
        observation.status === "observed" || observation.status === "changed"
          ? manageBlockers
          : ["no-promotion-eligible-observations"],
      href: input.detailHref,
    },
    {
      key: "defer-source-observations",
      state: observation.status === "observed" || observation.status === "changed" ? manageState : "disabled",
      blockers:
        observation.status === "observed" || observation.status === "changed"
          ? manageBlockers
          : ["no-promotion-eligible-observations"],
      href: input.detailHref,
    },
    {
      key: "start-reapply",
      state: observation.status === "promoted" ? manageState : "disabled",
      blockers: observation.status === "promoted" ? manageBlockers : ["no-promotion-eligible-observations"],
      href: input.detailHref,
    },
  ];
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

function sourceObservationReviewHrefFor(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  job: CatalogIntegrationRecentJobReadModel,
): string {
  return catalogPrimaryWorkbenchHref(
    {
      ...routeContext,
      jobId: job.jobId,
      sourceObservationFilters: {
        ...routeContext.sourceObservationFilters,
        providerKey: job.providerKey,
      },
    },
    "source-observation-review",
  );
}

function failureGroupsFor(
  job: CatalogIntegrationRecentJobReadModel,
  providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[],
): CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number]["failureGroups"] {
  const groups: {
    key: string;
    label: string;
    count: number;
    severity: "warning" | "error";
  }[] = [];
  if (job.operatorStatus === "cancelled") {
    groups.push({
      key: "durable-job-cancelled",
      label: "durable-job-cancelled",
      count: 1,
      severity: "warning",
    });
  } else if (job.operatorStatus === "failed" || job.phase === "failed") {
    groups.push({
      key: "durable-job-failed",
      label: "durable-job-failed",
      count: Math.max(job.total - job.completed, 1),
      severity: "error",
    });
  }
  if (job.operatorStatus === "partial") {
    groups.push({
      key: "partial-provider-data",
      label: "partial-provider-data",
      count: Math.max(job.total - job.completed, 1),
      severity: "warning",
    });
  }
  if (job.operatorStatus === "stale") {
    groups.push({
      key: "stale-replay",
      label: "stale-replay",
      count: 1,
      severity: "warning",
    });
  }
  for (const category of providerTransport) {
    groups.push({
      key: `provider-transport-${category}`,
      label: `provider-transport-${category}`,
      count: 1,
      severity: category === "degraded-provider" ? "warning" : "error",
    });
  }

  return groups;
}

function progressPercent(completed: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
}

function credentialBlockerFor(
  state: "not-required" | "configured" | "missing" | "invalid" | "expired" | "revoked" | "unknown",
): CatalogPrimaryWorkbenchBlockerCategory {
  if (state === "invalid" || state === "revoked") {
    return "provider-credential-invalid";
  }
  if (state === "expired") {
    return "provider-credential-expired";
  }

  return "provider-credential-missing";
}

function providerTransportCategoryFor(
  code: string,
  message: string | null,
  retryAfterSeconds: number | null,
): CatalogPrimaryWorkbenchProviderTransportCategory {
  const text = `${code} ${message ?? ""}`.toLowerCase();
  if (text.includes("quota")) {
    return "quota";
  }
  if (text.includes("timeout")) {
    return "timeout";
  }
  if (text.includes("pagination") || text.includes("cursor")) {
    return "pagination-failure";
  }
  if (text.includes("partial")) {
    return "partial-data";
  }
  if (text.includes("stale") || text.includes("cache")) {
    return "stale-cache";
  }
  if (text.includes("rate")) {
    return "rate-limit";
  }
  if (retryAfterSeconds !== null || text.includes("throttle")) {
    return "throttle";
  }

  return "degraded-provider";
}

function providerTransportBlockerFor(
  category: CatalogPrimaryWorkbenchProviderTransportCategory,
): CatalogPrimaryWorkbenchBlockerCategory {
  switch (category) {
    case "rate-limit":
      return "provider-transport-rate-limited";
    case "throttle":
      return "provider-transport-throttled";
    case "quota":
      return "provider-transport-quota-exceeded";
    case "timeout":
      return "provider-transport-timeout";
    case "pagination-failure":
      return "provider-transport-pagination-failure";
    case "partial-data":
      return "provider-transport-partial-data";
    case "stale-cache":
      return "provider-transport-stale-cache";
    case "degraded-provider":
      return "provider-transport-degraded";
  }
}

function buildActions(input: {
  canManage: boolean;
  providerSelected: boolean;
  activeProfileReady: boolean;
  eligible: number;
  activeJobCount: number;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
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
    input.eligible > 0 ? [] : (["selection-empty"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const reviewDecisionState = actionStateForBlockers(reviewDecisionBlockers, manageState);
  const profileWorkflowBlockers = input.activeProfileReady
    ? []
    : (["profile-version-missing"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);
  const profileWorkflowState = actionStateForBlockers(profileWorkflowBlockers, manageState);

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
      state: profileWorkflowState,
      blockers: profileWorkflowBlockers,
      copyKey: profileWorkflowBlockers.length > 0 ? "catalog.primary.reapply.originalProfileMissing" : null,
    },
    {
      key: "start-replay",
      state: profileWorkflowState,
      blockers: profileWorkflowBlockers,
      copyKey: profileWorkflowBlockers.length > 0 ? "catalog.primary.reapply.originalProfileMissing" : null,
    },
  ];
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
          activeProfile: profile
            ? {
                schemaVersion: "catalog-provider-profile-version-v1",
                compatibilityPolicy: "provider-profile-version",
                providerKey: profile.providerKey,
                profileKey: profile.profileKey,
                profileVersion: profile.profileVersion,
                lifecycle: profile.lifecycle,
                active: profile.active,
                connectorKind: profile.connectorKind,
                connectorSourceVersion: null,
                sourceMappingFingerprint: null,
              }
            : null,
        },
      ],
    };
  });
}

function normalizeUnitSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "catalog"
  );
}

function scopeKey(scope: SourceObservationIntegrationScope): string {
  return [scope.language_code, scope.product_line_id, scope.series_id, scope.expansion_id].filter(Boolean).join(":");
}

function sum<T>(items: readonly T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

function importScopeSegment(importScope: string | null, index: number): string | null {
  return importScope?.split(":")[index] || null;
}

function setQueryParam(params: URLSearchParams, key: string, value: string | null | undefined): void {
  if (value) {
    params.set(key, value);
  }
}
