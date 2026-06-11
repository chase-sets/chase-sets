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

export type CatalogPrimaryWorkbenchSourceObservationRowActionKey =
  | "view-source-observation"
  | "preview-promotion"
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

export const catalogPrimaryWorkbenchProviderTransportCategories = [
  "rate-limit",
  "throttle",
  "quota",
  "timeout",
  "pagination-failure",
  "partial-data",
  "stale-cache",
  "degraded-provider",
] as const satisfies readonly CatalogPrimaryWorkbenchProviderTransportCategory[];

export type CatalogPrimaryWorkbenchPromotionDisposition =
  | "eligible"
  | "skipped"
  | "blocked"
  | "conflicting"
  | "destructive"
  | "stale-preview"
  | "confirmation-required";

export type CatalogPrimaryWorkbenchPromotionScopeKind = "explicit-rows" | "matching-filter";

export type CatalogPrimaryWorkbenchPromotionOutcomeCountKey =
  | "eligible"
  | "blocked"
  | "skipped"
  | "conflicting"
  | "failed";

export type CatalogPrimaryWorkbenchPromotionStaleProtectionKey =
  | "observations"
  | "profile-version"
  | "rollout-state"
  | "permissions"
  | "command-inputs";

export type CatalogPrimaryWorkbenchPromotionProfileSemantics =
  | "current-active-profile"
  | "original-source-profile-version";

export type CatalogPrimaryWorkbenchRouteContextKey =
  | "section"
  | "providerKey"
  | "unitKey"
  | "importScope"
  | "profileVersion"
  | "sourceObservationFilters"
  | "selectedObservationIds"
  | "jobId"
  | "promotionPreviewId"
  | "returnPath";

export const catalogPrimaryWorkbenchRouteSections = [
  "import-to-promotion",
  "health-triage",
  "profile-authoring",
  "validation-readiness",
  "adapter-readiness",
  "lifecycle-recovery",
  "governance-controls",
  "audit-evidence",
  "provider-scope-selection",
  "readiness",
  "import-jobs",
  "source-observation-review",
  "promotion-preview",
  "promotion-result",
  "supporting-evidence",
] as const;

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
  section: string;
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
  activeJobCount: number;
  failedJobCount: number;
  selectedScope: Readonly<{
    providerKey: string;
    unitKey: CatalogIntegrationUnitKey | null;
    importScope: string;
    profileVersion: string | null;
    profileSnapshot: CatalogAdminProfileVersionPointer | null;
    expectedObservationVolume: number;
    observedCount: number;
    changedCount: number;
    promotedCount: number;
    rejectedCount: number;
    readiness: Readonly<{
      adapterReadiness: "ready" | "blocked" | "degraded" | "unknown";
      credentialReadiness: "ready" | "blocked" | "not-required" | "unknown";
      rolloutEnabled: boolean;
      providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[];
      blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    }>;
  }> | null;
  jobs: readonly Readonly<{
    jobId: string;
    action: Extract<CatalogPrimaryWorkbenchCommandKey, "start-provider-import" | "start-reapply" | "start-replay">;
    state: "queued" | "running" | "completed" | "failed" | "cancelled";
    operatorStatus: "queued" | "running" | "stale" | "retried" | "partial" | "failed" | "cancelled" | "completed";
    summary: string;
    completed: number;
    total: number;
    progressPercent: number;
    unitKey: CatalogIntegrationUnitKey | null;
    providerKey: string;
    importScope: string | null;
    profileVersion: string | null;
    profileSnapshot: CatalogAdminProfileVersionPointer | null;
    scopeMatchesRoute: boolean;
    createdAt: string;
    startedAt: string | null;
    consistency: CatalogAdminJobConsistency;
    failureGroups: readonly Readonly<{
      key: string;
      label: string;
      count: number;
      severity: "warning" | "error";
    }>[];
    retryAvailable: boolean;
    resumeAvailable: boolean;
    cancelAvailable: boolean;
    sourceObservationReviewHref: string;
    auditEvidenceUrl: string;
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
  filters: readonly Readonly<{
    key:
      | "providerKey"
      | "unitKey"
      | "profileVersion"
      | "status"
      | "language"
      | "setId"
      | "observedAfter"
      | "observedBefore";
    label: string;
    value: string | null;
    serverApplied: boolean;
  }>[];
  savedFilters: readonly Readonly<{
    key: string;
    label: string;
    filters: Readonly<Record<string, string>>;
    count: number | null;
  }>[];
  pagination: Readonly<{
    mode: "offset";
    limit: number;
    offset: number;
    total: number;
    nextCursor: string | null;
    previousCursor: string | null;
  }>;
  bulkSelection: Readonly<{
    selectedCount: number;
    eligibleSelectedCount: number;
    actions: readonly CatalogPrimaryWorkbenchSourceObservationRowActionKey[];
  }>;
  rows: readonly CatalogPrimaryWorkbenchSourceObservationReviewRow[];
}>;

export type CatalogPrimaryWorkbenchSourceObservationReviewRow = Readonly<{
  observationId: string;
  providerKey: string;
  externalKey: string;
  displayName: string;
  status: string;
  statusReason: string | null;
  languageCode: string;
  sourceUrl: string;
  sourceRecordHash: string;
  sourceUpdatedAt: string | null;
  observedAt: string;
  changedAt: string;
  sourceProfileVersion: string;
  promotionProfileVersion: string | null;
  normalizedFactSummaries: readonly string[];
  payloadSummary: string;
  redactionSummary: string;
  duplicateEvidence: readonly string[];
  conflictEvidence: readonly string[];
  promotionReadiness: Readonly<{
    state: "eligible" | "blocked" | "already-promoted" | "rejected";
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>;
  commandPreview: Readonly<{
    promotionPlanHash: string | null;
    disposition: CatalogPrimaryWorkbenchPromotionDisposition;
    confirmationRequired: boolean;
  }>;
  auditTrail: readonly string[];
  detailHref: string;
  actions: readonly Readonly<{
    key: CatalogPrimaryWorkbenchSourceObservationRowActionKey;
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    href: string | null;
  }>[];
}>;

export type CatalogPrimaryWorkbenchPromotionPreviewReadModel = Readonly<{
  previewId: string | null;
  freshness: CatalogAdminControlPlaneFreshnessState;
  scope: Readonly<{
    kind: CatalogPrimaryWorkbenchPromotionScopeKind;
    label: string;
    requestedCount: number;
    eligibleCount: number;
    selectedObservationIds: readonly string[];
    filterSummary: readonly string[];
    partialFailureMode: "per-observation";
  }>;
  dispositions: Readonly<Record<CatalogPrimaryWorkbenchPromotionDisposition, number>>;
  outcomeCounts: Readonly<Record<CatalogPrimaryWorkbenchPromotionOutcomeCountKey, number>>;
  commandPlanHash: string | null;
  confirmationRequired: boolean;
  destructiveCount: number;
  executionSafeguards: Readonly<{
    previewRequired: boolean;
    previewFresh: boolean;
    stalePreviewRejected: boolean;
    idempotencyRequired: true;
    doubleSubmitProtection: true;
    rejectsWhenChanged: readonly CatalogPrimaryWorkbenchPromotionStaleProtectionKey[];
    staleReasons: readonly CatalogPrimaryWorkbenchPromotionStaleProtectionKey[];
    overlappingActionBlockers: readonly Extract<
      CatalogPrimaryWorkbenchBlockerCategory,
      "active-job-conflict" | "concurrent-job"
    >[];
  }>;
  reviewDecisions: Readonly<{
    reject: Readonly<{
      reasonRequired: true;
      partialFailureMode: "failed-observations-remain-in-scope";
      auditEvidenceRequired: true;
    }>;
    defer: Readonly<{
      stateChange: "keeps-observation-in-review";
      returnsToReviewWhen: "next-provider-import-or-filter-reset";
      auditEvidenceRequired: true;
    }>;
  }>;
  profileWorkflows: Readonly<{
    reapply: Readonly<{
      profileSemantics: Extract<CatalogPrimaryWorkbenchPromotionProfileSemantics, "current-active-profile">;
      target: "promoted-observations";
      profileVersion: string | null;
    }>;
    replay: Readonly<{
      profileSemantics: Extract<CatalogPrimaryWorkbenchPromotionProfileSemantics, "original-source-profile-version">;
      target: "source-observation-evidence";
      profileVersion: string | null;
    }>;
  }>;
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
    routeContextKeys: ["section", "providerKey", "unitKey", "importScope", "profileVersion", "returnPath"],
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
    routeContextKeys: ["section", "providerKey", "unitKey", "importScope", "profileVersion", "returnPath"],
  }),
  section({
    key: "import-jobs",
    defaultVisible: true,
    queryKeys: ["import-job-progress-summary"],
    commands: ["start-provider-import", "resume-import-job", "retry-import-job", "cancel-import-job"],
    freshnessStates: ["fresh", "stale", "lagging", "unavailable"],
    pagination: "sse",
    routeContextKeys: ["section", "providerKey", "unitKey", "importScope", "profileVersion", "jobId", "returnPath"],
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
      "section",
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
      "section",
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
    routeContextKeys: ["section", "providerKey", "unitKey", "profileVersion", "jobId", "returnPath"],
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
    routeContextKeys: ["section", "providerKey", "unitKey", "profileVersion", "returnPath"],
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
      "active-job-conflict",
      "concurrent-job",
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
    "product patterns",
    "read-model contracts",
    "clients",
    "route aliases",
    "feature flags",
    "hidden flags",
    "fallback branches",
    "redirects",
    "compatibility aliases",
    "compatibility shims",
    "migration shims",
    "tests",
    "fixtures",
    "seeds",
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
    "documentation-only deprecation",
    "hidden flag fallback",
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
      "sourceObservationReview.filters",
      "sourceObservationReview.pagination",
      "sourceObservationReview.rows",
      "sourceObservationReview.rows.actions",
      "sourceObservationReview.rows.promotionReadiness",
      "promotionPreview.dispositions",
    ],
  ),
  downstream(
    "#1040",
    ["promotion-preview", "promotion-result"],
    [
      "promotionPreview.scope",
      "promotionPreview.outcomeCounts",
      "promotionPreview.commandPlanHash",
      "promotionPreview.executionSafeguards",
      "promotionPreview.reviewDecisions",
      "promotionPreview.profileWorkflows",
      "promotionResult.auditEvidenceIds",
    ],
  ),
  downstream(
    "#1057",
    ["provider-scope-selection", "import-jobs", "source-observation-review", "promotion-preview"],
    [
      "routeContext.section",
      "routeContext.providerKey",
      "routeContext.unitKey",
      "routeContext.importScope",
      "routeContext.sourceObservationFilters",
      "routeContext.selectedObservationIds",
      "routeContext.jobId",
      "routeContext.promotionPreviewId",
      "routeContext.returnPath",
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
  for (const actionEntry of value.actions ?? []) {
    assertCatalogPrimaryWorkbenchActionState(actionEntry.state);
    assertPrimaryWorkbenchBlockers(actionEntry.blockers);
  }
  assertPrimaryWorkbenchBlockers(value.readiness?.blockers);
  assertPrimaryWorkbenchBlockers(value.importJobs?.selectedScope?.readiness.blockers);
  assertPrimaryWorkbenchBlockers(value.importJobs?.jobs.flatMap((job) => job.blockers));
  assertPrimaryWorkbenchBlockers(
    value.sourceObservationReview?.rows.flatMap((row) => [
      ...row.promotionReadiness.blockers,
      ...row.actions.flatMap((actionEntry) => actionEntry.blockers),
    ]),
  );
  assertPrimaryWorkbenchBlockers(value.promotionPreview?.blockers);
  assertPrimaryWorkbenchPromotionPreview(value.promotionPreview);
}

function validatePrimaryWorkbenchRouteContext(context: CatalogPrimaryWorkbenchRouteContext): void {
  if (
    !context.section ||
    !catalogPrimaryWorkbenchRouteSections.includes(
      context.section as (typeof catalogPrimaryWorkbenchRouteSections)[number],
    ) ||
    /legacy|compat|raw-json|god-page|provider-profile-review/i.test(context.section)
  ) {
    throw new Error("Primary workbench route context section must be a rebuilt workspace or primary section key.");
  }
  if (!Array.isArray(context.selectedObservationIds)) {
    throw new Error("Primary workbench route context selectedObservationIds must be an array.");
  }
  if (context.selectedObservationIds.some((id) => !id || /[?#]/.test(id))) {
    throw new Error("Primary workbench route context selectedObservationIds must be clean identifiers.");
  }
  if (!context.sourceObservationFilters || typeof context.sourceObservationFilters !== "object") {
    throw new Error("Primary workbench route context Source Observation filters are required.");
  }
  for (const [key, value] of Object.entries(context.sourceObservationFilters)) {
    if (!key || key.includes("=") || key.includes("&") || value.includes("\n")) {
      throw new Error("Primary workbench route context filters must be clean query values.");
    }
  }
  if (
    context.returnPath &&
    (!isSafePrimaryWorkbenchReturnPath(context.returnPath) ||
      /legacy|compat|raw-json|god-page/i.test(context.returnPath))
  ) {
    throw new Error("Primary workbench returnPath must be a safe rebuilt Catalog admin path.");
  }
}

function isSafePrimaryWorkbenchReturnPath(path: string): boolean {
  if (path.startsWith("//")) {
    return false;
  }
  try {
    const parsedUrl = new URL(path, "https://admin.example");
    return parsedUrl.origin === "https://admin.example" && parsedUrl.pathname === "/catalog/integrations";
  } catch {
    return false;
  }
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

function assertPrimaryWorkbenchPromotionPreview(
  value: CatalogPrimaryWorkbenchReadModel["promotionPreview"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench promotion preview contract is required.");
  }
  if (!value.scope) {
    throw new Error("Primary workbench promotion preview scope is required.");
  }
  if (value.scope.partialFailureMode !== "per-observation") {
    throw new Error("Primary workbench promotion preview must preserve per-observation partial failure scope.");
  }
  for (const key of ["eligible", "blocked", "skipped", "conflicting", "failed"] as const) {
    if (typeof value.outcomeCounts?.[key] !== "number") {
      throw new Error(`Primary workbench promotion outcome count '${key}' is required.`);
    }
  }
  if (!value.executionSafeguards?.idempotencyRequired || !value.executionSafeguards.doubleSubmitProtection) {
    throw new Error(
      "Primary workbench promotion execution safeguards must include idempotency and double-submit protection.",
    );
  }
  for (const staleProtection of [
    "observations",
    "profile-version",
    "rollout-state",
    "permissions",
    "command-inputs",
  ] as const) {
    if (!value.executionSafeguards.rejectsWhenChanged.includes(staleProtection)) {
      throw new Error(`Primary workbench promotion execution must reject stale ${staleProtection} previews.`);
    }
  }
  assertPrimaryWorkbenchBlockers(value.executionSafeguards.overlappingActionBlockers);
  if (!value.reviewDecisions?.reject.reasonRequired) {
    throw new Error("Primary workbench rejection decisions must require a reason.");
  }
  if (value.reviewDecisions.defer.stateChange !== "keeps-observation-in-review") {
    throw new Error("Primary workbench defer decisions must preserve review return semantics.");
  }
  if (value.profileWorkflows?.reapply.profileSemantics !== "current-active-profile") {
    throw new Error("Primary workbench reapply must use current active profile semantics.");
  }
  if (value.profileWorkflows.replay.profileSemantics !== "original-source-profile-version") {
    throw new Error("Primary workbench replay must use original source profile version semantics.");
  }
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
