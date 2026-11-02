import type { CatalogControlPlaneActionId } from "../../ui/admin-control-plane/information-architecture-v2";
import type { CatalogPrimaryWorkbenchDeploySkewPolicy } from "./primary-workbench-contract-descriptors";
import type {
  CatalogPrimaryWorkbenchContractVersion,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchProviderScopeReadModel,
  CatalogPrimaryWorkbenchSourceOptionsReadModel,
} from "./primary-workbench-selection-contracts";
import type {
  CatalogPrimaryWorkbenchCatalogSyncReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetReadModel,
  CatalogPrimaryWorkbenchImportJobsReadModel,
} from "./primary-workbench-import-sync-contracts";
import type {
  CatalogPrimaryWorkbenchSourceObservationReviewReadModel,
  CatalogPrimaryWorkbenchMergeCandidateReviewReadModel,
  CatalogPrimaryWorkbenchConflictResolutionReadModel,
  CatalogPrimaryWorkbenchPromotionPreviewReadModel,
  CatalogPrimaryWorkbenchPromotionResultReadModel,
} from "./primary-workbench-promotion-review-contracts";
import type {
  CatalogPrimaryWorkbenchReadinessReadModel,
  CatalogPrimaryWorkbenchValidationReadinessReadModel,
  CatalogPrimaryWorkbenchProfileAuthoringReadModel,
} from "./primary-workbench-profile-readiness-contracts";
import type {
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchLifecycleRecoveryReadModel,
  CatalogPrimaryWorkbenchGovernanceControlsReadModel,
  CatalogPrimaryWorkbenchAuditEvidenceReadModel,
} from "./primary-workbench-lifecycle-governance-contracts";
import { catalogPrimaryWorkbenchBlockers } from "./primary-workbench-contract-descriptors";

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
  | "display-identity-unresolvable"
  | "stale-replay"
  | "idempotency-replay"
  | "security-privacy-blocked"
  | "unsupported-command"
  | "deploy-skew-unsupported-version"
  | "raw-json-retired"
  | "legacy-selector-retired";

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

export function isSafePrimaryWorkbenchReturnPath(path: string): boolean {
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

export function isSafePrimaryWorkbenchObservabilityLink(path: string): boolean {
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

export function assertPrimaryWorkbenchBlockers(blockers: readonly string[] | undefined): void {
  for (const blockerEntry of blockers ?? []) {
    assertCatalogPrimaryWorkbenchBlockerCategory(blockerEntry);
  }
}
