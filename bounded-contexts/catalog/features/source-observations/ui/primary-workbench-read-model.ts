import type { ListResponse } from "@chase-sets/http/responses";
import {
  catalogPrimaryWorkbenchContractVersion,
  catalogPrimaryWorkbenchDeploySkewPolicies,
  catalogPrimaryWorkbenchInstrumentationDimensions,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogPrimaryWorkbenchActionReadModel,
  type CatalogPrimaryWorkbenchBlockerCategory,
  type CatalogPrimaryWorkbenchProviderTransportCategory,
  type CatalogPrimaryWorkbenchReadModel,
  type CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import { defineCatalogIntegrationUnitKey, type CatalogIntegrationUnitKey } from "../api/integration-unit";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
} from "./contracts";
import {
  catalogPrimaryWorkbenchHref,
  parseCatalogPrimaryWorkbenchRouteContext,
} from "./primary-workbench-route-context";

export type CatalogPrimaryWorkbenchInput = Readonly<{
  requestUrl: string | URL;
  scopes: ListResponse<SourceObservationIntegrationScope>;
  profileReviews: ListResponse<CatalogProviderProfileVersionReview>;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  canManageCatalog: boolean;
}>;

type CatalogIntegrationRecentJobReadModel =
  CatalogIntegrationControlPlaneOverview["unitActivity"]["units"][number]["recentJobs"][number];

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
  const actions = buildActions({
    canManage,
    providerSelected: Boolean(providerKey && unitKey && importScope),
    activeProfileReady: Boolean(activeProfile),
    eligible,
    activeJobCount,
    blockers: readinessBlockers,
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
      auditEvidenceUrl: catalogPrimaryWorkbenchHref(routeContext, "evidence"),
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
    sourceObservationReview: {
      freshness: scopeRows.length > 0 ? "fresh" : "partial",
      counts: {
        observed,
        changed,
        promoted,
        rejected,
        blocked: readinessBlockers.length,
        eligible,
      },
      cursor: null,
      selectedObservationIds: routeContext.selectedObservationIds,
      evidenceSummariesRedacted: true,
      duplicateConflictCount: 0,
      promotionReadyCount: eligible,
    },
    promotionPreview: {
      previewId: routeContext.promotionPreviewId,
      freshness: eligible > 0 ? "fresh" : "partial",
      dispositions: {
        eligible,
        skipped: rejected,
        blocked: readinessBlockers.length,
        conflicting: 0,
        destructive: 0,
        "stale-preview": 0,
        "confirmation-required": eligible > 0 ? 1 : 0,
      },
      commandPlanHash: routeContext.promotionPreviewId ? `preview:${routeContext.promotionPreviewId}` : null,
      confirmationRequired: eligible > 0,
      destructiveCount: 0,
      blockers: eligible > 0 ? [] : ["no-promotion-eligible-observations"],
    },
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
      job.phase === "completed"
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
      workUnitClaimPolicy: "leased-work-units",
    },
    failureGroups: failureGroupsFor(job, providerTransport),
    retryAvailable:
      job.operatorStatus === "failed" || job.operatorStatus === "partial" || job.operatorStatus === "stale",
    resumeAvailable: job.operatorStatus === "stale" || job.operatorStatus === "retried",
    cancelAvailable: job.phase === "enqueued" || job.phase === "fetching" || job.phase === "processing",
    sourceObservationReviewHref: sourceObservationReviewHrefFor(routeContext, job),
    auditEvidenceUrl: catalogPrimaryWorkbenchHref({ ...routeContext, jobId: job.jobId }, "evidence"),
    observationLinks: [sourceObservationReviewHrefFor(routeContext, job)],
    blockers: job.operatorStatus === "stale" ? ["stale-replay"] : [],
  }));
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
  if (job.operatorStatus === "failed" || job.phase === "failed") {
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
  const promotionBlockers =
    input.eligible > 0
      ? []
      : (["no-promotion-eligible-observations"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);

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
      state: promotionBlockers.length > 0 ? "disabled" : manageState,
      blockers: promotionBlockers,
      copyKey: promotionBlockers.length > 0 ? "catalog.primary.review.empty" : null,
    },
    {
      key: "execute-promotion",
      state: promotionBlockers.length > 0 ? "disabled" : manageState,
      blockers: promotionBlockers,
      copyKey: promotionBlockers.length > 0 ? "catalog.primary.promotion.previewRequired" : null,
    },
  ];
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
