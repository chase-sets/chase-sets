import { t } from "@chase-sets/localization";
import type { CatalogIntegrationUnitKey } from "./integration-unit";
import type { ProviderAdapterRegistry } from "./provider-adapters/registry";
import type { ProviderUsageEstimate } from "./provider-adapters/provider-adapter";
import type { CatalogProviderIntegrationProfileVersionRecord } from "./provider-integration-profiles";
import type { CatalogIntegrationRolloutControlPolicy } from "./catalog-integration-rollout-controls";
import { unitKeyForCatalogProviderProfileVersion } from "./catalog-integration-impact-analysis";
import type { SourceObservationIntegrationJobScope } from "./runtime";

export type CatalogSyncScopeReferenceKind = "product-line" | "series" | "expansion" | "set" | "catalog-item";

// A Catalog sync scope v2 reference points at a canonical Catalog Scope Record
// by id. The reference kind stays as a classification (it decides which provider
// units can serve the scope) but the scope no longer carries any raw provider
// coordinates or names: every provider coordinate is resolved at planning time
// through an accepted Provider Scope Mapping keyed by this `scopeRecordId`.
export type CatalogSyncScopeReference = Readonly<{
  kind: CatalogSyncScopeReferenceKind;
  scopeRecordId: string;
}>;

// A provider's accepted (or auto-accepted) Provider Scope Mapping, resolved for
// a sync scope's canonical scope record. This is the ONLY source of provider
// coordinates during scope planning; the legacy per-submission provider-hint
// escape hatch has been deleted.
export type CatalogSyncAcceptedScopeMapping = Readonly<{
  scopeRecordId: string;
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey;
  productLineId?: string | null;
  seriesId?: string | null;
  setId?: string | null;
  setName?: string | null;
  mappingId: string;
  mappingVersion: string;
  reviewStatus: string;
}>;

export type CatalogSyncProviderParticipationSelection = Readonly<{
  requiredUnitKeys?: readonly CatalogIntegrationUnitKey[];
  selectedUnitKeys?: readonly CatalogIntegrationUnitKey[];
  excludedUnitKeys?: readonly CatalogIntegrationUnitKey[];
}>;

export type CatalogSyncScope = Readonly<{
  scopeVersion: "catalog-sync-scope-v2";
  productDomain: string;
  productForm?: string | null;
  languageCode?: string | null;
  reference: CatalogSyncScopeReference;
  providerParticipation?: CatalogSyncProviderParticipationSelection | null;
}>;

// Narrows a persisted Provider Scope Mapping read-model row into the planner's
// accepted-mapping input. Structural typing keeps the planner decoupled from the
// provider-scope-mapping read model while both the interactive runtime and the
// scope-sync batch planner feed it the same rows.
export function catalogSyncAcceptedScopeMappingFromRow(row: {
  scope_record_id: string;
  provider_key: string;
  unit_key: string;
  product_line_id: string | null;
  series_id: string | null;
  set_id: string | null;
  set_name: string | null;
  mapping_id: string;
  review_status: string;
  updated_at: string;
}): CatalogSyncAcceptedScopeMapping {
  return {
    scopeRecordId: row.scope_record_id.trim(),
    providerKey: row.provider_key.trim().toLowerCase(),
    unitKey: row.unit_key.trim(),
    productLineId: normalizeOptionalKey(row.product_line_id),
    seriesId: normalizeOptionalKey(row.series_id),
    setId: normalizeOptionalKey(row.set_id),
    setName: row.set_name?.trim() || null,
    mappingId: row.mapping_id,
    mappingVersion: row.updated_at,
    reviewStatus: row.review_status,
  };
}

export type CatalogSyncProviderParticipationBlocker = Readonly<{
  code:
    | "provider-adapter-missing"
    | "provider-adapter-diagnostics"
    | "provider-transport-unavailable"
    | "inactive-profile-unit"
    | "scope-product-domain-mismatch"
    | "scope-product-form-mismatch"
    | "scope-reference-unsupported"
    | "provider-scope-mapping-missing"
    | "provider-plan-unavailable"
    | "provider-credential-not-ready"
    | "provider-transport-blocked"
    | "provider-rollout-blocked"
    | "credited-provider-preflight-unavailable"
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
  planningEvidence?: Readonly<{
    rollout: readonly Readonly<{
      capability: "provider-transport" | "import";
      allowed: boolean;
      controls: readonly Readonly<{ controlId: string; status: string }>[];
    }>[];
    credentials: readonly Readonly<{
      unitKey: string | null;
      requirement: string;
      sourceKind: string;
      state: string;
      importBlocking: boolean;
      diagnosticCode: string | null;
    }>[];
    transport: readonly Readonly<{
      unitKey: string | null;
      code: string;
      severity: string;
      retryAfterSeconds: number | null;
    }>[];
  }>;
  estimate: Readonly<{
    targetCount: number | null;
    requestStrategy: ProviderUsageEstimate["requestStrategy"] | null;
    estimatedRequestCount: number | null;
    estimateState: ProviderUsageEstimate["estimateState"] | "not-requested" | "unavailable";
    estimateReason: string | null;
    usageCheckState?: ProviderUsageEstimate["usageCheckState"] | null;
    creditDiagnostic?: string | null;
    degradedDiagnostic?: string | null;
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
  acceptedScopeMappings: readonly CatalogSyncAcceptedScopeMapping[];
  providerProfileVersions: readonly CatalogProviderIntegrationProfileVersionRecord[];
  providerAdapterRegistry: ProviderAdapterRegistry;
  rolloutControlPolicy?: CatalogIntegrationRolloutControlPolicy;
  includeOperationalGates?: boolean;
}): Promise<CatalogSyncProviderParticipationPreview> {
  const scope = normalizeCatalogSyncScope(input.scope);
  // Only mappings resolved for THIS scope record supply provider coordinates.
  const acceptedScopeMappings = input.acceptedScopeMappings.filter(
    (mapping) => mapping.scopeRecordId === scope.reference.scopeRecordId,
  );
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
        mapping: acceptedMappingFor(acceptedScopeMappings, version.providerKey, unitKey),
        registry: input.providerAdapterRegistry,
        rolloutControlPolicy: input.rolloutControlPolicy,
        includeOperationalGates: input.includeOperationalGates ?? false,
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
      kind: scope.reference.kind,
      scopeRecordId: normalizeRequiredKey(
        scope.reference.scopeRecordId,
        "Catalog sync scope reference.scopeRecordId is required.",
        { preserveCase: true },
      ),
    },
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
  mapping: CatalogSyncAcceptedScopeMapping | null;
  registry: ProviderAdapterRegistry;
  rolloutControlPolicy?: CatalogIntegrationRolloutControlPolicy;
  includeOperationalGates: boolean;
  required: boolean;
  explicitlySelected: boolean;
}): Promise<CatalogSyncProviderParticipationUnit> {
  const blockers = eligibilityBlockers(input.version, input.unitKey, input.scope, input.mapping);
  const adapter = input.registry.get(input.version.providerKey);
  const rolloutEvidence: Array<
    NonNullable<CatalogSyncProviderParticipationUnit["planningEvidence"]>["rollout"][number]
  > = [];
  for (const capability of input.includeOperationalGates ? (["provider-transport", "import"] as const) : []) {
    const decision = input.rolloutControlPolicy?.decide({
      capability,
      providerKey: input.version.providerKey,
      profileKey: input.version.profileKey,
      profileVersion: input.version.profileVersion,
      profileLifecycle: input.version.lifecycle,
      unitKey: input.unitKey,
    });
    rolloutEvidence.push({
      capability,
      allowed: decision?.allowed ?? true,
      controls: (decision?.controls ?? []).map((control) => ({
        controlId: control.controlId,
        status: control.status,
      })),
    });
    if (decision && !decision.allowed) {
      blockers.push({
        code: "provider-rollout-blocked",
        severity: "error",
        message: decision.message ?? "Provider rollout controls block this unit.",
        action: "Open the provider rollout gate before confirming this sync.",
      });
    }
  }
  let readinessEvidence: Awaited<ReturnType<typeof appendProviderReadinessBlockers>> = {
    credentials: [],
    transport: [],
  };
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
  } else if (input.includeOperationalGates) {
    readinessEvidence = await appendProviderReadinessBlockers(adapter, input.unitKey, blockers);
  }

  const childExecutionScope =
    blockers.length === 0 ? childScopeForProviderUnit(input.scope, input.version, input.unitKey, input.mapping) : null;
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
    planningEvidence: { rollout: rolloutEvidence, ...readinessEvidence },
    estimate: estimate ?? {
      targetCount: null,
      requestStrategy: null,
      estimatedRequestCount: null,
      estimateState: "not-requested",
      estimateReason: null,
      usageCheckState: null,
      creditDiagnostic: null,
      degradedDiagnostic: null,
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
      usageCheckState: plan.usageEstimate?.usageCheckState ?? null,
      creditDiagnostic: plan.usageEstimate?.creditDiagnostic ?? null,
      degradedDiagnostic: plan.usageEstimate?.degradedDiagnostic ?? null,
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

async function appendProviderReadinessBlockers(
  adapter: NonNullable<ReturnType<ProviderAdapterRegistry["get"]>>,
  unitKey: CatalogIntegrationUnitKey,
  blockers: CatalogSyncProviderParticipationBlocker[],
): Promise<Pick<NonNullable<CatalogSyncProviderParticipationUnit["planningEvidence"]>, "credentials" | "transport">> {
  const credentials: Array<
    NonNullable<CatalogSyncProviderParticipationUnit["planningEvidence"]>["credentials"][number]
  > = [];
  const transport: Array<NonNullable<CatalogSyncProviderParticipationUnit["planningEvidence"]>["transport"][number]> =
    [];
  try {
    const readiness = await adapter.getCredentialReadiness();
    for (const item of readiness.filter((candidate) => !candidate.unitKey || candidate.unitKey === unitKey)) {
      credentials.push({
        unitKey: item.unitKey ?? null,
        requirement: item.requirement,
        sourceKind: item.sourceKind,
        state: item.state,
        importBlocking: item.importBlocking,
        diagnosticCode: item.diagnosticCode,
      });
      if (item.importBlocking) {
        blockers.push({
          code: "provider-credential-not-ready",
          severity: "error",
          message: item.message,
          action: "Restore provider credential readiness before confirming this sync.",
        });
      }
    }
  } catch {
    credentials.push({
      unitKey,
      requirement: "unknown",
      sourceKind: "unknown",
      state: "unknown",
      importBlocking: true,
      diagnosticCode: "credential-readiness-unavailable",
    });
    blockers.push({
      code: "provider-credential-not-ready",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.credentialReadinessUnavailable"),
      action: "Restore provider credential readiness evidence before confirming this sync.",
    });
  }

  try {
    const diagnostics = await adapter.getTransportDiagnostics();
    for (const diagnostic of diagnostics.filter((candidate) => !candidate.unitKey || candidate.unitKey === unitKey)) {
      transport.push({
        unitKey: diagnostic.unitKey ?? null,
        code: diagnostic.code,
        severity: diagnostic.severity,
        retryAfterSeconds: diagnostic.retryAfterSeconds ?? null,
      });
      if (diagnostic.severity !== "error") continue;
      blockers.push({
        code: "provider-transport-blocked",
        severity: "error",
        message: diagnostic.message,
        action: "Clear the provider transport blocker before confirming this sync.",
      });
    }
  } catch {
    transport.push({
      unitKey,
      code: "transport-diagnostics-unavailable",
      severity: "error",
      retryAfterSeconds: null,
    });
    blockers.push({
      code: "provider-transport-blocked",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.transportDiagnosticsUnavailable"),
      action: "Restore provider transport evidence before confirming this sync.",
    });
  }
  return { credentials, transport };
}

function eligibilityBlockers(
  version: CatalogProviderIntegrationProfileVersionRecord,
  unitKey: CatalogIntegrationUnitKey,
  scope: CatalogSyncScope,
  mapping: CatalogSyncAcceptedScopeMapping | null,
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
  // Provider coordinates come only from an accepted Provider Scope Mapping. A
  // missing mapping — or one that does not yet supply a coordinate this provider
  // unit requires — is an actionable blocker that points the operator at the
  // unmapped-scope inbox instead of asking them to hand-enter provider values.
  const childScope = childScopeForProviderUnit(scope, version, unitKey, mapping);
  for (const coordinate of requiredProviderScopeCoordinates(version)) {
    if (childScope[coordinate.field]) {
      continue;
    }
    blockers.push({
      code: "provider-scope-mapping-missing",
      severity: "error",
      message: t("catalog.features.sourceObservations.api.catalogSyncScopePlanner.providerScopeMappingMissing", {
        unitKey,
        coordinate: coordinate.label,
      }),
      action: "Resolve this scope in the unmapped-scope inbox before selecting this provider unit.",
    });
  }

  return blockers;
}

// The provider coordinate an accepted mapping MUST supply for a unit to plan a
// child execution scope, derived purely from the provider profile's supported
// scope granularities (never from a provider-key branch). Set-name and
// product-line/category are TCGplayer-shaped catalog coordinates; a bare
// expansion granularity resolves through the mapping's set id.
function requiredProviderScopeCoordinates(
  version: CatalogProviderIntegrationProfileVersionRecord,
): readonly Readonly<{ field: "setName" | "productLineId" | "setId"; label: string }>[] {
  const supported = version.profile.supportedScopes;
  const coordinates: Array<Readonly<{ field: "setName" | "productLineId" | "setId"; label: string }>> = [];
  if (supported.includes("set-name")) {
    coordinates.push({ field: "setName", label: "set-name" });
  }
  if (supported.includes("product-line/category")) {
    coordinates.push({ field: "productLineId", label: "product-line/category" });
  }
  if (supported.includes("expansion") && !supported.includes("set-name")) {
    coordinates.push({ field: "setId", label: "expansion" });
  }
  return coordinates;
}

// Translates the resolved accepted Provider Scope Mapping into the provider's
// transport-scoped child execution scope. Every coordinate comes from the
// mapping — there is deliberately NO fallback to the scope's reference id or
// name, so an unmapped scope can never silently plan against a raw canonical
// name (enforced by the scope-first boundary guard).
function childScopeForProviderUnit(
  scope: CatalogSyncScope,
  version: CatalogProviderIntegrationProfileVersionRecord,
  unitKey: CatalogIntegrationUnitKey,
  mapping: CatalogSyncAcceptedScopeMapping | null,
): SourceObservationIntegrationJobScope {
  const supportsSetName = version.profile.supportedScopes.includes("set-name");

  return {
    provider: version.providerKey,
    profileKey: version.profileKey,
    ingestionUnitKey: unitKey,
    language: scope.languageCode ?? undefined,
    productLineId: mapping?.productLineId ?? undefined,
    seriesId: mapping?.seriesId ?? undefined,
    setId: mapping?.setId ?? undefined,
    setName: supportsSetName ? (mapping?.setName ?? undefined) : undefined,
    productId: undefined,
    planningFingerprint: mapping
      ? [`profile:${version.profileVersion}`, `mapping:${mapping.mappingId}:${mapping.mappingVersion}`].join("|")
      : undefined,
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

// Resolves the accepted mapping that supplies a provider unit's coordinates.
// An exact (providerKey, unitKey) match wins; a provider-wide mapping (one with
// no unit-specific coordinates) serves as the fallback for every unit of that
// provider.
function acceptedMappingFor(
  mappings: readonly CatalogSyncAcceptedScopeMapping[],
  providerKey: string,
  unitKey: CatalogIntegrationUnitKey,
): CatalogSyncAcceptedScopeMapping | null {
  const providerMappings = mappings.filter((mapping) => mapping.providerKey === providerKey);
  return (
    providerMappings.find((mapping) => mapping.unitKey === unitKey) ??
    providerMappings.find((mapping) => !mapping.unitKey) ??
    null
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

function normalizeRequiredKey(
  value: string,
  message: string,
  options: Readonly<{ preserveCase?: boolean }> = {},
): string {
  const trimmed = value?.trim() ?? "";
  const normalized = options.preserveCase ? trimmed : trimmed.toLowerCase();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function normalizeOptionalKey(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
