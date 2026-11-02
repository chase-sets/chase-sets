import type {
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import {
  defineCatalogIntegrationUnitKey,
  parseCatalogIntegrationUnitKey,
  type CatalogIntegrationUnitKey,
} from "../api/integration-unit";
import type { CatalogProviderProfileVersionReview, SourceObservationIntegrationScope } from "./contracts";
import {
  parseCatalogPrimaryWorkbenchRouteContext,
  requestHasExplicitLanguageScopeSelection,
  requestHasSourceOptionIntent,
  requestHasStructuredImportScopeSelection,
} from "./primary-workbench-route-context";
import type { CatalogPrimaryWorkbenchInput } from "./primary-workbench-read-model-input";
import { normalizeUnitSegment, sourceOptionKindsForProfile } from "./primary-workbench-read-model-support";
import {
  canSelectStandaloneProductCoordinate,
  compactExpansionRouteScopeMatchesProviderScope,
  importScopeFromScopeContext,
  importScopeMatchesProviderScope,
  importScopeMatchesStructuredSelection,
  providerScopeMatchesStructuredSet,
} from "./primary-workbench-scope-context";
import { providerScopeMatchesSelectedScope } from "./primary-workbench-source-scope-workset";

// The provider, unit, profile and scope one workbench request selects, after the
// fallback precedence below has resolved conflicts between the route and the
// loaded profiles and scope rows. Every read-model slice reads these values;
// none of them re-derives a selection.
export type CatalogPrimaryWorkbenchRouteSelection = Readonly<{
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  providerKey: string | null;
  unitKey: CatalogIntegrationUnitKey | null;
  importScope: string | null;
  routeScope: CatalogPrimaryWorkbenchRouteContext["scope"];
  explicitStructuredScope: boolean;
  activeProfile: CatalogProviderProfileVersionReview | null;
  selectedProfile: CatalogProviderProfileVersionReview | null;
  requestedProfileVersion: string | null;
}>;

export function resolveCatalogPrimaryWorkbenchRouteSelection(
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchRouteSelection {
  const parsedContext = parseCatalogPrimaryWorkbenchRouteContext(input.requestUrl);
  const providerKey = parsedContext.providerKey ?? inferProviderKey(input);
  const normalizedRouteUnitKey = normalizeSelectedUnitKey(parsedContext.unitKey, providerKey);
  const activeProfile = findActiveProfile(input.profileReviews.items, providerKey, normalizedRouteUnitKey);
  const selectedProfile = findSelectedProfile(
    input.profileReviews.items,
    providerKey,
    parsedContext.profileVersion,
    normalizedRouteUnitKey,
    activeProfile,
  );
  const sourceOptionIntent = requestHasSourceOptionIntent(input.requestUrl);
  const useActiveProfileForSourceOptions =
    sourceOptionIntent && Boolean(parsedContext.profileVersion) && !selectedProfile && Boolean(activeProfile);
  const sourceOptionNormalizationProfile = sourceOptionIntent ? (selectedProfile ?? activeProfile) : activeProfile;
  const explicitStructuredScope = requestHasStructuredImportScopeSelection(input.requestUrl);
  const explicitLanguageScope = requestHasExplicitLanguageScopeSelection(input.requestUrl);
  const unitContextMismatch = Boolean(parsedContext.unitKey && providerKey && !normalizedRouteUnitKey);
  const unitKey = normalizedRouteUnitKey ?? inferUnitKey(input, providerKey, activeProfile);
  const providerUnitSelectionAmbiguous = Boolean(
    providerKey &&
    !normalizedRouteUnitKey &&
    providerHasMultipleActiveProfileUnits(input.profileReviews.items, providerKey),
  );
  const legacyImportScopeMismatch = legacyImportScopeConflictsWithSelectedProvider({
    requestUrl: input.requestUrl,
    importScope: parsedContext.importScope,
    scope: parsedContext.scope,
    providerKey,
    unitKey: normalizedRouteUnitKey,
    activeProfile: sourceOptionNormalizationProfile,
    scopes: input.scopes.items,
    explicitStructuredScope,
    unitContextMismatch,
  });
  const productScopeMismatch = Boolean(
    parsedContext.scope?.productId &&
    (!parsedContext.providerKey ||
      !normalizedRouteUnitKey ||
      sourceOptionNormalizationProfile?.ingestionUnitKey !== normalizedRouteUnitKey ||
      !canSelectStandaloneProductCoordinate(sourceOptionNormalizationProfile) ||
      sourceOptionProfileCannotSelectScope(sourceOptionNormalizationProfile, parsedContext.scope)),
  );
  const discardParsedImportScope = unitContextMismatch || legacyImportScopeMismatch || productScopeMismatch;
  const routeScope = productScopeMismatch
    ? providerOnlyScopeContext(providerKey)
    : discardParsedImportScope && legacyImportScopeMismatch && explicitStructuredScope
      ? sanitizeScopeForSourceOptionProfile(
          parsedContext.scope,
          sourceOptionNormalizationProfile,
          providerKey,
          explicitLanguageScope,
        )
      : discardParsedImportScope
        ? providerOnlyScopeContext(providerKey)
        : structuredScopeWithProfileLanguage(
            parsedContext.scope,
            sourceOptionNormalizationProfile,
            input.scopes.items,
            explicitStructuredScope,
          );
  const parsedImportScope = discardParsedImportScope
    ? null
    : structuredSelectionImportScope(parsedContext.importScope, routeScope, explicitStructuredScope);
  const structuredImportScope = explicitStructuredScope ? importScopeFromScopeContext(routeScope) : null;
  const unitRouteWithoutExplicitScope = Boolean(
    parsedContext.unitKey && !parsedContext.importScope && !explicitStructuredScope,
  );
  const inferredImportScope =
    explicitStructuredScope ||
    legacyImportScopeMismatch ||
    unitRouteWithoutExplicitScope ||
    providerUnitSelectionAmbiguous
      ? null
      : inferImportScope(input.scopes.items, providerKey);
  const importScope = unitContextMismatch ? null : (parsedImportScope ?? structuredImportScope ?? inferredImportScope);
  const discardParsedImportScopeFilters = discardParsedImportScope || unitRouteWithoutExplicitScope;
  const profileVersion =
    unitContextMismatch || useActiveProfileForSourceOptions
      ? (activeProfile?.profileVersion ?? null)
      : (parsedContext.profileVersion ?? activeProfile?.profileVersion ?? null);
  const routeSelectedProfile = useActiveProfileForSourceOptions ? activeProfile : selectedProfile;
  const routeRequestedProfileVersion = useActiveProfileForSourceOptions ? profileVersion : parsedContext.profileVersion;
  const routeContext: CatalogPrimaryWorkbenchRouteContext = {
    ...parsedContext,
    providerKey,
    unitKey,
    scope: routeScope,
    importScope,
    profileVersion,
    sourceObservationFilters: sourceObservationFiltersForRouteContext({
      parsedFilters: parsedContext.sourceObservationFilters,
      providerKey,
      importScope,
      explicitStructuredScope,
      discardParsedImportScope: discardParsedImportScopeFilters,
    }),
  };

  return {
    routeContext,
    providerKey,
    unitKey,
    importScope,
    routeScope,
    explicitStructuredScope,
    activeProfile,
    selectedProfile: routeSelectedProfile,
    requestedProfileVersion: routeRequestedProfileVersion,
  };
}

function inferProviderKey(input: CatalogPrimaryWorkbenchInput): string | null {
  return (
    input.scopes.items[0]?.provider_key ??
    input.profileReviews.items.find((profile) => profile.active)?.providerKey ??
    input.profileReviews.items[0]?.providerKey ??
    null
  );
}

export function inferUnitKey(
  input: CatalogPrimaryWorkbenchInput,
  providerKey: string | null,
  activeProfile: CatalogProviderProfileVersionReview | null,
): CatalogIntegrationUnitKey | null {
  if (activeProfile?.ingestionUnitKey) {
    return activeProfile.ingestionUnitKey as CatalogIntegrationUnitKey;
  }

  const overviewUnits =
    input.controlPlaneOverview?.readiness.units.filter((unit) => unit.providerKey === providerKey) ?? [];
  if (overviewUnits.length === 1) {
    return overviewUnits[0]?.unitKey ?? null;
  }
  if (overviewUnits.length > 1) {
    return null;
  }
  if (!providerKey) {
    return null;
  }
  const providerProfiles = input.profileReviews.items.filter((profile) => profile.providerKey === providerKey);
  const profileUnitKeys = uniqueProfileUnitKeys(providerProfiles);
  if (profileUnitKeys.size > 1) {
    return null;
  }
  const supportedScope = activeProfile?.supportedScopes[0] ?? "catalog/source-observation";
  const [productDomain = "catalog", productForm = "source-observation"] = supportedScope.split("/");

  return defineCatalogIntegrationUnitKey({
    providerKey,
    productDomain: normalizeUnitSegment(productDomain),
    productForm: normalizeUnitSegment(productForm),
    ingestionPurpose: "import",
  });
}

function normalizeSelectedUnitKey(
  unitKey: CatalogIntegrationUnitKey | null,
  providerKey: string | null,
): CatalogIntegrationUnitKey | null {
  if (!unitKey) {
    return null;
  }
  if (!providerKey) {
    return unitKey;
  }

  try {
    return parseCatalogIntegrationUnitKey(unitKey).providerKey === providerKey ? unitKey : null;
  } catch {
    return null;
  }
}

function providerOnlyScopeContext(providerKey: string | null): CatalogPrimaryWorkbenchRouteContext["scope"] {
  return {
    providerKey,
    productId: null,
    languageCode: null,
    productLineId: null,
    productLineName: null,
    seriesId: null,
    seriesName: null,
    expansionId: null,
    expansionName: null,
    status: null,
  };
}

export function selectedProviderScopeRows(input: {
  explicitStructuredScope: boolean;
  importScope: string | null;
  providerScopeRows: readonly SourceObservationIntegrationScope[];
  routeScope: CatalogPrimaryWorkbenchRouteContext["scope"];
  selectedScope: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"]["selectedScope"]["scope"];
}): readonly SourceObservationIntegrationScope[] {
  if (input.explicitStructuredScope) {
    return input.selectedScope.productId
      ? []
      : input.providerScopeRows.filter((scope) => providerScopeMatchesSelectedScope(input.selectedScope, scope));
  }
  if (!input.importScope) {
    return input.providerScopeRows;
  }

  const compactExpansionImportScope = input.importScope.split(":").filter(Boolean).length === 2;
  return input.providerScopeRows.filter(
    (scope) =>
      importScopeMatchesProviderScope(input.importScope, scope) ||
      (compactExpansionImportScope && input.explicitStructuredScope && input.routeScope
        ? compactExpansionRouteScopeMatchesProviderScope(input.routeScope, scope)
        : false),
  );
}

function structuredSelectionImportScope(
  importScope: string | null,
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
  explicitStructuredScope: boolean,
): string | null {
  if (!explicitStructuredScope || !importScope || importScopeMatchesStructuredSelection(importScope, scope)) {
    return importScope;
  }

  return importScopeFromScopeContext(scope);
}

function structuredScopeWithProfileLanguage(
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
  activeProfile: CatalogProviderProfileVersionReview | null,
  providerScopeRows: readonly SourceObservationIntegrationScope[],
  explicitStructuredScope: boolean,
): CatalogPrimaryWorkbenchRouteContext["scope"] {
  const structuredSetScope = Boolean(
    !scope?.seriesId && (scope?.expansionId || scope?.expansionName || scope?.productId),
  );
  const includesProductLineParent = Boolean(scope?.productLineId || scope?.productLineName);
  const sourceOptionScopes = new Set(sourceOptionKindsForProfile(activeProfile).map((kind) => kind.scope));
  const canSelectStructuredSet = scope?.productId
    ? canSelectStandaloneProductCoordinate(activeProfile)
    : sourceOptionScopes.size === 0 || sourceOptionScopes.has("expansion") || sourceOptionScopes.has("set-name");
  if (
    !explicitStructuredScope ||
    !scope ||
    scope.languageCode ||
    !structuredSetScope ||
    (!includesProductLineParent && !canSelectStructuredSet)
  ) {
    return scope;
  }
  const languageCode =
    providerScopeLanguageForStructuredSet(scope, providerScopeRows) ??
    (activeProfile?.languageOptions.length === 1 ? (activeProfile.languageOptions[0]?.trim() ?? null) : null);
  if (!languageCode) {
    return scope;
  }

  return { ...scope, languageCode };
}

function providerScopeLanguageForStructuredSet(
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
  providerScopeRows: readonly SourceObservationIntegrationScope[],
): string | null {
  if (!scope) {
    return null;
  }

  const languages = new Set(
    providerScopeRows
      .filter((row) => providerScopeMatchesStructuredSet(row, scope))
      .map((row) => row.language_code.trim())
      .filter(Boolean),
  );

  return languages.size === 1 ? (Array.from(languages)[0] ?? null) : null;
}

function legacyImportScopeConflictsWithSelectedProvider(input: {
  requestUrl: string | URL;
  importScope: string | null;
  scope: CatalogPrimaryWorkbenchRouteContext["scope"];
  providerKey: string | null;
  unitKey: CatalogIntegrationUnitKey | null;
  activeProfile: CatalogProviderProfileVersionReview | null;
  scopes: readonly SourceObservationIntegrationScope[];
  explicitStructuredScope: boolean;
  unitContextMismatch: boolean;
}): boolean {
  if (input.unitContextMismatch || !input.providerKey || (!input.importScope && !input.explicitStructuredScope)) {
    return false;
  }

  const hasSourceOptionIntent = requestHasSourceOptionIntent(input.requestUrl);
  if (!hasSourceOptionIntent) {
    return false;
  }

  // A source-option refresh for an explicit unit must never keep an old
  // provider-level importScope when the matching option profile cannot drive
  // source-option scope selection. That scope is only legacy route state;
  // preserving it leaks a previous product line into review queries before the
  // operator can pick a fresh guided scope.
  if (!input.activeProfile || sourceOptionKindsForProfile(input.activeProfile).length === 0) {
    return Boolean(input.unitKey && input.importScope);
  }

  if (
    input.importScope &&
    !input.explicitStructuredScope &&
    legacyImportScopeConflictsWithSelectedProviderScope({
      importScope: input.importScope,
      providerKey: input.providerKey,
      unitKey: input.unitKey,
      scopes: input.scopes,
    })
  ) {
    return true;
  }

  return sourceOptionProfileCannotSelectScope(input.activeProfile, input.scope);
}

function legacyImportScopeConflictsWithSelectedProviderScope(input: {
  importScope: string;
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey | null;
  scopes: readonly SourceObservationIntegrationScope[];
}): boolean {
  const matchingScopes = input.scopes.filter(
    (scope) => scope.provider_key === input.providerKey && importScopeMatchesProviderScope(input.importScope, scope),
  );
  if (matchingScopes.length === 0) {
    return true;
  }
  if (!input.unitKey) {
    return false;
  }
  const unitKey = input.unitKey;

  return !matchingScopes.some((scope) => !sourceObservationScopeProductLineConflictsWithUnit(scope, unitKey));
}

function sourceObservationScopeProductLineConflictsWithUnit(
  scope: SourceObservationIntegrationScope,
  unitKey: CatalogIntegrationUnitKey,
): boolean {
  const unitProductDomain = productDomainFromIntegrationUnitKey(unitKey);
  const scopeProductDomain = productDomainFromIntegrationScope(scope);

  return Boolean(unitProductDomain && scopeProductDomain && unitProductDomain !== scopeProductDomain);
}

function productDomainFromIntegrationUnitKey(unitKey: CatalogIntegrationUnitKey): string | null {
  try {
    return normalizeDomainSegment(parseCatalogIntegrationUnitKey(unitKey).productDomain);
  } catch {
    return null;
  }
}

function productDomainFromIntegrationScope(scope: SourceObservationIntegrationScope): string | null {
  return (
    tcgplayerProductLineDomain(scope.product_line_id) ??
    productDomainFromProductLineName(scope.product_line_name) ??
    productDomainFromProductLineId(scope.product_line_id)
  );
}

function tcgplayerProductLineDomain(productLineId: string): string | null {
  switch (productLineId.trim()) {
    case "1":
      return "mtg";
    case "2":
      return "yugioh";
    case "3":
      return "pokemon";
    default:
      return null;
  }
}

function productDomainFromProductLineName(productLineName: string): string | null {
  const normalized = productLineName.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("pokemon")) {
    return "pokemon";
  }
  if (normalized.includes("magic") || normalized.includes("mtg")) {
    return "mtg";
  }
  if (normalized.includes("yu-gi-oh") || normalized.includes("yugioh")) {
    return "yugioh";
  }

  return null;
}

function productDomainFromProductLineId(productLineId: string): string | null {
  const normalized = normalizeDomainSegment(productLineId);
  if (!normalized || /^\d+$/.test(normalized)) {
    return null;
  }

  return productDomainFromProductLineName(normalized) ?? normalized;
}

function normalizeDomainSegment(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function sourceOptionProfileCannotSelectScope(
  profile: CatalogProviderProfileVersionReview | null,
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
): boolean {
  if (scope?.productId && !canSelectStandaloneProductCoordinate(profile)) return true;
  if (!profile || !scope) {
    return false;
  }

  const selectableScopes = new Set(sourceOptionKindsForProfile(profile).map((kind) => kind.scope));
  if (selectableScopes.size === 0) {
    return false;
  }

  return (
    (Boolean(scope.productId) && !selectableScopes.has("product")) ||
    (Boolean(scope.productLineId || scope.productLineName) && !selectableScopes.has("product-line/category")) ||
    (Boolean(scope.seriesId || scope.seriesName) && !selectableScopes.has("series")) ||
    (Boolean(scope.expansionId || scope.expansionName) &&
      !selectableScopes.has("expansion") &&
      !selectableScopes.has("set-name"))
  );
}

function sanitizeScopeForSourceOptionProfile(
  scope: CatalogPrimaryWorkbenchRouteContext["scope"],
  profile: CatalogProviderProfileVersionReview | null,
  providerKey: string | null,
  explicitLanguageScope: boolean,
): CatalogPrimaryWorkbenchRouteContext["scope"] {
  if (!profile || !scope || sourceOptionKindsForProfile(profile).length === 0) {
    return providerOnlyScopeContext(providerKey);
  }

  const selectableScopes = new Set(sourceOptionKindsForProfile(profile).map((kind) => kind.scope));
  const supportsSetName = selectableScopes.has("set-name");
  const expansionIdIsSetNameSelection = supportsSetName && !scope.expansionName && !scope.seriesId && !scope.seriesName;

  return {
    providerKey,
    productId: canSelectStandaloneProductCoordinate(profile) ? scope.productId : null,
    languageCode: explicitLanguageScope ? (scope.languageCode ?? null) : null,
    productLineId:
      selectableScopes.has("product-line/category") || supportsSetName ? (scope.productLineId ?? null) : null,
    productLineName:
      selectableScopes.has("product-line/category") || supportsSetName ? (scope.productLineName ?? null) : null,
    seriesId: selectableScopes.has("series") ? (scope.seriesId ?? null) : null,
    seriesName: selectableScopes.has("series") ? (scope.seriesName ?? null) : null,
    expansionId:
      selectableScopes.has("expansion") || expansionIdIsSetNameSelection ? (scope.expansionId ?? null) : null,
    expansionName: selectableScopes.has("expansion") || supportsSetName ? (scope.expansionName ?? null) : null,
    status: scope.status ?? null,
  };
}

function sourceObservationFiltersForRouteContext(input: {
  parsedFilters: Readonly<Record<string, string>>;
  providerKey: string | null;
  importScope: string | null;
  explicitStructuredScope: boolean;
  discardParsedImportScope: boolean;
}): Readonly<Record<string, string>> {
  const filters = { ...input.parsedFilters };
  if (input.importScope || input.explicitStructuredScope || input.discardParsedImportScope) {
    delete filters.importScope;
  }
  if (input.providerKey) {
    filters.providerKey = input.providerKey;
  }
  if (input.importScope) {
    filters.importScope = input.importScope;
  }

  return filters;
}

function inferImportScope(
  scopes: readonly SourceObservationIntegrationScope[],
  providerKey: string | null,
): string | null {
  const scope = scopes.find((candidate) => !providerKey || candidate.provider_key === providerKey) ?? scopes[0];
  if (!scope) {
    return null;
  }

  return [scope.language_code, scope.product_line_id, scope.series_id, scope.expansion_id].filter(Boolean).join(":");
}

export function findActiveProfile(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string | null,
  unitKey: CatalogIntegrationUnitKey | null = null,
): CatalogProviderProfileVersionReview | null {
  const providerProfiles = providerKey ? profiles.filter((profile) => profile.providerKey === providerKey) : profiles;
  const activeProfiles = providerProfiles.filter(
    (profile) => profile.active && profileMatchesUnit(profile, unitKey, providerProfiles),
  );

  if (!unitKey && uniqueProfileUnitKeys(activeProfiles).size > 1) {
    return null;
  }

  return activeProfiles[0] ?? null;
}

function providerHasMultipleActiveProfileUnits(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string,
): boolean {
  const activeProfiles = profiles.filter((profile) => profile.providerKey === providerKey && profile.active);
  return uniqueProfileUnitKeys(activeProfiles).size > 1;
}

function findSelectedProfile(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string | null,
  requestedProfileVersion: string | null,
  unitKey: CatalogIntegrationUnitKey | null,
  activeProfile: CatalogProviderProfileVersionReview | null,
): CatalogProviderProfileVersionReview | null {
  const providerProfiles = providerKey ? profiles.filter((profile) => profile.providerKey === providerKey) : profiles;
  if (requestedProfileVersion) {
    return (
      providerProfiles.find(
        (profile) =>
          profile.profileVersion === requestedProfileVersion && profileMatchesUnit(profile, unitKey, providerProfiles),
      ) ??
      profiles.find(
        (profile) =>
          profile.profileVersion === requestedProfileVersion &&
          !providerKey &&
          profileMatchesUnit(profile, unitKey, profiles),
      ) ??
      null
    );
  }

  return activeProfile ?? providerProfiles[0] ?? (providerKey ? null : (profiles[0] ?? null));
}

function profileMatchesUnit(
  profile: CatalogProviderProfileVersionReview,
  unitKey: CatalogIntegrationUnitKey | null,
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

function uniqueProfileUnitKeys(profiles: readonly CatalogProviderProfileVersionReview[]): ReadonlySet<string> {
  return new Set(
    profiles.map((profile) => profile.ingestionUnitKey.trim().toLowerCase()).filter((unitKey) => unitKey.length > 0),
  );
}
