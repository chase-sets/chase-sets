import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchMagicSetSyncProviderReadModel,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchScopeContext,
} from "../api/primary-workbench-admin-contracts";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
} from "./contracts";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import { catalogPrimaryWorkbenchHref } from "./primary-workbench-route-context";
import {
  emptyCatalogPrimaryWorkbenchScopeContext,
  importScopeFromScopeContext,
  scopeContextMatchesProviderScope,
} from "./primary-workbench-scope-context";
import {
  actionStateForBlockers,
  credentialBlockerFor,
  providerTransportBlockerFor,
  providerTransportFor,
} from "./primary-workbench-read-model-support";

const MAGIC_PROVIDER_KEYS = ["mtgjson", "scryfall", "tcgplayer"] as const;

type MagicProviderKey = (typeof MAGIC_PROVIDER_KEYS)[number];

type MagicSetSyncInput = Readonly<{
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

export function magicSetSyncFor(input: MagicSetSyncInput): CatalogPrimaryWorkbenchReadModel["magicSetSync"] {
  const magicProfiles = input.profiles.filter(isMagicProviderProfile);
  const magicScopes = input.scopes.filter(isMagicProviderScope);
  const providerKeys = magicProviderKeys(input.controlPlaneOverview, magicProfiles, magicScopes);
  const selectedSet = selectedMagicSet(input.routeContext);
  const setOptions = magicSetOptions(input.sourceOptions, magicScopes);
  const providers = providerKeys.map((providerKey) => magicProviderRow(providerKey, selectedSet, input));
  const summary = {
    providerCount: providers.length,
    readyProviderCount: providers.filter((provider) => provider.state !== "blocked").length,
    blockedProviderCount: providers.filter((provider) => provider.state === "blocked").length,
    activeImportCount: providers.reduce((count, provider) => count + provider.activeJobCount, 0),
    changedObservationCount: providers.reduce((count, provider) => count + provider.counts.changed, 0),
    promotedObservationCount: providers.reduce((count, provider) => count + provider.counts.promoted, 0),
  };

  return {
    status: magicSetSyncStatus(providers, selectedSet.setId || selectedSet.setName),
    generatedAt: input.generatedAt,
    selectedSet: {
      setId: selectedSet.setId,
      setName: selectedSet.setName,
      label: selectedSet.setName ?? selectedSet.setId ?? "Select one Magic set",
    },
    setOptions,
    summary,
    providers,
  };
}

function magicSetSyncStatus(
  providers: readonly CatalogPrimaryWorkbenchMagicSetSyncProviderReadModel[],
  selectedSetKey: string | null,
): CatalogPrimaryWorkbenchReadModel["magicSetSync"]["status"] {
  if (providers.length === 0) {
    return "not-configured";
  }
  if (!selectedSetKey) {
    return "set-required";
  }
  if (providers.every((provider) => provider.state === "blocked")) {
    return "blocked";
  }
  if (providers.some((provider) => provider.state === "blocked" || provider.optionQueryState === "degraded")) {
    return "degraded";
  }

  return "ready";
}

function magicProviderRow(
  providerKey: MagicProviderKey,
  selectedSet: Readonly<{ setId: string | null; setName: string | null }>,
  input: MagicSetSyncInput,
): CatalogPrimaryWorkbenchMagicSetSyncProviderReadModel {
  const profiles = input.profiles.filter(
    (profile) => profile.providerKey === providerKey && isMagicProviderProfile(profile),
  );
  const profile = profiles.find((candidate) => candidate.active) ?? profiles[0] ?? null;
  const matchingScope = providerSetScopes(input.scopes, providerKey, selectedSet);
  const routeScope = providerMagicScope(providerKey, selectedSet, matchingScope[0] ?? null, input.routeContext.scope);
  const importScope = selectedSet.setId || selectedSet.setName ? importScopeFromScopeContext(routeScope) : null;
  const unitKey = (profile?.ingestionUnitKey ??
    input.controlPlaneOverview?.readiness.units.find((unit) => unit.providerKey === providerKey)?.unitKey ??
    null) as CatalogIntegrationUnitKey | null;
  const jobs = input.importJobs.jobs.filter(
    (job) =>
      job.providerKey === providerKey &&
      (!unitKey || job.unitKey === unitKey) &&
      (!importScope || job.importScope === importScope),
  );
  const activeJobCount = jobs.filter((job) => job.state === "queued" || job.state === "running").length;
  const counts = providerCounts(matchingScope);
  const providerBlockers = providerReadinessBlockers(providerKey, unitKey, input);
  const commandContext = {
    providerKey,
    unitKey,
    importScope,
    profileVersion: profile?.profileVersion ?? null,
    languageCode: routeScope.languageCode,
    productLineId: routeScope.productLineId,
    productLineName: routeScope.productLineName,
    seriesId: routeScope.seriesId,
    seriesName: routeScope.seriesName,
    expansionId: routeScope.expansionId,
    expansionName: routeScope.expansionName,
  };

  return {
    providerKey,
    displayName: magicProviderDisplayName(providerKey),
    unitKey,
    profileVersion: profile?.profileVersion ?? null,
    importScope,
    profileReady: Boolean(profile?.active),
    optionQueryState: optionQueryStateForProvider(providerKey, input.sourceOptions),
    state: providerState({
      activeJobCount,
      counts,
      hasSet: Boolean(selectedSet.setId || selectedSet.setName),
      providerBlockers,
    }),
    counts,
    activeJobCount,
    lastJobState: jobs[0]?.state ?? null,
    currentWorkbenchHref: catalogPrimaryWorkbenchHref(
      {
        ...input.routeContext,
        providerKey,
        unitKey,
        scope: routeScope,
        importScope,
        profileVersion: profile?.profileVersion ?? null,
        promotionPreviewId: null,
        selectedObservationIds: [],
      },
      "import-to-promotion",
    ),
    commandContext,
    actions: {
      import: action(
        "start-provider-import",
        importBlockers(input.canManage, selectedSet, profile, unitKey, activeJobCount, providerBlockers),
      ),
      previewPromotion: action(
        "preview-promotion",
        promotionPreviewBlockers(input.canManage, selectedSet, profile, unitKey, counts.eligible, providerBlockers),
      ),
      reapply: action(
        "start-reapply",
        reapplyBlockers(input.canManage, selectedSet, profile, unitKey, counts.promoted, providerBlockers),
      ),
    },
  };
}

function selectedMagicSet(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): Readonly<{ setId: string | null; setName: string | null }> {
  return {
    setId: routeContext.scope?.expansionId ?? null,
    setName: routeContext.scope?.expansionName ?? null,
  };
}

function providerMagicScope(
  providerKey: MagicProviderKey,
  selectedSet: Readonly<{ setId: string | null; setName: string | null }>,
  matchingScope: SourceObservationIntegrationScope | null,
  routeScope: CatalogPrimaryWorkbenchRouteContext["scope"],
): CatalogPrimaryWorkbenchScopeContext {
  return {
    ...emptyCatalogPrimaryWorkbenchScopeContext(providerKey),
    languageCode: routeScope?.languageCode ?? matchingScope?.language_code ?? "en",
    productLineId: matchingScope?.product_line_id ?? routeScope?.productLineId ?? null,
    productLineName: matchingScope?.product_line_name ?? routeScope?.productLineName ?? "Magic: The Gathering",
    seriesId: matchingScope?.series_id ?? routeScope?.seriesId ?? null,
    seriesName: matchingScope?.series_name ?? routeScope?.seriesName ?? null,
    expansionId: selectedSet.setId ?? matchingScope?.expansion_id ?? null,
    expansionName: selectedSet.setName ?? matchingScope?.expansion_name ?? null,
    status: routeScope?.status ?? null,
  };
}

function providerSetScopes(
  scopes: readonly SourceObservationIntegrationScope[],
  providerKey: MagicProviderKey,
  selectedSet: Readonly<{ setId: string | null; setName: string | null }>,
): readonly SourceObservationIntegrationScope[] {
  const providerScopes = scopes.filter((scope) => scope.provider_key === providerKey && isMagicProviderScope(scope));
  if (!selectedSet.setId && !selectedSet.setName) {
    return [];
  }

  const selectedScope = providerMagicScope(providerKey, selectedSet, null, undefined);
  return providerScopes.filter((scope) => scopeContextMatchesProviderScope(selectedScope, scope));
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

function providerState(input: {
  activeJobCount: number;
  counts: ReturnType<typeof providerCounts>;
  hasSet: boolean;
  providerBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}): CatalogPrimaryWorkbenchMagicSetSyncProviderReadModel["state"] {
  if (!input.hasSet || input.providerBlockers.length > 0) {
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
  selectedSet: Readonly<{ setId: string | null; setName: string | null }>,
  profile: CatalogProviderProfileVersionReview | null,
  unitKey: CatalogIntegrationUnitKey | null,
  activeJobCount: number,
  providerBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = sharedCommandBlockers(canManage, selectedSet, profile, unitKey, providerBlockers);
  return activeJobCount > 0 ? [...blockers, "active-job-conflict"] : blockers;
}

function promotionPreviewBlockers(
  canManage: boolean,
  selectedSet: Readonly<{ setId: string | null; setName: string | null }>,
  profile: CatalogProviderProfileVersionReview | null,
  unitKey: CatalogIntegrationUnitKey | null,
  eligibleCount: number,
  providerBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = sharedCommandBlockers(canManage, selectedSet, profile, unitKey, providerBlockers);
  return blockers.length > 0 ? blockers : eligibleCount > 0 ? [] : ["no-promotion-eligible-observations"];
}

function reapplyBlockers(
  canManage: boolean,
  selectedSet: Readonly<{ setId: string | null; setName: string | null }>,
  profile: CatalogProviderProfileVersionReview | null,
  unitKey: CatalogIntegrationUnitKey | null,
  promotedCount: number,
  providerBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = sharedCommandBlockers(canManage, selectedSet, profile, unitKey, providerBlockers);
  return blockers.length > 0 ? blockers : promotedCount > 0 ? [] : ["selection-empty"];
}

function sharedCommandBlockers(
  canManage: boolean,
  selectedSet: Readonly<{ setId: string | null; setName: string | null }>,
  profile: CatalogProviderProfileVersionReview | null,
  unitKey: CatalogIntegrationUnitKey | null,
  providerBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  if (!canManage) {
    return ["permission-denied"];
  }
  if (!selectedSet.setId && !selectedSet.setName) {
    return ["import-scope-required"];
  }
  if (!unitKey) {
    return ["unit-selection-required"];
  }
  if (!profile?.active) {
    return ["missing-active-profile"];
  }
  return providerBlockers;
}

function action(
  key: CatalogPrimaryWorkbenchActionReadModel["key"],
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): CatalogPrimaryWorkbenchActionReadModel {
  const missingSetOnly = blockers.length === 1 && blockers[0] === "import-scope-required";
  return {
    key,
    state: missingSetOnly ? "disabled" : actionStateForBlockers(blockers, "available"),
    blockers,
    copyKey: blockers.length > 0 ? "catalog.primary.import.blocked" : null,
  };
}

function providerReadinessBlockers(
  providerKey: MagicProviderKey,
  unitKey: CatalogIntegrationUnitKey | null,
  input: MagicSetSyncInput,
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  for (const blocker of input.readinessBlockers) {
    if (blocker === "kill-switch-active" || blocker === "rollout-disabled") {
      blockers.add(blocker);
    }
  }
  for (const control of input.controlPlaneOverview?.readiness.rolloutControls.controls ?? []) {
    const applies =
      (control.providerKeys.length === 0 || control.providerKeys.includes(providerKey)) &&
      (!unitKey || control.unitKeys.length === 0 || control.unitKeys.includes(unitKey));
    if (applies && control.status === "blocked") {
      blockers.add(control.defaultState === "quarantined" ? "kill-switch-active" : "rollout-disabled");
    }
  }
  for (const unit of input.controlPlaneOverview?.readiness.units ?? []) {
    if (unit.providerKey !== providerKey || (unitKey && unit.unitKey !== unitKey)) {
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
  for (const category of providerTransportFor(input.controlPlaneOverview, providerKey)) {
    blockers.add(providerTransportBlockerFor(category));
  }

  return [...blockers];
}

function optionQueryStateForProvider(
  providerKey: MagicProviderKey,
  sourceOptions: CatalogPrimaryWorkbenchReadModel["sourceOptions"],
): CatalogPrimaryWorkbenchReadModel["sourceOptions"]["status"] {
  return sourceOptions.selectedProviderKey === providerKey ? sourceOptions.status : "unavailable";
}

function magicSetOptions(
  sourceOptions: CatalogPrimaryWorkbenchReadModel["sourceOptions"],
  scopes: readonly SourceObservationIntegrationScope[],
): CatalogPrimaryWorkbenchReadModel["magicSetSync"]["setOptions"] {
  const options = new Map<string, CatalogPrimaryWorkbenchReadModel["magicSetSync"]["setOptions"][number]>();
  for (const scope of scopes) {
    if (!scope.expansion_id && !scope.expansion_name) {
      continue;
    }
    const setId = scope.expansion_id || scope.expansion_name;
    const label = scope.expansion_name || scope.expansion_id;
    addMagicSetOption(options, {
      setId,
      setName: scope.expansion_name || null,
      label,
      providerKey: scope.provider_key,
    });
  }
  for (const page of sourceOptions.pages) {
    if (page.scope !== "expansion" && page.scope !== "set-name") {
      continue;
    }
    for (const item of page.items) {
      addMagicSetOption(options, {
        setId: item.value,
        setName: item.label,
        label: item.label,
        providerKey: item.providerKey,
      });
    }
  }

  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function addMagicSetOption(
  options: Map<string, CatalogPrimaryWorkbenchReadModel["magicSetSync"]["setOptions"][number]>,
  option: CatalogPrimaryWorkbenchReadModel["magicSetSync"]["setOptions"][number],
): void {
  const key = option.setId.trim().toLowerCase();
  if (!options.has(key)) {
    options.set(key, option);
  }
}

function magicProviderKeys(
  overview: CatalogIntegrationControlPlaneOverview | null,
  profiles: readonly CatalogProviderProfileVersionReview[],
  scopes: readonly SourceObservationIntegrationScope[],
): readonly MagicProviderKey[] {
  const keys = new Set<MagicProviderKey>();
  for (const providerKey of MAGIC_PROVIDER_KEYS) {
    if (
      profiles.some((profile) => profile.providerKey === providerKey) ||
      scopes.some((scope) => scope.provider_key === providerKey) ||
      overview?.readiness.units.some((unit) => unit.providerKey === providerKey)
    ) {
      keys.add(providerKey);
    }
  }

  return MAGIC_PROVIDER_KEYS.filter((providerKey) => keys.has(providerKey));
}

function isMagicProviderProfile(profile: CatalogProviderProfileVersionReview): boolean {
  if (!isMagicProviderKey(profile.providerKey)) {
    return false;
  }
  const profileText = [
    profile.ingestionUnitKey,
    profile.displayName,
    profile.mappingOutputKind,
    ...profile.supportedScopes,
    ...profile.sourceOptionKinds.map((kind) => `${kind.scope}:${kind.queryKind}`),
  ]
    .join(" ")
    .toLowerCase();

  return /magic|mtg|scryfall|tcgplayer/.test(profileText);
}

function isMagicProviderScope(scope: SourceObservationIntegrationScope): boolean {
  if (!isMagicProviderKey(scope.provider_key)) {
    return false;
  }
  return /magic|mtg|the gathering/i.test(
    [
      scope.product_line_id,
      scope.product_line_name,
      scope.series_id,
      scope.series_name,
      scope.expansion_id,
      scope.expansion_name,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function isMagicProviderKey(providerKey: string): providerKey is MagicProviderKey {
  return MAGIC_PROVIDER_KEYS.includes(providerKey as MagicProviderKey);
}

function magicProviderDisplayName(providerKey: MagicProviderKey): string {
  switch (providerKey) {
    case "mtgjson":
      return "MTGJSON";
    case "scryfall":
      return "Scryfall";
    case "tcgplayer":
      return "TCGplayer";
  }
}
