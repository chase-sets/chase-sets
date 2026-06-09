import type {
  CatalogAdminControlPlaneFreshnessState,
  CatalogAdminControlPlanePaginationMode,
} from "./admin-control-plane-read-model-slos";
import type {
  CatalogAdminControlPlaneQueryKey,
  CatalogAdminJobConsistency,
  CatalogAdminProfileVersionPointer,
} from "./admin-control-plane-read-model-contracts";
import type { CatalogIntegrationUnitKey } from "./integration-unit";

export const catalogPrimaryWorkbenchContractVersion = "catalog-primary-workbench-v1" as const;

export type CatalogPrimaryWorkbenchContractVersion = typeof catalogPrimaryWorkbenchContractVersion;

export type CatalogPrimaryWorkbenchSectionKey =
  | "provider-scope-selection"
  | "readiness"
  | "import-jobs"
  | "source-observation-review"
  | "promotion-preview"
  | "promotion-result"
  | "supporting-evidence";

export type CatalogPrimaryWorkbenchCommandKey =
  | "select-provider-scope"
  | "start-provider-import"
  | "resume-import-job"
  | "retry-import-job"
  | "cancel-import-job"
  | "select-source-observations"
  | "preview-promotion"
  | "execute-promotion"
  | "reject-source-observations"
  | "defer-source-observations"
  | "start-reapply"
  | "start-replay";

export type CatalogPrimaryWorkbenchActionState =
  | "available"
  | "disabled"
  | "denied"
  | "blocked"
  | "unavailable"
  | "unsafe"
  | "degraded";

export type CatalogPrimaryWorkbenchBlockerCategory =
  | "permission-denied"
  | "authorization-denied"
  | "rollout-disabled"
  | "kill-switch-active"
  | "rbac-missing"
  | "active-job-conflict"
  | "concurrent-job"
  | "missing-active-profile"
  | "profile-version-missing"
  | "missing-fixture-coverage"
  | "fixture-validation-blocked"
  | "provider-credential-missing"
  | "provider-credential-invalid"
  | "provider-credential-expired"
  | "provider-transport-rate-limited"
  | "provider-transport-throttled"
  | "provider-transport-quota-exceeded"
  | "provider-transport-timeout"
  | "provider-transport-pagination-failure"
  | "provider-transport-partial-data"
  | "provider-transport-stale-cache"
  | "provider-transport-degraded"
  | "source-projection-stale"
  | "read-model-degraded"
  | "read-model-partial"
  | "read-model-unavailable"
  | "job-not-found"
  | "observation-not-found"
  | "selection-empty"
  | "no-promotion-eligible-observations"
  | "duplicate-conflict"
  | "promotion-conflict"
  | "destructive-confirmation-required"
  | "stale-promotion-preview"
  | "stale-replay"
  | "idempotency-replay"
  | "security-privacy-blocked"
  | "unsupported-command"
  | "deploy-skew-unsupported-version"
  | "raw-json-retired"
  | "legacy-selector-retired";

export type CatalogPrimaryWorkbenchProviderTransportCategory =
  | "rate-limit"
  | "throttle"
  | "quota"
  | "timeout"
  | "pagination-failure"
  | "partial-data"
  | "stale-cache"
  | "degraded-provider";

export type CatalogPrimaryWorkbenchPromotionDisposition =
  | "eligible"
  | "skipped"
  | "blocked"
  | "conflicting"
  | "destructive"
  | "stale-preview"
  | "confirmation-required";

export type CatalogPrimaryWorkbenchRouteContextKey =
  | "providerKey"
  | "unitKey"
  | "importScope"
  | "profileVersion"
  | "sourceObservationFilters"
  | "selectedObservationIds"
  | "jobId"
  | "promotionPreviewId"
  | "returnPath";

export type CatalogPrimaryWorkbenchCopyKey =
  | "catalog.primary.providerScope.required"
  | "catalog.primary.import.blocked"
  | "catalog.primary.import.denied"
  | "catalog.primary.job.partial"
  | "catalog.primary.review.empty"
  | "catalog.primary.review.blocked"
  | "catalog.primary.promotion.previewRequired"
  | "catalog.primary.promotion.stalePreview"
  | "catalog.primary.promotion.securityBlocked"
  | "catalog.primary.reapply.originalProfileMissing"
  | "catalog.primary.deploySkew.failClosed";

export type CatalogPrimaryWorkbenchInstrumentationDimension =
  | "provider_key"
  | "unit_key"
  | "import_scope"
  | "profile_version"
  | "source_observation_status"
  | "promotion_disposition"
  | "blocker_category"
  | "action_key"
  | "transport_category"
  | "read_model_freshness"
  | "route_context_preserved";

export type CatalogPrimaryWorkbenchDeploySkewMode = "current" | "old-ui-new-api" | "new-ui-old-api";

export type CatalogPrimaryWorkbenchDeploySkewPolicy = Readonly<{
  mode: CatalogPrimaryWorkbenchDeploySkewMode;
  supported: boolean;
  failClosedBlocker: Extract<CatalogPrimaryWorkbenchBlockerCategory, "deploy-skew-unsupported-version">;
  forbiddenFallbacks: readonly string[];
}>;

export type CatalogPrimaryWorkbenchRetirementPolicy = Readonly<{
  term: "retire";
  requiredDisposition: "complete-removal";
  surfaces: readonly string[];
  forbiddenOutcomes: readonly string[];
}>;

export type CatalogPrimaryWorkbenchBlockerContract = Readonly<{
  category: CatalogPrimaryWorkbenchBlockerCategory;
  actionStates: readonly CatalogPrimaryWorkbenchActionState[];
  copyKey: CatalogPrimaryWorkbenchCopyKey;
  instrumentationDimension: Extract<CatalogPrimaryWorkbenchInstrumentationDimension, "blocker_category">;
  failClosed: boolean;
}>;

export type CatalogPrimaryWorkbenchSectionContract = Readonly<{
  key: CatalogPrimaryWorkbenchSectionKey;
  defaultVisible: boolean;
  queryKeys: readonly CatalogAdminControlPlaneQueryKey[];
  commands: readonly CatalogPrimaryWorkbenchCommandKey[];
  freshnessStates: readonly CatalogAdminControlPlaneFreshnessState[];
  pagination: CatalogAdminControlPlanePaginationMode;
  routeContextKeys: readonly CatalogPrimaryWorkbenchRouteContextKey[];
}>;

export type CatalogPrimaryWorkbenchActionContract = Readonly<{
  key: CatalogPrimaryWorkbenchCommandKey;
  method: "GET" | "POST";
  routePattern: string;
  requiredPermission: "catalog.view" | "catalog.manage";
  successState: CatalogPrimaryWorkbenchActionState;
  blockerCategories: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  idempotencyRequired: boolean;
  confirmationRequired: boolean;
}>;

export type CatalogPrimaryWorkbenchDownstreamIssueKey =
  | "#1056"
  | "#1038"
  | "#1039"
  | "#1040"
  | "#1057"
  | "#1058"
  | "#1059"
  | "#1062"
  | "#1063"
  | "#1064"
  | "#1065";

export type CatalogPrimaryWorkbenchDownstreamContract = Readonly<{
  issue: CatalogPrimaryWorkbenchDownstreamIssueKey;
  consumes: readonly CatalogPrimaryWorkbenchSectionKey[];
  requiredFields: readonly string[];
}>;

export type CatalogPrimaryWorkbenchReadModel = Readonly<{
  schemaVersion: CatalogPrimaryWorkbenchContractVersion;
  generatedAt: string;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  providerScope: CatalogPrimaryWorkbenchProviderScopeReadModel;
  readiness: CatalogPrimaryWorkbenchReadinessReadModel;
  importJobs: CatalogPrimaryWorkbenchImportJobsReadModel;
  sourceObservationReview: CatalogPrimaryWorkbenchSourceObservationReviewReadModel;
  promotionPreview: CatalogPrimaryWorkbenchPromotionPreviewReadModel;
  promotionResult: CatalogPrimaryWorkbenchPromotionResultReadModel | null;
  actions: readonly CatalogPrimaryWorkbenchActionReadModel[];
  deploySkew: CatalogPrimaryWorkbenchDeploySkewPolicy;
  securityPrivacy: CatalogPrimaryWorkbenchSecurityPrivacyReadModel;
  instrumentation: CatalogPrimaryWorkbenchInstrumentationReadModel;
}>;

export type CatalogPrimaryWorkbenchRouteContext = Readonly<{
  providerKey: string | null;
  unitKey: CatalogIntegrationUnitKey | null;
  importScope: string | null;
  profileVersion: string | null;
  sourceObservationFilters: Readonly<Record<string, string>>;
  selectedObservationIds: readonly string[];
  jobId: string | null;
  promotionPreviewId: string | null;
  returnPath: string | null;
}>;

export type CatalogPrimaryWorkbenchProviderScopeReadModel = Readonly<{
  providers: readonly Readonly<{
    providerKey: string;
    displayName: string;
    units: readonly Readonly<{
      unitKey: CatalogIntegrationUnitKey;
      productDomain: string;
      productForm: string;
      importScopes: readonly string[];
      activeProfile: CatalogAdminProfileVersionPointer | null;
    }>[];
  }>[];
}>;

export type CatalogPrimaryWorkbenchReadinessReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[];
  rolloutEnabled: boolean;
  rbacAllowed: boolean;
  auditEvidenceUrl: string | null;
}>;

export type CatalogPrimaryWorkbenchImportJobsReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  jobs: readonly Readonly<{
    jobId: string;
    action: Extract<CatalogPrimaryWorkbenchCommandKey, "start-provider-import" | "start-reapply" | "start-replay">;
    state: "queued" | "running" | "completed" | "failed" | "cancelled";
    operatorStatus: "queued" | "running" | "stale" | "retried" | "partial" | "failed" | "completed";
    consistency: CatalogAdminJobConsistency;
    observationLinks: readonly string[];
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>[];
}>;

export type CatalogPrimaryWorkbenchSourceObservationReviewReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  counts: Readonly<Record<"observed" | "changed" | "promoted" | "rejected" | "blocked" | "eligible", number>>;
  cursor: string | null;
  selectedObservationIds: readonly string[];
  evidenceSummariesRedacted: boolean;
  duplicateConflictCount: number;
  promotionReadyCount: number;
}>;

export type CatalogPrimaryWorkbenchPromotionPreviewReadModel = Readonly<{
  previewId: string | null;
  freshness: CatalogAdminControlPlaneFreshnessState;
  dispositions: Readonly<Record<CatalogPrimaryWorkbenchPromotionDisposition, number>>;
  commandPlanHash: string | null;
  confirmationRequired: boolean;
  destructiveCount: number;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}>;

export type CatalogPrimaryWorkbenchPromotionResultReadModel = Readonly<{
  resultId: string;
  promotedCatalogItemIds: readonly string[];
  promotedReferenceIds: readonly string[];
  skippedObservationIds: readonly string[];
  auditEvidenceIds: readonly string[];
}>;

export type CatalogPrimaryWorkbenchActionReadModel = Readonly<{
  key: CatalogPrimaryWorkbenchCommandKey;
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  copyKey: CatalogPrimaryWorkbenchCopyKey | null;
}>;

export type CatalogPrimaryWorkbenchSecurityPrivacyReadModel = Readonly<{
  redactionApplied: boolean;
  governedDataClasses: readonly string[];
  unsafeEvidenceBlocked: boolean;
  missingSecurityFieldsBlocker: Extract<CatalogPrimaryWorkbenchBlockerCategory, "security-privacy-blocked">;
}>;

export type CatalogPrimaryWorkbenchInstrumentationReadModel = Readonly<{
  dimensions: readonly CatalogPrimaryWorkbenchInstrumentationDimension[];
  redactionSafe: boolean;
}>;

export const catalogPrimaryWorkbenchSections = [
  section({
    key: "provider-scope-selection",
    defaultVisible: true,
    queryKeys: ["integration-health-summary", "provider-transport-readiness-summary", "active-profile-version-summary"],
    commands: ["select-provider-scope"],
    freshnessStates: ["fresh", "stale", "partial", "unavailable"],
    pagination: "none",
    routeContextKeys: ["providerKey", "unitKey", "importScope", "profileVersion", "returnPath"],
  }),
  section({
    key: "readiness",
    defaultVisible: true,
    queryKeys: [
      "integration-health-summary",
      "profile-section-status-summary",
      "fixture-validation-summary",
      "activation-readiness-summary",
      "adapter-transport-diagnostics",
    ],
    commands: [],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "none",
    routeContextKeys: ["providerKey", "unitKey", "importScope", "profileVersion", "returnPath"],
  }),
  section({
    key: "import-jobs",
    defaultVisible: true,
    queryKeys: ["import-job-progress-summary"],
    commands: ["start-provider-import", "resume-import-job", "retry-import-job", "cancel-import-job"],
    freshnessStates: ["fresh", "stale", "lagging", "unavailable"],
    pagination: "sse",
    routeContextKeys: ["providerKey", "unitKey", "importScope", "profileVersion", "jobId", "returnPath"],
  }),
  section({
    key: "source-observation-review",
    defaultVisible: true,
    queryKeys: ["source-observation-review-query"],
    commands: ["select-source-observations", "reject-source-observations", "defer-source-observations"],
    freshnessStates: ["fresh", "stale", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: [
      "providerKey",
      "unitKey",
      "importScope",
      "profileVersion",
      "sourceObservationFilters",
      "selectedObservationIds",
      "returnPath",
    ],
  }),
  section({
    key: "promotion-preview",
    defaultVisible: true,
    queryKeys: ["promotion-plan-preview"],
    commands: ["preview-promotion", "execute-promotion"],
    freshnessStates: ["fresh", "stale", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: [
      "providerKey",
      "unitKey",
      "importScope",
      "profileVersion",
      "selectedObservationIds",
      "promotionPreviewId",
      "returnPath",
    ],
  }),
  section({
    key: "promotion-result",
    defaultVisible: true,
    queryKeys: ["audit-evidence-timeline"],
    commands: ["start-reapply", "start-replay"],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: ["providerKey", "unitKey", "profileVersion", "jobId", "returnPath"],
  }),
  section({
    key: "supporting-evidence",
    defaultVisible: false,
    queryKeys: [
      "dry-run-evidence-summary",
      "semantic-version-comparison",
      "replay-reapply-impact-summary",
      "rollback-retirement-impact-summary",
      "audit-evidence-timeline",
    ],
    commands: [],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: ["providerKey", "unitKey", "profileVersion", "returnPath"],
  }),
] as const satisfies readonly CatalogPrimaryWorkbenchSectionContract[];

export const catalogPrimaryWorkbenchActions = [
  action("select-provider-scope", "GET", "/api/catalog/source-observations/admin/primary-workbench", "catalog.view", {
    blockerCategories: ["permission-denied", "authorization-denied", "legacy-selector-retired"],
  }),
  action("start-provider-import", "POST", "/api/catalog/source-observations/admin/import-jobs", "catalog.manage", {
    blockerCategories: [
      "rollout-disabled",
      "kill-switch-active",
      "rbac-missing",
      "missing-active-profile",
      "missing-fixture-coverage",
      "provider-credential-missing",
      "provider-credential-invalid",
      "provider-transport-rate-limited",
      "provider-transport-throttled",
      "provider-transport-quota-exceeded",
      "provider-transport-timeout",
      "provider-transport-pagination-failure",
      "provider-transport-partial-data",
      "provider-transport-stale-cache",
      "provider-transport-degraded",
      "active-job-conflict",
      "concurrent-job",
      "security-privacy-blocked",
      "deploy-skew-unsupported-version",
    ],
    idempotencyRequired: true,
  }),
  action(
    "resume-import-job",
    "POST",
    "/api/catalog/source-observations/admin/import-jobs/:jobId/resume",
    "catalog.manage",
    {
      blockerCategories: ["job-not-found"],
      idempotencyRequired: true,
    },
  ),
  action(
    "retry-import-job",
    "POST",
    "/api/catalog/source-observations/admin/import-jobs/:jobId/retry",
    "catalog.manage",
    {
      blockerCategories: ["idempotency-replay", "stale-replay", "security-privacy-blocked"],
      idempotencyRequired: true,
    },
  ),
  action(
    "cancel-import-job",
    "POST",
    "/api/catalog/source-observations/admin/import-jobs/:jobId/cancel",
    "catalog.manage",
    {
      blockerCategories: ["permission-denied", "authorization-denied", "unsupported-command"],
      idempotencyRequired: true,
    },
  ),
  action("select-source-observations", "GET", "/api/catalog/source-observations/admin/review", "catalog.view", {
    blockerCategories: ["source-projection-stale", "read-model-unavailable"],
  }),
  action("preview-promotion", "POST", "/api/catalog/source-observations/admin/promotion-preview", "catalog.manage", {
    blockerCategories: [
      "selection-empty",
      "no-promotion-eligible-observations",
      "duplicate-conflict",
      "promotion-conflict",
      "source-projection-stale",
      "security-privacy-blocked",
    ],
    idempotencyRequired: true,
  }),
  action("execute-promotion", "POST", "/api/catalog/source-observations/admin/promotions", "catalog.manage", {
    blockerCategories: [
      "stale-promotion-preview",
      "destructive-confirmation-required",
      "promotion-conflict",
      "security-privacy-blocked",
      "deploy-skew-unsupported-version",
    ],
    confirmationRequired: true,
    idempotencyRequired: true,
  }),
  action("reject-source-observations", "POST", "/api/catalog/source-observations/admin/rejections", "catalog.manage", {
    blockerCategories: ["selection-empty", "permission-denied", "authorization-denied"],
    confirmationRequired: true,
    idempotencyRequired: true,
  }),
  action("defer-source-observations", "POST", "/api/catalog/source-observations/admin/deferrals", "catalog.manage", {
    blockerCategories: ["selection-empty", "permission-denied", "authorization-denied"],
    idempotencyRequired: true,
  }),
  action("start-reapply", "POST", "/api/catalog/source-observations/admin/reapply-jobs", "catalog.manage", {
    blockerCategories: ["profile-version-missing", "stale-replay", "idempotency-replay", "security-privacy-blocked"],
    idempotencyRequired: true,
  }),
  action("start-replay", "POST", "/api/catalog/source-observations/admin/replay-jobs", "catalog.manage", {
    blockerCategories: ["profile-version-missing", "stale-replay", "idempotency-replay", "security-privacy-blocked"],
    idempotencyRequired: true,
  }),
] as const satisfies readonly CatalogPrimaryWorkbenchActionContract[];

export const catalogPrimaryWorkbenchBlockers = [
  blocker("permission-denied", ["denied"], "catalog.primary.import.denied"),
  blocker("authorization-denied", ["denied"], "catalog.primary.import.denied"),
  blocker("rollout-disabled", ["blocked"], "catalog.primary.import.blocked"),
  blocker("kill-switch-active", ["blocked"], "catalog.primary.import.blocked"),
  blocker("rbac-missing", ["denied"], "catalog.primary.import.denied"),
  blocker("active-job-conflict", ["blocked"], "catalog.primary.import.blocked"),
  blocker("concurrent-job", ["blocked"], "catalog.primary.import.blocked"),
  blocker("missing-active-profile", ["blocked"], "catalog.primary.providerScope.required"),
  blocker("profile-version-missing", ["blocked"], "catalog.primary.reapply.originalProfileMissing"),
  blocker("missing-fixture-coverage", ["blocked"], "catalog.primary.import.blocked"),
  blocker("fixture-validation-blocked", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-credential-missing", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-credential-invalid", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-credential-expired", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-transport-rate-limited", ["degraded"], "catalog.primary.import.blocked"),
  blocker("provider-transport-throttled", ["degraded"], "catalog.primary.import.blocked"),
  blocker("provider-transport-quota-exceeded", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-transport-timeout", ["degraded"], "catalog.primary.import.blocked"),
  blocker("provider-transport-pagination-failure", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-transport-partial-data", ["degraded"], "catalog.primary.import.blocked"),
  blocker("provider-transport-stale-cache", ["degraded"], "catalog.primary.import.blocked"),
  blocker("provider-transport-degraded", ["degraded"], "catalog.primary.import.blocked"),
  blocker("source-projection-stale", ["degraded"], "catalog.primary.review.blocked"),
  blocker("read-model-degraded", ["degraded"], "catalog.primary.review.blocked"),
  blocker("read-model-partial", ["degraded"], "catalog.primary.review.blocked"),
  blocker("read-model-unavailable", ["unavailable"], "catalog.primary.review.blocked"),
  blocker("job-not-found", ["disabled"], "catalog.primary.import.blocked"),
  blocker("observation-not-found", ["disabled"], "catalog.primary.review.empty"),
  blocker("selection-empty", ["disabled"], "catalog.primary.review.empty"),
  blocker("no-promotion-eligible-observations", ["disabled"], "catalog.primary.review.empty"),
  blocker("duplicate-conflict", ["blocked"], "catalog.primary.promotion.previewRequired"),
  blocker("promotion-conflict", ["blocked"], "catalog.primary.promotion.previewRequired"),
  blocker("destructive-confirmation-required", ["unsafe"], "catalog.primary.promotion.previewRequired"),
  blocker("stale-promotion-preview", ["blocked"], "catalog.primary.promotion.stalePreview"),
  blocker("stale-replay", ["blocked"], "catalog.primary.reapply.originalProfileMissing"),
  blocker("idempotency-replay", ["blocked"], "catalog.primary.import.blocked"),
  blocker("security-privacy-blocked", ["unsafe"], "catalog.primary.promotion.securityBlocked"),
  blocker("unsupported-command", ["unavailable"], "catalog.primary.deploySkew.failClosed"),
  blocker("deploy-skew-unsupported-version", ["unavailable"], "catalog.primary.deploySkew.failClosed"),
  blocker("raw-json-retired", ["blocked"], "catalog.primary.deploySkew.failClosed"),
  blocker("legacy-selector-retired", ["blocked"], "catalog.primary.deploySkew.failClosed"),
] as const satisfies readonly CatalogPrimaryWorkbenchBlockerContract[];

export const catalogPrimaryWorkbenchDeploySkewPolicies = [
  deploySkew("current", true, []),
  deploySkew("old-ui-new-api", false, [
    "legacy provider selector",
    "current two-page module coupling",
    "raw JSON broad patch",
    "silent active-profile fallback",
  ]),
  deploySkew("new-ui-old-api", false, [
    "raw provider payload fallback",
    "generic disabled state",
    "support-only legacy route",
    "compatibility redirect",
  ]),
] as const satisfies readonly CatalogPrimaryWorkbenchDeploySkewPolicy[];

export const catalogPrimaryWorkbenchRetirementPolicy = {
  term: "retire",
  requiredDisposition: "complete-removal",
  surfaces: [
    "runtime code",
    "API routes",
    "UI modules",
    "route aliases",
    "hidden flags",
    "fallbacks",
    "redirects",
    "tests",
    "fixtures",
    "screenshots",
    "documentation",
    "runbooks",
    "release notes",
    "operator instructions",
  ],
  forbiddenOutcomes: [
    "soft deprecation",
    "compatibility shim",
    "legacy support path",
    "migration of the current two-page surface",
    "raw JSON escape hatch",
    "support-only preserved route",
  ],
} as const satisfies CatalogPrimaryWorkbenchRetirementPolicy;

export const catalogPrimaryWorkbenchInstrumentationDimensions = [
  "provider_key",
  "unit_key",
  "import_scope",
  "profile_version",
  "source_observation_status",
  "promotion_disposition",
  "blocker_category",
  "action_key",
  "transport_category",
  "read_model_freshness",
  "route_context_preserved",
] as const satisfies readonly CatalogPrimaryWorkbenchInstrumentationDimension[];

export const catalogPrimaryWorkbenchDownstreamContracts = [
  downstream(
    "#1056",
    [
      "provider-scope-selection",
      "readiness",
      "import-jobs",
      "source-observation-review",
      "promotion-preview",
      "promotion-result",
    ],
    [
      "schemaVersion",
      "routeContext",
      "providerScope",
      "readiness",
      "importJobs",
      "sourceObservationReview",
      "promotionPreview",
      "actions",
    ],
  ),
  downstream(
    "#1038",
    ["provider-scope-selection", "readiness", "import-jobs"],
    ["providerScope.providers.units.importScopes", "readiness.providerTransport", "importJobs.jobs.consistency"],
  ),
  downstream(
    "#1039",
    ["source-observation-review", "promotion-preview"],
    [
      "sourceObservationReview.counts",
      "sourceObservationReview.cursor",
      "sourceObservationReview.evidenceSummariesRedacted",
      "promotionPreview.dispositions",
    ],
  ),
  downstream(
    "#1040",
    ["promotion-preview", "promotion-result"],
    ["promotionPreview.commandPlanHash", "promotionPreview.dispositions", "promotionResult.auditEvidenceIds"],
  ),
  downstream(
    "#1057",
    ["provider-scope-selection", "import-jobs", "source-observation-review", "promotion-preview"],
    [
      "routeContext.providerKey",
      "routeContext.unitKey",
      "routeContext.importScope",
      "routeContext.selectedObservationIds",
      "routeContext.promotionPreviewId",
    ],
  ),
  downstream(
    "#1058",
    ["readiness", "import-jobs", "source-observation-review", "promotion-preview"],
    ["actions.copyKey", "readiness.blockers"],
  ),
  downstream(
    "#1059",
    ["provider-scope-selection", "readiness", "import-jobs", "source-observation-review", "promotion-preview"],
    ["instrumentation.dimensions", "instrumentation.redactionSafe"],
  ),
  downstream(
    "#1062",
    ["provider-scope-selection", "readiness", "import-jobs", "promotion-result"],
    ["providerScope.providers.providerKey", "readiness.providerTransport", "promotionResult.promotedCatalogItemIds"],
  ),
  downstream(
    "#1063",
    ["import-jobs", "promotion-preview"],
    ["importJobs.jobs.consistency", "promotionPreview.blockers"],
  ),
  downstream(
    "#1064",
    ["readiness", "promotion-preview", "promotion-result"],
    [
      "securityPrivacy.redactionApplied",
      "securityPrivacy.unsafeEvidenceBlocked",
      "securityPrivacy.missingSecurityFieldsBlocker",
    ],
  ),
  downstream("#1065", ["readiness", "import-jobs"], ["readiness.providerTransport", "readiness.blockers"]),
] as const satisfies readonly CatalogPrimaryWorkbenchDownstreamContract[];

export function assertCatalogPrimaryWorkbenchBlockerCategory(
  value: string,
): asserts value is CatalogPrimaryWorkbenchBlockerCategory {
  if (!catalogPrimaryWorkbenchBlockers.some((blockerEntry) => blockerEntry.category === value)) {
    throw new Error(`Unknown primary workbench blocker category '${value}' must fail closed.`);
  }
}

export function assertCatalogPrimaryWorkbenchActionState(
  value: string,
): asserts value is CatalogPrimaryWorkbenchActionState {
  const knownStates: readonly CatalogPrimaryWorkbenchActionState[] = [
    "available",
    "disabled",
    "denied",
    "blocked",
    "unavailable",
    "unsafe",
    "degraded",
  ];
  if (!knownStates.includes(value as CatalogPrimaryWorkbenchActionState)) {
    throw new Error(`Unknown primary workbench action state '${value}' must fail closed.`);
  }
}

export function validateCatalogPrimaryWorkbenchReadModelContract(
  value: Partial<CatalogPrimaryWorkbenchReadModel>,
): void {
  if (value.schemaVersion !== catalogPrimaryWorkbenchContractVersion) {
    throw new Error("Primary workbench schema version mismatch must fail closed.");
  }
  if (!value.routeContext) {
    throw new Error("Primary workbench route context is required for context preservation.");
  }
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
  for (const actionEntry of value.actions ?? []) {
    assertCatalogPrimaryWorkbenchActionState(actionEntry.state);
    assertPrimaryWorkbenchBlockers(actionEntry.blockers);
  }
  assertPrimaryWorkbenchBlockers(value.readiness?.blockers);
  assertPrimaryWorkbenchBlockers(value.importJobs?.jobs.flatMap((job) => job.blockers));
  assertPrimaryWorkbenchBlockers(value.promotionPreview?.blockers);
}

function section(input: CatalogPrimaryWorkbenchSectionContract): CatalogPrimaryWorkbenchSectionContract {
  return input;
}

function action(
  key: CatalogPrimaryWorkbenchCommandKey,
  method: CatalogPrimaryWorkbenchActionContract["method"],
  routePattern: string,
  requiredPermission: CatalogPrimaryWorkbenchActionContract["requiredPermission"],
  options: Partial<
    Pick<
      CatalogPrimaryWorkbenchActionContract,
      "blockerCategories" | "idempotencyRequired" | "confirmationRequired" | "successState"
    >
  > = {},
): CatalogPrimaryWorkbenchActionContract {
  return {
    key,
    method,
    routePattern,
    requiredPermission,
    successState: options.successState ?? "available",
    blockerCategories: options.blockerCategories ?? [],
    idempotencyRequired: options.idempotencyRequired ?? false,
    confirmationRequired: options.confirmationRequired ?? false,
  };
}

function blocker(
  category: CatalogPrimaryWorkbenchBlockerCategory,
  actionStates: readonly CatalogPrimaryWorkbenchActionState[],
  copyKey: CatalogPrimaryWorkbenchCopyKey,
): CatalogPrimaryWorkbenchBlockerContract {
  return {
    category,
    actionStates,
    copyKey,
    instrumentationDimension: "blocker_category",
    failClosed: true,
  };
}

function deploySkew(
  mode: CatalogPrimaryWorkbenchDeploySkewMode,
  supported: boolean,
  forbiddenFallbacks: readonly string[],
): CatalogPrimaryWorkbenchDeploySkewPolicy {
  return {
    mode,
    supported,
    failClosedBlocker: "deploy-skew-unsupported-version",
    forbiddenFallbacks,
  };
}

function downstream(
  issue: CatalogPrimaryWorkbenchDownstreamIssueKey,
  consumes: readonly CatalogPrimaryWorkbenchSectionKey[],
  requiredFields: readonly string[],
): CatalogPrimaryWorkbenchDownstreamContract {
  return {
    issue,
    consumes,
    requiredFields,
  };
}

function assertPrimaryWorkbenchBlockers(blockers: readonly string[] | undefined): void {
  for (const blockerEntry of blockers ?? []) {
    assertCatalogPrimaryWorkbenchBlockerCategory(blockerEntry);
  }
}
