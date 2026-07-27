import type { CatalogAdminControlPlaneQueryKey } from "../admin/admin-control-plane-read-model-contracts";
import {
  getCatalogAdminControlPlaneReadModelSlo,
  type CatalogAdminControlPlanePaginationMode,
  type CatalogAdminControlPlanePerformanceCheckKind,
} from "../admin/admin-control-plane-read-model-slos";
import { defineCatalogIntegrationUnitKey } from "./integration-unit";
import {
  catalogPrimaryWorkbenchBlockers,
  catalogPrimaryWorkbenchProviderTransportCategories,
  type CatalogPrimaryWorkbenchActionState,
  type CatalogPrimaryWorkbenchBlockerCategory,
  type CatalogPrimaryWorkbenchProviderTransportCategory,
} from "../admin/primary-workbench-admin-contracts";

export const catalogProviderTransportBudgetDocPath =
  "bounded-contexts/catalog/docs/catalog-integration-provider-transport-budgets.md" as const;

export const catalogProviderTransportFirstSliceUnitKey = defineCatalogIntegrationUnitKey({
  providerKey: "tcgdex",
  productDomain: "pokemon",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export const catalogProviderTransportSupplementalTcgplayerUnitKey = defineCatalogIntegrationUnitKey({
  providerKey: "tcgplayer",
  productDomain: "pokemon",
  productForm: "single-card",
  ingestionPurpose: "source-observation-import",
});

export type CatalogProviderTransportFailureConditionKey =
  | CatalogPrimaryWorkbenchProviderTransportCategory
  | "backpressure"
  | "retryable-provider-error"
  | "permanent-provider-error";

export type CatalogProviderTransportBudgetSurfaceKey =
  | "primary-workbench-initial-load"
  | "provider-scope-selector"
  | "source-observation-review-table"
  | "promotion-preview"
  | "durable-job-progress"
  | "real-provider-proof-run";

export type CatalogProviderTransportVerificationKind =
  | CatalogAdminControlPlanePerformanceCheckKind
  | "e2e"
  | "real-provider-proof"
  | "docs-review";

export type CatalogProviderTransportFailureCondition = Readonly<{
  condition: CatalogProviderTransportFailureConditionKey;
  transportCategory: CatalogPrimaryWorkbenchProviderTransportCategory;
  blockerCategory: Extract<CatalogPrimaryWorkbenchBlockerCategory, `provider-transport-${string}`>;
  actionState: Extract<CatalogPrimaryWorkbenchActionState, "blocked" | "degraded">;
  firstSliceRequired: boolean;
  adapterEvidence: readonly string[];
  operatorState: string;
}>;

export type CatalogProviderTransportOptionQueryCacheBudget = Readonly<{
  freshTtlSeconds: number;
  staleTtlSeconds: number;
  defaultPageSize: number;
  maxPageSize: number;
  degradedFallback: "stale-cache-or-blocked";
}>;

export type CatalogProviderTransportPerformanceBudget = Readonly<{
  surface: CatalogProviderTransportBudgetSurfaceKey;
  primaryPathRole: string;
  queryKeys: readonly CatalogAdminControlPlaneQueryKey[];
  p95Ms: number;
  timeoutMs: number;
  freshWithinSeconds: number;
  staleAfterSeconds: number;
  unavailableAfterSeconds: number;
  pagination: Readonly<{
    mode: CatalogAdminControlPlanePaginationMode;
    defaultLimit: number | null;
    maxLimit: number | null;
    representativeRows: number;
  }>;
  optionQueryCache?: CatalogProviderTransportOptionQueryCacheBudget;
  highVolume: boolean;
  verification: readonly CatalogProviderTransportVerificationKind[];
  exitEvidence: string;
}>;

export const catalogProviderTransportFailureConditions = [
  failureCondition("rate-limit", "rate-limit", "provider-transport-rate-limited", "degraded", [
    "HTTP 429",
    "provider Retry-After or cooldown seconds",
  ]),
  failureCondition("throttle", "throttle", "provider-transport-throttled", "degraded", [
    "adapter cooldown",
    "provider throttling diagnostic",
  ]),
  failureCondition("quota", "quota", "provider-transport-quota-exceeded", "blocked", [
    "provider quota exhausted",
    "operator must wait or change credentials",
  ]),
  failureCondition("timeout", "timeout", "provider-transport-timeout", "degraded", [
    "HTTP 504",
    "request timeout or abort diagnostic",
  ]),
  failureCondition("pagination-failure", "pagination-failure", "provider-transport-pagination-failure", "blocked", [
    "cursor rejected",
    "provider page boundary failed",
  ]),
  failureCondition("partial-data", "partial-data", "provider-transport-partial-data", "degraded", [
    "one or more payloads failed while the job can keep safe rows",
    "partial failure group",
  ]),
  failureCondition("stale-cache", "stale-cache", "provider-transport-stale-cache", "degraded", [
    "option query served stale cache",
    "cache-only degraded mode",
  ]),
  failureCondition("degraded-provider", "degraded-provider", "provider-transport-degraded", "degraded", [
    "provider unavailable",
    "transport diagnostic without a narrower category",
  ]),
  failureCondition("backpressure", "throttle", "provider-transport-throttled", "degraded", [
    "durable worker backpressure",
    "adapter cooldown before another provider call",
  ]),
  failureCondition("retryable-provider-error", "degraded-provider", "provider-transport-degraded", "degraded", [
    "HTTP 502 or 503",
    "retryable provider status",
  ]),
  failureCondition("permanent-provider-error", "degraded-provider", "provider-transport-degraded", "blocked", [
    "provider contract changed",
    "non-retryable payload parse failure",
  ]),
] as const satisfies readonly CatalogProviderTransportFailureCondition[];

export const catalogProviderTransportFirstSliceBudgets = [
  {
    surface: "primary-workbench-initial-load",
    primaryPathRole:
      "Open the rebuilt workbench directly on provider import, Source Observation review, and promotion.",
    queryKeys: [
      "integration-health-summary",
      "provider-transport-readiness-summary",
      "active-profile-version-summary",
      "import-job-progress-summary",
    ],
    p95Ms: 750,
    timeoutMs: 5_000,
    freshWithinSeconds: 15,
    staleAfterSeconds: 60,
    unavailableAfterSeconds: 300,
    pagination: { mode: "none", defaultLimit: null, maxLimit: null, representativeRows: 10_000 },
    highVolume: false,
    verification: ["smoke", "e2e"],
    exitEvidence: "The workbench shell renders selected provider, readiness, active job status, and review handoff.",
  },
  budgetFromSlo({
    surface: "provider-scope-selector",
    primaryPathRole: "Keep provider import scope selection front and center without repeated live dropdown calls.",
    queryKey: "provider-transport-readiness-summary",
    representativeRows: 10,
    verification: ["unit-test", "smoke"],
    exitEvidence: "Provider selector proves bounded readiness plus cached option queries before import starts.",
    optionQueryCache: {
      freshTtlSeconds: 900,
      staleTtlSeconds: 86_400,
      defaultPageSize: 50,
      maxPageSize: 200,
      degradedFallback: "stale-cache-or-blocked",
    },
  }),
  budgetFromSlo({
    surface: "source-observation-review-table",
    primaryPathRole: "Review provider-fed Source Observations at high volume before promotion.",
    queryKey: "source-observation-review-query",
    representativeRows: 100_000,
    verification: ["unit-test", "explain-plan", "load-sample"],
    exitEvidence: "Review list keeps provider/profile/status/time filters server-side and uses cursor paging.",
  }),
  budgetFromSlo({
    surface: "promotion-preview",
    primaryPathRole: "Preview promotion counts and command plans before any Catalog write.",
    queryKey: "promotion-plan-preview",
    representativeRows: 50_000,
    verification: ["unit-test", "explain-plan", "load-sample"],
    exitEvidence: "Promotion preview returns counts first and pages command/evidence detail without broad scans.",
  }),
  budgetFromSlo({
    surface: "durable-job-progress",
    primaryPathRole: "Keep import progress visible across retry, resume, cancellation, and deploy transitions.",
    queryKey: "import-job-progress-summary",
    representativeRows: 10_000,
    verification: ["smoke", "load-sample"],
    exitEvidence: "Job progress uses bounded replay by job id and sequence with stale/lagging states.",
  }),
  {
    surface: "real-provider-proof-run",
    primaryPathRole:
      "Run the selected TCGdex provider proof from import through review and promotion preview evidence.",
    queryKeys: [
      "provider-transport-readiness-summary",
      "import-job-progress-summary",
      "source-observation-review-query",
      "promotion-plan-preview",
    ],
    p95Ms: 900_000,
    timeoutMs: 1_200_000,
    freshWithinSeconds: 15,
    staleAfterSeconds: 90,
    unavailableAfterSeconds: 300,
    pagination: { mode: "cursor", defaultLimit: 100, maxLimit: 500, representativeRows: 50_000 },
    highVolume: true,
    verification: ["real-provider-proof", "smoke", "load-sample", "docs-review"],
    exitEvidence:
      "The real-provider proof packet links selected provider scope, transport diagnostics, Source Observation rows, and promotion preview counts.",
  },
] as const satisfies readonly CatalogProviderTransportPerformanceBudget[];

export function assertCatalogProviderTransportBudgetsAreValid(): void {
  const blockerCategories = new Set(catalogPrimaryWorkbenchBlockers.map((blocker) => blocker.category));

  for (const category of catalogPrimaryWorkbenchProviderTransportCategories) {
    const condition = catalogProviderTransportFailureConditions.find(
      (entry) => entry.condition === category && entry.transportCategory === category,
    );
    if (!condition) {
      throw new Error(`Missing provider transport failure condition for '${category}'.`);
    }
    if (!blockerCategories.has(condition.blockerCategory)) {
      throw new Error(`Provider transport condition '${category}' maps to an unknown blocker.`);
    }
  }

  for (const condition of catalogProviderTransportFailureConditions) {
    if (!blockerCategories.has(condition.blockerCategory)) {
      throw new Error(`Provider transport condition '${condition.condition}' maps to an unknown blocker.`);
    }
    if (condition.adapterEvidence.length === 0) {
      throw new Error(`Provider transport condition '${condition.condition}' needs adapter evidence.`);
    }
  }

  for (const budget of catalogProviderTransportFirstSliceBudgets) {
    if (budget.p95Ms <= 0 || budget.timeoutMs < budget.p95Ms) {
      throw new Error(`Invalid provider transport latency budget for '${budget.surface}'.`);
    }
    if (
      budget.freshWithinSeconds > budget.staleAfterSeconds ||
      budget.staleAfterSeconds > budget.unavailableAfterSeconds
    ) {
      throw new Error(`Invalid provider transport freshness budget for '${budget.surface}'.`);
    }
    if (
      budget.pagination.defaultLimit !== null &&
      budget.pagination.maxLimit !== null &&
      budget.pagination.defaultLimit > budget.pagination.maxLimit
    ) {
      throw new Error(`Invalid provider transport page limit budget for '${budget.surface}'.`);
    }
    if (budget.highVolume && !budget.verification.some((kind) => kind === "explain-plan" || kind === "load-sample")) {
      throw new Error(`High-volume provider transport budget '${budget.surface}' needs query-plan evidence.`);
    }
  }
}

function failureCondition(
  condition: CatalogProviderTransportFailureConditionKey,
  transportCategory: CatalogPrimaryWorkbenchProviderTransportCategory,
  blockerCategory: Extract<CatalogPrimaryWorkbenchBlockerCategory, `provider-transport-${string}`>,
  actionState: Extract<CatalogPrimaryWorkbenchActionState, "blocked" | "degraded">,
  adapterEvidence: readonly string[],
): CatalogProviderTransportFailureCondition {
  return {
    condition,
    transportCategory,
    blockerCategory,
    actionState,
    firstSliceRequired: true,
    adapterEvidence,
    operatorState:
      actionState === "blocked"
        ? "Block the affected import or promotion workflow until safe evidence is available."
        : "Show degraded transport state, preserve operator context, and allow only safe retries or cached reads.",
  };
}

function budgetFromSlo(input: {
  surface: CatalogProviderTransportBudgetSurfaceKey;
  primaryPathRole: string;
  queryKey: CatalogAdminControlPlaneQueryKey;
  representativeRows: number;
  verification: readonly CatalogProviderTransportVerificationKind[];
  exitEvidence: string;
  optionQueryCache?: CatalogProviderTransportOptionQueryCacheBudget;
}): CatalogProviderTransportPerformanceBudget {
  const slo = getCatalogAdminControlPlaneReadModelSlo(input.queryKey);

  return {
    surface: input.surface,
    primaryPathRole: input.primaryPathRole,
    queryKeys: [input.queryKey],
    p95Ms: slo.latency.p95Ms,
    timeoutMs: slo.latency.timeoutMs,
    freshWithinSeconds: slo.freshness.freshWithinSeconds,
    staleAfterSeconds: slo.freshness.staleAfterSeconds,
    unavailableAfterSeconds: slo.freshness.unavailableAfterSeconds,
    pagination: {
      mode: slo.pagination.mode,
      defaultLimit: slo.pagination.defaultLimit,
      maxLimit: slo.pagination.maxLimit,
      representativeRows: input.representativeRows,
    },
    ...(input.optionQueryCache ? { optionQueryCache: input.optionQueryCache } : {}),
    highVolume: slo.highVolume,
    verification: input.verification,
    exitEvidence: input.exitEvidence,
  };
}
