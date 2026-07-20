import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogMergeCandidateReviewCommandPreview } from "./catalog-merge-candidate-review-command-payloads";
import type {
  CatalogAdminControlPlaneFreshnessState,
  CatalogAdminControlPlanePaginationMode,
} from "./admin-control-plane-read-model-slos";
import type {
  CatalogIntegrationAuditEvidenceCategory,
  CatalogIntegrationAuditEvidenceEventName,
  CatalogIntegrationAuditEvidenceRedactionState,
} from "./catalog-integration-audit-evidence";
import type {
  CatalogAdminControlPlaneQueryKey,
  CatalogAdminControlPlaneDiagnostic,
  CatalogAdminRollbackRetirementImpactSummaryReadModel,
  CatalogAdminJobConsistency,
  CatalogAdminProfileVersionPointer,
} from "./admin-control-plane-read-model-contracts";
import type { CatalogIntegrationUnitKey } from "./integration-unit";
import type { CatalogProviderProfileEditableSectionKey } from "./provider-profile-section-registry";
import type { CatalogControlPlaneActionId } from "../ui/admin-control-plane/information-architecture-v2";

export const catalogPrimaryWorkbenchContractVersion = "catalog-primary-workbench-v2" as const;

export type CatalogPrimaryWorkbenchContractVersion = typeof catalogPrimaryWorkbenchContractVersion;

export type CatalogPrimaryWorkbenchSectionKey =
  | "provider-scope-selection"
  | "readiness"
  | "import-jobs"
  | "source-observation-review"
  | "conflict-resolution"
  | "promotion-preview"
  | "promotion-result"
  | "lifecycle-recovery"
  | "governance-controls"
  | "audit-evidence"
  | "supporting-evidence";

export type CatalogPrimaryWorkbenchCommandKey = CatalogControlPlaneActionId;

export type CatalogPrimaryWorkbenchSourceObservationRowActionKey =
  | "view-source-observation"
  | "observation.promote"
  | "observation.reject"
  | "observation.defer"
  | "observation.reapply"
  | "observation.replay";

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
  | "provider-selection-required"
  | "unit-selection-required"
  | "import-scope-required"
  | "missing-active-profile"
  | "profile-version-missing"
  | "profile-section-read-only"
  | "profile-section-stale"
  | "profile-section-invalid"
  | "profile-lifecycle-conflict"
  | "profile-retirement-references"
  | "activation-readiness-blocked"
  | "migration-evidence-missing"
  | "reference-impact-review-required"
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
  | "scope"
  | "importScope"
  | "profileVersion"
  | "sourceObservationFilters"
  | "selectedObservationIds"
  | "reviewOffset"
  | "reviewLimit"
  | "jobId"
  | "promotionPreviewId"
  | "returnPath";

export const catalogPrimaryWorkbenchRouteSections = [
  "import-to-promotion",
  "health-triage",
  "profile-authoring",
  "validation-readiness",
  "conflict-resolution",
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
  method: "GET" | "POST" | "PATCH";
  routePattern: string;
  requiredPermission: "catalog.view" | "catalog.manage";
  successState: CatalogPrimaryWorkbenchActionState;
  blockerCategories: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  idempotencyRequired: boolean;
  confirmationRequired: boolean;
}>;

export type CatalogPrimaryWorkbenchDownstreamIssueKey =
  | "#1033"
  | "#1034"
  | "#1035"
  | "#1036"
  | "#1037"
  | "#1056"
  | "#1038"
  | "#1039"
  | "#1040"
  | "#1041"
  | "#1042"
  | "#1043"
  | "#1044"
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
  sourceOptions: CatalogPrimaryWorkbenchSourceOptionsReadModel;
  catalogSync: CatalogPrimaryWorkbenchCatalogSyncReadModel;
  sourceScopeWorkset: CatalogPrimaryWorkbenchSourceScopeWorksetReadModel;
  readiness: CatalogPrimaryWorkbenchReadinessReadModel;
  healthTriage: CatalogPrimaryWorkbenchHealthTriageReadModel;
  profileAuthoring: CatalogPrimaryWorkbenchProfileAuthoringReadModel;
  validationReadiness: CatalogPrimaryWorkbenchValidationReadinessReadModel;
  lifecycleRecovery: CatalogPrimaryWorkbenchLifecycleRecoveryReadModel;
  governanceControls: CatalogPrimaryWorkbenchGovernanceControlsReadModel;
  auditEvidence: CatalogPrimaryWorkbenchAuditEvidenceReadModel;
  importJobs: CatalogPrimaryWorkbenchImportJobsReadModel;
  sourceObservationReview: CatalogPrimaryWorkbenchSourceObservationReviewReadModel;
  mergeCandidateReview: CatalogPrimaryWorkbenchMergeCandidateReviewReadModel;
  conflictResolution: CatalogPrimaryWorkbenchConflictResolutionReadModel;
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
  scope?: CatalogPrimaryWorkbenchScopeContext;
  importScope: string | null;
  profileVersion: string | null;
  sourceObservationFilters: Readonly<Record<string, string>>;
  selectedObservationIds: readonly string[];
  // Source Observation review page window. reviewOffset is the durable, URL-backed
  // pager cursor (null = first page); reviewLimit overrides the default page size
  // only when present. Kept on the route context so catalogPrimaryWorkbenchHref
  // round-trips the page through the loader alongside provider/unit/scope/filters
  // and the current selection.
  reviewOffset: number | null;
  reviewLimit: number | null;
  jobId: string | null;
  promotionPreviewId: string | null;
  /** Canonical Scope Record identity for scope-first routes. */
  scopeRecordId?: string | null;
  returnPath: string | null;
}>;

export type CatalogPrimaryWorkbenchScopeContext = Readonly<{
  providerKey: string | null;
  languageCode: string | null;
  productLineId: string | null;
  productLineName: string | null;
  seriesId: string | null;
  seriesName: string | null;
  expansionId: string | null;
  expansionName: string | null;
  status: string | null;
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

export type CatalogPrimaryWorkbenchSourceOptionsStatus = "ready" | "degraded" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchSourceOptionPageState =
  | "live"
  | "cached"
  | "stale"
  | "unavailable"
  | "rollout-blocked"
  | "not-requested";

export type CatalogPrimaryWorkbenchSourceOptionKindReadModel = Readonly<{
  queryKind: string;
  queryKeySynonyms: readonly string[];
  displayName: string;
  scope: string;
  parentScope: string | null;
  parent: Readonly<{
    scope: string | null;
    required: boolean;
    valueKind: string | null;
    diagnosticText: string | null;
    selectedValue: string | null;
    selectedLabel: string | null;
    missing: boolean;
  }>;
}>;

export type CatalogPrimaryWorkbenchSourceOptionPageReadModel = Readonly<{
  queryKind: string;
  displayName: string;
  scope: string;
  state: CatalogPrimaryWorkbenchSourceOptionPageState;
  actionState: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  degraded: boolean;
  request: Readonly<{
    providerKey: string;
    languageCode: string | null;
    parentValue: string | null;
    cursor: string | null;
    limit: number;
    cacheOnly: boolean;
  }>;
  page: Readonly<{
    cursor: string | null;
    nextCursor: string | null;
    limit: number;
    hasMore: boolean;
    total: number;
    count: number;
  }>;
  cache: Readonly<{
    status: "fresh" | "stale" | "miss" | "bypass" | "unavailable";
    source: "cache" | "live" | "none";
    cacheKey: string | null;
    fetchedAt: string | null;
    expiresAt: string | null;
    staleUntil: string | null;
    cacheOnly: boolean;
    forceRefresh: boolean;
    degraded: boolean;
    diagnostics: readonly Readonly<{
      code: string;
      severity: "info" | "warning" | "error";
      message: string;
      retryAfterSeconds: number | null;
    }>[];
  }>;
  items: readonly Readonly<{
    providerKey: string;
    queryKind: string;
    value: string;
    label: string;
    description: string | null;
    parentValue: string | null;
    imageUrl: string | null;
    metadata: Readonly<Record<string, JsonValue>>;
  }>[];
  queryHref: string;
  refreshHref: string | null;
  nextPageHref: string | null;
}>;

export type CatalogPrimaryWorkbenchSourceOptionsReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchSourceOptionsStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  selectedProviderKey: string | null;
  selectedUnitKey: CatalogIntegrationUnitKey | null;
  selectedProfile: CatalogAdminProfileVersionPointer | null;
  summary: Readonly<{
    declaredKinds: number;
    loadedPages: number;
    availableOptions: number;
    stalePages: number;
    degradedPages: number;
    unavailablePages: number;
    rolloutBlockedPages: number;
    blockedPages: number;
    missingParentPages: number;
    hasMorePages: number;
  }>;
  optionKinds: readonly CatalogPrimaryWorkbenchSourceOptionKindReadModel[];
  pages: readonly CatalogPrimaryWorkbenchSourceOptionPageReadModel[];
  refresh: Readonly<{
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    refreshAllHref: string | null;
    cacheOnly: boolean;
    forceRefreshSupported: boolean;
  }>;
}>;

export type CatalogPrimaryWorkbenchCatalogSyncStatus = "scope-required" | "ready" | "blocked" | "degraded";

export type CatalogPrimaryWorkbenchCatalogSyncReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchCatalogSyncStatus;
  generatedAt: string;
  scope: Readonly<{
    scopeVersion: "catalog-sync-scope-v2";
    productDomain: string | null;
    productForm: string | null;
    languageCode: string | null;
    reference: Readonly<{
      kind: "product-line" | "series" | "expansion" | "set" | "catalog-item" | null;
      scopeRecordId: string | null;
    }>;
    label: string;
    hasConcreteScope: boolean;
  }>;
  preview: Readonly<{
    previewVersion: "catalog-sync-provider-participation-preview-v1";
    status: "ready" | "degraded" | "blocked";
    startAllowed: boolean;
    explanation: string;
    estimate: Readonly<{
      totalEstimatedRequestCount: number | null;
      estimateState: "estimated" | "estimate-unavailable";
      estimateReason: string | null;
      creditConsumingProviders: readonly Readonly<{
        providerKey: string;
        displayName: string;
        unitKeys: readonly string[];
      }>[];
    }>;
    blockers: readonly Readonly<{
      code: string;
      severity: "info" | "warning" | "error";
      message: string;
      providerKey: string;
      unitKey: string | null;
    }>[];
    units: readonly CatalogPrimaryWorkbenchCatalogSyncUnitReadModel[];
  }>;
  action: CatalogPrimaryWorkbenchActionReadModel;
}>;

export type CatalogPrimaryWorkbenchCatalogSyncUnitReadModel = Readonly<{
  providerKey: string;
  unitKey: string | null;
  displayName: string;
  profileVersion: string | null;
  productDomain: string | null;
  productForm: string | null;
  role: "primary" | "supplementary" | "reference";
  requirement: "required" | "optional";
  selected: boolean;
  eligibility: "eligible" | "blocked";
  childExecutionScope: Readonly<Record<string, string>> | null;
  estimate: Readonly<{
    estimateState: "estimated" | "estimate-unavailable";
    estimatedRequestCount: number | null;
    estimateReason: string | null;
  }> | null;
  blockers: readonly Readonly<{
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
  }>[];
}>;

export type CatalogPrimaryWorkbenchSourceScopeWorksetStatus =
  | "not-configured"
  | "scope-required"
  | "ready"
  | "blocked"
  | "degraded";

export type CatalogPrimaryWorkbenchSourceScopeWorksetUnitState =
  | "not-imported"
  | "imported"
  | "changed"
  | "promoted"
  | "blocked";

export type CatalogPrimaryWorkbenchSourceScopeWorksetReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchSourceScopeWorksetStatus;
  generatedAt: string;
  selectedScope: Readonly<{
    importScope: string | null;
    label: string;
    hasConcreteScope: boolean;
    scope: CatalogPrimaryWorkbenchScopeContext;
  }>;
  summary: Readonly<{
    unitCount: number;
    readyUnitCount: number;
    blockedUnitCount: number;
    activeImportCount: number;
    changedObservationCount: number;
    promotedObservationCount: number;
  }>;
  units: readonly CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel[];
}>;

export type CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel = Readonly<{
  providerKey: string;
  displayName: string;
  unitKey: CatalogIntegrationUnitKey | null;
  productDomain: string | null;
  productForm: string | null;
  profileVersion: string | null;
  importScope: string | null;
  profileReady: boolean;
  optionQueryState: CatalogPrimaryWorkbenchSourceOptionsStatus;
  state: CatalogPrimaryWorkbenchSourceScopeWorksetUnitState;
  counts: Readonly<{
    observed: number;
    changed: number;
    promoted: number;
    rejected: number;
    eligible: number;
  }>;
  activeJobCount: number;
  lastJobState: CatalogPrimaryWorkbenchImportJobsReadModel["jobs"][number]["state"] | null;
  currentWorkbenchHref: string;
  commandContext: Readonly<{
    providerKey: string;
    unitKey: CatalogIntegrationUnitKey | null;
    importScope: string | null;
    profileVersion: string | null;
    languageCode: string | null;
    productLineId: string | null;
    productLineName: string | null;
    seriesId: string | null;
    seriesName: string | null;
    expansionId: string | null;
    expansionName: string | null;
  }>;
  actions: Readonly<{
    import: CatalogPrimaryWorkbenchActionReadModel;
    previewPromotion: CatalogPrimaryWorkbenchActionReadModel;
    reapply: CatalogPrimaryWorkbenchActionReadModel;
  }>;
}>;

export type CatalogPrimaryWorkbenchReadinessReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[];
  rolloutEnabled: boolean;
  rbacAllowed: boolean;
  auditEvidenceUrl: string | null;
}>;

export type CatalogPrimaryWorkbenchHealthTriageStatus = "ready" | "degraded" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchHealthTriageReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchHealthTriageStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  selectedProviderKey: string | null;
  selectedUnitKey: CatalogIntegrationUnitKey | null;
  returnToPrimaryHref: string;
  summary: Readonly<{
    readyUnits: number;
    totalUnits: number;
    blockedUnits: number;
    degradedProviders: number;
    activeJobs: number;
    rolloutStops: number;
    auditEntries: number;
  }>;
  readModels: readonly CatalogPrimaryWorkbenchHealthTriageReadModelState[];
  units: readonly CatalogPrimaryWorkbenchHealthTriageUnit[];
  providers: readonly CatalogPrimaryWorkbenchHealthTriageProvider[];
  rolloutControls: readonly CatalogPrimaryWorkbenchHealthTriageRolloutControl[];
  recentJobs: readonly CatalogPrimaryWorkbenchHealthTriageJob[];
  auditPreview: CatalogPrimaryWorkbenchHealthTriageAuditPreview;
}>;

export type CatalogPrimaryWorkbenchHealthTriageReadModelState = Readonly<{
  queryKey: CatalogAdminControlPlaneQueryKey;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string | null;
  statusMessage: string;
  ownerMetricKey: string;
}>;

export type CatalogPrimaryWorkbenchHealthTriageUnit = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  providerKey: string;
  displayName: string;
  productDomain: string;
  productForm: string;
  ingestionPurpose: string | null;
  profileVersion: string | null;
  status: CatalogPrimaryWorkbenchHealthTriageStatus;
  semanticReadiness: "ready" | "blocked";
  credentialReadiness: "ready" | "blocked" | "not-required";
  credentialReadinessState: string;
  transportReadiness: "ready" | "blocked";
  fixtureValidationStatus: "ready" | "blocked";
  dryRunStatus: "completed" | "blocked";
  observationFacts: number;
  diagnosticCounts: Readonly<Record<"info" | "warning" | "error", number>>;
  diagnosticCodes: readonly string[];
  latestDiagnosticText: string | null;
  affectedPrimaryAction: "pull-provider-data" | "review-source-observations" | "observation.promote";
  ownerMetricKey: string;
  nextAction: string;
}>;

export type CatalogPrimaryWorkbenchHealthTriageProvider = Readonly<{
  providerKey: string;
  adapterKey: string;
  status: CatalogPrimaryWorkbenchHealthTriageStatus;
  readiness: "ready" | "blocked" | "degraded";
  credentialReadiness: "ready" | "blocked" | "not-required";
  credentialReadinessState: string;
  unitKeys: readonly CatalogIntegrationUnitKey[];
  apiReachability: string;
  optionQueryHealth: string;
  rateLimitStatus: string;
  payloadAcquisition: string;
  usageBudget: Readonly<{
    creditBalance: number | null;
    creditUnit: string | null;
    readiness: "ready" | "degraded" | "blocked" | "unknown";
    estimatedCalls: number | null;
    estimatedScope: string | null;
    refreshedAt: string | null;
  }> | null;
  diagnosticCodes: readonly string[];
  latestDiagnosticText: string | null;
  ownerMetricKey: string;
  nextAction: string;
}>;

export type CatalogPrimaryWorkbenchValidationReadinessStatus = "ready" | "degraded" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchValidationFixtureFlowStatus = "ready" | "warning" | "blocked" | "not-covered";

export type CatalogPrimaryWorkbenchValidationReadinessReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchValidationReadinessStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  selectedProviderKey: string | null;
  selectedUnitKey: CatalogIntegrationUnitKey | null;
  selectedProfileVersion: string | null;
  selectedFixtureFlow: string | null;
  returnToPrimaryHref: string;
  summary: Readonly<{
    readyFixtureFlows: number;
    totalFixtureFlows: number;
    blockedFixtureFlows: number;
    dryRunEvidenceCount: number;
    semanticChangeCount: number;
    unchangedSectionCount: number;
    blockingReadinessChecks: number;
    auditEvidenceCount: number;
  }>;
  fixtureFlows: readonly Readonly<{
    flow: string;
    label: string;
    status: CatalogPrimaryWorkbenchValidationFixtureFlowStatus;
    payloadFile: string | null;
    payloadPath: string | null;
    expectedStatus: string | null;
    expectedDiagnosticPaths: readonly string[];
    expectedHashEvidencePaths: readonly string[];
    expectedMergeEvidencePaths: readonly string[];
    expectedPromotionCommands: readonly string[];
    samplePayloadAvailable: boolean;
    diagnostics: readonly Readonly<{
      path: string;
      diagnosticText: string;
      severity: "error" | "warning";
    }>[];
    actionState: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>[];
  dryRunEvidence: readonly Readonly<{
    externalKey: string;
    sourceUrl: string | null;
    sourceHash: string | null;
    status: "completed" | "blocked" | "not-run";
    normalizedFacts: readonly Readonly<{ key: string; value: string }>[];
    redactionSummary: readonly Readonly<{ label: string; value: string }>[];
    duplicateCandidates: readonly CatalogPrimaryWorkbenchValidationEvidenceRow[];
    selectedOptions: readonly CatalogPrimaryWorkbenchValidationEvidenceRow[];
    promotionCommandPreview: readonly Readonly<{
      commandName: string;
      inputs: readonly CatalogPrimaryWorkbenchValidationEvidenceRow[];
    }>[];
    diagnostics: readonly Readonly<{
      code: string;
      path: string;
      sectionKey: string;
      domainConcept: string;
      diagnosticText: string;
      severity: "error" | "warning";
      fixtureFlow: string | null;
    }>[];
    auditEvidence: readonly string[];
  }>[];
  semanticCompare: Readonly<{
    mappingFingerprint: Readonly<{
      candidate: string | null;
      active: string | null;
      changed: boolean;
    }>;
    activationImpact: readonly string[];
    fixtureCoverage: readonly Readonly<{
      flow: string;
      status: CatalogPrimaryWorkbenchValidationFixtureFlowStatus;
    }>[];
    sections: readonly Readonly<{
      sectionKey: string;
      domainConcept: string;
      status: "valid" | "warning" | "error";
      changeCount: number;
      changes: readonly Readonly<{
        path: string;
        label: string;
        candidateSummary: string;
        activeSummary: string;
        changed: boolean;
        severity: "info" | "warning" | "error";
        activationImpact: string;
      }>[];
    }>[];
    unchangedSections: readonly Readonly<{
      sectionKey: string;
      domainConcept: string;
    }>[];
  }>;
  activationReadiness: Readonly<{
    status: "ready" | "blocked";
    requiresMigrationEvidence: boolean;
    referenceCount: number;
    groups: readonly Readonly<{
      domainConcept: string;
      status: "ready" | "blocked";
      checks: readonly Readonly<{
        checkKey: string;
        code: string;
        sectionKey: string;
        status: "passed" | "blocked";
        path: string;
        diagnosticText: string;
        severity: "error" | "warning";
        remediation: string;
        blockingBehavior: string;
        flow: string | null;
      }>[];
    }>[];
  }>;
  activationDecision: Readonly<{
    status: "ready" | "blocked" | "unavailable";
    actionState: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    saveEvidenceState: CatalogPrimaryWorkbenchActionState;
    saveEvidenceBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    activationCommandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.activate">;
    evidenceCommandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.edit-section">;
    workspaceHref: string;
    providerKey: string | null;
    profileVersion: string | null;
    lifecycle: string | null;
    importEligibility: "eligible" | "blocked" | "not-selected";
    affectedReferences: Readonly<{
      referenceCount: number;
      requiresMigrationEvidence: boolean;
      replayImplications: readonly string[];
    }>;
    migrationEvidence: Readonly<{
      state: "recorded" | "required" | "not-required";
      evidenceText: string;
      fixtureRunId: string | null;
      mappingFingerprintBefore: string | null;
      mappingFingerprintAfter: string | null;
      recordedAt: string | null;
      recordedByUserId: string | null;
    }>;
    auditConsequences: Readonly<{
      auditEvidenceUrl: string;
      eventNames: readonly string[];
      summary: string;
    }>;
  }>;
}>;

export type CatalogPrimaryWorkbenchValidationEvidenceRow = Readonly<{
  key: string;
  label: string;
  path: string;
  summary: string;
  owner: string | null;
  uses: readonly string[];
  diagnostics: readonly Readonly<{
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
  }>[];
}>;

export type CatalogPrimaryWorkbenchLifecycleOperation =
  CatalogAdminRollbackRetirementImpactSummaryReadModel["operation"];

export type CatalogPrimaryWorkbenchLifecycleRecoveryStatus = "ready" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchLifecycleRecoveryReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchLifecycleRecoveryStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  selectedProviderKey: string | null;
  selectedProfileVersion: string | null;
  returnToPrimaryHref: string;
  auditEvidenceUrl: string;
  summary: Readonly<{
    activeJobs: number;
    affectedReferences: number;
    downstreamProfileReferences: number;
    impactedCatalogItems: number;
    blockers: number;
    recentLifecycleEvents: number;
  }>;
  profiles: readonly Readonly<{
    providerKey: string;
    profileKey: string;
    profileVersion: string;
    displayName: string;
    lifecycle: string;
    active: boolean;
    referenceCount: number;
    href: string;
  }>[];
  operations: readonly CatalogPrimaryWorkbenchLifecycleOperationReadModel[];
  recentAuditEvents: readonly Readonly<{
    eventId: string;
    occurredAt: string;
    eventName: string;
    category: string;
    providerKey: string;
    unitKey: CatalogIntegrationUnitKey | null;
    profileVersion: string | null;
    summary: string;
  }>[];
  strictRetirement: Readonly<{
    requiredDisposition: "complete-removal";
    forbiddenSupportPaths: readonly string[];
    summary: string;
  }>;
}>;

export type CatalogPrimaryWorkbenchLifecycleOperationReadModel = Readonly<{
  operation: CatalogPrimaryWorkbenchLifecycleOperation;
  label: string;
  description: string;
  commandKey: Extract<
    CatalogPrimaryWorkbenchCommandKey,
    "provider-profile.activate" | "provider-profile.rollback" | "provider-profile.deprecate" | "provider-profile.retire"
  >;
  providerKey: string | null;
  profileVersion: string | null;
  lifecycle: string | null;
  active: boolean;
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  confirmationRequired: boolean;
  allowed: boolean;
  submitHref: string;
  supportHref: string | null;
  impact: Readonly<{
    generatedAt: string | null;
    referencedObservationCount: number;
    sourceProfileReferenceCount: number;
    promotionProfileReferenceCount: number;
    impactedCatalogItemCount: number;
    impactedCatalogItemIds: readonly string[];
    externalReferenceCount: number;
    sampleObservationIds: readonly string[];
    impactedJobCount: number;
    blockers: readonly CatalogAdminControlPlaneDiagnostic[];
  }>;
  auditConsequences: Readonly<{
    auditEvidenceUrl: string;
    eventName: string;
    summary: string;
  }>;
  nextSteps: readonly string[];
}>;

export type CatalogPrimaryWorkbenchGovernanceControlsStatus = "ready" | "degraded" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchGovernanceControlKind =
  | "staged-rollout"
  | "provider-emergency-stop"
  | "import-kill-switch"
  | "promotion-kill-switch"
  | "reapply-kill-switch"
  | "worker-pause"
  | "legacy-removal";

export type CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey =
  | "option-query-latency"
  | "job-failure-rate"
  | "projection-freshness"
  | "source-observation-quarantine"
  | "data-quarantine"
  | "conflict-spike";

export type CatalogPrimaryWorkbenchGovernanceControlsReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchGovernanceControlsStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  returnToPrimaryHref: string;
  auditEvidenceUrl: string;
  summary: Readonly<{
    activeRolloutStops: number;
    deniedCommands: number;
    blockedCommands: number;
    degradedSignals: number;
    alertCount: number;
    deletionEvidenceCount: number;
  }>;
  rolloutMode: Readonly<{
    label: string;
    state: "open" | "staged" | "stopped" | "degraded";
    rolloutEnabled: boolean;
    workerState: "running" | "paused" | "unknown";
    providerEmergencyStopCount: number;
    importKillSwitchActive: boolean;
    promotionKillSwitchActive: boolean;
    reapplyKillSwitchActive: boolean;
  }>;
  controls: readonly Readonly<{
    controlId: string;
    kind: CatalogPrimaryWorkbenchGovernanceControlKind;
    label: string;
    status: "open" | "degraded" | "blocked" | "removed";
    metricKey: string;
    evidenceUrl: string;
    commandKeys: readonly CatalogPrimaryWorkbenchCommandKey[];
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    providerKeys: readonly string[];
    unitKeys: readonly string[];
    message: string;
  }>[];
  rbacMatrix: readonly Readonly<{
    actionKey: CatalogPrimaryWorkbenchCommandKey;
    requiredPermission: CatalogPrimaryWorkbenchActionContract["requiredPermission"];
    routePattern: string;
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    confirmationRequired: boolean;
    destructive: boolean;
    deniedCopy: string;
  }>[];
  observability: Readonly<{
    status: CatalogPrimaryWorkbenchGovernanceControlsStatus;
    generatedAt: string | null;
    signals: readonly Readonly<{
      key: CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey;
      label: string;
      status: "ready" | "degraded" | "blocked" | "unavailable";
      value: string;
      threshold: string;
      ownerMetricKey: string;
      evidenceUrl: string;
      stale: boolean;
      alertLinks: readonly Readonly<{ label: string; href: string }>[];
      runbookLinks: readonly Readonly<{ label: string; href: string }>[];
    }>[];
  }>;
  legacyRemovalEvidence: Readonly<{
    status: "removed";
    requiredDisposition: "complete-removal";
    removedSurfaces: readonly string[];
    forbiddenSupportPaths: readonly string[];
    evidence: readonly Readonly<{
      key: string;
      label: string;
      status: "removed";
      evidenceUrl: string;
      detail: string;
    }>[];
    launchBlockerIfPresent: readonly string[];
  }>;
}>;

export type CatalogPrimaryWorkbenchAuditEvidenceStatus = "ready" | "partial" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchAuditEvidenceFilterKey =
  | "provider"
  | "unit"
  | "profile-version"
  | "job"
  | "observation"
  | "action-category"
  | "actor"
  | "time";

export type CatalogPrimaryWorkbenchAuditEvidenceTargetType =
  | "provider-profile"
  | "import-job"
  | "source-observation"
  | "catalog-item"
  | "control-plane";

export type CatalogPrimaryWorkbenchAuditEvidenceReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchAuditEvidenceStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  returnToPrimaryHref: string;
  summary: Readonly<{
    timelineEvents: number;
    redactedEvidenceLinks: number;
    partialProjectionCount: number;
  }>;
  filters: readonly Readonly<{
    key: CatalogPrimaryWorkbenchAuditEvidenceFilterKey;
    label: string;
    value: string | null;
    options: readonly string[];
    active: boolean;
  }>[];
  projectionState: Readonly<{
    queryKey: Extract<CatalogAdminControlPlaneQueryKey, "audit-evidence-timeline">;
    freshness: CatalogAdminControlPlaneFreshnessState;
    generatedAt: string | null;
    statusMessage: string;
    missingProjection: boolean;
    partialProjection: boolean;
  }>;
  redactionPolicy: Readonly<{
    sourcePayloadAccess: "not-required";
    profileSnapshotAccess: "not-required";
    unsafeEvidenceBlocked: boolean;
    governedDataClasses: readonly string[];
    forbiddenEvidenceRequests: readonly string[];
    summary: string;
  }>;
  timeline: readonly Readonly<{
    eventId: string;
    occurredAt: string;
    eventName: CatalogIntegrationAuditEvidenceEventName;
    category: CatalogIntegrationAuditEvidenceCategory;
    actorLabel: string;
    targetType: CatalogPrimaryWorkbenchAuditEvidenceTargetType;
    targetId: string;
    providerKey: string | null;
    unitKey: CatalogIntegrationUnitKey | null;
    profileVersion: string | null;
    jobId: string | null;
    observationId: string | null;
    catalogItemId: string | null;
    summary: string;
    diagnosticCodes: readonly string[];
    redactionState: CatalogIntegrationAuditEvidenceRedactionState;
    evidenceLinks: readonly CatalogPrimaryWorkbenchAuditEvidenceLink[];
  }>[];
  evidenceLinks: readonly CatalogPrimaryWorkbenchAuditEvidenceLink[];
}>;

export type CatalogPrimaryWorkbenchAuditEvidenceLink = Readonly<{
  key: string;
  label: string;
  href: string;
  kind: "audit-event" | "diagnostic" | "proof" | "runbook" | "test";
  summary: string;
  redactionState: CatalogIntegrationAuditEvidenceRedactionState;
  sourcePayloadAccess: "not-required";
  profileSnapshotAccess: "not-required";
}>;

export type CatalogPrimaryWorkbenchHealthTriageRolloutControl = Readonly<{
  controlId: string;
  status: "open" | "degraded" | "blocked";
  severity: "info" | "warning" | "error";
  metricKey: string;
  message: string;
  providerKeys: readonly string[];
  unitKeys: readonly string[];
  nextAction: string;
}>;

export type CatalogPrimaryWorkbenchHealthTriageJob = Readonly<{
  jobId: string;
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey | null;
  operatorStatus: CatalogPrimaryWorkbenchImportJobsReadModel["jobs"][number]["operatorStatus"];
  phase: CatalogPrimaryWorkbenchImportJobsReadModel["jobs"][number]["state"];
  progressLabel: string;
  summary: string;
  ownerMetricKey: string;
  nextAction: string;
}>;

export type CatalogPrimaryWorkbenchHealthTriageAuditPreview = Readonly<{
  generatedAt: string | null;
  projectionStatus: "partial" | "unavailable";
  statusMessage: string;
  entries: readonly Readonly<{
    eventId: string;
    occurredAt: string;
    eventName: string;
    category: string;
    providerKey: string;
    unitKey: CatalogIntegrationUnitKey | null;
    summary: string;
  }>[];
}>;

export type CatalogPrimaryWorkbenchProfileAuthoringStatus = "ready" | "missing-profile" | "stale-selection";

export type CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode =
  | "draft-editable"
  | "test-editable"
  | "active-clone-required"
  | "deprecated-clone-required"
  | "retired-read-only"
  | "missing-profile"
  | "stale-selection";

export type CatalogPrimaryWorkbenchProfileImmutableFactKey =
  | "provider-key"
  | "profile-key"
  | "source-contract-owner"
  | "source-contract-repository"
  | "connector-kind"
  | "supported-scopes";

export type CatalogPrimaryWorkbenchProfileImmutableFact = Readonly<{
  key: CatalogPrimaryWorkbenchProfileImmutableFactKey;
  label: string;
  value: string;
}>;

export type CatalogPrimaryWorkbenchProfileLifecycleRestriction = Readonly<{
  code: CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode;
  label: string;
  description: string;
  severity: "info" | "warning" | "blocked";
}>;

export type CatalogPrimaryWorkbenchProfileOption = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  lifecycle: string;
  active: boolean;
  status: string;
  href: string;
}>;

export type CatalogPrimaryWorkbenchProfileOverview = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  lifecycle: string;
  active: boolean;
  status: string;
  connectorKind: string;
  capabilities: readonly string[];
  supportedScopes: readonly string[];
  languageOptions: readonly string[];
  mappingOutputKind: string;
  hasExecutableMappingContract: boolean;
  mappingFingerprint: string | null;
  referenceCount: number;
  sourceContract: Readonly<{
    owner: string;
    repository: string | null;
    commit: string | null;
    documentPath: string;
    fixtureSetVersion: string;
  }>;
  fixtures: Readonly<{
    fixtureRoot: string;
    coveredFlows: readonly string[];
    liveProviderCallsAllowed: boolean;
  }>;
  validation: Readonly<{
    status: "valid" | "invalid";
    diagnosticCount: number;
    latestDiagnosticText: string | null;
  }>;
  migrationEvidence: Readonly<{
    state: "recorded" | "not-recorded";
    recordedAt: string | null;
    fixtureRunId: string | null;
    mappingFingerprintBefore: string | null;
    mappingFingerprintAfter: string | null;
  }>;
  authoringAudit: Readonly<{
    createdAt: string | null;
    createdByUserId: string | null;
    createdForAccountId: string | null;
    updatedAt: string | null;
    updatedByUserId: string | null;
    updatedForAccountId: string | null;
  }>;
  immutableIdentityFacts: readonly CatalogPrimaryWorkbenchProfileImmutableFact[];
}>;

export type CatalogPrimaryWorkbenchProfileSectionGroupKey =
  | "profile-foundation"
  | "provider-acquisition"
  | "observation-mapping"
  | "catalog-promotion"
  | "evidence-lifecycle";

export type CatalogPrimaryWorkbenchProfileSectionSaveOutcome =
  | "not-submitted"
  | "saved"
  | "conflict"
  | "invalid"
  | "failed";

export type CatalogPrimaryWorkbenchProfileSectionFieldControl = "text" | "textarea" | "select" | "checkbox" | "tags";

export type CatalogPrimaryWorkbenchProfileSectionField = Readonly<{
  key: string;
  label: string;
  value: string;
  control: CatalogPrimaryWorkbenchProfileSectionFieldControl;
  required: boolean;
  disabled: boolean;
  helpText: string | null;
  options: readonly Readonly<{ value: string; label: string }>[];
}>;

export type CatalogPrimaryWorkbenchProfileOptionQueryDetail = Readonly<{
  queryKind: string;
  queryKeySynonyms: readonly string[];
  displayName: string;
  scope: string;
  parentScope: string | null;
  parentRequired: boolean;
  parentValueKind: string | null;
  parentDiagnosticText: string | null;
  operation: string;
  outputMappings: readonly Readonly<{
    key: string;
    label: string;
    path: string;
  }>[];
  cacheState: Readonly<{
    status: "ready" | "degraded" | "blocked" | "unknown";
    label: string;
    description: string;
    diagnosticCodes: readonly string[];
    freshTtlMinutes: number;
    staleTtlHours: number;
    cacheOnly: boolean;
  }>;
}>;

export type CatalogPrimaryWorkbenchProfileImportScopeControl = Readonly<{
  scope: string;
  label: string;
  state: "selected" | "available" | "unavailable";
  reason: string | null;
  href: string | null;
  importScope: string | null;
  expectedObservationCount: number;
  observedCount: number;
  changedCount: number;
  promotedCount: number;
  rejectedCount: number;
}>;

export type CatalogPrimaryWorkbenchProfileMappingRow = Readonly<{
  key: string;
  label: string;
  path: string;
  summary: string;
  owner: string | null;
  redaction: string | null;
  uses: readonly string[];
  diagnostics: readonly Readonly<{
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
  }>[];
  previewAvailable: boolean;
  affordances: Readonly<{
    duplicate: boolean;
    reorder: boolean;
    remove: boolean;
    inlineDiagnostics: boolean;
    longPathSafe: boolean;
  }>;
}>;

export type CatalogPrimaryWorkbenchProfileSectionWorkspace = Readonly<{
  sectionKey: CatalogProviderProfileEditableSectionKey;
  displayName: string;
  group: CatalogPrimaryWorkbenchProfileSectionGroupKey;
  groupLabel: string;
  description: string;
  domainConcept: string;
  status: "valid" | "warning" | "error" | "blocked";
  editable: boolean;
  actionState: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  dirtyState: "clean";
  staleState: "fresh" | "stale" | "conflict";
  saveOutcome: CatalogPrimaryWorkbenchProfileSectionSaveOutcome;
  submitHref: string;
  commandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.edit-section">;
  fields: readonly CatalogPrimaryWorkbenchProfileSectionField[];
  optionQueries: readonly CatalogPrimaryWorkbenchProfileOptionQueryDetail[];
  importScopeControls: readonly CatalogPrimaryWorkbenchProfileImportScopeControl[];
  mappingRows: readonly CatalogPrimaryWorkbenchProfileMappingRow[];
  diagnostics: readonly Readonly<{
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
  }>[];
  semanticChangeCount: number;
  readinessCheckCount: number;
  anchorId: string;
}>;

export type CatalogPrimaryWorkbenchProfileCloneDraftReadModel = Readonly<{
  commandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.clone">;
  sourceProviderKey: string | null;
  sourceProfileVersion: string | null;
  targetProfileVersion: string | null;
  targetLifecycle: "draft";
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  submitHref: string;
  lifecycleRestrictions: readonly CatalogPrimaryWorkbenchProfileLifecycleRestriction[];
  immutableIdentityFacts: readonly CatalogPrimaryWorkbenchProfileImmutableFact[];
}>;

export type CatalogPrimaryWorkbenchProfileAuthoringReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchProfileAuthoringStatus;
  generatedAt: string;
  selectedProfile: CatalogPrimaryWorkbenchProfileOverview | null;
  activeProfile: CatalogPrimaryWorkbenchProfileOption | null;
  availableProfiles: readonly CatalogPrimaryWorkbenchProfileOption[];
  returnToPrimaryHref: string;
  sectionGroups: readonly Readonly<{
    key: CatalogPrimaryWorkbenchProfileSectionGroupKey;
    label: string;
    sections: readonly CatalogProviderProfileEditableSectionKey[];
  }>[];
  sectionWorkspaces: readonly CatalogPrimaryWorkbenchProfileSectionWorkspace[];
  cloneDraft: CatalogPrimaryWorkbenchProfileCloneDraftReadModel;
}>;

export type CatalogPrimaryWorkbenchImportJobsReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  activeJobCount: number;
  failedJobCount: number;
  selectedScope: Readonly<{
    providerKey: string;
    unitKey: CatalogIntegrationUnitKey | null;
    scope: CatalogPrimaryWorkbenchScopeContext;
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
    action: Extract<CatalogPrimaryWorkbenchCommandKey, "scope.import" | "observation.reapply" | "observation.replay">;
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
    result: Readonly<{
      requestedScope: CatalogPrimaryWorkbenchScopeContext;
      requestedCount: number;
      importedSetCount: number;
      observedCount: number;
      reappliedCount: number;
      skippedCount: number;
      failedCount: number;
      redactedFailureReasons: readonly string[];
      usage: Readonly<{
        actualRequestCount: number | null;
        pageCount: number | null;
        cacheHitCount: number | null;
        cacheMissCount: number | null;
      }> | null;
      replayOrReapplyState:
        | "not-applicable"
        | "reapply-current-active-profile"
        | "replay-original-source-profile"
        | "unknown";
    }> | null;
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

// Slim review-row contract. A review row carries ONLY what the dense table
// cell and the per-row action buttons render: identity, status, the first-N fact
// summaries the cell badges show, a duplicate count, the redaction-safe payload
// summary, promotion readiness, command disposition, and the inline `actions[]`
// that drive row buttons and readiness. The full fact/duplicate/conflict/audit
// evidence and the deep KeyValueList fields the SideSheet renders are NOT shipped
// per row; they live in `CatalogPrimaryWorkbenchSourceObservationEvidenceDetail`
// and are lazy-loaded when the evidence sheet opens. This keeps a 25-row review
// page small at first paint instead of serializing every row's deep evidence the
// table never shows.
export type CatalogPrimaryWorkbenchSourceObservationReviewRow = Readonly<{
  observationId: string;
  providerKey: string;
  externalKey: string;
  displayName: string;
  status: string;
  statusReason: string | null;
  sourceUpdatedAt: string | null;
  changedAt: string;
  // The first-N normalized fact summaries the dense cell renders as badges. The
  // full list lives on the lazily-fetched evidence detail.
  factSummaryPreview: readonly string[];
  payloadSummary: string;
  redactionSummary: string;
  // The duplicate-evidence COUNT the cell renders as a warning badge. The full
  // duplicate evidence list lives on the lazily-fetched evidence detail.
  duplicateCount: number;
  promotionReadiness: Readonly<{
    state: "eligible" | "blocked" | "already-promoted" | "rejected";
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>;
  commandPreview: Readonly<{
    promotionPlanHash: string | null;
    disposition: CatalogPrimaryWorkbenchPromotionDisposition;
    confirmationRequired: boolean;
  }>;
  detailHref: string;
  actions: readonly Readonly<{
    key: CatalogPrimaryWorkbenchSourceObservationRowActionKey;
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    href: string | null;
  }>[];
}>;

// Deep evidence for a single Source Observation, separated from the review row so
// it ships only when the operator opens the evidence SideSheet. It carries
// the full normalized-fact / duplicate / conflict / audit lists and every
// provenance field the sheet's KeyValueList renders. Composed from the same Source
// Observation the slim row is, so the sheet shows exactly what it showed before —
// only WHEN the data is fetched changes. Fetched via a small evidence endpoint
// keyed by `observationId`.
export type CatalogPrimaryWorkbenchSourceObservationEvidenceDetail = Readonly<{
  observationId: string;
  providerKey: string;
  externalKey: string;
  displayName: string;
  languageCode: string;
  sourceUrl: string;
  sourceRecordHash: string;
  sourceUpdatedAt: string | null;
  observedAt: string;
  changedAt: string;
  sourceProfileVersion: string;
  promotionProfileVersion: string | null;
  payloadSummary: string;
  redactionSummary: string;
  normalizedFactSummaries: readonly string[];
  productContentsEvidence: CatalogPrimaryWorkbenchProductContentsEvidenceReview;
  duplicateEvidence: readonly string[];
  conflictEvidence: readonly string[];
  auditTrail: readonly string[];
  promotionReadiness: Readonly<{
    state: "eligible" | "blocked" | "already-promoted" | "rejected";
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>;
  commandPreview: Readonly<{
    promotionPlanHash: string | null;
    disposition: CatalogPrimaryWorkbenchPromotionDisposition;
    confirmationRequired: boolean;
  }>;
}>;

export type CatalogPrimaryWorkbenchProductContentsEvidenceState =
  | "none"
  | "reviewable"
  | "unresolved"
  | "promoted"
  | "rejected";

export type CatalogPrimaryWorkbenchProductContentsEvidenceReview = Readonly<{
  state: CatalogPrimaryWorkbenchProductContentsEvidenceState;
  summary: string;
  lineCount: number;
  rows: readonly CatalogPrimaryWorkbenchProductContentsEvidenceLine[];
}>;

export type CatalogPrimaryWorkbenchProductContentsEvidenceLine = Readonly<{
  lineNumber: number;
  state: "reviewable" | "unresolved" | "promoted" | "rejected";
  contentTypeLabel: string;
  contentTypeId: string | null;
  inclusionPolicyLabel: string | null;
  inclusionPolicyId: string | null;
  quantity: number | null;
  containedCatalogItemId: string | null;
  containedSelectedOptionLabels: readonly string[];
  targetSummary: string;
  provenanceSummary: readonly string[];
}>;

// Response contract for the lazy evidence endpoint the review SideSheet fetches.
// On success `detail` carries the composed deep evidence; on absence or a
// transient failure it is null so the sheet renders its error fallback instead of
// the route boundary throwing. Lives on the feature contract so both the route
// loader (server) and the evidence sheet (client) depend on the feature, not on a
// deployable route module.
export type CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData = Readonly<{
  observationId: string;
  detail: CatalogPrimaryWorkbenchSourceObservationEvidenceDetail | null;
}>;

export type CatalogPrimaryWorkbenchMergeCandidateActionKey = Extract<
  CatalogPrimaryWorkbenchCommandKey,
  "candidate.promote" | "candidate.split" | "candidate.edit" | "candidate.ignore" | "candidate.defer"
>;

export type CatalogPrimaryWorkbenchMergeCandidateReviewReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  counts: Readonly<{
    total: number;
    ready: number;
    conflict: number;
    stale: number;
    deferred: number;
    terminal: number;
    blocked: number;
  }>;
  filters: readonly Readonly<{
    key: "scope" | "status" | "search" | "syncRun";
    label: string;
    value: string | null;
    serverApplied: boolean;
  }>[];
  pagination: Readonly<{
    mode: CatalogAdminControlPlanePaginationMode;
    limit: number;
    offset: number;
    total: number;
  }>;
  rows: readonly CatalogPrimaryWorkbenchMergeCandidateReviewRow[];
}>;

export type CatalogPrimaryWorkbenchMergeCandidateReviewRow = Readonly<{
  candidateId: string;
  identityFingerprint: string;
  identityLabel: string;
  sourceCount: number;
  sources: readonly Readonly<{
    providerKey: string;
    observationId: string | null;
    externalKey: string | null;
    sourceProfileVersion: string | null;
  }>[];
  status: "ready" | "has-conflicts" | "stale" | "deferred" | "rejected" | "promoted";
  statusReason: string | null;
  conflicts: Readonly<{
    blocking: number;
    warnings: number;
    messages: readonly string[];
    // Every blocking conflict on this candidate, with enough detail to resolve it
    // inline in the review drawer: requireConflictResolutionsForBlockingConflicts
    // rejects promotion unless every entry here has a matching resolution by code.
    blockingConflicts: readonly Readonly<{
      code: string;
      message: string;
      fieldPath: string | null;
      existingValueDisplay: string;
      proposedValueDisplay: string;
      existingValueJson: string;
      proposedValueJson: string;
      observationIds: readonly string[];
    }>[];
  }>;
  promoteReadiness: Readonly<{
    state: "ready" | "blocked" | "stale" | "deferred" | "terminal";
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>;
  proposedMapping: Readonly<{
    promotionIntent: "create-catalog-item" | "update-catalog-item" | "link-existing-catalog-item";
    catalogItemId: string | null;
    productIds: readonly string[];
    externalCatalogItemReferences: readonly string[];
    externalProductReferences: readonly string[];
  }>;
  sourceComparison: readonly Readonly<{
    fieldPath: string;
    value: string;
    providerKey: string;
    observationId: string;
    confidence: "exact" | "high" | "candidate" | "manual";
  }>[];
  fieldProvenance: readonly Readonly<{
    fieldPath: string;
    providerKey: string;
    sourceProfileVersion: string;
    confidence: "exact" | "high" | "candidate" | "manual";
    evidenceSummary: string;
  }>[];
  proposedFacts: readonly Readonly<{
    key: string;
    value: string;
  }>[];
  actions: readonly Readonly<{
    key: CatalogPrimaryWorkbenchMergeCandidateActionKey;
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    reasonRequired: boolean;
    commandPreview: CatalogMergeCandidateReviewCommandPreview | null;
  }>[];
  // The typed candidate edit surface. `state` gates the inline editor:
  // when it is not `available`, `baseSnapshotJson` is null and the drawer renders
  // the blockers instead of inputs. Operator field corrections submitted from this
  // surface are recorded as `manual` provenance and carried through promotion.
  editForm: CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel;
}>;

export type CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride = Readonly<{
  key: string;
  fieldPath: string;
  label: string;
  value: string;
}>;

export type CatalogPrimaryWorkbenchMergeCandidateEditReference = Readonly<{
  index: number;
  label: string;
}>;

export type CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel = Readonly<{
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  baseSnapshotJson: string | null;
  promotionIntent: "create-catalog-item" | "update-catalog-item" | "link-existing-catalog-item";
  catalogItemId: string | null;
  productIds: readonly string[];
  editableFacts: readonly CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride[];
  externalCatalogItemReferences: readonly CatalogPrimaryWorkbenchMergeCandidateEditReference[];
  externalProductReferences: readonly CatalogPrimaryWorkbenchMergeCandidateEditReference[];
}>;

export type CatalogPrimaryWorkbenchConflictResolutionStatus = "ready" | "empty" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchConflictResolutionState = "blocks-promotion" | "requires-review" | "auto-resolved";

export type CatalogPrimaryWorkbenchConflictResolutionReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchConflictResolutionStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  returnToPrimaryHref: string;
  auditEvidenceUrl: string;
  selectedObservationIds: readonly string[];
  summary: Readonly<{
    conflictCount: number;
    blockingCount: number;
    autoResolvedCount: number;
    reviewRequiredCount: number;
    overrideAvailableCount: number;
    auditEventCount: number;
  }>;
  rows: readonly CatalogPrimaryWorkbenchConflictResolutionRow[];
  precedenceRules: readonly Readonly<{
    ruleId: string;
    label: string;
    description: string;
    blockingBehavior: "promotion-blocking" | "review-required" | "auto-resolved";
    sourceAuthority: string;
    evidencePaths: readonly string[];
  }>[];
  overridePolicy: Readonly<{
    supported: boolean;
    requiredPermission: "catalog.manage";
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    auditRequired: true;
    reason: string;
  }>;
  recentAuditEvents: readonly Readonly<{
    eventId: string;
    occurredAt: string;
    eventName: string;
    providerKey: string;
    unitKey: CatalogIntegrationUnitKey | null;
    observationId: string | null;
    summary: string;
  }>[];
}>;

export type CatalogPrimaryWorkbenchConflictResolutionRow = Readonly<{
  observationId: string;
  displayName: string;
  providerKey: string;
  externalKey: string;
  affectedFact: string;
  factKey: string;
  resolutionState: CatalogPrimaryWorkbenchConflictResolutionState;
  promotionReadinessState: CatalogPrimaryWorkbenchSourceObservationReviewRow["promotionReadiness"]["state"];
  precedenceRuleId: string;
  candidateValues: readonly Readonly<{
    source: string;
    value: string;
    role: "winner" | "loser" | "candidate";
    evidencePath: string;
  }>[];
  evidencePaths: readonly string[];
  diagnostics: readonly string[];
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  auditTrail: readonly string[];
  detailHref: string;
  overrideAction: Readonly<{
    state: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    auditRequired: true;
  }>;
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
  jobId: string;
  status: "completed" | "partial" | "failed";
  requestedCount: number;
  promotedCount: number;
  skippedCount: number;
  failedCount: number;
  promotedCatalogItemIds: readonly string[];
  promotedReferenceIds: readonly string[];
  skippedObservationIds: readonly string[];
  failedObservationIds: readonly string[];
  redactedFailureReasons: readonly string[];
  completedAt: string;
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
    queryKeys: [
      "integration-health-summary",
      "provider-transport-readiness-summary",
      "active-profile-version-summary",
      "provider-source-options",
    ],
    commands: [],
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
    commands: ["scope.sync", "scope.import", "job.resume", "job.retry", "job.cancel"],
    freshnessStates: ["fresh", "stale", "lagging", "unavailable"],
    pagination: "sse",
    routeContextKeys: ["section", "providerKey", "unitKey", "importScope", "profileVersion", "jobId", "returnPath"],
  }),
  section({
    key: "source-observation-review",
    defaultVisible: true,
    queryKeys: ["source-observation-review-query"],
    commands: ["observation.reject", "observation.defer"],
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
    key: "conflict-resolution",
    defaultVisible: false,
    queryKeys: ["source-observation-review-query", "promotion-plan-preview", "audit-evidence-timeline"],
    commands: ["observation.promote", "observation.reject", "observation.defer"],
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
      "promotionPreviewId",
      "returnPath",
    ],
  }),
  section({
    key: "promotion-preview",
    defaultVisible: true,
    queryKeys: ["promotion-plan-preview"],
    commands: ["observation.promote"],
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
    commands: ["observation.reapply", "observation.replay"],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: ["section", "providerKey", "unitKey", "profileVersion", "jobId", "returnPath"],
  }),
  section({
    key: "lifecycle-recovery",
    defaultVisible: false,
    queryKeys: ["rollback-retirement-impact-summary", "audit-evidence-timeline", "import-job-progress-summary"],
    commands: [
      "provider-profile.activate",
      "provider-profile.rollback",
      "provider-profile.deprecate",
      "provider-profile.retire",
    ],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: ["section", "providerKey", "unitKey", "profileVersion", "jobId", "returnPath"],
  }),
  section({
    key: "governance-controls",
    defaultVisible: false,
    queryKeys: [
      "integration-health-summary",
      "provider-transport-readiness-summary",
      "import-job-progress-summary",
      "source-observation-review-query",
      "promotion-plan-preview",
      "audit-evidence-timeline",
    ],
    commands: [
      "scope.sync",
      "scope.import",
      "observation.promote",
      "observation.reject",
      "observation.defer",
      "provider-profile.rollback",
      "provider-profile.deprecate",
      "provider-profile.retire",
      "observation.reapply",
      "observation.replay",
    ],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: ["section", "providerKey", "unitKey", "importScope", "profileVersion", "jobId", "returnPath"],
  }),
  section({
    key: "audit-evidence",
    defaultVisible: false,
    queryKeys: [
      "audit-evidence-timeline",
      "import-job-progress-summary",
      "source-observation-review-query",
      "promotion-plan-preview",
      "dry-run-evidence-summary",
      "rollback-retirement-impact-summary",
    ],
    commands: [],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: [
      "section",
      "providerKey",
      "unitKey",
      "importScope",
      "profileVersion",
      "sourceObservationFilters",
      "selectedObservationIds",
      "jobId",
      "promotionPreviewId",
      "returnPath",
    ],
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
  action("scope.sync", "POST", "/api/catalog/source-observations/catalog-sync-scope/runs", "catalog.manage", {
    blockerCategories: [
      "permission-denied",
      "authorization-denied",
      "rollout-disabled",
      "kill-switch-active",
      "unit-selection-required",
      "import-scope-required",
      "missing-active-profile",
      "read-model-unavailable",
      "security-privacy-blocked",
      "deploy-skew-unsupported-version",
    ],
    idempotencyRequired: true,
  }),
  action("scope.import", "POST", "/api/catalog/source-observations/admin/import-jobs", "catalog.manage", {
    blockerCategories: [
      "rollout-disabled",
      "kill-switch-active",
      "rbac-missing",
      "provider-selection-required",
      "unit-selection-required",
      "import-scope-required",
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
  action("job.resume", "POST", "/api/catalog/source-observations/admin/import-jobs/:jobId/resume", "catalog.manage", {
    blockerCategories: ["job-not-found"],
    idempotencyRequired: true,
  }),
  action("job.retry", "POST", "/api/catalog/source-observations/admin/import-jobs/:jobId/retry", "catalog.manage", {
    blockerCategories: ["idempotency-replay", "stale-replay", "security-privacy-blocked"],
    idempotencyRequired: true,
  }),
  action("job.cancel", "POST", "/api/catalog/source-observations/admin/import-jobs/:jobId/cancel", "catalog.manage", {
    blockerCategories: ["permission-denied", "authorization-denied", "unsupported-command"],
    idempotencyRequired: true,
  }),
  action(
    "provider-profile.clone",
    "POST",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/clone",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "active-job-conflict",
        "concurrent-job",
        "raw-json-retired",
      ],
      idempotencyRequired: true,
    },
  ),
  action(
    "provider-profile.activate",
    "POST",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/activate",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "activation-readiness-blocked",
        "migration-evidence-missing",
        "reference-impact-review-required",
        "active-job-conflict",
        "concurrent-job",
        "security-privacy-blocked",
        "deploy-skew-unsupported-version",
      ],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "provider-profile.rollback",
    "POST",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/rollback",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "profile-lifecycle-conflict",
        "active-job-conflict",
        "concurrent-job",
        "security-privacy-blocked",
        "deploy-skew-unsupported-version",
      ],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "provider-profile.deprecate",
    "POST",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/deprecate",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "profile-lifecycle-conflict",
        "active-job-conflict",
        "concurrent-job",
        "security-privacy-blocked",
        "deploy-skew-unsupported-version",
      ],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "provider-profile.retire",
    "POST",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/retire",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "profile-lifecycle-conflict",
        "profile-retirement-references",
        "active-job-conflict",
        "concurrent-job",
        "security-privacy-blocked",
        "deploy-skew-unsupported-version",
      ],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "provider-profile.edit-section",
    "PATCH",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/sections/:section",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "profile-section-read-only",
        "profile-section-stale",
        "profile-section-invalid",
        "active-job-conflict",
        "concurrent-job",
        "raw-json-retired",
      ],
      idempotencyRequired: true,
    },
  ),
  action("observation.promote", "POST", "/api/catalog/source-observations/admin/promotions", "catalog.manage", {
    blockerCategories: [
      "selection-empty",
      "no-promotion-eligible-observations",
      "duplicate-conflict",
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
  action("observation.reject", "POST", "/api/catalog/source-observations/admin/rejections", "catalog.manage", {
    blockerCategories: ["selection-empty", "permission-denied", "authorization-denied"],
    confirmationRequired: true,
    idempotencyRequired: true,
  }),
  action("observation.defer", "POST", "/api/catalog/source-observations/admin/deferrals", "catalog.manage", {
    blockerCategories: ["selection-empty", "permission-denied", "authorization-denied"],
    idempotencyRequired: true,
  }),
  action(
    "candidate.promote",
    "POST",
    "/api/catalog/source-observations/admin/merge-candidates/:candidateId/promote",
    "catalog.manage",
    {
      blockerCategories: [
        "selection-empty",
        "permission-denied",
        "authorization-denied",
        "promotion-conflict",
        "source-projection-stale",
      ],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "candidate.split",
    "POST",
    "/api/catalog/source-observations/admin/merge-candidates/:candidateId/split",
    "catalog.manage",
    {
      blockerCategories: ["selection-empty", "permission-denied", "authorization-denied", "source-projection-stale"],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "candidate.edit",
    "POST",
    "/api/catalog/source-observations/admin/merge-candidates/:candidateId/update",
    "catalog.manage",
    {
      blockerCategories: ["selection-empty", "permission-denied", "authorization-denied", "source-projection-stale"],
      idempotencyRequired: true,
    },
  ),
  action(
    "candidate.ignore",
    "POST",
    "/api/catalog/source-observations/admin/merge-candidates/:candidateId/ignore",
    "catalog.manage",
    {
      blockerCategories: ["selection-empty", "permission-denied", "authorization-denied"],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "candidate.defer",
    "POST",
    "/api/catalog/source-observations/admin/merge-candidates/:candidateId/defer",
    "catalog.manage",
    {
      blockerCategories: ["selection-empty", "permission-denied", "authorization-denied"],
      idempotencyRequired: true,
    },
  ),
  action("observation.reapply", "POST", "/api/catalog/source-observations/admin/reapply-jobs", "catalog.manage", {
    blockerCategories: ["profile-version-missing", "stale-replay", "idempotency-replay", "security-privacy-blocked"],
    idempotencyRequired: true,
  }),
  action("observation.replay", "POST", "/api/catalog/source-observations/admin/replay-jobs", "catalog.manage", {
    blockerCategories: ["profile-version-missing", "stale-replay", "idempotency-replay", "security-privacy-blocked"],
    idempotencyRequired: true,
  }),
  action("alias.accept", "POST", "/api/catalog/alias-equivalence/admin/review", "catalog.manage", {
    idempotencyRequired: true,
  }),
  action("alias.reject", "POST", "/api/catalog/alias-equivalence/admin/review", "catalog.manage", {
    blockerCategories: ["permission-denied", "authorization-denied"],
    idempotencyRequired: true,
  }),
  action("alias.revoke", "POST", "/api/catalog/alias-equivalence/admin/review", "catalog.manage", {
    blockerCategories: ["permission-denied", "authorization-denied"],
    idempotencyRequired: true,
  }),
  action("alias.defer", "POST", "/api/catalog/alias-equivalence/admin/review", "catalog.manage", {
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
  blocker("provider-selection-required", ["blocked"], "catalog.primary.providerScope.required"),
  blocker("unit-selection-required", ["blocked"], "catalog.primary.providerScope.required"),
  blocker("import-scope-required", ["blocked"], "catalog.primary.providerScope.required"),
  blocker("missing-active-profile", ["blocked"], "catalog.primary.providerScope.required"),
  blocker("profile-version-missing", ["blocked"], "catalog.primary.reapply.originalProfileMissing"),
  blocker("profile-section-read-only", ["blocked"], "catalog.primary.import.blocked"),
  blocker("profile-section-stale", ["blocked"], "catalog.primary.deploySkew.failClosed"),
  blocker("profile-section-invalid", ["blocked"], "catalog.primary.import.blocked"),
  blocker("profile-lifecycle-conflict", ["blocked"], "catalog.primary.reapply.originalProfileMissing"),
  blocker("profile-retirement-references", ["blocked"], "catalog.primary.reapply.originalProfileMissing"),
  blocker("activation-readiness-blocked", ["blocked"], "catalog.primary.import.blocked"),
  blocker("migration-evidence-missing", ["blocked"], "catalog.primary.import.blocked"),
  blocker("reference-impact-review-required", ["blocked"], "catalog.primary.import.blocked"),
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
    "retired admin module coupling",
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
    "migration of retired admin structure",
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
    "#1033",
    ["supporting-evidence"],
    [
      "profileAuthoring.status",
      "profileAuthoring.selectedProfile",
      "profileAuthoring.availableProfiles",
      "profileAuthoring.cloneDraft",
    ],
  ),
  downstream(
    "#1034",
    ["supporting-evidence"],
    [
      "profileAuthoring.sectionGroups",
      "profileAuthoring.sectionWorkspaces",
      "profileAuthoring.sectionWorkspaces.fields",
      "profileAuthoring.sectionWorkspaces.diagnostics",
      "profileAuthoring.sectionWorkspaces.saveOutcome",
    ],
  ),
  downstream(
    "#1035",
    ["supporting-evidence"],
    [
      "profileAuthoring.sectionWorkspaces.optionQueries",
      "profileAuthoring.sectionWorkspaces.importScopeControls",
      "profileAuthoring.sectionWorkspaces.mappingRows",
    ],
  ),
  downstream(
    "#1036",
    ["readiness", "supporting-evidence"],
    [
      "validationReadiness.status",
      "validationReadiness.fixtureFlows",
      "validationReadiness.dryRunEvidence.normalizedFacts",
      "validationReadiness.dryRunEvidence.duplicateCandidates",
      "validationReadiness.dryRunEvidence.selectedOptions",
      "validationReadiness.dryRunEvidence.promotionCommandPreview",
      "validationReadiness.semanticCompare",
      "validationReadiness.activationReadiness",
    ],
  ),
  downstream(
    "#1037",
    ["readiness", "supporting-evidence"],
    [
      "validationReadiness.activationDecision.status",
      "validationReadiness.activationDecision.actionState",
      "validationReadiness.activationDecision.blockers",
      "validationReadiness.activationDecision.affectedReferences",
      "validationReadiness.activationDecision.migrationEvidence",
      "validationReadiness.activationDecision.auditConsequences",
    ],
  ),
  downstream(
    "#1041",
    ["conflict-resolution", "source-observation-review", "promotion-preview", "supporting-evidence"],
    [
      "conflictResolution.rows",
      "conflictResolution.precedenceRules",
      "conflictResolution.overridePolicy",
      "conflictResolution.recentAuditEvents",
    ],
  ),
  downstream(
    "#1042",
    ["lifecycle-recovery", "supporting-evidence"],
    [
      "lifecycleRecovery.operations",
      "lifecycleRecovery.summary",
      "lifecycleRecovery.strictRetirement",
      "lifecycleRecovery.recentAuditEvents",
    ],
  ),
  downstream(
    "#1043",
    ["governance-controls", "readiness", "import-jobs", "promotion-preview", "supporting-evidence"],
    [
      "governanceControls.rolloutMode",
      "governanceControls.controls",
      "governanceControls.rbacMatrix",
      "governanceControls.observability.signals",
      "governanceControls.legacyRemovalEvidence",
    ],
  ),
  downstream(
    "#1044",
    [
      "audit-evidence",
      "import-jobs",
      "source-observation-review",
      "promotion-preview",
      "lifecycle-recovery",
      "governance-controls",
      "supporting-evidence",
    ],
    [
      "auditEvidence.filters",
      "auditEvidence.projectionState",
      "auditEvidence.redactionPolicy",
      "auditEvidence.timeline",
      "auditEvidence.evidenceLinks",
    ],
  ),
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
    [
      "provider-scope-selection",
      "readiness",
      "import-jobs",
      "source-observation-review",
      "promotion-preview",
      "governance-controls",
    ],
    ["instrumentation.dimensions", "instrumentation.redactionSafe", "governanceControls.observability.signals"],
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
    ["readiness", "promotion-preview", "promotion-result", "governance-controls"],
    [
      "securityPrivacy.redactionApplied",
      "securityPrivacy.unsafeEvidenceBlocked",
      "securityPrivacy.missingSecurityFieldsBlocker",
      "governanceControls.rbacMatrix",
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

function assertPrimaryWorkbenchPromotionResult(
  value: CatalogPrimaryWorkbenchReadModel["promotionResult"] | undefined,
): void {
  if (value == null) {
    return;
  }
  if (!value.resultId || !value.jobId || !value.completedAt) {
    throw new Error("Primary workbench promotion results require durable outcome identity and timing.");
  }
  if (!["completed", "partial", "failed"].includes(value.status)) {
    throw new Error("Primary workbench promotion results require an explicit terminal status.");
  }
  const counts = [value.requestedCount, value.promotedCount, value.skippedCount, value.failedCount];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("Primary workbench promotion result counts must be non-negative integers.");
  }
  if (value.promotedCount + value.skippedCount + value.failedCount !== value.requestedCount) {
    throw new Error("Primary workbench promotion result counts must reconcile to the requested count.");
  }
  if (!Array.isArray(value.redactedFailureReasons)) {
    throw new Error("Primary workbench promotion results must expose redacted failure reasons.");
  }
  for (const reason of value.redactedFailureReasons) {
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.includes("\n") ||
      /\b(api[-_ ]?key|x-api-key|x-team-id|authorization|bearer|token|secret|password)\s*[=:]\s*(?!\[redacted\])/i.test(
        reason,
      )
    ) {
      throw new Error("Primary workbench promotion failure reasons must stay redaction-safe.");
    }
  }
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
  if (context.scope) {
    validatePrimaryWorkbenchScopeContext(context.scope);
  }
  if (
    context.returnPath &&
    (!isSafePrimaryWorkbenchReturnPath(context.returnPath) ||
      /legacy|compat|raw-json|god-page/i.test(context.returnPath))
  ) {
    throw new Error("Primary workbench returnPath must be a safe rebuilt Catalog admin path.");
  }
}

function validatePrimaryWorkbenchScopeContext(scope: CatalogPrimaryWorkbenchScopeContext): void {
  for (const [key, value] of Object.entries(scope)) {
    if (
      ![
        "providerKey",
        "languageCode",
        "productLineId",
        "productLineName",
        "seriesId",
        "seriesName",
        "expansionId",
        "expansionName",
        "status",
      ].includes(key) ||
      (value !== null && (typeof value !== "string" || value.includes("\n")))
    ) {
      throw new Error("Primary workbench route scope must use clean structured scope fields.");
    }
  }
}

function assertPrimaryWorkbenchImportJobs(value: CatalogPrimaryWorkbenchReadModel["importJobs"] | undefined): void {
  if (!value) {
    throw new Error("Primary workbench import jobs contract is required.");
  }
  for (const job of value.jobs) {
    if (!job.result) {
      continue;
    }
    if (!Array.isArray(job.result.redactedFailureReasons)) {
      throw new Error("Primary workbench import job results must expose redacted failure reasons.");
    }
    if (job.result.usage) {
      const counts = Object.values(job.result.usage);
      if (counts.some((count) => count !== null && (!Number.isSafeInteger(count) || count < 0))) {
        throw new Error("Primary workbench import job usage counts must be non-negative integers.");
      }
    }
    for (const reason of job.result.redactedFailureReasons) {
      if (
        typeof reason !== "string" ||
        !reason.trim() ||
        reason.includes("\n") ||
        /\b(api[-_ ]?key|x-api-key|x-team-id|authorization|bearer|token|secret|password)\s*[=:]\s*(?!\[redacted\])/i.test(
          reason,
        )
      ) {
        throw new Error("Primary workbench import job failure reasons must stay redaction-safe.");
      }
    }
  }
}

// The four audience surface routes that make up the rebuilt integrations
// workbench. The daily base route plus three nested surface routes are
// all safe in-workbench destinations; ?section= only names a workspace within a
// surface, so it never changes which route a link targets.
const safePrimaryWorkbenchSurfacePaths = new Set<string>([
  "/catalog/integrations",
  "/catalog/integrations/governance",
  "/catalog/integrations/health",
  // The v2 Provider detail page's own bare fallback when no provider is
  // selected (catalogProviderDetailHref(null)).
  "/catalog/providers",
]);
// The v2 Provider detail page (/catalog/providers/:providerKey) is a
// real path-param route, not a fixed workspace path, so it is recognized by
// prefix rather than exact match.
const safePrimaryWorkbenchDynamicSurfacePathPrefix = "/catalog/providers/";

function isSafePrimaryWorkbenchReturnPath(path: string): boolean {
  if (path.startsWith("//")) {
    return false;
  }
  try {
    const parsedUrl = new URL(path, "https://admin.example");
    if (parsedUrl.origin !== "https://admin.example") {
      return false;
    }
    return (
      safePrimaryWorkbenchSurfacePaths.has(parsedUrl.pathname) ||
      (parsedUrl.pathname.startsWith(safePrimaryWorkbenchDynamicSurfacePathPrefix) &&
        parsedUrl.pathname.length > safePrimaryWorkbenchDynamicSurfacePathPrefix.length)
    );
  } catch {
    return false;
  }
}

function isSafePrimaryWorkbenchObservabilityLink(path: string): boolean {
  if (isSafePrimaryWorkbenchReturnPath(path)) {
    return true;
  }
  if (path.startsWith("//")) {
    return false;
  }
  try {
    const parsedUrl = new URL(path);
    if (parsedUrl.protocol !== "https:") {
      return false;
    }
    if (
      ["grafana.chasesets.com", "grafana.staging.chasesets.com"].includes(parsedUrl.hostname) &&
      parsedUrl.pathname.startsWith("/d/chase-sets-catalog-control-plane")
    ) {
      return true;
    }

    return (
      parsedUrl.hostname === "github.com" &&
      (parsedUrl.pathname.startsWith("/chase-sets/chase-sets/blob/main/docs/runbooks/") ||
        parsedUrl.pathname.startsWith("/chase-sets/chase-sets/blob/main/bounded-contexts/catalog/docs/"))
    );
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

function assertPrimaryWorkbenchSourceOptions(
  value: CatalogPrimaryWorkbenchReadModel["sourceOptions"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench source options contract is required.");
  }
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench source options status must be explicit.");
  }
  if (!["fresh", "stale", "lagging", "partial", "unavailable"].includes(value.freshness)) {
    throw new Error("Primary workbench source options freshness must be explicit.");
  }
  for (const kind of value.optionKinds) {
    if (!kind.queryKind || !kind.displayName || !kind.scope) {
      throw new Error("Primary workbench source option kinds must expose canonical query metadata.");
    }
    if (kind.parent.required && !kind.parent.scope) {
      throw new Error("Primary workbench source option required parents must name the parent scope.");
    }
    if (kind.parent.missing && !kind.parent.diagnosticText) {
      throw new Error("Primary workbench source option missing parents require diagnostic text.");
    }
  }
  for (const page of value.pages) {
    if (!page.queryKind || !page.displayName || !page.scope) {
      throw new Error("Primary workbench source option pages must preserve option kind identity.");
    }
    if (!["live", "cached", "stale", "unavailable", "rollout-blocked", "not-requested"].includes(page.state)) {
      throw new Error("Primary workbench source option page state must be explicit.");
    }
    assertCatalogPrimaryWorkbenchActionState(page.actionState);
    assertPrimaryWorkbenchBlockers(page.blockers);
    if (page.request.limit < 1 || page.page.limit < 1) {
      throw new Error("Primary workbench source option pages must expose positive limits.");
    }
    if (page.page.count !== page.items.length) {
      throw new Error("Primary workbench source option page count must match item count.");
    }
    if (!["fresh", "stale", "miss", "bypass", "unavailable"].includes(page.cache.status)) {
      throw new Error("Primary workbench source option cache status must be explicit.");
    }
    if (!["cache", "live", "none"].includes(page.cache.source)) {
      throw new Error("Primary workbench source option cache source must be explicit.");
    }
    if ((page.state === "live" || page.state === "cached" || page.state === "stale") && !page.cache.cacheKey) {
      throw new Error("Primary workbench source option cached/live pages must include the cache key.");
    }
    if (!page.queryHref || /raw-json|legacy|compat/i.test(page.queryHref)) {
      throw new Error("Primary workbench source option query links must stay on typed option routes.");
    }
    if (page.refreshHref && /raw-json|legacy|compat/i.test(page.refreshHref)) {
      throw new Error("Primary workbench source option refresh links must stay on typed option routes.");
    }
  }
  if (value.summary.declaredKinds !== value.optionKinds.length || value.pages.length !== value.optionKinds.length) {
    throw new Error("Primary workbench source options must expose one page state per declared option kind.");
  }
  assertCatalogPrimaryWorkbenchActionState(value.refresh.state);
  assertPrimaryWorkbenchBlockers(value.refresh.blockers);
}

function assertPrimaryWorkbenchConflictResolution(
  value: CatalogPrimaryWorkbenchReadModel["conflictResolution"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench conflict resolution contract is required.");
  }
  if (!["ready", "empty", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench conflict resolution status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench conflict resolution return link must target the rebuilt workbench.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.auditEvidenceUrl)) {
    throw new Error("Primary workbench conflict resolution audit link must target the rebuilt workbench.");
  }
  if (value.rows.length > 0 && value.precedenceRules.length === 0) {
    throw new Error("Primary workbench conflict resolution rows require precedence rule evidence.");
  }
  if (value.overridePolicy.supported && value.overridePolicy.state === "available") {
    throw new Error("Primary workbench conflict overrides need a rebuilt backend command before becoming available.");
  }
  assertCatalogPrimaryWorkbenchActionState(value.overridePolicy.state);
  for (const row of value.rows) {
    if (!row.observationId || !row.affectedFact || !row.precedenceRuleId) {
      throw new Error("Primary workbench conflict resolution rows must name observation, fact, and precedence rule.");
    }
    if (!["blocks-promotion", "requires-review", "auto-resolved"].includes(row.resolutionState)) {
      throw new Error("Primary workbench conflict resolution row state must be explicit.");
    }
    if (row.candidateValues.length < 2) {
      throw new Error("Primary workbench conflict resolution rows must show winning and losing candidate values.");
    }
    if (row.evidencePaths.length === 0 || row.diagnostics.length === 0) {
      throw new Error("Primary workbench conflict resolution rows must expose evidence paths and diagnostics.");
    }
    assertCatalogPrimaryWorkbenchActionState(row.overrideAction.state);
  }
}

function assertPrimaryWorkbenchSourceScopeWorkset(
  value: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench source-scope workset contract is required.");
  }
  if (!["not-configured", "scope-required", "ready", "blocked", "degraded"].includes(value.status)) {
    throw new Error("Primary workbench source-scope workset status must be explicit.");
  }
  if (!value.selectedScope.label) {
    throw new Error("Primary workbench source-scope workset must label the selected scope state.");
  }
  if (value.summary.unitCount !== value.units.length) {
    throw new Error("Primary workbench source-scope workset unit summary must match unit rows.");
  }
  const unitKeys = new Set<string>();
  for (const unit of value.units) {
    const unitIdentity = `${unit.providerKey}:${unit.unitKey ?? "none"}`;
    if (unitKeys.has(unitIdentity)) {
      throw new Error("Primary workbench source-scope workset unit rows must be unique by provider and unit.");
    }
    unitKeys.add(unitIdentity);
    if (
      !unit.providerKey ||
      !unit.displayName ||
      !unit.currentWorkbenchHref ||
      /api\/|raw-json|legacy|compat/i.test(unit.currentWorkbenchHref)
    ) {
      throw new Error("Primary workbench source-scope workset rows must link back to the typed workbench.");
    }
    if (!["not-imported", "imported", "changed", "promoted", "blocked"].includes(unit.state)) {
      throw new Error("Primary workbench source-scope workset row state must be explicit.");
    }
    if (!unit.commandContext.providerKey || unit.commandContext.providerKey !== unit.providerKey) {
      throw new Error("Primary workbench source-scope workset command context must preserve provider identity.");
    }
    if (!value.selectedScope.hasConcreteScope || !unit.importScope) {
      for (const action of [unit.actions.import, unit.actions.previewPromotion, unit.actions.reapply] as const) {
        if (action.state !== "disabled" || !action.blockers.includes("import-scope-required")) {
          throw new Error("Primary workbench source-scope workset must fail closed until a source scope is selected.");
        }
      }
    }
    for (const action of [unit.actions.import, unit.actions.previewPromotion, unit.actions.reapply] as const) {
      assertCatalogPrimaryWorkbenchActionState(action.state);
      assertPrimaryWorkbenchBlockers(action.blockers);
    }
  }
}

function assertPrimaryWorkbenchGovernanceControls(
  value: CatalogPrimaryWorkbenchReadModel["governanceControls"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench governance controls contract is required.");
  }
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench governance controls status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench governance controls return link must target the rebuilt workbench.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.auditEvidenceUrl)) {
    throw new Error("Primary workbench governance controls audit link must target the rebuilt workbench.");
  }
  if (value.controls.length === 0) {
    throw new Error("Primary workbench governance controls must expose rollout, worker, and removal evidence.");
  }
  for (const control of value.controls) {
    if (!control.controlId || !control.kind || !control.label || !control.metricKey) {
      throw new Error("Primary workbench governance controls must name control, metric, and label.");
    }
    if (!["open", "degraded", "blocked", "removed"].includes(control.status)) {
      throw new Error("Primary workbench governance control status must be explicit.");
    }
    if (!isSafePrimaryWorkbenchReturnPath(control.evidenceUrl)) {
      throw new Error("Primary workbench governance control evidence link must target the rebuilt workbench.");
    }
  }

  const sensitiveActions = catalogPrimaryWorkbenchActions.filter(
    (actionEntry) => actionEntry.requiredPermission === "catalog.manage" || actionEntry.confirmationRequired,
  );
  const matrixKeys = new Set(value.rbacMatrix.map((entry) => entry.actionKey));
  for (const actionEntry of sensitiveActions) {
    if (!matrixKeys.has(actionEntry.key)) {
      throw new Error(`Primary workbench governance controls must cover sensitive action '${actionEntry.key}'.`);
    }
  }
  for (const entry of value.rbacMatrix) {
    assertCatalogPrimaryWorkbenchActionState(entry.state);
    if (!entry.deniedCopy) {
      throw new Error("Primary workbench governance RBAC matrix must provide denied-state copy.");
    }
    if (entry.confirmationRequired && !entry.destructive) {
      throw new Error("Primary workbench governance destructive confirmation rows must be explicit.");
    }
    if (/legacy|compat|raw-json/i.test(entry.routePattern)) {
      throw new Error("Primary workbench governance RBAC matrix must not preserve retired route patterns.");
    }
  }

  const requiredSignals: readonly CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey[] = [
    "option-query-latency",
    "job-failure-rate",
    "projection-freshness",
    "source-observation-quarantine",
    "data-quarantine",
    "conflict-spike",
  ];
  const signalKeys = new Set(value.observability.signals.map((signal) => signal.key));
  for (const signal of requiredSignals) {
    if (!signalKeys.has(signal)) {
      throw new Error(`Primary workbench governance observability signal '${signal}' is required.`);
    }
  }
  for (const signal of value.observability.signals) {
    if (!["ready", "degraded", "blocked", "unavailable"].includes(signal.status)) {
      throw new Error("Primary workbench governance observability signal status must be explicit.");
    }
    if (signal.alertLinks.length === 0 || signal.runbookLinks.length === 0) {
      throw new Error("Primary workbench governance observability signals require alert and runbook links.");
    }
    for (const link of [...signal.alertLinks, ...signal.runbookLinks]) {
      if (!link.label || !isSafePrimaryWorkbenchObservabilityLink(link.href)) {
        throw new Error("Primary workbench governance alert and runbook links must target approved observability.");
      }
    }
    if (signal.stale && signal.status === "ready") {
      throw new Error("Primary workbench governance stale observability data must be degraded or unavailable.");
    }
  }

  if (value.legacyRemovalEvidence.status !== "removed") {
    throw new Error("Primary workbench governance retired compatibility evidence must be removed.");
  }
  if (value.legacyRemovalEvidence.requiredDisposition !== "complete-removal") {
    throw new Error("Primary workbench governance retired compatibility evidence must require complete removal.");
  }
  for (const surface of [
    "runtime code",
    "product patterns",
    "tests",
    "fixtures",
    "screenshots",
    "documentation",
    "runbooks",
    "operator instructions",
  ] as const) {
    if (!value.legacyRemovalEvidence.removedSurfaces.includes(surface)) {
      throw new Error(`Primary workbench governance retirement evidence must remove '${surface}'.`);
    }
  }
  for (const evidence of value.legacyRemovalEvidence.evidence) {
    if (evidence.status !== "removed" || !isSafePrimaryWorkbenchReturnPath(evidence.evidenceUrl)) {
      throw new Error("Primary workbench governance retirement evidence rows must be removed and linked.");
    }
  }
  const removalText = `${value.legacyRemovalEvidence.evidence.map((evidence) => evidence.detail).join(" ")} ${value.legacyRemovalEvidence.launchBlockerIfPresent.join(
    " ",
  )}`;
  if (/holding area/i.test(removalText)) {
    throw new Error("Primary workbench governance controls must not preserve a compatibility holding area.");
  }
}

function assertPrimaryWorkbenchAuditEvidence(
  value: CatalogPrimaryWorkbenchReadModel["auditEvidence"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench audit evidence contract is required.");
  }
  if (!["ready", "partial", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench audit evidence status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench audit evidence return link must target the rebuilt workbench.");
  }
  if (value.projectionState.queryKey !== "audit-evidence-timeline") {
    throw new Error("Primary workbench audit evidence projection must use the canonical audit timeline query.");
  }
  if (value.projectionState.missingProjection && value.status !== "unavailable") {
    throw new Error("Primary workbench missing audit projection must be unavailable.");
  }
  if (value.projectionState.partialProjection && value.status === "ready") {
    throw new Error("Primary workbench partial audit projection cannot report ready.");
  }

  const requiredFilterKeys: readonly CatalogPrimaryWorkbenchAuditEvidenceFilterKey[] = [
    "provider",
    "unit",
    "profile-version",
    "job",
    "observation",
    "action-category",
    "actor",
    "time",
  ];
  const filterKeys = new Set(value.filters.map((filter) => filter.key));
  for (const filterKey of requiredFilterKeys) {
    if (!filterKeys.has(filterKey)) {
      throw new Error(`Primary workbench audit evidence filter '${filterKey}' is required.`);
    }
  }

  if (
    value.redactionPolicy.sourcePayloadAccess !== "not-required" ||
    value.redactionPolicy.profileSnapshotAccess !== "not-required"
  ) {
    throw new Error("Primary workbench audit evidence must not require source payload or profile snapshot access.");
  }
  if (value.redactionPolicy.forbiddenEvidenceRequests.length === 0) {
    throw new Error("Primary workbench audit evidence must list forbidden evidence request patterns.");
  }

  const links = [...value.evidenceLinks, ...value.timeline.flatMap((event) => event.evidenceLinks)];
  for (const link of links) {
    assertPrimaryWorkbenchAuditEvidenceLink(link);
  }
  for (const event of value.timeline) {
    if (!event.eventId || !event.occurredAt || !event.eventName || !event.category || !event.targetId) {
      throw new Error("Primary workbench audit timeline rows must name event, time, category, and target.");
    }
    if (event.evidenceLinks.length === 0) {
      throw new Error("Primary workbench audit timeline rows must expose redacted evidence links.");
    }
  }

  const evidenceText = JSON.stringify(value);
  if (/raw\s+json|payload\s+json|profile\s+json|compatibility holding area/i.test(evidenceText)) {
    throw new Error(
      "Primary workbench audit evidence must expose redacted summaries without legacy document workflows.",
    );
  }
}

function assertPrimaryWorkbenchAuditEvidenceLink(link: CatalogPrimaryWorkbenchAuditEvidenceLink): void {
  if (!link.key || !link.label || !link.summary || !isSafePrimaryWorkbenchReturnPath(link.href)) {
    throw new Error("Primary workbench audit evidence links must be named and target rebuilt workbench evidence.");
  }
  if (
    link.sourcePayloadAccess !== "not-required" ||
    link.profileSnapshotAccess !== "not-required" ||
    !["not-needed", "redacted", "excluded"].includes(link.redactionState)
  ) {
    throw new Error("Primary workbench audit evidence links must remain redaction-safe.");
  }
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

function assertPrimaryWorkbenchMergeCandidateReview(
  value: CatalogPrimaryWorkbenchReadModel["mergeCandidateReview"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench merge candidate review contract is required.");
  }
  if (!["fresh", "partial", "stale", "unavailable"].includes(value.freshness)) {
    throw new Error("Primary workbench merge candidate review freshness must be explicit.");
  }
  for (const countKey of ["total", "ready", "conflict", "stale", "deferred", "terminal", "blocked"] as const) {
    if (typeof value.counts[countKey] !== "number") {
      throw new Error(`Primary workbench merge candidate count '${countKey}' is required.`);
    }
  }
  for (const row of value.rows) {
    if (!row.candidateId || !row.identityFingerprint || !row.identityLabel) {
      throw new Error("Primary workbench merge candidate rows must expose identity.");
    }
    if (row.sourceCount < 1 || row.sources.length < 1) {
      throw new Error("Primary workbench merge candidate rows must expose contributing sources.");
    }
    if (row.promoteReadiness.state === "ready" && row.promoteReadiness.blockers.length > 0) {
      throw new Error("Primary workbench ready merge candidates cannot carry promotion blockers.");
    }
    if (!row.proposedMapping.promotionIntent) {
      throw new Error("Primary workbench merge candidate detail must expose proposed Catalog mapping.");
    }
    if (row.fieldProvenance.length === 0 || row.sourceComparison.length === 0) {
      throw new Error("Primary workbench merge candidate detail must expose source comparison and field provenance.");
    }
    if (row.conflicts.blockingConflicts.length !== row.conflicts.blocking) {
      throw new Error(
        "Primary workbench merge candidate blocking conflict count must match its resolvable conflict detail.",
      );
    }
    const actions = new Set(row.actions.map((actionEntry) => actionEntry.key));
    for (const actionKey of [
      "candidate.promote",
      "candidate.split",
      "candidate.edit",
      "candidate.ignore",
      "candidate.defer",
    ] as const) {
      if (!actions.has(actionKey)) {
        throw new Error(`Primary workbench merge candidate rows must expose '${actionKey}'.`);
      }
    }
    for (const actionEntry of row.actions) {
      assertCatalogPrimaryWorkbenchActionState(actionEntry.state);
      assertPrimaryWorkbenchBlockers(actionEntry.blockers);
      if (
        (actionEntry.key === "candidate.split" || actionEntry.key === "candidate.edit") &&
        (actionEntry.state === "available" || actionEntry.state === "degraded") &&
        !actionEntry.commandPreview
      ) {
        throw new Error("Primary workbench split/update merge candidate actions require typed command previews.");
      }
    }
  }
}

function assertPrimaryWorkbenchHealthTriage(value: CatalogPrimaryWorkbenchReadModel["healthTriage"] | undefined): void {
  if (!value) {
    throw new Error("Primary workbench health triage contract is required.");
  }
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench health triage status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench health triage return link must target the rebuilt workbench.");
  }
  for (const unit of value.units) {
    if (!unit.providerKey || !unit.unitKey || !unit.ownerMetricKey || !unit.nextAction) {
      throw new Error("Primary workbench health triage units must name provider, unit, owner metric, and next action.");
    }
  }
  for (const provider of value.providers) {
    if (!provider.providerKey || !provider.ownerMetricKey || !provider.nextAction) {
      throw new Error("Primary workbench health triage providers must name provider, owner metric, and next action.");
    }
  }
}

function assertPrimaryWorkbenchProfileAuthoring(
  value: CatalogPrimaryWorkbenchReadModel["profileAuthoring"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench profile authoring contract is required.");
  }
  if (!["ready", "missing-profile", "stale-selection"].includes(value.status)) {
    throw new Error("Primary workbench profile authoring status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench profile authoring return link must target the rebuilt workbench.");
  }
  if (value.cloneDraft.commandKey !== "provider-profile.clone") {
    throw new Error("Primary workbench profile draft command must use the rebuilt provider-profile.clone boundary.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.cloneDraft.submitHref)) {
    throw new Error("Primary workbench profile draft submit link must target the rebuilt workbench.");
  }
  assertCatalogPrimaryWorkbenchActionState(value.cloneDraft.state);
  assertPrimaryWorkbenchBlockers(value.cloneDraft.blockers);
  if (value.status === "ready" && !value.selectedProfile) {
    throw new Error("Primary workbench profile authoring ready state requires a selected profile.");
  }
  if (value.status !== "ready" && value.cloneDraft.blockers.length === 0) {
    throw new Error("Primary workbench profile draft command must fail closed when profile selection is missing.");
  }
  if (value.selectedProfile) {
    if (
      !value.selectedProfile.providerKey ||
      !value.selectedProfile.profileKey ||
      !value.selectedProfile.profileVersion
    ) {
      throw new Error("Primary workbench selected profile must preserve provider, profile, and version identity.");
    }
    if (value.selectedProfile.immutableIdentityFacts.length === 0) {
      throw new Error("Primary workbench selected profile must expose immutable identity facts.");
    }
    if (
      value.cloneDraft.sourceProviderKey !== value.selectedProfile.providerKey ||
      value.cloneDraft.sourceProfileVersion !== value.selectedProfile.profileVersion
    ) {
      throw new Error("Primary workbench profile draft command must preserve source provider and version context.");
    }
  }
  if (value.selectedProfile && value.sectionWorkspaces.length === 0) {
    throw new Error("Primary workbench profile authoring must expose guided section workspaces.");
  }
  const groupedSections = new Set(value.sectionGroups.flatMap((group) => group.sections));
  for (const workspace of value.sectionWorkspaces) {
    if (!groupedSections.has(workspace.sectionKey)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must belong to a navigation group.`);
    }
    if (workspace.commandKey !== "provider-profile.edit-section") {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must use section-scoped saves.`);
    }
    if (!isSafePrimaryWorkbenchReturnPath(workspace.submitHref)) {
      throw new Error(
        `Primary workbench profile section ${workspace.sectionKey} submit link must stay in the rebuilt workbench.`,
      );
    }
    if (workspace.fields.length === 0) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must expose guided controls.`);
    }
    if (workspace.fields.some((field) => /json/i.test(`${field.key} ${field.label} ${field.helpText ?? ""}`))) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must not expose raw JSON controls.`);
    }
    if (!Array.isArray(workspace.optionQueries)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} option-query details are required.`);
    }
    if (!Array.isArray(workspace.importScopeControls)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} import-scope controls are required.`);
    }
    if (!Array.isArray(workspace.mappingRows)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} mapping rows are required.`);
    }
    for (const optionQuery of workspace.optionQueries) {
      if (!optionQuery.queryKind || !optionQuery.displayName || !optionQuery.scope || !optionQuery.operation) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} option queries must expose canonical query metadata.`,
        );
      }
      if (optionQuery.outputMappings.length === 0) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} option queries must expose output mappings.`,
        );
      }
      if (!optionQuery.cacheState.label || !optionQuery.cacheState.description) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} option-query cache state must be explainable.`,
        );
      }
    }
    for (const importScope of workspace.importScopeControls) {
      if (!importScope.scope || !importScope.label) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} import-scope controls must name the scope.`,
        );
      }
      if (importScope.state === "unavailable" && !importScope.reason) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} unavailable import scopes need a reason.`,
        );
      }
    }
    for (const mappingRow of workspace.mappingRows) {
      if (!mappingRow.key || !mappingRow.label || !mappingRow.path || !mappingRow.summary) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} mapping rows must expose row metadata.`,
        );
      }
      if (!mappingRow.affordances.inlineDiagnostics || !mappingRow.affordances.longPathSafe) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} mapping rows must support diagnostics and long paths.`,
        );
      }
    }
    assertCatalogPrimaryWorkbenchActionState(workspace.actionState);
    assertPrimaryWorkbenchBlockers(workspace.blockers);
    if (!["fresh", "stale", "conflict"].includes(workspace.staleState)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} stale state must be explicit.`);
    }
    if (!["not-submitted", "saved", "conflict", "invalid", "failed"].includes(workspace.saveOutcome)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} save outcome must be explicit.`);
    }
  }
}

function assertPrimaryWorkbenchValidationReadiness(
  value: CatalogPrimaryWorkbenchReadModel["validationReadiness"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench validation readiness contract is required.");
  }
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench validation readiness status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench validation readiness return link must target the rebuilt workbench.");
  }
  if (value.selectedProfileVersion && value.fixtureFlows.length === 0) {
    throw new Error("Primary workbench validation readiness must expose fixture flows for the selected profile.");
  }
  for (const flow of value.fixtureFlows) {
    if (!flow.flow || !["ready", "warning", "blocked", "not-covered"].includes(flow.status)) {
      throw new Error("Primary workbench validation fixture flows must be named and explicitly statused.");
    }
    assertPrimaryWorkbenchBlockers(flow.blockers);
    assertCatalogPrimaryWorkbenchActionState(flow.actionState);
  }
  for (const evidence of value.dryRunEvidence) {
    if (!["completed", "blocked", "not-run"].includes(evidence.status)) {
      throw new Error("Primary workbench validation dry-run evidence status must be explicit.");
    }
    if (evidence.redactionSummary.length === 0) {
      throw new Error("Primary workbench validation dry-run evidence must summarize redaction.");
    }
  }
  if (!["ready", "blocked"].includes(value.activationReadiness.status)) {
    throw new Error("Primary workbench activation readiness status must be explicit.");
  }
  if (!value.activationDecision || value.activationDecision.activationCommandKey !== "provider-profile.activate") {
    throw new Error("Primary workbench activation decision must expose the rebuilt activation command.");
  }
  if (value.activationDecision.evidenceCommandKey !== "provider-profile.edit-section") {
    throw new Error("Primary workbench activation decision must save evidence through typed profile sections.");
  }
  if (!["ready", "blocked", "unavailable"].includes(value.activationDecision.status)) {
    throw new Error("Primary workbench activation decision status must be explicit.");
  }
  assertCatalogPrimaryWorkbenchActionState(value.activationDecision.actionState);
  assertCatalogPrimaryWorkbenchActionState(value.activationDecision.saveEvidenceState);
  assertPrimaryWorkbenchBlockers(value.activationDecision.blockers);
  assertPrimaryWorkbenchBlockers(value.activationDecision.saveEvidenceBlockers);
  if (value.activationDecision.status === "ready" && value.activationDecision.actionState !== "available") {
    throw new Error("Primary workbench activation decision must make ready activation actionable.");
  }
  const validationText = JSON.stringify(value);
  if (/raw\s+json/i.test(validationText)) {
    throw new Error("Primary workbench validation readiness must not expose raw JSON workflow copy.");
  }
}

function assertPrimaryWorkbenchLifecycleRecovery(
  value: CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench lifecycle recovery contract is required.");
  }
  if (!["ready", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench lifecycle recovery status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench lifecycle recovery return link must target the rebuilt workbench.");
  }
  if (value.strictRetirement.requiredDisposition !== "complete-removal") {
    throw new Error("Primary workbench lifecycle recovery must preserve complete-removal retirement semantics.");
  }
  const operations = new Set(value.operations.map((operation) => operation.operation));
  for (const operation of ["activation", "rollback", "deprecate", "retire"] as const) {
    if (!operations.has(operation)) {
      throw new Error(`Primary workbench lifecycle recovery must expose ${operation} evidence.`);
    }
  }
  for (const operation of value.operations) {
    assertCatalogPrimaryWorkbenchActionState(operation.state);
    assertPrimaryWorkbenchBlockers(operation.blockers);
    if (!isSafePrimaryWorkbenchReturnPath(operation.submitHref)) {
      throw new Error("Primary workbench lifecycle recovery submit link must stay in the rebuilt workbench.");
    }
    if (
      (operation.operation === "rollback" || operation.operation === "deprecate" || operation.operation === "retire") &&
      !operation.confirmationRequired
    ) {
      throw new Error("Primary workbench lifecycle recovery destructive lifecycle actions require confirmation.");
    }
    if (operation.operation === "retire" && operation.blockers.includes("profile-retirement-references")) {
      const referenceCount =
        operation.impact.referencedObservationCount +
        operation.impact.sourceProfileReferenceCount +
        operation.impact.promotionProfileReferenceCount;
      if (referenceCount === 0) {
        throw new Error("Primary workbench profile retirement reference blocker must name concrete references.");
      }
    }
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
