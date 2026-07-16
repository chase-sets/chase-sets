import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchScopeContext,
} from "../api/primary-workbench-admin-contracts";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogIntegrationControlPlaneUnitReadiness,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
} from "./contracts";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import { catalogPrimaryWorkbenchHref } from "./primary-workbench-route-context";
import {
  emptyCatalogPrimaryWorkbenchScopeContext,
  importScopeFromScopeContext,
  scopeContextFromProviderScope,
  scopeContextFromRouteContext,
  scopeDisplayLabel,
} from "./primary-workbench-scope-context";
import {
  actionStateForBlockers,
  credentialBlockerFor,
  providerTransportBlockerFor,
  providerTransportFor,
  sourceOptionKindsForProfile,
} from "./primary-workbench-read-model-support";

type SourceScopeWorksetInput = Readonly<{
  canManage: boolean;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"];
  profiles: readonly CatalogProviderProfileVersionReview[];
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  scopes: readonly SourceObservationIntegrationScope[];
  sourceOptions: CatalogPrimaryWorkbenchReadModel["sourceOptions"];
}>;

type SourceScopeCandidate = Readonly<{
  providerKey: string;
  displayName: string;
  unitKey: CatalogIntegrationUnitKey | null;
  productDomain: string | null;
  productForm: string | null;
  profile: CatalogProviderProfileVersionReview | null;
  readinessUnit: CatalogIntegrationControlPlaneUnitReadiness | null;
}>;

type SourceScopeSelection = Readonly<{
  hasConcreteScope: boolean;
  importScope: string | null;
  label: string;
  scope: CatalogPrimaryWorkbenchScopeContext;
}>;

export function sourceScopeWorksetFor(
  input: SourceScopeWorksetInput,
): CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"] {
  const selectedScope = selectedSourceScope(input);
  const units = sourceScopeCandidates(input)
    .filter((candidate) => candidateIsRelevantToSelection(candidate, selectedScope, input.scopes, input.routeContext))
    .map((candidate) => sourceScopeUnitRow(candidate, selectedScope, input));
  const summary = {
    unitCount: units.length,
    readyUnitCount: units.filter((unit) => unit.state !== "blocked").length,
    blockedUnitCount: units.filter((unit) => unit.state === "blocked").length,
    activeImportCount: units.reduce((count, unit) => count + unit.activeJobCount, 0),
    changedObservationCount: units.reduce((count, unit) => count + unit.counts.changed, 0),
    promotedObservationCount: units.reduce((count, unit) => count + unit.counts.promoted, 0),
  };

  return {
    status: sourceScopeWorksetStatus(units, selectedScope),
    generatedAt: input.generatedAt,
    selectedScope,
    summary,
    units,
  };
}

function sourceScopeWorksetStatus(
  units: readonly CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"]["units"][number][],
  selectedScope: SourceScopeSelection,
): CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"]["status"] {
  if (units.length === 0) {
    return "not-configured";
  }
  if (!selectedScope.hasConcreteScope) {
    return "scope-required";
  }
  if (units.every((unit) => unit.state === "blocked")) {
    return "blocked";
  }
  if (units.some((unit) => unit.state === "blocked" || unit.optionQueryState === "degraded")) {
    return "degraded";
  }

  return "ready";
}

function selectedSourceScope(
  input: Pick<SourceScopeWorksetInput, "profiles" | "routeContext" | "scopes" | "sourceOptions">,
) {
  const routeContext = input.routeContext;
  const explicitScope = explicitScopeFromRouteContext(routeContext);
  const routeScope = scopeHasConcreteSelection(explicitScope)
    ? explicitScope
    : scopeContextFromRouteContext(routeContext);
  const scope = enrichedSetNameSelectedScope(routeScope, input.profiles, input.sourceOptions, input.scopes);
  const hasConcreteScope = scopeHasConcreteSelection(scope);
  const importScope = hasConcreteScope ? importScopeFromScopeContext(scope) : null;

  return {
    hasConcreteScope,
    importScope,
    label: hasConcreteScope ? scopeDisplayLabel(scope) : "Select a source scope",
    scope,
  };
}

function enrichedSetNameSelectedScope(
  scope: CatalogPrimaryWorkbenchScopeContext,
  profiles: readonly CatalogProviderProfileVersionReview[],
  sourceOptions: CatalogPrimaryWorkbenchReadModel["sourceOptions"],
  scopes: readonly SourceObservationIntegrationScope[],
): CatalogPrimaryWorkbenchScopeContext {
  const providerKey = scope.providerKey;
  if (!providerKey) {
    return scope;
  }
  const profile = activeProfileForProvider(profiles, providerKey);
  if (!sourceOptionKindsForProfile(profile).some((kind) => kind.scope === "set-name")) {
    return scope;
  }
  const selectedValue = scope.expansionName ?? scope.expansionId;
  if (!selectedValue) {
    return scope;
  }
  const page = sourceOptions.pages.find(
    (candidatePage) => candidatePage.request.providerKey === providerKey && candidatePage.scope === "set-name",
  );
  const option = page?.items.find((item) => item.value === selectedValue || item.label === selectedValue);
  if (!option?.label || option.label === selectedValue) {
    const productDomain = normalizeProductDomain(productDomainFromProfile(profile));
    const siblingScope = scopes.find((candidateScope) => {
      const candidateContext = scopeContextFromProviderScope(candidateScope);
      const candidateDomain = normalizeProductDomain(productDomainFromScope(candidateContext));
      return (
        Boolean(productDomain && candidateDomain && productDomainsMatch(productDomain, candidateDomain)) &&
        selectedScopeFieldMatches(selectedValue, [candidateScope.expansion_id, candidateScope.expansion_name]) &&
        Boolean(candidateScope.expansion_name) &&
        comparableText(candidateScope.expansion_name) !== comparableText(selectedValue)
      );
    });
    return siblingScope
      ? {
          ...scope,
          productLineName:
            scope.productLineName ??
            (siblingScope.product_line_name || productLineDisplayNameFromDomain(productDomainFromProfile(profile))),
          expansionName: siblingScope.expansion_name,
        }
      : scope;
  }

  return {
    ...scope,
    productLineName: scope.productLineName ?? productLineDisplayNameFromDomain(productDomainFromProfile(profile)),
    expansionName: option.label,
  };
}

function explicitScopeFromRouteContext(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): CatalogPrimaryWorkbenchScopeContext {
  return {
    providerKey: routeContext.providerKey ?? routeContext.scope?.providerKey ?? null,
    languageCode: routeContext.scope?.languageCode ?? null,
    productLineId: routeContext.scope?.productLineId ?? null,
    productLineName: routeContext.scope?.productLineName ?? null,
    seriesId: routeContext.scope?.seriesId ?? null,
    seriesName: routeContext.scope?.seriesName ?? null,
    expansionId: routeContext.scope?.expansionId ?? null,
    expansionName: routeContext.scope?.expansionName ?? null,
    status: routeContext.scope?.status ?? routeContext.sourceObservationFilters.status ?? null,
  };
}

function sourceScopeCandidates(input: SourceScopeWorksetInput): readonly SourceScopeCandidate[] {
  const candidates = new Map<string, SourceScopeCandidate>();

  for (const profile of input.profiles) {
    if (!profile.active) {
      continue;
    }
    upsertCandidate(candidates, {
      providerKey: profile.providerKey,
      displayName: profile.displayName || providerBaseDisplayName(profile.providerKey),
      unitKey: profile.ingestionUnitKey as CatalogIntegrationUnitKey,
      productDomain: productDomainFromProfile(profile),
      productForm: productFormFromProfile(profile),
      profile,
      readinessUnit: null,
    });
  }

  for (const unit of input.controlPlaneOverview?.readiness.units ?? []) {
    if (unit.ingestionPurpose === "source-observation-proof") {
      continue;
    }
    const profile = activeProfileForUnit(input.profiles, unit.providerKey, unit.unitKey);
    upsertCandidate(candidates, {
      providerKey: unit.providerKey,
      displayName: unit.displayName || profile?.displayName || providerBaseDisplayName(unit.providerKey),
      unitKey: unit.unitKey,
      productDomain: unit.productDomain,
      productForm: unit.productForm,
      profile,
      readinessUnit: unit,
    });
  }

  for (const scope of input.scopes) {
    const profile = activeProfileForProvider(input.profiles, scope.provider_key);
    const unitKey = (profile?.ingestionUnitKey ?? null) as CatalogIntegrationUnitKey | null;
    upsertCandidate(candidates, {
      providerKey: scope.provider_key,
      displayName: profile?.displayName || providerBaseDisplayName(scope.provider_key),
      unitKey,
      productDomain: productDomainFromProfile(profile),
      productForm: productFormFromProfile(profile),
      profile,
      readinessUnit:
        input.controlPlaneOverview?.readiness.units.find(
          (unit) => unit.providerKey === scope.provider_key && (!unitKey || unit.unitKey === unitKey),
        ) ?? null,
    });
  }

  const selectedProviderKey = input.routeContext.providerKey;
  if (
    selectedProviderKey &&
    ![...candidates.values()].some((candidate) => candidate.providerKey === selectedProviderKey)
  ) {
    const profile = activeProfileForProvider(input.profiles, selectedProviderKey);
    const unitKey = (profile?.ingestionUnitKey ??
      input.routeContext.unitKey ??
      null) as CatalogIntegrationUnitKey | null;
    upsertCandidate(candidates, {
      providerKey: selectedProviderKey,
      displayName: profile?.displayName || providerBaseDisplayName(selectedProviderKey),
      unitKey,
      productDomain: productDomainFromProfile(profile),
      productForm: productFormFromProfile(profile),
      profile,
      readinessUnit: null,
    });
  }

  return [...candidates.values()].sort((left, right) =>
    `${left.displayName}:${left.unitKey ?? ""}`.localeCompare(`${right.displayName}:${right.unitKey ?? ""}`),
  );
}

function upsertCandidate(candidates: Map<string, SourceScopeCandidate>, candidate: SourceScopeCandidate): void {
  const key = `${candidate.providerKey}:${candidate.unitKey ?? "none"}`;
  const current = candidates.get(key);
  if (!current) {
    candidates.set(key, candidate);
    return;
  }
  candidates.set(key, {
    providerKey: current.providerKey,
    displayName: candidate.displayName || current.displayName,
    unitKey: current.unitKey ?? candidate.unitKey,
    productDomain: candidate.productDomain ?? current.productDomain,
    productForm: candidate.productForm ?? current.productForm,
    profile: candidate.profile ?? current.profile,
    readinessUnit: candidate.readinessUnit ?? current.readinessUnit,
  });
}

function candidateIsRelevantToSelection(
  candidate: SourceScopeCandidate,
  selectedScope: SourceScopeSelection,
  scopes: readonly SourceObservationIntegrationScope[],
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): boolean {
  if (!selectedScope.hasConcreteScope) {
    return routeContext.providerKey ? candidate.providerKey === routeContext.providerKey : true;
  }
  if (routeContext.unitKey === candidate.unitKey) {
    return true;
  }
  const selectedScopeMatchesCandidate =
    selectedScopeMatchesCandidateProfile(candidate, selectedScope.scope) &&
    sourceScopeMatchesCandidateProductDomain(candidate, selectedScope.scope);
  if (routeContext.providerKey === candidate.providerKey && selectedScopeMatchesCandidate) {
    return true;
  }
  const providerScopes = scopes.filter(
    (scope) =>
      scope.provider_key === candidate.providerKey && providerScopeMatchesCandidateProductDomain(candidate, scope),
  );
  if (providerScopes.some((scope) => providerScopeMatchesSelectedScope(selectedScope.scope, scope))) {
    return true;
  }
  if (!sourceScopeMatchesCandidateProductDomain(candidate, selectedScope.scope)) {
    return false;
  }

  return candidateProfileMatchesSelectedScope(candidate, selectedScope.scope);
}

function sourceScopeUnitRow(
  candidate: SourceScopeCandidate,
  selectedScope: SourceScopeSelection,
  input: SourceScopeWorksetInput,
): CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"]["units"][number] {
  const matchingScopes = input.scopes.filter(
    (scope) =>
      scope.provider_key === candidate.providerKey &&
      providerScopeMatchesCandidateProductDomain(candidate, scope) &&
      providerScopeMatchesSelectedScope(selectedScope.scope, scope),
  );
  const routeScope = providerCommandScope(
    candidate,
    selectedScope.scope,
    matchingScopes[0] ?? null,
    input.sourceOptions,
    input.scopes,
  );
  const importScope = selectedScope.hasConcreteScope ? importScopeFromScopeContext(routeScope) : null;
  const workbenchScope = selectedScope.hasConcreteScope
    ? routeScope
    : emptyCatalogPrimaryWorkbenchScopeContext(candidate.providerKey);
  const jobs = importScope
    ? input.importJobs.jobs.filter(
        (job) =>
          job.providerKey === candidate.providerKey &&
          (!candidate.unitKey || job.unitKey === candidate.unitKey) &&
          job.importScope === importScope,
      )
    : [];
  const activeJobCount = jobs.filter((job) => job.state === "queued" || job.state === "running").length;
  const counts = providerCounts(matchingScopes);
  const blockers = unitReadinessBlockers(candidate, input);
  const commandContext = {
    providerKey: candidate.providerKey,
    unitKey: candidate.unitKey,
    importScope,
    profileVersion: candidate.profile?.profileVersion ?? null,
    languageCode: routeScope.languageCode,
    productLineId: routeScope.productLineId,
    productLineName: routeScope.productLineName,
    seriesId: routeScope.seriesId,
    seriesName: routeScope.seriesName,
    expansionId: routeScope.expansionId,
    expansionName: routeScope.expansionName,
  };

  return {
    providerKey: candidate.providerKey,
    displayName: candidate.displayName,
    unitKey: candidate.unitKey,
    productDomain: candidate.productDomain,
    productForm: candidate.productForm,
    profileVersion: candidate.profile?.profileVersion ?? null,
    importScope,
    profileReady: Boolean(candidate.profile?.active),
    optionQueryState:
      input.sourceOptions.selectedProviderKey === candidate.providerKey ? input.sourceOptions.status : "unavailable",
    state: unitState({
      activeJobCount,
      counts,
      hasScope: selectedScope.hasConcreteScope && Boolean(importScope),
      blockers,
    }),
    counts,
    activeJobCount,
    lastJobState: jobs[0]?.state ?? null,
    currentWorkbenchHref: catalogPrimaryWorkbenchHref(
      {
        ...input.routeContext,
        providerKey: candidate.providerKey,
        unitKey: candidate.unitKey,
        scope: workbenchScope,
        importScope,
        profileVersion: candidate.profile?.profileVersion ?? null,
        sourceObservationFilters: {},
        reviewOffset: null,
        reviewLimit: null,
        jobId: null,
        promotionPreviewId: null,
        selectedObservationIds: [],
      },
      "import-to-promotion",
    ),
    commandContext,
    actions: {
      import: action(
        "scope.import",
        importBlockers(
          input.canManage,
          selectedScope,
          candidate.profile,
          candidate.unitKey,
          importScope,
          activeJobCount,
          blockers,
        ),
      ),
      previewPromotion: action(
        "observation.promote",
        promotionPreviewBlockers(
          input.canManage,
          selectedScope,
          candidate.profile,
          candidate.unitKey,
          importScope,
          counts.eligible,
          blockers,
        ),
      ),
      reapply: action(
        "observation.reapply",
        reapplyBlockers(
          input.canManage,
          selectedScope,
          candidate.profile,
          candidate.unitKey,
          importScope,
          counts.promoted,
          blockers,
        ),
      ),
    },
  };
}

function providerCommandScope(
  candidate: SourceScopeCandidate,
  selectedScope: CatalogPrimaryWorkbenchScopeContext,
  matchingScope: SourceObservationIntegrationScope | null,
  sourceOptions: CatalogPrimaryWorkbenchReadModel["sourceOptions"],
  scopes: readonly SourceObservationIntegrationScope[],
): CatalogPrimaryWorkbenchScopeContext {
  const providerScope = matchingScope
    ? scopeContextFromProviderScope(matchingScope)
    : emptyCatalogPrimaryWorkbenchScopeContext(candidate.providerKey);
  const selectedSetOption = selectedSetNameOption(candidate, selectedScope, sourceOptions, scopes);
  const selectedScopeMatchesCandidate =
    selectedScope.providerKey === candidate.providerKey &&
    selectedScopeMatchesCandidateProfile(candidate, selectedScope) &&
    sourceScopeMatchesCandidateProductDomain(candidate, selectedScope);
  const canProjectSelectedScope = selectedScopeMatchesCandidate || Boolean(matchingScope);
  const preferProviderScope = Boolean(matchingScope) && !selectedScopeMatchesCandidate;

  return {
    providerKey: candidate.providerKey,
    languageCode: canProjectSelectedScope
      ? (selectedScope.languageCode ?? providerScope.languageCode ?? candidate.profile?.languageOptions[0] ?? null)
      : providerScope.languageCode,
    productLineId: scopedValue(
      canProjectSelectedScope ? selectedScope.productLineId : null,
      providerScope.productLineId,
      preferProviderScope,
    ),
    productLineName: scopedValue(
      canProjectSelectedScope ? selectedScope.productLineName : null,
      providerScope.productLineName ?? selectedSetOption?.productLineName ?? null,
      preferProviderScope,
    ),
    seriesId: scopedValue(
      canProjectSelectedScope ? selectedScope.seriesId : null,
      providerScope.seriesId,
      preferProviderScope,
    ),
    seriesName: scopedValue(
      canProjectSelectedScope ? selectedScope.seriesName : null,
      providerScope.seriesName,
      preferProviderScope,
    ),
    expansionId: scopedValue(
      canProjectSelectedScope ? selectedScope.expansionId : null,
      providerScope.expansionId,
      preferProviderScope,
    ),
    expansionName: scopedNameValue(
      canProjectSelectedScope ? (selectedSetOption?.label ?? selectedScope.expansionName) : null,
      providerScope.expansionName,
      canProjectSelectedScope ? selectedScope.expansionId : null,
      providerScope.expansionId,
      preferProviderScope,
    ),
    status: canProjectSelectedScope ? (selectedScope.status ?? null) : null,
  };
}

function selectedSetNameOption(
  candidate: SourceScopeCandidate,
  selectedScope: CatalogPrimaryWorkbenchScopeContext,
  sourceOptions: CatalogPrimaryWorkbenchReadModel["sourceOptions"],
  scopes: readonly SourceObservationIntegrationScope[],
): Readonly<{ label: string; productLineName: string | null }> | null {
  if (!candidate.profile || !sourceOptionKindsForProfile(candidate.profile).some((kind) => kind.scope === "set-name")) {
    return null;
  }

  const selectedValue = selectedScope.expansionName ?? selectedScope.expansionId;
  if (!selectedValue) {
    return null;
  }

  const page = sourceOptions.pages.find(
    (candidatePage) =>
      candidatePage.request.providerKey === candidate.providerKey && candidatePage.scope === "set-name",
  );
  const option = page?.items.find((item) => item.value === selectedValue || item.label === selectedValue);
  if (!option?.label || option.label === selectedValue) {
    const scope = scopes.find(
      (candidateScope) =>
        sourceScopeMatchesCandidateProductDomain(candidate, scopeContextFromProviderScope(candidateScope)) &&
        selectedScopeFieldMatches(selectedValue, [candidateScope.expansion_id, candidateScope.expansion_name]) &&
        Boolean(candidateScope.expansion_name) &&
        comparableText(candidateScope.expansion_name) !== comparableText(selectedValue),
    );
    return scope
      ? {
          label: scope.expansion_name,
          productLineName: scope.product_line_name || productLineDisplayNameFromDomain(candidate.productDomain),
        }
      : null;
  }

  return {
    label: option.label,
    productLineName: productLineDisplayNameFromDomain(candidate.productDomain),
  };
}

function selectedScopeMatchesCandidateProfile(
  candidate: SourceScopeCandidate,
  selectedScope: CatalogPrimaryWorkbenchScopeContext,
): boolean {
  return profileCanSelectScope(candidate.profile, selectedScope);
}

function providerScopeMatchesCandidateProductDomain(
  candidate: SourceScopeCandidate,
  scope: SourceObservationIntegrationScope,
): boolean {
  return sourceScopeMatchesCandidateProductDomain(candidate, scopeContextFromProviderScope(scope));
}

function sourceScopeMatchesCandidateProductDomain(
  candidate: SourceScopeCandidate,
  scope: CatalogPrimaryWorkbenchScopeContext,
): boolean {
  const selectedDomain = productDomainFromScope(scope);
  const candidateDomain = normalizeProductDomain(candidate.productDomain);
  if (!selectedDomain || !candidateDomain) {
    return true;
  }

  return productDomainsMatch(selectedDomain, candidateDomain);
}

function productDomainFromScope(scope: CatalogPrimaryWorkbenchScopeContext): string | null {
  return (
    tcgplayerProductLineDomain(scope.productLineId) ??
    productDomainFromProductLineName(scope.productLineName) ??
    productDomainFromProductLineId(scope.productLineId)
  );
}

function tcgplayerProductLineDomain(productLineId: string | null): string | null {
  switch (productLineId?.trim()) {
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

function productDomainFromProductLineName(productLineName: string | null): string | null {
  const normalized = normalizeProductDomain(productLineName);
  if (!normalized) {
    return null;
  }
  if (normalized.includes("pokemon")) {
    return "pokemon";
  }
  if (normalized.includes("magic") || normalized.includes("mtg")) {
    return "mtg";
  }
  if (normalized.includes("yugioh")) {
    return "yugioh";
  }

  return normalized;
}

function productLineDisplayNameFromDomain(productDomain: string | null): string | null {
  switch (normalizeProductDomain(productDomain)) {
    case "lorcana":
      return "Disney Lorcana";
    case "mtg":
      return "Magic: The Gathering";
    case "onepiece":
      return "One Piece Card Game";
    case "pokemon":
      return "Pokemon";
    case "yugioh":
      return "Yu-Gi-Oh!";
    default:
      return null;
  }
}

function productDomainFromProductLineId(productLineId: string | null): string | null {
  const normalized = normalizeProductDomain(productLineId);
  if (!normalized || /^\d+$/.test(normalized)) {
    return null;
  }

  return productDomainFromProductLineName(normalized) ?? normalized;
}

function normalizeProductDomain(value: string | null | undefined): string | null {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9]+/g, "") ?? "";
  return normalized || null;
}

function productDomainsMatch(left: string, right: string): boolean {
  return left === right || left.includes(right) || right.includes(left);
}

function scopedValue(selected: string | null, provider: string | null, preferProviderScope: boolean): string | null {
  return preferProviderScope ? (provider ?? selected) : (selected ?? provider);
}

function scopedNameValue(
  selectedName: string | null,
  providerName: string | null,
  selectedId: string | null,
  providerId: string | null,
  preferProviderScope: boolean,
): string | null {
  const value = scopedValue(selectedName, providerName, preferProviderScope);
  if (!providerName || preferProviderScope) {
    return value;
  }

  const selectedLooksLikeProviderId =
    Boolean(selectedName && providerId) &&
    comparableScopeToken(selectedName) === comparableScopeToken(providerId) &&
    comparableScopeToken(providerName) !== comparableScopeToken(providerId);
  const selectedIdAlreadyNamesProvider = Boolean(
    selectedId &&
    providerName &&
    comparableScopeToken(selectedId) === comparableScopeToken(providerName) &&
    comparableScopeToken(providerName) !== comparableScopeToken(providerId),
  );
  return selectedLooksLikeProviderId && !selectedIdAlreadyNamesProvider ? providerName : value;
}

function comparableScopeToken(value: string | null | undefined): string | null {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9]+/g, "") ?? "";
  return normalized || null;
}

function profileCanSelectScope(
  profile: CatalogProviderProfileVersionReview | null,
  scope: CatalogPrimaryWorkbenchScopeContext,
): boolean {
  const sourceOptionKinds = sourceOptionKindsForProfile(profile);
  if (!profile || sourceOptionKinds.length === 0) {
    return true;
  }

  const selectableScopes = new Set(sourceOptionKinds.map((kind) => kind.scope));
  const selectsSetName = selectableScopes.has("set-name");
  if (
    Boolean(scope.productLineId || scope.productLineName) &&
    !selectableScopes.has("product-line/category") &&
    !selectsSetName
  ) {
    return false;
  }
  if (Boolean(scope.seriesId || scope.seriesName) && !selectableScopes.has("series")) {
    return false;
  }
  if (scope.expansionId && !selectableScopes.has("expansion") && !selectsSetName) {
    return false;
  }
  if (scope.expansionName && !selectableScopes.has("expansion") && !selectableScopes.has("set-name")) {
    return false;
  }

  return true;
}

function providerCounts(scopes: readonly SourceObservationIntegrationScope[]) {
  const observed = sumScopes(scopes, "observed_observations");
  const changed = sumScopes(scopes, "changed_observations");
  return {
    observed,
    changed,
    promoted: sumScopes(scopes, "promoted_observations"),
    rejected: sumScopes(scopes, "rejected_observations"),
    eligible: observed + changed,
  };
}

function sumScopes(
  scopes: readonly SourceObservationIntegrationScope[],
  key: keyof Pick<
    SourceObservationIntegrationScope,
    "observed_observations" | "changed_observations" | "promoted_observations" | "rejected_observations"
  >,
): number {
  return scopes.reduce((count, scope) => count + scope[key], 0);
}

function unitState(input: {
  activeJobCount: number;
  counts: ReturnType<typeof providerCounts>;
  hasScope: boolean;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}): CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"]["units"][number]["state"] {
  if (!input.hasScope || input.blockers.length > 0) {
    return "blocked";
  }
  if (input.counts.changed > 0) {
    return "changed";
  }
  if (input.counts.promoted > 0) {
    return "promoted";
  }
  if (input.counts.observed > 0 || input.activeJobCount > 0) {
    return "imported";
  }

  return "not-imported";
}

function importBlockers(
  canManage: boolean,
  selectedScope: SourceScopeSelection,
  profile: CatalogProviderProfileVersionReview | null,
  unitKey: CatalogIntegrationUnitKey | null,
  importScope: string | null,
  activeJobCount: number,
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const shared = sharedCommandBlockers(canManage, selectedScope, profile, unitKey, importScope, blockers);
  if (shared.includes("import-scope-required")) {
    return shared;
  }
  return activeJobCount > 0 ? [...shared, "active-job-conflict"] : shared;
}

function promotionPreviewBlockers(
  canManage: boolean,
  selectedScope: SourceScopeSelection,
  profile: CatalogProviderProfileVersionReview | null,
  unitKey: CatalogIntegrationUnitKey | null,
  importScope: string | null,
  eligibleCount: number,
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const shared = sharedCommandBlockers(canManage, selectedScope, profile, unitKey, importScope, blockers);
  return shared.length > 0 ? shared : eligibleCount > 0 ? [] : ["no-promotion-eligible-observations"];
}

function reapplyBlockers(
  canManage: boolean,
  selectedScope: SourceScopeSelection,
  profile: CatalogProviderProfileVersionReview | null,
  unitKey: CatalogIntegrationUnitKey | null,
  importScope: string | null,
  promotedCount: number,
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const shared = sharedCommandBlockers(canManage, selectedScope, profile, unitKey, importScope, blockers);
  return shared.length > 0 ? shared : promotedCount > 0 ? [] : ["selection-empty"];
}

function sharedCommandBlockers(
  canManage: boolean,
  selectedScope: SourceScopeSelection,
  profile: CatalogProviderProfileVersionReview | null,
  unitKey: CatalogIntegrationUnitKey | null,
  importScope: string | null,
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  if (!selectedScope.hasConcreteScope || !importScope) {
    return ["import-scope-required"];
  }
  if (!canManage) {
    return ["permission-denied"];
  }
  if (!unitKey) {
    return ["unit-selection-required"];
  }
  if (!profile?.active) {
    return ["missing-active-profile"];
  }
  return blockers;
}

function action(
  key: CatalogPrimaryWorkbenchActionReadModel["key"],
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): CatalogPrimaryWorkbenchActionReadModel {
  const missingScopeOnly = blockers.length === 1 && blockers[0] === "import-scope-required";
  return {
    key,
    state: missingScopeOnly ? "disabled" : actionStateForBlockers(blockers, "available"),
    blockers,
    copyKey: blockers.length > 0 ? "catalog.primary.import.blocked" : null,
  };
}

function unitReadinessBlockers(
  candidate: SourceScopeCandidate,
  input: SourceScopeWorksetInput,
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  for (const blocker of input.readinessBlockers) {
    if (blocker === "kill-switch-active" || blocker === "rollout-disabled") {
      blockers.add(blocker);
    }
  }
  for (const control of input.controlPlaneOverview?.readiness.rolloutControls.controls ?? []) {
    const applies =
      (control.providerKeys.length === 0 || control.providerKeys.includes(candidate.providerKey)) &&
      (!candidate.unitKey || control.unitKeys.length === 0 || control.unitKeys.includes(candidate.unitKey));
    if (applies && control.status === "blocked") {
      blockers.add(control.defaultState === "quarantined" ? "kill-switch-active" : "rollout-disabled");
    }
  }
  for (const unit of input.controlPlaneOverview?.readiness.units ?? []) {
    if (unit.providerKey !== candidate.providerKey || (candidate.unitKey && unit.unitKey !== candidate.unitKey)) {
      continue;
    }
    if (unit.credentialReadiness === "blocked") {
      blockers.add(credentialBlockerFor(unit.credentialReadinessState));
    }
    if (unit.transportReadiness === "blocked") {
      blockers.add("provider-transport-degraded");
    }
    if (unit.fixtureValidationStatus === "blocked") {
      blockers.add("missing-fixture-coverage");
    }
  }
  for (const category of providerTransportFor(input.controlPlaneOverview, candidate.providerKey)) {
    blockers.add(providerTransportBlockerFor(category));
  }

  return [...blockers];
}

function activeProfileForUnit(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string,
  unitKey: string | null,
): CatalogProviderProfileVersionReview | null {
  return (
    profiles.find(
      (profile) => profile.active && profile.providerKey === providerKey && profile.ingestionUnitKey === unitKey,
    ) ?? activeProfileForProvider(profiles, providerKey)
  );
}

function activeProfileForProvider(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string,
): CatalogProviderProfileVersionReview | null {
  return profiles.find((profile) => profile.active && profile.providerKey === providerKey) ?? null;
}

function productDomainFromProfile(profile: CatalogProviderProfileVersionReview | null): string | null {
  const unitSegment = profile?.ingestionUnitKey.split(":")[1] ?? null;
  return unitSegment ?? profile?.supportedScopes[0]?.split("/")[0] ?? null;
}

function productFormFromProfile(profile: CatalogProviderProfileVersionReview | null): string | null {
  const unitSegment = profile?.ingestionUnitKey.split(":")[2] ?? null;
  return unitSegment ?? profile?.supportedScopes[0]?.split("/")[1] ?? null;
}

function providerScopeMatchesSelectedScope(
  selectedScope: CatalogPrimaryWorkbenchScopeContext,
  scope: SourceObservationIntegrationScope,
): boolean {
  const scopeContext = scopeContextFromProviderScope(scope);
  return (
    selectedScopeFieldMatches(selectedScope.languageCode, [scopeContext.languageCode]) &&
    selectedScopePairMatches(
      [selectedScope.productLineId, selectedScope.productLineName],
      [scopeContext.productLineId, scopeContext.productLineName],
    ) &&
    selectedScopePairMatches(
      [selectedScope.seriesId, selectedScope.seriesName],
      [scopeContext.seriesId, scopeContext.seriesName],
    ) &&
    selectedScopePairMatches(
      [selectedScope.expansionId, selectedScope.expansionName],
      [scopeContext.expansionId, scopeContext.expansionName],
    )
  );
}

function selectedScopePairMatches(
  expectedValues: readonly (string | null)[],
  actualValues: readonly (string | null)[],
): boolean {
  const expected = expectedValues.filter((value): value is string => Boolean(value));
  return expected.length === 0 || expected.some((value) => selectedScopeFieldMatches(value, actualValues));
}

function selectedScopeFieldMatches(expected: string | null, actuals: readonly (string | null)[]): boolean {
  if (!expected) {
    return true;
  }
  return actuals.some((actual) => comparableText(actual) === comparableText(expected));
}

function candidateProfileMatchesSelectedScope(
  candidate: SourceScopeCandidate,
  selectedScope: CatalogPrimaryWorkbenchScopeContext,
): boolean {
  const selectionTokens = scopeTokens(selectedScope);
  if (selectionTokens.size === 0) {
    return true;
  }
  const candidateText = comparableText(
    [
      candidate.providerKey,
      candidate.displayName,
      candidate.unitKey,
      candidate.productDomain,
      candidate.productForm,
      candidate.profile?.displayName,
      candidate.profile?.mappingOutputKind,
      ...(candidate.profile?.supportedScopes ?? []),
    ]
      .filter(Boolean)
      .join(" "),
  );

  for (const token of selectionTokens) {
    if (candidateText.includes(token)) {
      return true;
    }
  }

  return false;
}

function scopeTokens(scope: CatalogPrimaryWorkbenchScopeContext): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const value of [
    scope.productLineId,
    scope.productLineName,
    scope.seriesId,
    scope.seriesName,
    scope.expansionId,
    scope.expansionName,
  ]) {
    addComparableTokens(tokens, value);
  }

  return tokens;
}

function addComparableTokens(tokens: Set<string>, value: string | null): void {
  const comparable = comparableText(value);
  if (!comparable || isGenericScopeToken(comparable)) {
    return;
  }
  if (comparable.length >= 3) {
    tokens.add(comparable);
  }
  const words = (value ?? "")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0 && !isGenericScopeToken(comparableText(word)));
  if (words.length > 1) {
    tokens.add(words.map((word) => word[0]?.toLowerCase() ?? "").join(""));
  }
}

function scopeHasConcreteSelection(scope: CatalogPrimaryWorkbenchScopeContext): boolean {
  return Boolean(
    scope.languageCode ||
    scope.productLineId ||
    scope.productLineName ||
    scope.seriesId ||
    scope.seriesName ||
    scope.expansionId ||
    scope.expansionName,
  );
}

function comparableText(value: string | null | undefined): string {
  return value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
}

function isGenericScopeToken(token: string): boolean {
  return new Set([
    "card",
    "cards",
    "data",
    "import",
    "line",
    "product",
    "products",
    "reference",
    "scope",
    "set",
    "sets",
    "single",
    "source",
    "the",
  ]).has(token);
}

function providerBaseDisplayName(providerKey: string): string {
  const names = new Map([
    ["mtgjson", "MTGJSON"],
    ["scryfall", "Scryfall"],
    ["scrydex", "Scrydex"],
    ["tcgdex", "TCGdex"],
    ["tcgplayer", "TCGplayer"],
  ]);

  return names.get(providerKey) ?? providerKey;
}
