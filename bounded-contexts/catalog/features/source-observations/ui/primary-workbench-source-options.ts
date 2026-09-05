import { t } from "@chase-sets/localization";
import type { CatalogAdminControlPlaneFreshnessState } from "../api/admin-control-plane-read-model-slos";
import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import type {
  CatalogProviderProfileVersionReview,
  CatalogProviderSourceOptionKind,
  SourceObservationIntegrationOptionResponse,
  SourceObservationIntegrationScope,
} from "./contracts";
import { parseCatalogPrimaryWorkbenchRouteContext } from "./primary-workbench-route-context";
import {
  actionStateForBlockers,
  profilePointerForProfile,
  sourceOptionKindsForProfile,
} from "./primary-workbench-read-model-support";
import {
  canSelectStandaloneProductCoordinate,
  scopeContextFromProviderScope,
  scopeContextFromRouteContext,
  scopeContextMatchesProviderScope,
  scopeKey,
} from "./primary-workbench-scope-context";
import { sourceOptionDisplayLabel } from "./primary-workbench-source-option-labels";

export type CatalogPrimaryWorkbenchSourceOptionRequest = Readonly<{
  providerKey: string;
  profileKey: string | null;
  profileVersion: string;
  ingestionUnitKey: string | null;
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
const sourceScopeOptionScopes = new Set([
  "language",
  "product-line/category",
  "series",
  "expansion",
  "set-name",
  "product",
]);

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
  const context = sourceOptionContext({
    requestUrl: "https://admin.example/catalog/integrations",
    scopes: input.scopes,
    profiles: input.profiles,
    routeContext: input.routeContext,
  });
  const sourceOptionProfile = selectedSourceOptionProfile(
    input.activeProfile,
    context.activeProfile,
    context.providerKey,
    context.requestedProfileVersion,
    context.requestedUnitKey,
    context.activeProfileAmbiguous,
  );
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl: "https://admin.example/catalog/integrations",
    scopes: input.scopes,
    profiles: input.profiles,
    routeContext: input.routeContext,
    activeProfile: sourceOptionProfile,
    cacheOnly: true,
    limit: SOURCE_OPTION_PAGE_LIMIT,
  });
  const pageSnapshots = new Map(input.sourceOptionPages?.map((page) => [sourceOptionRequestKey(page.request), page]));
  const optionKinds = requests.map((request) => sourceOptionKindReadModel(request, sourceOptionProfile));
  const pages = requests.map((request) =>
    sourceOptionPageReadModel(request, pageSnapshots.get(sourceOptionRequestKey(request)), input.scopes),
  );
  const summary = sourceOptionSummary(pages);
  const refreshBlockers = sourceOptionRefreshBlockers(
    { ...input, activeProfile: sourceOptionProfile },
    requests,
    pages,
  );
  const status = sourceOptionsStatus(sourceOptionProfile, summary, input.readinessBlockers);

  return {
    status,
    freshness: sourceOptionsFreshness(status, summary),
    generatedAt: input.generatedAt,
    selectedProviderKey: input.routeContext.providerKey,
    selectedUnitKey: input.routeContext.unitKey,
    selectedProfile: profilePointerForProfile(sourceOptionProfile),
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
  const providerKey = context.providerKey;
  const profile = selectedSourceOptionProfile(
    input.activeProfile ?? null,
    context.activeProfile,
    providerKey,
    context.requestedProfileVersion,
    context.requestedUnitKey,
    context.activeProfileAmbiguous,
  );
  const sourceOptionKinds = normalizedSourceOptionKindsForProfile(profile);
  if (!profile || sourceOptionKinds.length === 0 || !providerKey) {
    return [];
  }

  const selections = sourceOptionSelections({
    providerKey,
    scope: context.scope,
    profile,
    scopes: input.scopes,
    allowRepresentativeScope: context.allowRepresentativeScope,
  });
  const limit = input.limit ?? SOURCE_OPTION_PAGE_LIMIT;
  return sourceOptionKinds
    .filter(
      (kind) =>
        sourceScopeOptionScopes.has(kind.scope) &&
        (kind.scope !== "product" ||
          (context.requestedUnitKey === profile.ingestionUnitKey && canSelectStandaloneProductCoordinate(profile))),
    )
    .map((kind) => {
      const parent = kind.parentScope ? (selections.get(kind.parentScope) ?? null) : null;
      const languageSelection = selections.get("language") ?? null;
      const languageCode = sourceOptionLanguageCode(profile, languageSelection?.value ?? null);
      const parentValue = kind.parentScope === "language" ? null : (parent?.value ?? null);
      const request = {
        providerKey,
        profileKey: profile.profileKey,
        profileVersion: profile.profileVersion,
        ingestionUnitKey: profile.ingestionUnitKey,
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
  scope: NonNullable<CatalogPrimaryWorkbenchRouteContext["scope"]>;
  activeProfile: CatalogProviderProfileVersionReview | null;
  requestedProfileVersion: string | null;
  requestedUnitKey: string | null;
  activeProfileAmbiguous: boolean;
  allowRepresentativeScope: boolean;
}> {
  const parsed = input.routeContext ?? parseCatalogPrimaryWorkbenchRouteContext(input.requestUrl);
  const providerKey =
    parsed.providerKey ??
    input.scopes[0]?.provider_key ??
    input.profiles.find((profile) => profile.active)?.providerKey ??
    input.profiles[0]?.providerKey ??
    null;
  const providerProfiles = providerKey
    ? input.profiles.filter((profile) => profile.providerKey === providerKey)
    : input.profiles;
  const requestedProfileVersion = parsed.profileVersion;
  const requestedUnitKey = parsed.unitKey;
  const requestedProfile = requestedProfileVersion
    ? (providerProfiles.find(
        (profile) =>
          profile.profileVersion === requestedProfileVersion &&
          profileMatchesUnitWithin(profile, requestedUnitKey, providerProfiles),
      ) ?? null)
    : null;
  const activeProfileSelection = activeSourceOptionProfile(providerProfiles, requestedUnitKey);
  const activeProfile = requestedProfile ?? activeProfileSelection.profile;
  const explicitScopeSelection = scopeHasExplicitSelection(parsed.scope);
  const unitRouteWithoutExplicitScope = Boolean(parsed.unitKey && !parsed.importScope && !explicitScopeSelection);
  const allowRepresentativeScope = !unitRouteWithoutExplicitScope;
  const representativeScope = allowRepresentativeScope
    ? (input.scopes.find((scope) => !providerKey || scope.provider_key === providerKey) ?? null)
    : null;
  const importScope = parsed.importScope ?? (representativeScope ? scopeKey(representativeScope) : null);
  const scope = scopeContextFromRouteContext({
    ...parsed,
    providerKey,
    importScope: explicitScopeSelection ? null : importScope,
  });

  return {
    providerKey,
    importScope,
    scope,
    activeProfile,
    requestedProfileVersion,
    requestedUnitKey,
    activeProfileAmbiguous: requestedProfile ? false : activeProfileSelection.ambiguous,
    allowRepresentativeScope,
  };
}

function selectedSourceOptionProfile(
  explicitProfile: CatalogProviderProfileVersionReview | null,
  contextProfile: CatalogProviderProfileVersionReview | null,
  providerKey: string | null,
  requestedProfileVersion: string | null,
  requestedUnitKey: string | null,
  activeProfileAmbiguous: boolean,
): CatalogProviderProfileVersionReview | null {
  if (requestedProfileVersion) {
    return contextProfile;
  }
  if (requestedUnitKey && contextProfile && (!providerKey || contextProfile.providerKey === providerKey)) {
    return contextProfile;
  }
  if (!requestedUnitKey && activeProfileAmbiguous) {
    return null;
  }
  if (
    explicitProfile &&
    (!providerKey || explicitProfile.providerKey === providerKey) &&
    profileMatchesUnit(explicitProfile, requestedUnitKey)
  ) {
    return explicitProfile;
  }
  if (
    contextProfile &&
    (!providerKey || contextProfile.providerKey === providerKey) &&
    profileMatchesUnit(contextProfile, requestedUnitKey)
  ) {
    return contextProfile;
  }

  return null;
}

function activeSourceOptionProfile(
  providerProfiles: readonly CatalogProviderProfileVersionReview[],
  requestedUnitKey: string | null,
): Readonly<{ profile: CatalogProviderProfileVersionReview | null; ambiguous: boolean }> {
  const activeProfiles = providerProfiles.filter(
    (profile) => profile.active && profileMatchesUnitWithin(profile, requestedUnitKey, providerProfiles),
  );
  if (requestedUnitKey) {
    return { profile: activeProfiles[0] ?? null, ambiguous: false };
  }

  const activeProfileUnitKeys = new Set(
    activeProfiles
      .map((profile) => profile.ingestionUnitKey.trim().toLowerCase())
      .filter((unitKey) => unitKey.length > 0),
  );
  if (activeProfileUnitKeys.size > 1) {
    return { profile: null, ambiguous: true };
  }

  return { profile: activeProfiles[0] ?? null, ambiguous: false };
}

function profileMatchesUnit(profile: CatalogProviderProfileVersionReview, unitKey: string | null): boolean {
  return !unitKey || profile.ingestionUnitKey === unitKey;
}

function profileMatchesUnitWithin(
  profile: CatalogProviderProfileVersionReview,
  unitKey: string | null,
  providerProfiles: readonly CatalogProviderProfileVersionReview[],
): boolean {
  if (!unitKey || profile.ingestionUnitKey === unitKey) {
    return true;
  }

  const normalizedProviderKey = profile.providerKey.trim().toLowerCase();
  const unitIdentities = new Set(
    providerProfiles
      .filter((candidate) => candidate.providerKey.trim().toLowerCase() === normalizedProviderKey)
      .map((candidate) => candidate.ingestionUnitKey.trim().toLowerCase()),
  );

  return unitIdentities.size <= 1 && unitKey.trim().toLowerCase().startsWith(`${normalizedProviderKey}:`);
}

function sourceOptionSelections(input: {
  providerKey: string;
  scope: CatalogPrimaryWorkbenchRouteContext["scope"];
  profile: CatalogProviderProfileVersionReview;
  scopes: readonly SourceObservationIntegrationScope[];
  allowRepresentativeScope: boolean;
}): ReadonlyMap<string, Readonly<{ value: string; label: string }>> {
  const providerRows = input.scopes.filter((scope) => scope.provider_key === input.providerKey);
  const hasExplicitScopeSelection = scopeHasExplicitSelection(input.scope);
  const selectedContextScopes = sourceOptionSelectedContextScopes(input.profile, input.scope);
  const matchedRepresentative =
    hasExplicitScopeSelection && input.scope
      ? (providerRows.find((scope) => scopeContextMatchesProviderScope(input.scope!, scope)) ?? null)
      : null;
  const representative = input.allowRepresentativeScope
    ? (matchedRepresentative ?? (hasExplicitScopeSelection ? null : (providerRows[0] ?? null)))
    : null;
  const scope = hasExplicitScopeSelection
    ? input.scope
    : representative
      ? scopeContextFromProviderScope(representative)
      : null;
  const selections = new Map<string, Readonly<{ value: string; label: string }>>();
  addLanguageSelection(
    selections,
    representativeSelectionValue(
      input,
      representative,
      selectedContextScopes,
      "language",
      representative?.language_code,
    ),
    representativeSelectionValue(
      input,
      representative,
      selectedContextScopes,
      "language",
      representative?.language_code,
    ),
  );
  addSelection(
    selections,
    "product-line/category",
    representativeSelectionValue(
      input,
      representative,
      selectedContextScopes,
      "product-line/category",
      representative?.product_line_id,
    ),
    representativeSelectionValue(
      input,
      representative,
      selectedContextScopes,
      "product-line/category",
      representative?.product_line_name,
    ),
  );
  addSelection(
    selections,
    "series",
    representativeSelectionValue(input, representative, selectedContextScopes, "series", representative?.series_id),
    representativeSelectionValue(input, representative, selectedContextScopes, "series", representative?.series_name),
  );
  addSelection(
    selections,
    "expansion",
    representativeSelectionValue(
      input,
      representative,
      selectedContextScopes,
      "expansion",
      representative?.expansion_id || representative?.expansion_name,
    ),
    representativeSelectionValue(
      input,
      representative,
      selectedContextScopes,
      "expansion",
      representative?.expansion_name || representative?.expansion_id,
    ),
  );
  addSelection(
    selections,
    "set-name",
    representativeSelectionValue(
      input,
      representative,
      selectedContextScopes,
      "set-name",
      representative?.expansion_name || representative?.expansion_id,
    ),
    representativeSelectionValue(
      input,
      representative,
      selectedContextScopes,
      "set-name",
      representative?.expansion_name || representative?.expansion_id,
    ),
  );
  addSelection(
    selections,
    "product/card",
    representativeSelectionValue(
      input,
      representative,
      selectedContextScopes,
      "product/card",
      representative ? scopeKey(representative) : null,
    ),
    representativeSelectionValue(
      input,
      representative,
      selectedContextScopes,
      "product/card",
      representative?.expansion_name,
    ),
  );
  addLanguageSelection(selections, scope?.languageCode, scope?.languageCode);
  addSelection(
    selections,
    "product-line/category",
    scope?.productLineId,
    scope?.productLineName ?? scope?.productLineId,
  );
  addSelection(selections, "series", scope?.seriesId, scope?.seriesName ?? scope?.seriesId);
  addSelection(selections, "product", scope?.productId, scope?.productId);
  addSelection(selections, "expansion", scope?.expansionId, scope?.expansionName ?? scope?.expansionId);
  addSelection(
    selections,
    "set-name",
    scope?.expansionName ?? scope?.expansionId,
    scope?.expansionName ?? scope?.expansionId,
  );
  if (!selections.has("language")) {
    addLanguageSelection(
      selections,
      input.profile.languageOptions[0] ?? "en",
      input.profile.languageOptions[0] ?? "en",
    );
  }

  return selections;
}

function sourceOptionLanguageCode(
  profile: CatalogProviderProfileVersionReview,
  selectedLanguage: string | null,
): string {
  const profileDefault = profile.languageOptions[0]?.trim();
  const selected = selectedLanguage?.trim();
  const languageIsOperatorSelectable = normalizedSourceOptionKindsForProfile(profile).some(
    (kind) => kind.scope === "language",
  );

  if (languageIsOperatorSelectable && selected) {
    return selected;
  }

  return profileDefault || selected || "en";
}

function representativeSelectionValue(
  input: Readonly<{
    scope: CatalogPrimaryWorkbenchRouteContext["scope"];
  }>,
  representative: SourceObservationIntegrationScope | null,
  selectedContextScopes: ReadonlySet<string>,
  selectionScope: string,
  value: string | null | undefined,
): string | null | undefined {
  if (!representative || !scopeHasExplicitSelection(input.scope) || selectedContextScopes.has(selectionScope)) {
    return value;
  }

  return null;
}

function sourceOptionSelectedContextScopes(
  profile: CatalogProviderProfileVersionReview,
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
): ReadonlySet<string> {
  const selectedScopes = new Set<string>();
  if (!scopeHasExplicitSelection(scope)) {
    return selectedScopes;
  }

  const sourceOptionKinds = normalizedSourceOptionKindsForProfile(profile);
  const parentScopeByScope = new Map(sourceOptionKinds.map((kind) => [kind.scope, kind.parentScope]));
  for (const kind of sourceOptionKinds) {
    if (explicitScopeIncludesSelection(scope, kind.scope)) {
      addScopeAndAncestors(selectedScopes, parentScopeByScope, kind.scope);
    }
  }

  return selectedScopes;
}

function addScopeAndAncestors(
  selectedScopes: Set<string>,
  parentScopeByScope: ReadonlyMap<string, string | null>,
  scope: string | null,
): void {
  let current = scope;
  while (current && !selectedScopes.has(current)) {
    selectedScopes.add(current);
    current = parentScopeByScope.get(current) ?? null;
  }
}

function scopeHasExplicitSelection(scope: CatalogPrimaryWorkbenchRouteContext["scope"]): boolean {
  return Boolean(
    scope?.productId ||
    scope?.languageCode ||
    scope?.productLineId ||
    scope?.productLineName ||
    scope?.seriesId ||
    scope?.seriesName ||
    scope?.expansionId ||
    scope?.expansionName,
  );
}

function explicitScopeIncludesSelection(
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
  selectionScope: string,
): boolean {
  if (!scope) {
    return true;
  }

  switch (selectionScope) {
    case "product":
      return Boolean(scope.productId);
    case "language":
      return Boolean(scope.languageCode);
    case "product-line/category":
      return Boolean(scope.productLineId || scope.productLineName);
    case "series":
      return Boolean(scope.seriesId || scope.seriesName);
    case "expansion":
    case "set-name":
      return Boolean(scope.expansionId || scope.expansionName);
    case "product/card":
      return false;
    default:
      return false;
  }
}

function addLanguageSelection(
  selections: Map<string, Readonly<{ value: string; label: string }>>,
  value: string | null | undefined,
  label: string | null | undefined,
): void {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return;
  }
  addSelection(
    selections,
    "language",
    normalizedValue,
    sourceOptionDisplayLabel({
      queryKind: "languages",
      scope: "language",
      value: normalizedValue,
      label,
    }),
  );
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
  const kind = normalizedSourceOptionKindsForProfile(profile).find(
    (candidate) => candidate.queryKind === request.queryKind,
  );
  const missing = Boolean(kind?.parentRequired && kind.parentScope && !request.selectedParentValue);
  return {
    queryKind: request.queryKind,
    queryKeySynonyms: kind?.queryKeySynonyms ?? [],
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

function normalizedSourceOptionKindsForProfile(
  profile: CatalogProviderProfileVersionReview | null | undefined,
): readonly CatalogProviderSourceOptionKind[] {
  return sourceOptionKindsForProfile(profile).map(normalizedSourceOptionKind);
}

function normalizedSourceOptionKind(kind: CatalogProviderSourceOptionKind): CatalogProviderSourceOptionKind {
  const parentScope = kind.parentScope ?? inferredRequiredParentScope(kind);
  const parentRequired = Boolean(kind.parentRequired && parentScope);

  return {
    ...kind,
    parentScope,
    parentRequired,
    parentValueKind: parentRequired ? (kind.parentValueKind ?? inferredParentValueKind(parentScope)) : null,
    parentDiagnosticText:
      parentRequired && parentScope
        ? (kind.parentDiagnosticText ?? requiredParentDiagnosticText(parentScope, kind.displayName))
        : null,
  };
}

function inferredRequiredParentScope(kind: CatalogProviderSourceOptionKind): string | null {
  if (!kind.parentRequired) {
    return null;
  }
  if (kind.scope === "set-name") {
    return "product-line/category";
  }

  return null;
}

function inferredParentValueKind(parentScope: string | null): string | null {
  return parentScope === "product-line/category" ? "product-line-id" : null;
}

function requiredParentDiagnosticText(parentScope: string, displayName: string): string {
  return `Select a ${parentScope} value before loading ${displayName}.`;
}

function sourceOptionPageReadModel(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  snapshot: CatalogPrimaryWorkbenchSourceOptionPageSnapshot | undefined,
  scopes: readonly SourceObservationIntegrationScope[],
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
    const responseItems = sourceOptionItemsReadModel(request, response.items, page.limit);
    const fallbackItems =
      responseItems.length === 0 && (state === "unavailable" || cache.degraded)
        ? sourceOptionItemsFromScopes(request, scopes)
        : [];
    const items = fallbackItems.length > 0 ? fallbackItems : responseItems;
    const effectiveState = fallbackItems.length > 0 && state === "unavailable" ? "stale" : state;
    const effectiveBlockers = fallbackItems.length > 0 ? ["provider-transport-stale-cache" as const] : blockers;

    return {
      queryKind: request.queryKind,
      displayName: request.displayName,
      scope: request.scope,
      state: effectiveState,
      actionState: actionStateForBlockers(effectiveBlockers, "available"),
      blockers: effectiveBlockers,
      degraded: cache.degraded || fallbackItems.length > 0,
      request: requestReadModel(request),
      page: {
        cursor: page.cursor ?? null,
        nextCursor: page.nextCursor ?? null,
        limit: page.limit,
        hasMore: page.hasMore,
        total: fallbackItems.length > 0 ? fallbackItems.length : response.total,
        count: items.length,
      },
      cache: {
        ...cache,
        status: fallbackItems.length > 0 && cache.status === "unavailable" ? "stale" : cache.status,
        source: fallbackItems.length > 0 && cache.source === "none" ? "cache" : cache.source,
        cacheKey: cache.cacheKey ?? (fallbackItems.length > 0 ? sourceOptionScopeFallbackCacheKey(request) : null),
        degraded: cache.degraded || fallbackItems.length > 0,
      },
      items,
      queryHref: request.queryHref,
      refreshHref: request.refreshHref,
      nextPageHref: page.nextCursor ? sourceOptionHref({ ...request, cursor: page.nextCursor }) : null,
    };
  }

  if (snapshot?.error) {
    const state = snapshot.error.rolloutBlocked ? "rollout-blocked" : "unavailable";
    const fallbackItems = state === "unavailable" ? sourceOptionItemsFromScopes(request, scopes) : [];
    if (fallbackItems.length > 0) {
      return sourceOptionScopeFallbackPage(request, fallbackItems, {
        code: snapshot.error.code,
        message: snapshot.error.message,
      });
    }
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

function sourceOptionScopeFallbackPage(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  items: SourceObservationIntegrationOptionResponse["items"],
  diagnostic: Readonly<{ code: string; message: string }>,
): CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number] {
  return {
    queryKind: request.queryKind,
    displayName: request.displayName,
    scope: request.scope,
    state: "stale",
    actionState: actionStateForBlockers(["provider-transport-stale-cache"], "available"),
    blockers: ["provider-transport-stale-cache"],
    degraded: true,
    request: requestReadModel(request),
    page: {
      cursor: request.cursor,
      nextCursor: null,
      limit: request.limit,
      hasMore: false,
      total: items.length,
      count: items.length,
    },
    cache: {
      ...unavailableCache(diagnostic.code, diagnostic.message, "warning"),
      status: "stale",
      source: "cache",
      cacheKey: sourceOptionScopeFallbackCacheKey(request),
    },
    items,
    queryHref: request.queryHref,
    refreshHref: request.refreshHref,
    nextPageHref: null,
  };
}

function sourceOptionItemsFromScopes(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  scopes: readonly SourceObservationIntegrationScope[],
): SourceObservationIntegrationOptionResponse["items"] {
  if (request.scope !== "expansion" && request.scope !== "set-name") {
    return [];
  }

  const items = scopes
    .filter((scope) => scope.provider_key === request.providerKey)
    .map((scope) => sourceOptionItemFromScope(request, scope))
    .filter((item): item is SourceObservationIntegrationOptionResponse["items"][number] => item !== null);
  const seen = new Set<string>();
  const unique: SourceObservationIntegrationOptionResponse["items"] = [];
  for (const item of items) {
    const key = `${item.parentValue ?? ""}:${item.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
    if (unique.length >= request.limit) {
      return unique;
    }
  }

  return unique;
}

function sourceOptionScopeFallbackCacheKey(request: CatalogPrimaryWorkbenchSourceOptionRequest): string {
  return [
    "scope-fallback",
    request.providerKey,
    request.ingestionUnitKey ?? "unit",
    request.queryKind,
    request.parentValue ?? "root",
  ].join(":");
}

function sourceOptionItemFromScope(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  scope: SourceObservationIntegrationScope,
): SourceObservationIntegrationOptionResponse["items"][number] | null {
  const option = scopeFallbackOptionValue(request, scope);
  if (!option) {
    return null;
  }

  return {
    providerKey: request.providerKey,
    queryKind: request.queryKind,
    value: option.value,
    label: sourceOptionDisplayLabel({
      queryKind: request.queryKind,
      scope: request.scope,
      value: option.value,
      label: option.label,
    }),
    description: null,
    parentValue: scopeFallbackParentValue(request, scope),
    imageUrl: null,
    aliases: [],
    metadata: sourceOptionDisplayMetadata(),
  };
}

function scopeFallbackOptionValue(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  scope: SourceObservationIntegrationScope,
): Readonly<{ value: string; label: string }> | null {
  switch (request.scope) {
    case "language":
      return scopeValue(scope.language_code, scope.language_code);
    case "product-line/category":
      return scopeValue(
        scope.product_line_id || scope.product_line_name,
        scope.product_line_name || scope.product_line_id,
      );
    case "series":
      return scopeValue(scope.series_id || scope.series_name, scope.series_name || scope.series_id);
    case "expansion":
      return scopeValue(scope.expansion_id || scope.expansion_name, scope.expansion_name || scope.expansion_id);
    case "set-name":
      return scopeValue(scope.expansion_id || scope.expansion_name, scope.expansion_name || scope.expansion_id);
    default:
      return null;
  }
}

function scopeFallbackParentValue(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  scope: SourceObservationIntegrationScope,
): string | null {
  switch (request.parentScope) {
    case "language":
      return scope.language_code || null;
    case "product-line/category":
      return scope.product_line_id || scope.product_line_name || null;
    case "series":
      return scope.series_id || scope.series_name || null;
    case "expansion":
    case "set-name":
      return scope.expansion_name || scope.expansion_id || null;
    default:
      return null;
  }
}

function scopeValue(
  value: string | null | undefined,
  label: string | null | undefined,
): Readonly<{
  value: string;
  label: string;
}> | null {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return null;
  }

  return { value: normalizedValue, label: label?.trim() || normalizedValue };
}

function sourceOptionItemsReadModel(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  items: SourceObservationIntegrationOptionResponse["items"],
  limit: number,
): SourceObservationIntegrationOptionResponse["items"] {
  return items.slice(0, limit).map((item) => ({
    providerKey: item.providerKey,
    queryKind: item.queryKind,
    value: item.value,
    label: sourceOptionDisplayLabel({
      queryKind: item.queryKind || request.queryKind,
      scope: request.scope,
      value: item.value,
      label: item.label,
      aliases: item.aliases,
    }),
    description: item.description,
    parentValue: item.parentValue,
    imageUrl: item.imageUrl,
    aliases: item.aliases ?? [],
    metadata: sourceOptionDisplayMetadata(),
  }));
}

// The in-page option read model exposes only the precomputed label, image URL,
// and typed aliases. Raw provider metadata is intentionally not surfaced here so
// arbitrary provider payload can never leak into the page snapshot; the semantic
// English-equivalent signal lives in typed `aliases`, and richer non-semantic
// metadata (logo URL, card counts) is read from the HTTP option response by the
// scope-field hook, not from this leak-guarded page model.
function sourceOptionDisplayMetadata(): SourceObservationIntegrationOptionResponse["items"][number]["metadata"] {
  return {};
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
    .find((blocker) => blocker !== "provider-transport-stale-cache");
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
    request.profileKey,
    request.profileVersion,
    request.ingestionUnitKey,
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
  if (request.profileKey) {
    params.set("profileKey", request.profileKey);
  }
  if (request.ingestionUnitKey) {
    params.set("ingestionUnitKey", request.ingestionUnitKey);
  }
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
