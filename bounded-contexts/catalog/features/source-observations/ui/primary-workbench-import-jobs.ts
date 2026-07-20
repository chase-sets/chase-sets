import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchProviderTransportCategory,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
} from "./contracts";
import { catalogPrimaryWorkbenchHref, catalogPrimaryWorkbenchSupportingHref } from "./primary-workbench-route-context";
import type { CatalogPrimaryWorkbenchInput } from "./primary-workbench-read-model-input";
import {
  importScopeFromScopeContext,
  scopeContextFromProviderScope,
  scopeContextFromRouteContext,
  scopeKey,
} from "./primary-workbench-scope-context";
import {
  comparableImportScopeKey,
  importScopeMatchesProviderScope,
  profilePointerForProfile,
  providerTransportBlockerFor,
  providerTransportFor,
  sum,
} from "./primary-workbench-read-model-support";

export type CatalogIntegrationRecentJobReadModel =
  CatalogIntegrationControlPlaneOverview["unitActivity"]["units"][number]["recentJobs"][number];

const MAX_PRIMARY_WORKBENCH_IMPORT_JOB_ROWS = 10;

export function selectedImportScopeFor(input: {
  activeProfile: CatalogProviderProfileVersionReview | null;
  activeJobCount: number;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  input: CatalogPrimaryWorkbenchInput;
  importScope: string | null;
  providerKey: string | null;
  providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
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
    (scope) => scope.provider_key === input.providerKey && importScopeMatchesProviderScope(input.importScope, scope),
  );
  const rows = matchingRows;
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>(input.blockers);
  for (const category of input.providerTransport) {
    blockers.add(providerTransportBlockerFor(category));
  }
  if (input.activeJobCount > 0) {
    blockers.add("active-job-conflict");
  }
  if (input.activeJobCount > 1) {
    blockers.add("concurrent-job");
  }

  return {
    providerKey: input.providerKey,
    unitKey: input.unitKey,
    scope: scopeContextFromRouteContext(input.routeContext),
    importScope: input.importScope,
    profileVersion: input.activeProfile?.profileVersion ?? null,
    profileSnapshot: profilePointerForProfile(input.activeProfile),
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

export function importJobsFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  scopes: readonly SourceObservationIntegrationScope[] = [],
): CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"] {
  const providerTransport = providerTransportFor(overview, routeContext.providerKey);
  const seenJobIds = new Set<string>();
  const rows = (overview?.unitActivity.units ?? [])
    .flatMap((unit) =>
      unit.recentJobs.map((job) => ({
        unitKey: unit.unitKey,
        job,
      })),
    )
    .filter(({ unitKey, job }) => {
      if (routeContext.unitKey && unitKey !== routeContext.unitKey) {
        return false;
      }
      if (routeContext.providerKey && job.providerKey !== routeContext.providerKey) {
        return false;
      }

      return true;
    })
    .filter(({ job }) => {
      if (seenJobIds.has(job.jobId)) {
        return false;
      }
      seenJobIds.add(job.jobId);

      return true;
    })
    .sort((left, right) => {
      const rightMatchesScope = jobMatchesRouteScope(right.job, routeContext) ? 1 : 0;
      const leftMatchesScope = jobMatchesRouteScope(left.job, routeContext) ? 1 : 0;
      if (rightMatchesScope !== leftMatchesScope) {
        return rightMatchesScope - leftMatchesScope;
      }

      return jobOccurredAt(right.job).localeCompare(jobOccurredAt(left.job));
    })
    .slice(0, MAX_PRIMARY_WORKBENCH_IMPORT_JOB_ROWS);

  return rows.map(({ unitKey, job }) => {
    const scopeMatchesRoute = jobMatchesRouteScope(job, routeContext);
    const matchingScope = matchingProviderScopeForJob(scopes, job);
    const state = importJobState(job);
    const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
    if (job.operatorStatus === "stale") {
      blockers.add("stale-replay");
    }
    if (!scopeMatchesRoute && (state === "queued" || state === "running")) {
      blockers.add("active-job-conflict");
    }

    return {
      jobId: job.jobId,
      action: job.action === "reapply" ? "observation.reapply" : "scope.import",
      state,
      operatorStatus: job.operatorStatus,
      summary: job.summary,
      completed: job.completed,
      total: job.total,
      progressPercent: progressPercent(job.completed, job.total),
      unitKey: job.unitKey ?? unitKey,
      providerKey: job.providerKey,
      importScope: job.importScope,
      profileVersion: job.profileVersion,
      profileSnapshot: job.profileSnapshot,
      scopeMatchesRoute,
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
      sourceObservationReviewHref: sourceObservationReviewHrefFor(routeContext, unitKey, job, matchingScope),
      auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(
        { ...routeContext, jobId: job.jobId, importScope: job.importScope ?? routeContext.importScope },
        "audit-evidence",
      ),
      observationLinks: [sourceObservationReviewHrefFor(routeContext, unitKey, job, matchingScope)],
      result: jobResultFor(routeContext, job),
      blockers: [...blockers],
    };
  });
}

function jobResultFor(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  job: CatalogIntegrationRecentJobReadModel,
): CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number]["result"] {
  if (!job.result) {
    return null;
  }

  return {
    requestedScope: scopeContextFromRouteContext({
      ...routeContext,
      providerKey: job.providerKey,
      importScope: job.importScope,
    }),
    requestedCount: job.result.requested,
    importedSetCount: job.result.imported,
    observedCount: job.result.observed,
    reappliedCount: job.result.reapplied,
    skippedCount: job.result.skipped,
    failedCount: job.result.failed,
    redactedFailureReasons: job.result.redactedFailureReasons ?? [],
    usage: job.result.usage ?? null,
    replayOrReapplyState: replayOrReapplyStateFor(job),
  };
}

function replayOrReapplyStateFor(
  job: CatalogIntegrationRecentJobReadModel,
): NonNullable<CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number]["result"]>["replayOrReapplyState"] {
  if (job.action !== "reapply") {
    return "not-applicable";
  }
  if (job.reapplyProfileMode === "current-active-profile") {
    return "reapply-current-active-profile";
  }
  if (job.reapplyProfileMode === "original-source-profile") {
    return "replay-original-source-profile";
  }

  return "unknown";
}

function sourceObservationReviewHrefFor(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  unitKey: string | null,
  job: CatalogIntegrationRecentJobReadModel,
  matchingScope: SourceObservationIntegrationScope | null,
): string {
  const jobScope = matchingScope ? scopeContextFromProviderScope(matchingScope) : routeContext.scope;
  const importScope = job.importScope ?? importScopeFromScopeContext(jobScope) ?? routeContext.importScope;

  return catalogPrimaryWorkbenchHref(
    {
      ...routeContext,
      providerKey: job.providerKey,
      unitKey: job.unitKey ?? unitKey ?? routeContext.unitKey,
      jobId: job.jobId,
      importScope,
      scope: jobScope,
      profileVersion: job.profileVersion ?? routeContext.profileVersion,
      selectedObservationIds: [],
      reviewOffset: null,
      reviewLimit: null,
      promotionPreviewId: null,
      sourceObservationFilters: {},
    },
    "source-observation-review",
  );
}

function matchingProviderScopeForJob(
  scopes: readonly SourceObservationIntegrationScope[],
  job: CatalogIntegrationRecentJobReadModel,
): SourceObservationIntegrationScope | null {
  const jobScope = normalizedProviderScopeCandidate(job.importScope, job.providerKey);
  if (!jobScope) {
    return null;
  }

  return (
    scopes.find(
      (scope) =>
        scope.provider_key === job.providerKey &&
        providerScopeImportScopeCandidates(scope).some(
          (candidate) => normalizedProviderScopeCandidate(candidate, scope.provider_key) === jobScope,
        ),
    ) ?? null
  );
}

function providerScopeImportScopeCandidates(scope: SourceObservationIntegrationScope): readonly string[] {
  const candidates = new Set<string>();
  const addCandidate = (...segments: readonly (string | null | undefined)[]) => {
    const value = segments
      .map((segment) => segment?.trim())
      .filter((segment): segment is string => Boolean(segment))
      .join(":");
    if (value) {
      candidates.add(value);
    }
  };

  addCandidate(scopeKey(scope));
  addCandidate(scope.language_code, scope.product_line_id);
  addCandidate(scope.language_code, scope.product_line_id, scope.expansion_id);
  addCandidate(scope.language_code, scope.product_line_id, scope.expansion_name);
  addCandidate(scope.language_code, scope.series_id);
  addCandidate(scope.language_code, scope.series_id, scope.expansion_id);
  addCandidate(scope.language_code, scope.series_id, scope.expansion_name);
  addCandidate(scope.language_code, scope.expansion_id);
  addCandidate(scope.language_code, scope.expansion_name);

  return [...candidates];
}

function normalizedProviderScopeCandidate(value: string | null | undefined, providerKey: string | null): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  return providerKey === "tcgdex" ? normalized.toLowerCase() : normalized;
}

function importJobState(
  job: CatalogIntegrationRecentJobReadModel,
): CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number]["state"] {
  if (job.operatorStatus === "cancelled") {
    return "cancelled";
  }
  if (job.phase === "completed") {
    return "completed";
  }
  if (job.phase === "failed") {
    return "failed";
  }
  if (job.phase === "enqueued") {
    return "queued";
  }

  return "running";
}

function jobMatchesRouteScope(
  job: CatalogIntegrationRecentJobReadModel,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): boolean {
  if (!routeContext.importScope) {
    return !job.importScope;
  }

  return (
    comparableImportScopeKey(job.importScope, job.providerKey) ===
    comparableImportScopeKey(routeContext.importScope, routeContext.providerKey)
  );
}

function jobOccurredAt(job: CatalogIntegrationRecentJobReadModel): string {
  return job.startedAt ?? job.createdAt;
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
