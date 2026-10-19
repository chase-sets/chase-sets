import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogMergeCandidateReviewCommandPreview } from "../promotion/catalog-merge-candidate-review-command-payloads";
import type {
  CatalogAdminControlPlaneFreshnessState,
  CatalogAdminControlPlanePaginationMode,
} from "./admin-control-plane-read-model-slos";
import type {
  CatalogIntegrationAuditEvidenceCategory,
  CatalogIntegrationAuditEvidenceEventName,
  CatalogIntegrationAuditEvidenceRedactionState,
} from "../governance/catalog-integration-audit-evidence";
import type {
  CatalogAdminControlPlaneQueryKey,
  CatalogAdminControlPlaneDiagnostic,
  CatalogAdminRollbackRetirementImpactSummaryReadModel,
  CatalogAdminJobConsistency,
  CatalogAdminProfileVersionPointer,
} from "./admin-control-plane-read-model-contracts";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type { CatalogIntegrationProviderUsageBudget } from "./admin-control-plane-overview";
import type { CatalogProviderProfileEditableSectionKey } from "../providers/provider-profile-section-registry";
import type { CatalogControlPlaneActionId } from "../../ui/admin-control-plane/information-architecture-v2";

const catalogPrimaryWorkbenchContractVersion = "catalog-primary-workbench-v2" as const;

type CatalogPrimaryWorkbenchContractVersion = typeof catalogPrimaryWorkbenchContractVersion;

type CatalogPrimaryWorkbenchSectionKey =
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

type CatalogPrimaryWorkbenchCommandKey = CatalogControlPlaneActionId;

type CatalogPrimaryWorkbenchSourceObservationRowActionKey =
  | "view-source-observation"
  | "observation.promote"
  | "observation.reject"
  | "observation.defer"
  | "observation.reapply"
  | "observation.replay";

type CatalogPrimaryWorkbenchActionState =
  | "available"
  | "disabled"
  | "denied"
  | "blocked"
  | "unavailable"
  | "unsafe"
  | "degraded";

type CatalogPrimaryWorkbenchBlockerCategory =
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
  | "display-identity-unresolvable"
  | "stale-replay"
  | "idempotency-replay"
  | "security-privacy-blocked"
  | "unsupported-command"
  | "deploy-skew-unsupported-version"
  | "raw-json-retired"
  | "legacy-selector-retired";

type CatalogPrimaryWorkbenchProviderTransportCategory =
  | "rate-limit"
  | "throttle"
  | "quota"
  | "timeout"
  | "pagination-failure"
  | "partial-data"
  | "stale-cache"
  | "degraded-provider";

const catalogPrimaryWorkbenchProviderTransportCategories = [
  "rate-limit",
  "throttle",
  "quota",
  "timeout",
  "pagination-failure",
  "partial-data",
  "stale-cache",
  "degraded-provider",
] as const satisfies readonly CatalogPrimaryWorkbenchProviderTransportCategory[];

type CatalogPrimaryWorkbenchPromotionDisposition =
  | "eligible"
  | "skipped"
  | "blocked"
  | "conflicting"
  | "destructive"
  | "stale-preview"
  | "confirmation-required";

type CatalogPrimaryWorkbenchPromotionScopeKind = "explicit-rows" | "matching-filter";

type CatalogPrimaryWorkbenchPromotionOutcomeCountKey = "eligible" | "blocked" | "skipped" | "conflicting" | "failed";

type CatalogPrimaryWorkbenchPromotionStaleProtectionKey =
  | "observations"
  | "profile-version"
  | "rollout-state"
  | "permissions"
  | "command-inputs";

type CatalogPrimaryWorkbenchPromotionProfileSemantics = "current-active-profile" | "original-source-profile-version";

type CatalogPrimaryWorkbenchRouteContextKey =
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

const catalogPrimaryWorkbenchRouteSections = [
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

type CatalogPrimaryWorkbenchCopyKey =
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

type CatalogPrimaryWorkbenchInstrumentationDimension =
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

type CatalogPrimaryWorkbenchDeploySkewMode = "current" | "old-ui-new-api" | "new-ui-old-api";

type CatalogPrimaryWorkbenchDeploySkewPolicy = Readonly<{
  mode: CatalogPrimaryWorkbenchDeploySkewMode;
  supported: boolean;
  failClosedBlocker: Extract<CatalogPrimaryWorkbenchBlockerCategory, "deploy-skew-unsupported-version">;
  forbiddenFallbacks: readonly string[];
}>;

type CatalogPrimaryWorkbenchRetirementPolicy = Readonly<{
  term: "retire";
  requiredDisposition: "complete-removal";
  surfaces: readonly string[];
  forbiddenOutcomes: readonly string[];
}>;

type CatalogPrimaryWorkbenchBlockerContract = Readonly<{
  category: CatalogPrimaryWorkbenchBlockerCategory;
  actionStates: readonly CatalogPrimaryWorkbenchActionState[];
  copyKey: CatalogPrimaryWorkbenchCopyKey;
  instrumentationDimension: Extract<CatalogPrimaryWorkbenchInstrumentationDimension, "blocker_category">;
  failClosed: boolean;
}>;

type CatalogPrimaryWorkbenchSectionContract = Readonly<{
  key: CatalogPrimaryWorkbenchSectionKey;
  defaultVisible: boolean;
  queryKeys: readonly CatalogAdminControlPlaneQueryKey[];
  commands: readonly CatalogPrimaryWorkbenchCommandKey[];
  freshnessStates: readonly CatalogAdminControlPlaneFreshnessState[];
  pagination: CatalogAdminControlPlanePaginationMode;
  routeContextKeys: readonly CatalogPrimaryWorkbenchRouteContextKey[];
}>;

type CatalogPrimaryWorkbenchActionContract = Readonly<{
  key: CatalogPrimaryWorkbenchCommandKey;
  method: "GET" | "POST" | "PATCH";
  routePattern: string;
  requiredPermission: "catalog.view" | "catalog.manage";
  successState: CatalogPrimaryWorkbenchActionState;
  blockerCategories: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  idempotencyRequired: boolean;
  confirmationRequired: boolean;
}>;

type CatalogPrimaryWorkbenchDownstreamIssueKey =
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

type CatalogPrimaryWorkbenchDownstreamContract = Readonly<{
  issue: CatalogPrimaryWorkbenchDownstreamIssueKey;
  consumes: readonly CatalogPrimaryWorkbenchSectionKey[];
  requiredFields: readonly string[];
}>;

type CatalogPrimaryWorkbenchReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchRouteContext = Readonly<{
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
  /**
   * The explicit promote-as-draft review choice the current promotion preview
   * was generated under. Absent means false; changing it invalidates the
   * preview, so execution always re-confirms against the submitted choice.
   */
  promoteAsDraft?: boolean;
  /** Canonical Scope Record identity for scope-first routes. */
  scopeRecordId?: string | null;
  returnPath: string | null;
}>;

type CatalogPrimaryWorkbenchScopeContext = Readonly<{
  providerKey: string | null;
  productId: string | null;
  languageCode: string | null;
  productLineId: string | null;
  productLineName: string | null;
  seriesId: string | null;
  seriesName: string | null;
  expansionId: string | null;
  expansionName: string | null;
  status: string | null;
}>;

type CatalogPrimaryWorkbenchProviderScopeReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchSourceOptionsStatus = "ready" | "degraded" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchSourceOptionPageState =
  | "live"
  | "cached"
  | "stale"
  | "unavailable"
  | "rollout-blocked"
  | "not-requested";

type CatalogPrimaryWorkbenchSourceOptionKindReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchSourceOptionPageReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchSourceOptionsReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchCatalogSyncStatus = "scope-required" | "ready" | "blocked" | "degraded";

type CatalogPrimaryWorkbenchCatalogSyncReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchCatalogSyncUnitReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchSourceScopeWorksetStatus =
  | "not-configured"
  | "scope-required"
  | "ready"
  | "blocked"
  | "degraded";

type CatalogPrimaryWorkbenchSourceScopeWorksetUnitState =
  | "not-imported"
  | "imported"
  | "changed"
  | "promoted"
  | "blocked";

type CatalogPrimaryWorkbenchSourceScopeWorksetReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel = Readonly<{
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
    productId: string | null;
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

type CatalogPrimaryWorkbenchReadinessReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[];
  rolloutEnabled: boolean;
  rbacAllowed: boolean;
  auditEvidenceUrl: string | null;
}>;

type CatalogPrimaryWorkbenchHealthTriageStatus = "ready" | "degraded" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchHealthTriageReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchHealthTriageReadModelState = Readonly<{
  queryKey: CatalogAdminControlPlaneQueryKey;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string | null;
  statusMessage: string;
  ownerMetricKey: string;
}>;

type CatalogPrimaryWorkbenchHealthTriageUnit = Readonly<{
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

type CatalogPrimaryWorkbenchHealthTriageProvider = Readonly<{
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
  usageBudget: CatalogIntegrationProviderUsageBudget | null;
  countSpend?: readonly import("../../../scope-sync-batches/domain/count-acquisition").CountSpend[];
  diagnosticCodes: readonly string[];
  latestDiagnosticText: string | null;
  ownerMetricKey: string;
  nextAction: string;
}>;

type CatalogPrimaryWorkbenchValidationReadinessStatus = "ready" | "degraded" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchValidationFixtureFlowStatus = "ready" | "warning" | "blocked" | "not-covered";

type CatalogPrimaryWorkbenchValidationReadinessReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchValidationEvidenceRow = Readonly<{
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

type CatalogPrimaryWorkbenchLifecycleOperation = CatalogAdminRollbackRetirementImpactSummaryReadModel["operation"];

type CatalogPrimaryWorkbenchLifecycleRecoveryStatus = "ready" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchLifecycleRecoveryReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchLifecycleOperationReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchGovernanceControlsStatus = "ready" | "degraded" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchGovernanceControlKind =
  | "staged-rollout"
  | "provider-emergency-stop"
  | "import-kill-switch"
  | "promotion-kill-switch"
  | "reapply-kill-switch"
  | "worker-pause"
  | "legacy-removal";

type CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey =
  | "option-query-latency"
  | "job-failure-rate"
  | "projection-freshness"
  | "source-observation-quarantine"
  | "data-quarantine"
  | "conflict-spike";

type CatalogPrimaryWorkbenchGovernanceControlsReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchAuditEvidenceStatus = "ready" | "partial" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchAuditEvidenceFilterKey =
  | "provider"
  | "unit"
  | "profile-version"
  | "job"
  | "observation"
  | "action-category"
  | "actor"
  | "time";

type CatalogPrimaryWorkbenchAuditEvidenceTargetType =
  | "provider-profile"
  | "import-job"
  | "source-observation"
  | "catalog-item"
  | "control-plane";

type CatalogPrimaryWorkbenchAuditEvidenceReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchAuditEvidenceLink = Readonly<{
  key: string;
  label: string;
  href: string;
  kind: "audit-event" | "diagnostic" | "proof" | "runbook" | "test";
  summary: string;
  redactionState: CatalogIntegrationAuditEvidenceRedactionState;
  sourcePayloadAccess: "not-required";
  profileSnapshotAccess: "not-required";
}>;

type CatalogPrimaryWorkbenchHealthTriageRolloutControl = Readonly<{
  controlId: string;
  status: "open" | "degraded" | "blocked";
  severity: "info" | "warning" | "error";
  metricKey: string;
  message: string;
  providerKeys: readonly string[];
  unitKeys: readonly string[];
  nextAction: string;
}>;

type CatalogPrimaryWorkbenchHealthTriageJob = Readonly<{
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

type CatalogPrimaryWorkbenchHealthTriageAuditPreview = Readonly<{
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

type CatalogPrimaryWorkbenchProfileAuthoringStatus = "ready" | "missing-profile" | "stale-selection";

type CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode =
  | "draft-editable"
  | "test-editable"
  | "active-clone-required"
  | "deprecated-clone-required"
  | "retired-read-only"
  | "missing-profile"
  | "stale-selection";

type CatalogPrimaryWorkbenchProfileImmutableFactKey =
  | "provider-key"
  | "profile-key"
  | "source-contract-owner"
  | "source-contract-repository"
  | "connector-kind"
  | "supported-scopes";

type CatalogPrimaryWorkbenchProfileImmutableFact = Readonly<{
  key: CatalogPrimaryWorkbenchProfileImmutableFactKey;
  label: string;
  value: string;
}>;

type CatalogPrimaryWorkbenchProfileLifecycleRestriction = Readonly<{
  code: CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode;
  label: string;
  description: string;
  severity: "info" | "warning" | "blocked";
}>;

type CatalogPrimaryWorkbenchProfileOption = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  lifecycle: string;
  active: boolean;
  status: string;
  href: string;
}>;

type CatalogPrimaryWorkbenchProfileOverview = Readonly<{
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

type CatalogPrimaryWorkbenchProfileSectionGroupKey =
  | "profile-foundation"
  | "provider-acquisition"
  | "observation-mapping"
  | "catalog-promotion"
  | "evidence-lifecycle";

type CatalogPrimaryWorkbenchProfileSectionSaveOutcome = "not-submitted" | "saved" | "conflict" | "invalid" | "failed";

type CatalogPrimaryWorkbenchProfileSectionFieldControl = "text" | "textarea" | "select" | "checkbox" | "tags";

type CatalogPrimaryWorkbenchProfileSectionField = Readonly<{
  key: string;
  label: string;
  value: string;
  control: CatalogPrimaryWorkbenchProfileSectionFieldControl;
  required: boolean;
  disabled: boolean;
  helpText: string | null;
  options: readonly Readonly<{ value: string; label: string }>[];
}>;

type CatalogPrimaryWorkbenchProfileOptionQueryDetail = Readonly<{
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

type CatalogPrimaryWorkbenchProfileImportScopeControl = Readonly<{
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

type CatalogPrimaryWorkbenchProfileMappingRow = Readonly<{
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

type CatalogPrimaryWorkbenchProfileSectionWorkspace = Readonly<{
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

type CatalogPrimaryWorkbenchProfileCloneDraftReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchProfileAuthoringReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchImportJobsReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchSourceObservationReviewReadModel = Readonly<{
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
type CatalogPrimaryWorkbenchSourceObservationReviewRow = Readonly<{
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
type CatalogPrimaryWorkbenchSourceObservationEvidenceDetail = Readonly<{
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

type CatalogPrimaryWorkbenchProductContentsEvidenceState =
  | "none"
  | "reviewable"
  | "unresolved"
  | "promoted"
  | "rejected";

type CatalogPrimaryWorkbenchProductContentsEvidenceReview = Readonly<{
  state: CatalogPrimaryWorkbenchProductContentsEvidenceState;
  summary: string;
  lineCount: number;
  rows: readonly CatalogPrimaryWorkbenchProductContentsEvidenceLine[];
}>;

type CatalogPrimaryWorkbenchProductContentsEvidenceLine = Readonly<{
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
type CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData = Readonly<{
  observationId: string;
  detail: CatalogPrimaryWorkbenchSourceObservationEvidenceDetail | null;
}>;

type CatalogPrimaryWorkbenchMergeCandidateActionKey = Extract<
  CatalogPrimaryWorkbenchCommandKey,
  "candidate.promote" | "candidate.split" | "candidate.edit" | "candidate.ignore" | "candidate.defer"
>;

type CatalogPrimaryWorkbenchMergeCandidateReviewReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchMergeCandidateReviewRow = Readonly<{
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

type CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride = Readonly<{
  key: string;
  fieldPath: string;
  label: string;
  value: string;
}>;

type CatalogPrimaryWorkbenchMergeCandidateEditReference = Readonly<{
  index: number;
  label: string;
}>;

type CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchConflictResolutionStatus = "ready" | "empty" | "blocked" | "unavailable";

type CatalogPrimaryWorkbenchConflictResolutionState = "blocks-promotion" | "requires-review" | "auto-resolved";

type CatalogPrimaryWorkbenchConflictResolutionReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchConflictResolutionRow = Readonly<{
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

/**
 * Read-only pre-write validation carried by the current promotion preview.
 * `coverage: "not-previewed"` means no preview token is in play; `"partial"`
 * means only the first `coveredCount` eligible observations (id order) were
 * validated and the rest are validated at execution, never called safe here.
 */
type CatalogPrimaryWorkbenchPromotionValidationReadModel = Readonly<{
  promoteAsDraft: boolean;
  coverage: "complete" | "partial" | "not-previewed";
  coveredCount: number;
  continuation: string | null;
  identityDiagnostics: readonly CatalogPrimaryWorkbenchPromotionIdentityDiagnostic[];
  otherBlockedObservationIds: readonly string[];
}>;

type CatalogPrimaryWorkbenchPromotionIdentityDiagnostic = Readonly<{
  observationId: string;
  /** False only for the degraded identity an explicit draft choice carries visibly. */
  blocking: boolean;
  templateReason: "unresolved-title-tokens" | "no-targeted-template" | "missing-required-fields";
  diagnosticText: string;
  missingTokens: readonly string[];
  templateKey: string | null;
}>;

type CatalogPrimaryWorkbenchPromotionPreviewReadModel = Readonly<{
  previewId: string | null;
  validation: CatalogPrimaryWorkbenchPromotionValidationReadModel;
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

type CatalogPrimaryWorkbenchPromotionResultReadModel = Readonly<{
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

type CatalogPrimaryWorkbenchActionReadModel = Readonly<{
  key: CatalogPrimaryWorkbenchCommandKey;
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  copyKey: CatalogPrimaryWorkbenchCopyKey | null;
}>;

type CatalogPrimaryWorkbenchSecurityPrivacyReadModel = Readonly<{
  redactionApplied: boolean;
  governedDataClasses: readonly string[];
  unsafeEvidenceBlocked: boolean;
  missingSecurityFieldsBlocker: Extract<CatalogPrimaryWorkbenchBlockerCategory, "security-privacy-blocked">;
}>;

type CatalogPrimaryWorkbenchInstrumentationReadModel = Readonly<{
  dimensions: readonly CatalogPrimaryWorkbenchInstrumentationDimension[];
  redactionSafe: boolean;
}>;

export {
  catalogPrimaryWorkbenchContractVersion,
  CatalogPrimaryWorkbenchContractVersion,
  CatalogPrimaryWorkbenchSectionKey,
  CatalogPrimaryWorkbenchCommandKey,
  CatalogPrimaryWorkbenchSourceObservationRowActionKey,
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchProviderTransportCategory,
  catalogPrimaryWorkbenchProviderTransportCategories,
  CatalogPrimaryWorkbenchPromotionDisposition,
  CatalogPrimaryWorkbenchPromotionScopeKind,
  CatalogPrimaryWorkbenchPromotionOutcomeCountKey,
  CatalogPrimaryWorkbenchPromotionStaleProtectionKey,
  CatalogPrimaryWorkbenchPromotionProfileSemantics,
  CatalogPrimaryWorkbenchRouteContextKey,
  catalogPrimaryWorkbenchRouteSections,
  CatalogPrimaryWorkbenchCopyKey,
  CatalogPrimaryWorkbenchInstrumentationDimension,
  CatalogPrimaryWorkbenchDeploySkewMode,
  CatalogPrimaryWorkbenchDeploySkewPolicy,
  CatalogPrimaryWorkbenchRetirementPolicy,
  CatalogPrimaryWorkbenchBlockerContract,
  CatalogPrimaryWorkbenchSectionContract,
  CatalogPrimaryWorkbenchActionContract,
  CatalogPrimaryWorkbenchDownstreamIssueKey,
  CatalogPrimaryWorkbenchDownstreamContract,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchScopeContext,
  CatalogPrimaryWorkbenchProviderScopeReadModel,
  CatalogPrimaryWorkbenchSourceOptionsStatus,
  CatalogPrimaryWorkbenchSourceOptionPageState,
  CatalogPrimaryWorkbenchSourceOptionKindReadModel,
  CatalogPrimaryWorkbenchSourceOptionPageReadModel,
  CatalogPrimaryWorkbenchSourceOptionsReadModel,
  CatalogPrimaryWorkbenchCatalogSyncStatus,
  CatalogPrimaryWorkbenchCatalogSyncReadModel,
  CatalogPrimaryWorkbenchCatalogSyncUnitReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetStatus,
  CatalogPrimaryWorkbenchSourceScopeWorksetUnitState,
  CatalogPrimaryWorkbenchSourceScopeWorksetReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel,
  CatalogPrimaryWorkbenchReadinessReadModel,
  CatalogPrimaryWorkbenchHealthTriageStatus,
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchHealthTriageReadModelState,
  CatalogPrimaryWorkbenchHealthTriageUnit,
  CatalogPrimaryWorkbenchHealthTriageProvider,
  CatalogPrimaryWorkbenchValidationReadinessStatus,
  CatalogPrimaryWorkbenchValidationFixtureFlowStatus,
  CatalogPrimaryWorkbenchValidationReadinessReadModel,
  CatalogPrimaryWorkbenchValidationEvidenceRow,
  CatalogPrimaryWorkbenchLifecycleOperation,
  CatalogPrimaryWorkbenchLifecycleRecoveryStatus,
  CatalogPrimaryWorkbenchLifecycleRecoveryReadModel,
  CatalogPrimaryWorkbenchLifecycleOperationReadModel,
  CatalogPrimaryWorkbenchGovernanceControlsStatus,
  CatalogPrimaryWorkbenchGovernanceControlKind,
  CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey,
  CatalogPrimaryWorkbenchGovernanceControlsReadModel,
  CatalogPrimaryWorkbenchAuditEvidenceStatus,
  CatalogPrimaryWorkbenchAuditEvidenceFilterKey,
  CatalogPrimaryWorkbenchAuditEvidenceTargetType,
  CatalogPrimaryWorkbenchAuditEvidenceReadModel,
  CatalogPrimaryWorkbenchAuditEvidenceLink,
  CatalogPrimaryWorkbenchHealthTriageRolloutControl,
  CatalogPrimaryWorkbenchHealthTriageJob,
  CatalogPrimaryWorkbenchHealthTriageAuditPreview,
  CatalogPrimaryWorkbenchProfileAuthoringStatus,
  CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode,
  CatalogPrimaryWorkbenchProfileImmutableFactKey,
  CatalogPrimaryWorkbenchProfileImmutableFact,
  CatalogPrimaryWorkbenchProfileLifecycleRestriction,
  CatalogPrimaryWorkbenchProfileOption,
  CatalogPrimaryWorkbenchProfileOverview,
  CatalogPrimaryWorkbenchProfileSectionGroupKey,
  CatalogPrimaryWorkbenchProfileSectionSaveOutcome,
  CatalogPrimaryWorkbenchProfileSectionFieldControl,
  CatalogPrimaryWorkbenchProfileSectionField,
  CatalogPrimaryWorkbenchProfileOptionQueryDetail,
  CatalogPrimaryWorkbenchProfileImportScopeControl,
  CatalogPrimaryWorkbenchProfileMappingRow,
  CatalogPrimaryWorkbenchProfileSectionWorkspace,
  CatalogPrimaryWorkbenchProfileCloneDraftReadModel,
  CatalogPrimaryWorkbenchProfileAuthoringReadModel,
  CatalogPrimaryWorkbenchImportJobsReadModel,
  CatalogPrimaryWorkbenchSourceObservationReviewReadModel,
  CatalogPrimaryWorkbenchSourceObservationReviewRow,
  CatalogPrimaryWorkbenchSourceObservationEvidenceDetail,
  CatalogPrimaryWorkbenchProductContentsEvidenceState,
  CatalogPrimaryWorkbenchProductContentsEvidenceReview,
  CatalogPrimaryWorkbenchProductContentsEvidenceLine,
  CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData,
  CatalogPrimaryWorkbenchMergeCandidateActionKey,
  CatalogPrimaryWorkbenchMergeCandidateReviewReadModel,
  CatalogPrimaryWorkbenchMergeCandidateReviewRow,
  CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride,
  CatalogPrimaryWorkbenchMergeCandidateEditReference,
  CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel,
  CatalogPrimaryWorkbenchConflictResolutionStatus,
  CatalogPrimaryWorkbenchConflictResolutionState,
  CatalogPrimaryWorkbenchConflictResolutionReadModel,
  CatalogPrimaryWorkbenchConflictResolutionRow,
  CatalogPrimaryWorkbenchPromotionValidationReadModel,
  CatalogPrimaryWorkbenchPromotionIdentityDiagnostic,
  CatalogPrimaryWorkbenchPromotionPreviewReadModel,
  CatalogPrimaryWorkbenchPromotionResultReadModel,
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchSecurityPrivacyReadModel,
  CatalogPrimaryWorkbenchInstrumentationReadModel,
};
