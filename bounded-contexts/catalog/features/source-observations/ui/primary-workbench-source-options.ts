import { t } from "@chase-sets/localization";
import type { CatalogAdminControlPlaneFreshnessState } from "../api/admin-control-plane-read-model-slos";
import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import type {
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationOptionResponse,
  SourceObservationIntegrationScope,
} from "./contracts";
import { parseCatalogPrimaryWorkbenchRouteContext } from "./primary-workbench-route-context";
import {
  actionStateForBlockers,
  importScopeMatchesProviderScope,
  profilePointerForProfile,
  scopeKey,
} from "./primary-workbench-read-model-support";

export type CatalogPrimaryWorkbenchSourceOptionRequest = Readonly<{
  providerKey: string;
  profileVersion: string;
  queryKind: string;
  displayName: string;
  scope: string;
  parentScope: string | null;
  parentRequired: boolean;
  parentDiagnosticText: string | null;
  selectedParentValue: string | null;
  selectedParentLabel: string | null;
  languageCode: string | null;
  parentValue: string | null;
  cursor: string | null;
  limit: number;
  cacheOnly: boolean;
  queryHref: string;
  refreshHref: string | null;
}>;

export type CatalogPrimaryWorkbenchSourceOptionPageSnapshot = Readonly<{
  request: CatalogPrimaryWorkbenchSourceOptionRequest;
  response?: SourceObservationIntegrationOptionResponse;
  error?: Readonly<{
    status: number | null;
    code: string;
    message: string;
    rolloutBlocked: boolean;
  }>;
}>;

const SOURCE_OPTION_PAGE_LIMIT = 25;
const SOURCE_OPTION_ROUTE = "/api/catalog/source-observations/integration-options";

export function buildCatalogPrimaryWorkbenchSourceOptions(input: {
  generatedAt: string;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  scopes: readonly SourceObservationIntegrationScope[];
  profiles: readonly CatalogProviderProfileVersionReview[];
  activeProfile: CatalogProviderProfileVersionReview | null;
  sourceOptionPages?: readonly CatalogPrimaryWorkbenchSourceOptionPageSnapshot[] | null;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  canManage: boolean;
}): CatalogPrimaryWorkbenchReadModel["sourceOptions"] {
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl: "https://admin.example/catalog/integrations",
    scopes: input.scopes,
    profiles: input.profiles,
    routeContext: input.routeContext,
    activeProfile: input.activeProfile,
    cacheOnly: true,
    limit: SOURCE_OPTION_PAGE_LIMIT,
  });
  const pageSnapshots = new Map(input.sourceOptionPages?.map((page) => [sourceOptionRequestKey(page.request), page]));
  const optionKinds = requests.map((request) => sourceOptionKindReadModel(request, input.activeProfile));
  const pages = requests.map((request) =>
    sourceOptionPageReadModel(request, pageSnapshots.get(sourceOptionRequestKey(request))),
  );
  const summary = sourceOptionSummary(pages);
  const refreshBlockers = sourceOptionRefreshBlockers(input, requests, pages);
  const status = sourceOptionsStatus(input.activeProfile, summary, input.readinessBlockers);

  return {
    status,
    freshness: sourceOptionsFreshness(status, summary),
    generatedAt: input.generatedAt,
    selectedProviderKey: input.routeContext.providerKey,
    selectedUnitKey: input.routeContext.unitKey,
    selectedProfile: profilePointerForProfile(input.activeProfile),
    summary,
    optionKinds,
    pages,
    refresh: {
      state: actionStateForBlockers(refreshBlockers, input.canManage ? "available" : "denied"),
      blockers: refreshBlockers,
      refreshAllHref: refreshBlockers.length === 0 ? sourceOptionRefreshAllHref(requests) : null,
      cacheOnly: true,
      forceRefreshSupported: true,
    },
  };
}

export function buildCatalogPrimaryWorkbenchSourceOptionRequests(input: {
  requestUrl: string | URL;
  scopes: readonly SourceObservationIntegrationScope[];
  profiles: readonly CatalogProviderProfileVersionReview[];
  routeContext?: CatalogPrimaryWorkbenchRouteContext | null;
  activeProfile?: CatalogProviderProfileVersionReview | null;
  cacheOnly?: boolean;
  limit?: number;
}): readonly CatalogPrimaryWorkbenchSourceOptionRequest[] {
  const context = sourceOptionContext(input);
  const profile = input.activeProfile ?? context.activeProfile;
  const providerKey = context.providerKey;
  if (!profile?.sourceOptionKinds.length || !providerKey) {
    return [];
  }

  const selections = sourceOptionSelections({
    providerKey,
    importScope: context.importScope,
    profile,
    scopes: input.scopes,
  });
  const limit = input.limit ?? SOURCE_OPTION_PAGE_LIMIT;
  return profile.sourceOptionKinds.map((kind) => {
    const parent = kind.parentScope ? (selections.get(kind.parentScope) ?? null) : null;
    const languageSelection = selections.get("language") ?? null;
    const languageCode = languageSelection?.value ?? profile.languageOptions[0] ?? "en";
    const parentValue = kind.parentScope === "language" ? null : (parent?.value ?? null);
    const request = {
      providerKey,
      profileVersion: profile.profileVersion,
      queryKind: kind.queryKind,
      displayName: kind.displayName,
      scope: kind.scope,
      parentScope: kind.parentScope,
      parentRequired: kind.parentRequired,
      parentDiagnosticText: kind.parentDiagnosticText,
      selectedParentValue: parent?.value ?? null,
      selectedParentLabel: parent?.label ?? null,
      languageCode,
      parentValue,
      cursor: null,
      limit,
      cacheOnly: input.cacheOnly ?? true,
    } satisfies Omit<CatalogPrimaryWorkbenchSourceOptionRequest, "queryHref" | "refreshHref">;

    return {
      ...request,
      queryHref: sourceOptionHref(request),
      refreshHref: sourceOptionHref({ ...request, cacheOnly: false, forceRefresh: true }),
    };
  });
}

function sourceOptionContext(input: {
  requestUrl: string | URL;
  scopes: readonly SourceObservationIntegrationScope[];
  profiles: readonly CatalogProviderProfileVersionReview[];
  routeContext?: CatalogPrimaryWorkbenchRouteContext | null;
}): Readonly<{
  providerKey: string | null;
  importScope: string | null;
  activeProfile: CatalogProviderProfileVersionReview | null;
}> {
  const parsed = input.routeContext ?? parseCatalogPrimaryWorkbenchRouteContext(input.requestUrl);
  const providerKey =
    parsed.providerKey ??
    input.scopes[0]?.provider_key ??
    input.profiles.find((profile) => profile.active)?.providerKey ??
    input.profiles[0]?.providerKey ??
    null;
  const activeProfile =
    input.profiles.find((profile) => profile.providerKey === providerKey && profile.active) ??
    input.profiles.find((profile) => profile.active) ??
    null;
  const representativeScope = input.scopes.find((scope) => !providerKey || scope.provider_key === providerKey) ?? null;
  const importScope = parsed.importScope ?? (representativeScope ? scopeKey(representativeScope) : null);

  return { providerKey, importScope, activeProfile };
}

function sourceOptionSelections(input: {
  providerKey: string;
  importScope: string | null;
  profile: CatalogProviderProfileVersionReview;
  scopes: readonly SourceObservationIntegrationScope[];
}): ReadonlyMap<string, Readonly<{ value: string; label: string }>> {
  const providerRows = input.scopes.filter((scope) => scope.provider_key === input.providerKey);
  const matchedRepresentative =
    providerRows.find((scope) => importScopeMatchesProviderScope(input.importScope, scope)) ?? null;
  const representative = matchedRepresentative ?? (input.importScope ? null : (providerRows[0] ?? null));
  const selections = new Map<string, Readonly<{ value: string; label: string }>>();
  addSelection(selections, "language", representative?.language_code, representative?.language_code);
  addSelection(selections, "product-line/category", representative?.product_line_id, representative?.product_line_name);
  addSelection(selections, "series", representative?.series_id, representative?.series_name);
  addSelection(
    selections,
    "expansion",
    representative?.expansion_id || representative?.expansion_name,
    representative?.expansion_name || representative?.expansion_id,
  );
  addSelection(
    selections,
    "set-name",
    representative?.expansion_name || representative?.expansion_id,
    representative?.expansion_name || representative?.expansion_id,
  );
  addSelection(
    selections,
    "product/card",
    representative ? scopeKey(representative) : null,
    representative?.expansion_name,
  );

  const segments = input.importScope
    ?.split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments?.[0] && !selections.has("language")) {
    addSelection(selections, "language", segments[0], segments[0]);
  }
  if (segments && segments.length >= 4) {
    addSelection(selections, "product-line/category", segments[1], segments[1]);
    addSelection(selections, "series", segments[2], segments[2]);
    addSelection(selections, "expansion", segments[3], segments[3]);
  }
  if (segments && segments.length === 2 && input.profile.supportedScopes.includes("series")) {
    addSelection(selections, "series", segments[1], segments[1]);
  }
  if (segments && segments.length >= 2 && input.profile.supportedScopes.includes("product-line/category")) {
    addSelection(selections, "product-line/category", segments[1], segments[1]);
  }
  if (segments && segments.length >= 3 && input.profile.supportedScopes.includes("set-name")) {
    addSelection(selections, "set-name", segments[2], segments[2]);
  }
  if (!selections.has("language")) {
    addSelection(
      selections,
      "language",
      input.profile.languageOptions[0] ?? "en",
      input.profile.languageOptions[0] ?? "en",
    );
  }

  return selections;
}

function addSelection(
  selections: Map<string, Readonly<{ value: string; label: string }>>,
  scope: string,
  value: string | null | undefined,
  label: string | null | undefined,
): void {
  const normalizedValue = value?.trim();
  if (!normalizedValue || selections.has(scope)) {
    return;
  }
  selections.set(scope, { value: normalizedValue, label: label?.trim() || normalizedValue });
}

function sourceOptionKindReadModel(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  profile: CatalogProviderProfileVersionReview | null,
): CatalogPrimaryWorkbenchReadModel["sourceOptions"]["optionKinds"][number] {
  const kind = profile?.sourceOptionKinds.find((candidate) => candidate.queryKind === request.queryKind);
  const missing = Boolean(kind?.parentRequired && kind.parentScope && !request.selectedParentValue);
  return {
    queryKind: request.queryKind,
    aliases: kind?.aliases ?? [],
    displayName: request.displayName,
    scope: request.scope,
    parentScope: request.parentScope,
    parent: {
      scope: request.parentScope,
      required: kind?.parentRequired ?? request.parentRequired,
      valueKind: kind?.parentValueKind ?? null,
      diagnosticText:
        kind?.parentDiagnosticText ??
        (missing && request.parentScope
          ? `Select a ${request.parentScope} value before loading ${request.displayName}.`
          : null),
      selectedValue: request.selectedParentValue,
      selectedLabel: request.selectedParentLabel,
      missing,
    },
  };
}

function sourceOptionPageReadModel(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  snapshot: CatalogPrimaryWorkbenchSourceOptionPageSnapshot | undefined,
): CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number] {
  const missingRequiredParent = request.parentRequired && request.parentScope !== null && !request.selectedParentValue;
  if (missingRequiredParent) {
    return emptySourceOptionPage(request, {
      state: "not-requested",
      blockers: ["selection-empty"],
      diagnostic: {
        code: "provider-source-option-parent-required",
        severity: "warning",
        message:
          request.parentDiagnosticText ??
          `Select a ${request.parentScope ?? "parent"} value before loading ${request.displayName}.`,
        retryAfterSeconds: null,
      },
    });
  }

  if (snapshot?.response) {
    const response = snapshot.response;
    const cache =
      response.cache ??
      unavailableCache("provider-source-option-cache-metadata-missing", "Cache metadata was not returned.");
    const state = sourceOptionPageState(cache);
    const page = response.page ?? {
      cursor: request.cursor,
      nextCursor: null,
      limit: request.limit,
      hasMore: false,
    };
    const blockers = sourceOptionBlockersForState(state, cache.degraded);

    return {
      queryKind: request.queryKind,
      displayName: request.displayName,
      scope: request.scope,
      state,
      actionState: actionStateForBlockers(blockers, "available"),
      blockers,
      degraded: cache.degraded,
      request: requestReadModel(request),
      page: {
        cursor: page.cursor ?? null,
        nextCursor: page.nextCursor ?? null,
        limit: page.limit,
        hasMore: page.hasMore,
        total: response.total,
        count: response.count,
      },
      cache: {
        ...cache,
        cacheKey: cache.cacheKey ?? null,
      },
      items: response.items,
      queryHref: request.queryHref,
      refreshHref: request.refreshHref,
      nextPageHref: page.nextCursor ? sourceOptionHref({ ...request, cursor: page.nextCursor }) : null,
    };
  }

  if (snapshot?.error) {
    const state = snapshot.error.rolloutBlocked ? "rollout-blocked" : "unavailable";
    return emptySourceOptionPage(request, {
      state,
      blockers: [snapshot.error.rolloutBlocked ? "rollout-disabled" : "read-model-unavailable"],
      diagnostic: {
        code: snapshot.error.code,
        severity: "error",
        message: snapshot.error.message,
        retryAfterSeconds: null,
      },
    });
  }

  return emptySourceOptionPage(request, {
    state: "unavailable",
    blockers: ["read-model-partial"],
    diagnostic: {
      code: "provider-source-option-page-not-loaded",
      severity: "warning",
      message: t("catalog.features.sourceObservations.ui.primaryWorkbench.sourceOptions.notLoaded"),
      retryAfterSeconds: null,
    },
  });
}

function emptySourceOptionPage(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  input: Readonly<{
    state: CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number]["state"];
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    diagnostic: CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number]["cache"]["diagnostics"][number];
  }>,
): CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number] {
  return {
    queryKind: request.queryKind,
    displayName: request.displayName,
    scope: request.scope,
    state: input.state,
    actionState: actionStateForBlockers(input.blockers, "available"),
    blockers: input.blockers,
    degraded: input.state === "stale" || input.state === "unavailable" || input.state === "rollout-blocked",
    request: requestReadModel(request),
    page: {
      cursor: request.cursor,
      nextCursor: null,
      limit: request.limit,
      hasMore: false,
      total: 0,
      count: 0,
    },
    cache: unavailableCache(input.diagnostic.code, input.diagnostic.message, input.diagnostic.severity),
    items: [],
    queryHref: request.queryHref,
    refreshHref: request.refreshHref,
    nextPageHref: null,
  };
}

function unavailableCache(
  code: string,
  message: string,
  severity: "info" | "warning" | "error" = "error",
): CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number]["cache"] {
  return {
    status: "unavailable",
    source: "none",
    cacheKey: null,
    fetchedAt: null,
    expiresAt: null,
    staleUntil: null,
    cacheOnly: true,
    forceRefresh: false,
    degraded: true,
    diagnostics: [{ code, severity, message, retryAfterSeconds: null }],
  };
}

function requestReadModel(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
): CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number]["request"] {
  return {
    providerKey: request.providerKey,
    languageCode: request.languageCode,
    parentValue: request.parentValue,
    cursor: request.cursor,
    limit: request.limit,
    cacheOnly: request.cacheOnly,
  };
}

function sourceOptionPageState(
  cache: CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number]["cache"],
): CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number]["state"] {
  if (cache.status === "stale" || cache.degraded) {
    return "stale";
  }
  if (cache.source === "live") {
    return "live";
  }
  if (cache.source === "cache") {
    return "cached";
  }
  return "unavailable";
}

function sourceOptionBlockersForState(
  state: CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number]["state"],
  degraded: boolean,
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  if (state === "rollout-blocked") {
    return ["rollout-disabled"];
  }
  if (state === "unavailable") {
    return ["read-model-unavailable"];
  }
  if (state === "not-requested") {
    return ["selection-empty"];
  }
  if (state === "stale" || degraded) {
    return ["provider-transport-stale-cache"];
  }
  return [];
}

function sourceOptionSummary(
  pages: readonly CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number][],
): CatalogPrimaryWorkbenchReadModel["sourceOptions"]["summary"] {
  return {
    declaredKinds: pages.length,
    loadedPages: pages.filter((page) => page.state === "live" || page.state === "cached" || page.state === "stale")
      .length,
    availableOptions: pages.reduce((count, page) => count + page.items.length, 0),
    stalePages: pages.filter((page) => page.state === "stale").length,
    degradedPages: pages.filter((page) => page.degraded).length,
    unavailablePages: pages.filter((page) => page.state === "unavailable").length,
    rolloutBlockedPages: pages.filter((page) => page.state === "rollout-blocked").length,
    blockedPages: pages.filter((page) => page.actionState === "blocked" || page.actionState === "unavailable").length,
    missingParentPages: pages.filter((page) => page.state === "not-requested").length,
    hasMorePages: pages.filter((page) => page.page.hasMore).length,
  };
}

function sourceOptionRefreshBlockers(
  input: Readonly<{
    activeProfile: CatalogProviderProfileVersionReview | null;
    readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    canManage: boolean;
  }>,
  requests: readonly CatalogPrimaryWorkbenchSourceOptionRequest[],
  pages: readonly CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number][],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  if (!input.canManage) {
    return ["permission-denied"];
  }
  if (!input.activeProfile) {
    return ["missing-active-profile"];
  }
  if (requests.length === 0) {
    return ["read-model-unavailable"];
  }
  const hardBlocker = input.readinessBlockers.find(
    (blocker) => blocker === "kill-switch-active" || blocker === "rollout-disabled",
  );
  if (hardBlocker) {
    return [hardBlocker];
  }
  const pageBlocker = pages
    .flatMap((page) => page.blockers)
    .find((blocker) => blocker !== "selection-empty" && blocker !== "provider-transport-stale-cache");
  return pageBlocker ? [pageBlocker] : [];
}

function sourceOptionsStatus(
  activeProfile: CatalogProviderProfileVersionReview | null,
  summary: CatalogPrimaryWorkbenchReadModel["sourceOptions"]["summary"],
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): CatalogPrimaryWorkbenchReadModel["sourceOptions"]["status"] {
  if (!activeProfile || summary.declaredKinds === 0) {
    return "unavailable";
  }
  if (
    summary.rolloutBlockedPages > 0 ||
    readinessBlockers.includes("kill-switch-active") ||
    readinessBlockers.includes("rollout-disabled")
  ) {
    return "blocked";
  }
  if (summary.unavailablePages > 0 && summary.loadedPages === 0) {
    return "unavailable";
  }
  if (summary.stalePages > 0 || summary.degradedPages > 0 || summary.unavailablePages > 0) {
    return "degraded";
  }
  return "ready";
}

function sourceOptionsFreshness(
  status: CatalogPrimaryWorkbenchReadModel["sourceOptions"]["status"],
  summary: CatalogPrimaryWorkbenchReadModel["sourceOptions"]["summary"],
): CatalogAdminControlPlaneFreshnessState {
  if (status === "unavailable" || status === "blocked") {
    return "unavailable";
  }
  if (summary.stalePages > 0) {
    return "stale";
  }
  if (summary.unavailablePages > 0 || summary.missingParentPages > 0) {
    return "partial";
  }
  return "fresh";
}

function sourceOptionRefreshAllHref(requests: readonly CatalogPrimaryWorkbenchSourceOptionRequest[]): string | null {
  const firstRefresh = requests.find((request) => request.refreshHref)?.refreshHref ?? null;
  return firstRefresh;
}

function sourceOptionRequestKey(request: CatalogPrimaryWorkbenchSourceOptionRequest): string {
  return [
    request.providerKey,
    request.profileVersion,
    request.queryKind,
    normalizeKey(request.languageCode),
    normalizeKey(request.parentValue),
    normalizeKey(request.cursor),
  ].join("|");
}

function sourceOptionHref(
  request: Omit<CatalogPrimaryWorkbenchSourceOptionRequest, "queryHref" | "refreshHref"> &
    Readonly<{ forceRefresh?: boolean }>,
): string {
  const params = new URLSearchParams({
    providerKey: request.providerKey,
    queryKind: request.queryKind,
    limit: String(request.limit),
  });
  if (request.languageCode) {
    params.set("languageCode", request.languageCode);
  }
  if (request.parentValue) {
    params.set("parentValue", request.parentValue);
  }
  if (request.cursor) {
    params.set("cursor", request.cursor);
  }
  if (request.cacheOnly) {
    params.set("cacheOnly", "true");
  }
  if (request.forceRefresh) {
    params.set("forceRefresh", "true");
  }
  return `${SOURCE_OPTION_ROUTE}?${params.toString()}`;
}

function normalizeKey(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
