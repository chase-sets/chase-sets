import {
  assertPrimaryWorkbenchBlockers,
  assertCatalogPrimaryWorkbenchActionState,
} from "./primary-workbench-shared-contracts";
import { isSafePrimaryWorkbenchReturnPath } from "./primary-workbench-shared-contracts";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogMergeCandidateReviewCommandPreview } from "../promotion/catalog-merge-candidate-review-command-payloads";
import type {
  CatalogAdminControlPlaneFreshnessState,
  CatalogAdminControlPlanePaginationMode,
  CatalogAdminControlPlaneQueryKey,
  CatalogAdminControlPlaneDiagnostic,
  CatalogAdminRollbackRetirementImpactSummaryReadModel,
  CatalogAdminJobConsistency,
  CatalogAdminProfileVersionPointer,
} from "./admin-control-plane-read-model-contracts";
import type {
  CatalogIntegrationAuditEvidenceCategory,
  CatalogIntegrationAuditEvidenceEventName,
  CatalogIntegrationAuditEvidenceRedactionState,
} from "../governance/catalog-integration-audit-evidence";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type { CatalogIntegrationProviderUsageBudget } from "./admin-control-plane-overview";
import type { CatalogProviderProfileEditableSectionKey } from "../providers/provider-profile-section-registry";
import type { CatalogControlPlaneActionId } from "../../ui/admin-control-plane/information-architecture-v2";
import type {
  CatalogPrimaryWorkbenchCatalogSyncStatus,
  CatalogPrimaryWorkbenchCatalogSyncReadModel,
  CatalogPrimaryWorkbenchCatalogSyncUnitReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetStatus,
  CatalogPrimaryWorkbenchSourceScopeWorksetUnitState,
  CatalogPrimaryWorkbenchSourceScopeWorksetReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel,
} from "./primary-workbench-import-sync-contracts";
import type {
  CatalogPrimaryWorkbenchReadinessReadModel,
  CatalogPrimaryWorkbenchHealthTriageStatus,
  CatalogPrimaryWorkbenchValidationFixtureFlowStatus,
  CatalogPrimaryWorkbenchValidationReadinessReadModel,
  CatalogPrimaryWorkbenchValidationEvidenceRow,
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
} from "./primary-workbench-profile-readiness-contracts";
import type {
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchHealthTriageReadModelState,
  CatalogPrimaryWorkbenchHealthTriageUnit,
  CatalogPrimaryWorkbenchHealthTriageProvider,
  CatalogPrimaryWorkbenchValidationReadinessStatus,
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
} from "./primary-workbench-lifecycle-governance-contracts";
import type {
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
} from "./primary-workbench-promotion-review-contracts";

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

export function validatePrimaryWorkbenchRouteContext(context: CatalogPrimaryWorkbenchRouteContext): void {
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

export function validatePrimaryWorkbenchScopeContext(scope: CatalogPrimaryWorkbenchScopeContext): void {
  for (const [key, value] of Object.entries(scope)) {
    if (
      ![
        "providerKey",
        "productId",
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

export function assertPrimaryWorkbenchSourceOptions(
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

export type {
  CatalogPrimaryWorkbenchContractVersion,
  CatalogPrimaryWorkbenchSectionKey,
  CatalogPrimaryWorkbenchCommandKey,
  CatalogPrimaryWorkbenchSourceObservationRowActionKey,
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchProviderTransportCategory,
  CatalogPrimaryWorkbenchPromotionDisposition,
  CatalogPrimaryWorkbenchPromotionScopeKind,
  CatalogPrimaryWorkbenchPromotionOutcomeCountKey,
  CatalogPrimaryWorkbenchPromotionStaleProtectionKey,
  CatalogPrimaryWorkbenchPromotionProfileSemantics,
  CatalogPrimaryWorkbenchRouteContextKey,
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
};
export {
  catalogPrimaryWorkbenchContractVersion,
  catalogPrimaryWorkbenchProviderTransportCategories,
  catalogPrimaryWorkbenchRouteSections,
};
