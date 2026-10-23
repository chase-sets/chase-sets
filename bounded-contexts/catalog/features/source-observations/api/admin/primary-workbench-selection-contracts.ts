import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogAdminControlPlaneFreshnessState } from "./admin-control-plane-read-model-slos";
import type { CatalogAdminProfileVersionPointer } from "./admin-control-plane-read-model-contracts";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type {
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "./primary-workbench-shared-contracts";
import {
  assertCatalogPrimaryWorkbenchActionState,
  isSafePrimaryWorkbenchReturnPath,
  assertPrimaryWorkbenchBlockers,
} from "./primary-workbench-shared-contracts";

export const catalogPrimaryWorkbenchContractVersion = "catalog-primary-workbench-v2" as const;

export type CatalogPrimaryWorkbenchContractVersion = typeof catalogPrimaryWorkbenchContractVersion;

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

export type CatalogPrimaryWorkbenchScopeContext = Readonly<{
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

function validatePrimaryWorkbenchScopeContext(scope: CatalogPrimaryWorkbenchScopeContext): void {
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
