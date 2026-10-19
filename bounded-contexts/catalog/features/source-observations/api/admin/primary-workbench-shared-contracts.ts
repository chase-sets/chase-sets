import type {
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchScopeContext,
  CatalogPrimaryWorkbenchSourceOptionsReadModel,
} from "./primary-workbench-selection-contracts";
import type {
  CatalogPrimaryWorkbenchImportJobsReadModel,
  CatalogPrimaryWorkbenchValidationReadinessReadModel,
  CatalogPrimaryWorkbenchProfileAuthoringReadModel,
} from "./primary-workbench-profile-readiness-contracts";
import type { CatalogPrimaryWorkbenchSourceScopeWorksetReadModel } from "./primary-workbench-import-sync-contracts";
import type {
  CatalogPrimaryWorkbenchConflictResolutionReadModel,
  CatalogPrimaryWorkbenchPromotionPreviewReadModel,
  CatalogPrimaryWorkbenchMergeCandidateReviewReadModel,
  CatalogPrimaryWorkbenchPromotionResultReadModel,
} from "./primary-workbench-promotion-review-contracts";
import type {
  CatalogPrimaryWorkbenchGovernanceControlsReadModel,
  CatalogPrimaryWorkbenchAuditEvidenceReadModel,
  CatalogPrimaryWorkbenchLifecycleRecoveryReadModel,
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchAuditEvidenceLink,
} from "./primary-workbench-lifecycle-governance-contracts";
import { catalogPrimaryWorkbenchBlockers } from "./primary-workbench-contract-descriptors";
import type {
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
} from "./primary-workbench-selection-contracts";
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
