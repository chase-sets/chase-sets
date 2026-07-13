import { t } from "@chase-sets/localization";
import type { CatalogIntegrationUnitKey } from "./integration-unit";
import type { ProviderAdapterRegistry } from "./provider-adapters/registry";
import type { ProviderUsageEstimate } from "./provider-adapters/provider-adapter";
import type { CatalogProviderIntegrationProfileVersionRecord } from "./provider-integration-profiles";
import { unitKeyForCatalogProviderProfileVersion } from "./catalog-integration-impact-analysis";
import type { SourceObservationIntegrationJobScope } from "./runtime";

export type CatalogSyncScopeReferenceKind = "product-line" | "series" | "expansion" | "set" | "catalog-item";

export type CatalogSyncScopeReference = Readonly<{
  kind: CatalogSyncScopeReferenceKind;
  id?: string | null;
  name?: string | null;
  seriesId?: string | null;
  seriesName?: string | null;
}>;

export type CatalogSyncProviderScopeHint = Readonly<{
  providerKey: string;
  unitKey?: CatalogIntegrationUnitKey | null;
  productLineId?: string | null;
  productLineName?: string | null;
  seriesId?: string | null;
  setId?: string | null;
  setName?: string | null;
  productId?: string | null;
}>;

export type CatalogSyncProviderParticipationSelection = Readonly<{
  requiredUnitKeys?: readonly CatalogIntegrationUnitKey[];
  selectedUnitKeys?: readonly CatalogIntegrationUnitKey[];
  excludedUnitKeys?: readonly CatalogIntegrationUnitKey[];
}>;

export type CatalogSyncScope = Readonly<{
  scopeVersion: "catalog-sync-scope-v1";
  productDomain: string;
  productForm?: string | null;
  languageCode?: string | null;
  reference: CatalogSyncScopeReference;
  providerHints?: readonly CatalogSyncProviderScopeHint[];
  providerParticipation?: CatalogSyncProviderParticipationSelection | null;
}>;

export type CatalogSyncProviderParticipationBlocker = Readonly<{
  code:
    | "provider-adapter-missing"
    | "provider-adapter-diagnostics"
    | "provider-transport-unavailable"
    | "inactive-profile-unit"
    | "scope-product-domain-mismatch"
    | "scope-product-form-mismatch"
    | "scope-reference-unsupported"
    | "scope-parent-required"
    | "provider-plan-unavailable"
    | "required-provider-unit-missing";
  severity: "error" | "warning";
  message: string;
  action: string;
}>;

export type CatalogSyncProviderParticipationUnit = Readonly<{
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  role: "primary-source-observation" | "supplemental-marketplace-reference" | "reference-data" | "image-evidence";
  requirement: "required" | "optional";
  eligibility: "eligible" | "ineligible";
  defaultSelected: boolean;
  selected: boolean;
  childExecutionScope: SourceObservationIntegrationJobScope | null;
  estimate: Readonly<{
    targetCount: number | null;
    requestStrategy: ProviderUsageEstimate["requestStrategy"] | null;
    estimatedRequestCount: number | null;
    estimateState: ProviderUsageEstimate["estimateState"] | "not-requested" | "unavailable";
    estimateReason: string | null;
    transportSteps: readonly string[];
  }>;
  blockers: readonly CatalogSyncProviderParticipationBlocker[];
  explanation: string;
}>;

export type CatalogSyncProviderParticipationEstimate = Readonly<{
  totalEstimatedRequestCount: number | null;
  estimateState: "estimated" | "estimate-unavailable";
  estimateReason: string | null;
  creditConsumingProviders: readonly Readonly<{
    providerKey: string;
    displayName: string;
    unitKeys: readonly CatalogIntegrationUnitKey[];
  }>[];
}>;

export type CatalogSyncProviderParticipationPreview = Readonly<{
  previewVersion: "catalog-sync-provider-participation-preview-v1";
  scope: CatalogSyncScope;
  status: "ready" | "degraded" | "blocked";
  startAllowed: boolean;
  units: readonly CatalogSyncProviderParticipationUnit[];
  estimate: CatalogSyncProviderParticipationEstimate;
  blockers: readonly CatalogSyncProviderParticipationBlocker[];
  explanation: string;
}>;

export async function previewCatalogSyncProviderParticipation(input: {
  scope: CatalogSyncScope;
  providerProfileVersions: readonly CatalogProviderIntegrationProfileVersionRecord[];
  providerAdapterRegistry: ProviderAdapterRegistry;
}): Promise<CatalogSyncProviderParticipationPreview> {
  const scope = normalizeCatalogSyncScope(input.scope);
  const selectedUnitKeys = new Set(scope.providerParticipation?.selectedUnitKeys ?? []);
  const excludedUnitKeys = new Set(scope.providerParticipation?.excludedUnitKeys ?? []);
  const requiredUnitKeys = new Set(scope.providerParticipation?.requiredUnitKeys ?? []);
  const restrictToExplicitParticipation = selectedUnitKeys.size > 0 || requiredUnitKeys.size > 0;
  const activeCandidates = input.providerProfileVersions.filter((version) =>
    version.profile.capabilities.includes("source-observation-import"),
  );
  const matchingCandidates = activeCandidates
    .map((version) => ({ version, unitKey: unitKeyForCatalogProviderProfileVersion(version) }))
    .filter(({ version, unitKey }) => {
      if (excludedUnitKeys.has(unitKey)) {
        return false;
      }
      if (requiredUnitKeys.has(unitKey) || selectedUnitKeys.has(unitKey)) {
        return true;
      }
      if (restrictToExplicitParticipation) {
        return false;
      }
      return unitMatchesCatalogSyncScope(version, unitKey, scope);
    });

  const requiredDefaults = new Set(requiredUnitKeys);
  const plannedUnitKeys = new Set(matchingCandidates.map((candidate) => candidate.unitKey));
  const missingRequiredUnitBlockers: CatalogSyncProviderParticipationBlocker[] = [...requiredUnitKeys]
    .filter((unitKey) => !plannedUnitKeys.has(unitKey))
    .map((unitKey) => ({
      code: "required-provider-unit-missing",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.requiredUnitMissing", {
        unitKey,
      }),
      action: "Activate the provider profile unit or remove it from the required provider selection.",
    }));
  if (requiredDefaults.size === 0) {
    for (const candidate of matchingCandidates) {
      if (providerParticipationRole(candidate.version) === "primary-source-observation") {
        requiredDefaults.add(candidate.unitKey);
      }
    }
  }

  const units = await Promise.all(
    matchingCandidates.map(({ version, unitKey }) =>
      planProviderUnit({
        scope,
        version,
        unitKey,
        registry: input.providerAdapterRegistry,
        required: requiredDefaults.has(unitKey),
        explicitlySelected: selectedUnitKeys.has(unitKey),
      }),
    ),
  );
  const blockers = units.flatMap((unit) =>
    unit.requirement === "required" ? unit.blockers.filter((blocker) => blocker.severity === "error") : [],
  );
  const allBlockers = [...missingRequiredUnitBlockers, ...blockers];
  const hasIneligibleOptional = units.some(
    (unit) => unit.requirement === "optional" && unit.eligibility === "ineligible",
  );
  const status = allBlockers.length > 0 ? "blocked" : hasIneligibleOptional ? "degraded" : "ready";
  const estimate = aggregateCatalogSyncProviderParticipationEstimate(units);

  return {
    previewVersion: "catalog-sync-provider-participation-preview-v1",
    scope,
    status,
    startAllowed: status !== "blocked",
    units,
    estimate,
    blockers: allBlockers,
    explanation:
      status === "blocked"
        ? "Required provider units must be eligible before this Catalog sync can start."
        : status === "degraded"
          ? "The required provider units are eligible, but at least one selected optional unit cannot participate."
          : "Eligible provider units are ready to pull Source Observations for this Catalog scope.",
  };
}

export function aggregateCatalogSyncProviderParticipationEstimate(
  units: readonly CatalogSyncProviderParticipationUnit[],
  selectedUnitKeys?: ReadonlySet<string>,
): CatalogSyncProviderParticipationEstimate {
  const selectedEligibleUnits = units.filter(
    (unit) =>
      unit.eligibility === "eligible" && unit.selected && (!selectedUnitKeys || selectedUnitKeys.has(unit.unitKey)),
  );
  const estimates = selectedEligibleUnits.map((unit) => unit.estimate);
  const unavailableEstimate = estimates.find((estimate) => estimate.estimatedRequestCount === null);
  const creditConsumingProviders = creditConsumingProviderSummaries(selectedEligibleUnits);

  return {
    totalEstimatedRequestCount: unavailableEstimate
      ? null
      : estimates.reduce((total, estimate) => total + (estimate.estimatedRequestCount ?? 0), 0),
    estimateState: unavailableEstimate ? "estimate-unavailable" : "estimated",
    estimateReason: unavailableEstimate?.estimateReason ?? null,
    creditConsumingProviders,
  };
}

function creditConsumingProviderSummaries(
  units: readonly CatalogSyncProviderParticipationUnit[],
): CatalogSyncProviderParticipationEstimate["creditConsumingProviders"] {
  const summaries = new Map<
    string,
    { providerKey: string; displayName: string; unitKeys: CatalogIntegrationUnitKey[] }
  >();
  for (const unit of units) {
    if (unit.providerKey.toLowerCase() !== "scrydex") {
      continue;
    }
    const summary = summaries.get(unit.providerKey) ?? {
      providerKey: unit.providerKey,
      displayName: unit.displayName,
      unitKeys: [],
    };
    summary.unitKeys.push(unit.unitKey);
    summaries.set(unit.providerKey, summary);
  }
  return [...summaries.values()];
}

export function normalizeCatalogSyncScope(scope: CatalogSyncScope): CatalogSyncScope {
  return {
    ...scope,
    productDomain: normalizeRequiredKey(scope.productDomain, "Catalog sync scope productDomain is required."),
    productForm: normalizeOptionalKey(scope.productForm),
    languageCode: normalizeOptionalKey(scope.languageCode),
    reference: {
      ...scope.reference,
      id: normalizeOptionalKey(scope.reference.id),
      name: scope.reference.name?.trim() || null,
      seriesId: normalizeOptionalKey(scope.reference.seriesId),
      seriesName: scope.reference.seriesName?.trim() || null,
    },
    providerHints: scope.providerHints?.map((hint) => ({
      providerKey: normalizeRequiredKey(hint.providerKey, "Provider hint providerKey is required."),
      unitKey: normalizeOptionalKey(hint.unitKey),
      productLineId: normalizeOptionalKey(hint.productLineId),
      productLineName: hint.productLineName?.trim() || null,
      seriesId: normalizeOptionalKey(hint.seriesId),
      setId: normalizeOptionalKey(hint.setId),
      setName: hint.setName?.trim() || null,
      productId: normalizeOptionalKey(hint.productId),
    })),
    providerParticipation: scope.providerParticipation
      ? {
          requiredUnitKeys: normalizeUnitKeys(scope.providerParticipation.requiredUnitKeys),
          selectedUnitKeys: normalizeUnitKeys(scope.providerParticipation.selectedUnitKeys),
          excludedUnitKeys: normalizeUnitKeys(scope.providerParticipation.excludedUnitKeys),
        }
      : null,
  };
}

async function planProviderUnit(input: {
  scope: CatalogSyncScope;
  version: CatalogProviderIntegrationProfileVersionRecord;
  unitKey: CatalogIntegrationUnitKey;
  registry: ProviderAdapterRegistry;
  required: boolean;
  explicitlySelected: boolean;
}): Promise<CatalogSyncProviderParticipationUnit> {
  const blockers = eligibilityBlockers(input.version, input.unitKey, input.scope);
  const adapter = input.registry.get(input.version.providerKey);
  if (!adapter) {
    blockers.push({
      code: "provider-adapter-missing",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.providerAdapterMissing", {
        providerKey: input.version.providerKey,
      }),
      action: "Register and configure this provider adapter before selecting the unit.",
    });
  } else if (!adapter.capabilities.supportsImportPlanning) {
    blockers.push({
      code: "provider-transport-unavailable",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.importPlanningUnavailable", {
        providerKey: input.version.providerKey,
      }),
      action: "Enable import planning on the provider adapter or deselect this unit.",
    });
  }

  const childExecutionScope =
    blockers.length === 0 ? childScopeForProviderUnit(input.scope, input.version, input.unitKey) : null;
  const selected = input.explicitlySelected || input.required || blockers.length === 0;
  const estimate =
    childExecutionScope && adapter ? await planEstimate(adapter, input.unitKey, childExecutionScope, blockers) : null;
  const eligibility = blockers.some((blocker) => blocker.severity === "error") ? "ineligible" : "eligible";

  return {
    providerKey: input.version.providerKey,
    unitKey: input.unitKey,
    profileKey: input.version.profileKey,
    profileVersion: input.version.profileVersion,
    displayName: input.version.profile.displayName,
    role: providerParticipationRole(input.version),
    requirement: input.required ? "required" : "optional",
    eligibility,
    defaultSelected: eligibility === "eligible",
    selected,
    childExecutionScope,
    estimate: estimate ?? {
      targetCount: null,
      requestStrategy: null,
      estimatedRequestCount: null,
      estimateState: "not-requested",
      estimateReason: null,
      transportSteps: [],
    },
    blockers,
    explanation: unitExplanation(input.version, input.required, eligibility, blockers),
  };
}

async function planEstimate(
  adapter: NonNullable<ReturnType<ProviderAdapterRegistry["get"]>>,
  unitKey: CatalogIntegrationUnitKey,
  childScope: SourceObservationIntegrationJobScope,
  blockers: CatalogSyncProviderParticipationBlocker[],
): Promise<CatalogSyncProviderParticipationUnit["estimate"] | null> {
  try {
    const plan = await adapter.planImport({
      unitKey,
      scopeKey: providerImportScopeKey(childScope),
      values: providerImportScopeValues(childScope),
    });
    return {
      targetCount: plan.estimatedPayloads ?? null,
      requestStrategy: plan.usageEstimate?.requestStrategy ?? null,
      estimatedRequestCount: plan.usageEstimate?.estimatedRequestCount ?? null,
      estimateState: plan.usageEstimate?.estimateState ?? "unavailable",
      estimateReason: plan.usageEstimate?.estimateReason ?? null,
      transportSteps: plan.transportSteps,
    };
  } catch (error) {
    blockers.push({
      code: "provider-plan-unavailable",
      severity: "error",
      message: error instanceof Error ? error.message : "Provider import plan could not be built.",
      action: "Complete the provider source-scope inputs or deselect this provider unit.",
    });
    return null;
  }
}

function eligibilityBlockers(
  version: CatalogProviderIntegrationProfileVersionRecord,
  unitKey: CatalogIntegrationUnitKey,
  scope: CatalogSyncScope,
): CatalogSyncProviderParticipationBlocker[] {
  const blockers: CatalogSyncProviderParticipationBlocker[] = [];
  if (!(version.active && version.lifecycle === "active" && version.profile.status === "active")) {
    blockers.push({
      code: "inactive-profile-unit",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.inactiveProfileUnit", {
        unitKey,
      }),
      action: "Activate a provider profile unit for this scope or leave it unselected.",
    });
  }
  if (!unitMatchesProductDomain(unitKey, scope.productDomain)) {
    blockers.push({
      code: "scope-product-domain-mismatch",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.productDomainMismatch", {
        unitKey,
        productDomain: scope.productDomain,
      }),
      action: "Select a provider unit for the same Catalog product domain.",
    });
  }
  if (scope.productForm && !unitMatchesProductForm(unitKey, scope.productForm)) {
    blockers.push({
      code: "scope-product-form-mismatch",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.productFormMismatch", {
        unitKey,
        productForm: scope.productForm,
      }),
      action: "Select a provider unit with the same Catalog product form.",
    });
  }
  if (!unitSupportsReferenceScope(version, scope.reference.kind)) {
    blockers.push({
      code: "scope-reference-unsupported",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.referenceUnsupported", {
        unitKey,
        referenceKind: scope.reference.kind,
      }),
      action: "Select a provider unit that supports Expansion or Set source scopes.",
    });
  }
  const childScope = childScopeForProviderUnit(scope, version, unitKey);
  if (version.profile.supportedScopes.includes("set-name") && !childScope.setName) {
    blockers.push({
      code: "scope-parent-required",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.setNameRequired", {
        unitKey,
      }),
      action: "Choose or map the provider set-name value before selecting this provider unit.",
    });
  }
  if (version.profile.supportedScopes.includes("product-line/category") && !childScope.productLineId) {
    blockers.push({
      code: "scope-parent-required",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.productLineRequired", {
        unitKey,
      }),
      action: "Choose or map the provider product-line/category value before selecting this provider unit.",
    });
  }

  return blockers;
}

function childScopeForProviderUnit(
  scope: CatalogSyncScope,
  version: CatalogProviderIntegrationProfileVersionRecord,
  unitKey: CatalogIntegrationUnitKey,
): SourceObservationIntegrationJobScope {
  const hint = providerHintFor(scope, version.providerKey, unitKey);
  const supportsSetName = version.profile.supportedScopes.includes("set-name");
  const supportsExpansion = version.profile.supportedScopes.includes("expansion");
  const setId = hint?.setId ?? (supportsExpansion ? (scope.reference.id ?? undefined) : undefined);

  return {
    provider: version.providerKey,
    profileKey: version.profileKey,
    ingestionUnitKey: unitKey,
    language: scope.languageCode ?? undefined,
    productLineId: hint?.productLineId ?? undefined,
    seriesId: hint?.seriesId ?? scope.reference.seriesId ?? undefined,
    setId,
    setName: supportsSetName ? (hint?.setName ?? scope.reference.name ?? scope.reference.id ?? undefined) : undefined,
    productId: hint?.productId ?? undefined,
  };
}

function unitMatchesCatalogSyncScope(
  version: CatalogProviderIntegrationProfileVersionRecord,
  unitKey: CatalogIntegrationUnitKey,
  scope: CatalogSyncScope,
): boolean {
  return (
    unitMatchesProductDomain(unitKey, scope.productDomain) &&
    (!scope.productForm || unitMatchesProductForm(unitKey, scope.productForm)) &&
    unitSupportsReferenceScope(version, scope.reference.kind)
  );
}

function providerParticipationRole(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogSyncProviderParticipationUnit["role"] {
  if (version.profile.capabilities.includes("catalog-item-promotion")) {
    return "primary-source-observation";
  }
  if (version.profile.capabilities.includes("reference-data-promotion")) {
    return "reference-data";
  }
  if (version.profileKey.includes("image")) {
    return "image-evidence";
  }
  return "supplemental-marketplace-reference";
}

function unitExplanation(
  version: CatalogProviderIntegrationProfileVersionRecord,
  required: boolean,
  eligibility: CatalogSyncProviderParticipationUnit["eligibility"],
  blockers: readonly CatalogSyncProviderParticipationBlocker[],
): string {
  if (eligibility === "eligible") {
    return `${version.profile.displayName} can participate as a ${providerParticipationRole(version).replaceAll("-", " ")} unit.`;
  }
  const impact = required ? "blocks this Catalog sync" : "will be skipped unless the operator fixes it";
  return `${version.profile.displayName} is ineligible and ${impact}: ${blockers[0]?.message ?? "No reason was reported."}`;
}

function unitSupportsReferenceScope(
  version: CatalogProviderIntegrationProfileVersionRecord,
  referenceKind: CatalogSyncScopeReferenceKind,
): boolean {
  if (referenceKind === "expansion" || referenceKind === "set") {
    return (
      version.profile.supportedScopes.includes("expansion") || version.profile.supportedScopes.includes("set-name")
    );
  }
  if (referenceKind === "series") {
    return version.profile.supportedScopes.includes("series");
  }
  if (referenceKind === "product-line") {
    return version.profile.supportedScopes.includes("product-line/category");
  }
  return (
    version.profile.supportedScopes.includes("product/card") || version.profile.supportedScopes.includes("product")
  );
}

function providerImportScopeKey(scope: SourceObservationIntegrationJobScope): string {
  if (scope.productId) {
    return "product";
  }
  if (scope.setName) {
    return "set-name";
  }
  if (scope.setId) {
    return "expansion";
  }
  if (scope.seriesId) {
    return "series";
  }
  return "catalog-sync-scope";
}

function providerImportScopeValues(scope: SourceObservationIntegrationJobScope): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries({
      provider: scope.provider,
      profileKey: scope.profileKey,
      ingestionUnitKey: scope.ingestionUnitKey,
      language: scope.language,
      seriesId: scope.seriesId,
      setId: scope.setId,
      productLineId: scope.productLineId,
      setName: scope.setName,
      productId: scope.productId,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0),
  );
}

function providerHintFor(
  scope: CatalogSyncScope,
  providerKey: string,
  unitKey: CatalogIntegrationUnitKey,
): CatalogSyncProviderScopeHint | null {
  return (
    scope.providerHints?.find(
      (hint) => hint.providerKey === providerKey && (!hint.unitKey || hint.unitKey === unitKey),
    ) ?? null
  );
}

function unitMatchesProductDomain(unitKey: CatalogIntegrationUnitKey, productDomain: string): boolean {
  return unitKey.split(":")[1] === productDomain;
}

function unitMatchesProductForm(unitKey: CatalogIntegrationUnitKey, productForm: string): boolean {
  return unitKey.split(":")[2] === productForm;
}

function normalizeUnitKeys(
  unitKeys: readonly CatalogIntegrationUnitKey[] | undefined,
): readonly CatalogIntegrationUnitKey[] {
  return [...new Set((unitKeys ?? []).map((unitKey) => unitKey.trim()).filter(Boolean))];
}

function normalizeRequiredKey(value: string, message: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function normalizeOptionalKey(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
