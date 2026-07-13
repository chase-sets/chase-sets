import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchCatalogSyncReadModel,
  CatalogPrimaryWorkbenchCatalogSyncUnitReadModel,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import type {
  CatalogSyncProviderParticipationBlocker,
  CatalogSyncProviderParticipationPreview,
  CatalogSyncProviderParticipationUnit,
} from "../api/catalog-sync-scope-planner";
import { actionStateForBlockers } from "./primary-workbench-read-model-support";
import { scopeDisplayLabel } from "./primary-workbench-scope-context";

export function catalogSyncFor(input: {
  canManage: boolean;
  generatedAt: string;
  catalogSyncPreview?: CatalogSyncProviderParticipationPreview | null;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceScopeWorkset: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"];
}): CatalogPrimaryWorkbenchCatalogSyncReadModel {
  const scope = catalogSyncScope(input.routeContext, input.sourceScopeWorkset);
  const units = input.catalogSyncPreview
    ? catalogSyncUnitsFromPreview(input.catalogSyncPreview)
    : input.sourceScopeWorkset.units.map((unit, index) => catalogSyncUnit(unit, index));
  const initialSelectedUnitKeys = new Set(
    units.flatMap((unit) => (unit.selected && unit.unitKey ? [unit.unitKey] : [])),
  );
  const selectedEligibleUnits = units.filter((unit) => unit.selected && unit.eligibility === "eligible");
  const baseBlockers = catalogSyncBlockers({
    canManage: input.canManage,
    scopeReady: scope.hasConcreteScope && Boolean(scope.productDomain && scope.productForm && scope.languageCode),
    selectedEligibleUnitCount: selectedEligibleUnits.length,
    readinessBlockers: input.readinessBlockers,
  });
  const blockers = catalogSyncActionBlockers(baseBlockers, input.catalogSyncPreview);
  const status = catalogSyncStatusFromPreview({
    hasConcreteScope: scope.hasConcreteScope,
    blockers,
    preview: input.catalogSyncPreview,
    selectedEligibleUnitCount: selectedEligibleUnits.length,
    units,
  });
  const startAllowed =
    blockers.length === 0 &&
    selectedEligibleUnits.length > 0 &&
    (input.catalogSyncPreview ? input.catalogSyncPreview.startAllowed : true);
  const previewStatus = status === "scope-required" ? "blocked" : status;
  const previewBlockers = input.catalogSyncPreview
    ? catalogSyncPreviewBlockers(input.catalogSyncPreview, input.routeContext)
    : blockers.map((blocker) => ({
        code: blocker,
        severity: "error" as const,
        message: blocker,
        providerKey: input.routeContext.providerKey ?? "catalog",
        unitKey: input.routeContext.unitKey,
      }));

  return {
    status,
    generatedAt: input.generatedAt,
    scope,
    preview: {
      previewVersion: "catalog-sync-provider-participation-preview-v1",
      status: previewStatus,
      startAllowed,
      estimate: catalogSyncEstimateForSelection(
        {
          units,
          estimate: input.catalogSyncPreview?.estimate ?? {
            totalEstimatedRequestCount: null,
            estimateState: "estimate-unavailable",
            estimateReason: null,
            creditConsumingProviders: [],
          },
        },
        initialSelectedUnitKeys,
      ),
      explanation: input.catalogSyncPreview
        ? input.catalogSyncPreview.explanation
        : blockers.length === 0
          ? "Selected provider units can pull Source Observations for this Catalog scope."
          : "Resolve the blocked scope or provider participation before starting the Catalog sync.",
      blockers: previewBlockers,
      units,
    },
    action: {
      key: "start-catalog-sync",
      state:
        blockers.length === 0 && input.catalogSyncPreview?.status === "degraded"
          ? "degraded"
          : actionStateForBlockers(blockers, input.canManage ? "available" : "denied"),
      blockers,
      copyKey: blockers.length > 0 ? "catalog.primary.import.blocked" : null,
    },
  };
}

export function catalogSyncEstimateForSelection(
  preview: Pick<CatalogPrimaryWorkbenchCatalogSyncReadModel["preview"], "units" | "estimate">,
  selectedUnitKeys: ReadonlySet<string>,
): CatalogPrimaryWorkbenchCatalogSyncReadModel["preview"]["estimate"] {
  const selectedEligibleUnits = preview.units.filter(
    (unit) => unit.unitKey && selectedUnitKeys.has(unit.unitKey) && unit.eligibility === "eligible",
  );
  const unavailableEstimate = selectedEligibleUnits.find(
    (unit) => unit.estimate?.estimatedRequestCount === null || !unit.estimate,
  );
  const selectedKeys = new Set(selectedEligibleUnits.map((unit) => unit.unitKey));

  return {
    totalEstimatedRequestCount: unavailableEstimate
      ? null
      : selectedEligibleUnits.reduce((total, unit) => total + (unit.estimate?.estimatedRequestCount ?? 0), 0),
    estimateState: unavailableEstimate ? "estimate-unavailable" : "estimated",
    estimateReason: unavailableEstimate?.estimate?.estimateReason ?? null,
    creditConsumingProviders: preview.estimate.creditConsumingProviders
      .map((provider) => ({
        ...provider,
        unitKeys: provider.unitKeys.filter((unitKey) => selectedKeys.has(unitKey)),
      }))
      .filter((provider) => provider.unitKeys.length > 0),
  };
}

function catalogSyncScope(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  sourceScopeWorkset: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"],
): CatalogPrimaryWorkbenchCatalogSyncReadModel["scope"] {
  const routeScope = sourceScopeWorkset.selectedScope.scope;
  const firstUnit = sourceScopeWorkset.units.find((unit) => unit.productDomain && unit.productForm);
  const reference = routeScope.expansionId
    ? {
        kind: "expansion" as const,
        id: routeScope.expansionId,
        name: routeScope.expansionName,
        seriesId: routeScope.seriesId,
        seriesName: routeScope.seriesName,
      }
    : routeScope.expansionName
      ? {
          kind: "set" as const,
          id: routeScope.expansionName,
          name: routeScope.expansionName,
          seriesId: routeScope.seriesId,
          seriesName: routeScope.seriesName,
        }
      : routeScope.seriesId
        ? {
            kind: "series" as const,
            id: routeScope.seriesId,
            name: routeScope.seriesName,
            seriesId: routeScope.seriesId,
            seriesName: routeScope.seriesName,
          }
        : {
            kind: routeScope.productLineId ? ("product-line" as const) : null,
            id: routeScope.productLineId,
            name: routeScope.productLineName,
            seriesId: null,
            seriesName: null,
          };

  return {
    scopeVersion: "catalog-sync-scope-v1",
    productDomain: firstUnit?.productDomain ?? null,
    productForm: firstUnit?.productForm ?? null,
    languageCode: routeScope.languageCode,
    reference,
    label: sourceScopeWorkset.selectedScope.hasConcreteScope
      ? scopeDisplayLabel(routeScope)
      : sourceScopeWorkset.selectedScope.label,
    hasConcreteScope: sourceScopeWorkset.selectedScope.hasConcreteScope,
  };
}

function catalogSyncUnit(
  unit: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"]["units"][number],
  index: number,
): CatalogPrimaryWorkbenchCatalogSyncUnitReadModel {
  const blocked = !unit.profileReady || unit.state === "blocked" || !unit.unitKey || !unit.importScope;
  const childExecutionScope = unit.unitKey
    ? compactRecord({
        provider: unit.providerKey,
        ingestionUnitKey: unit.unitKey,
        language: unit.commandContext.languageCode,
        productLineId: unit.commandContext.productLineId,
        seriesId: unit.commandContext.seriesId,
        setId: unit.commandContext.expansionId,
        setName: unit.commandContext.expansionName,
      })
    : null;

  return {
    providerKey: unit.providerKey,
    unitKey: unit.unitKey,
    displayName: unit.displayName,
    profileVersion: unit.profileVersion,
    productDomain: unit.productDomain,
    productForm: unit.productForm,
    role: index === 0 ? "primary" : "supplementary",
    requirement: index === 0 ? "required" : "optional",
    selected: !blocked,
    eligibility: blocked ? "blocked" : "eligible",
    childExecutionScope,
    estimate: null,
    blockers: blocked
      ? [
          {
            code: unit.profileReady ? "catalog-sync-scope-unavailable" : "missing-active-profile",
            severity: "error",
            message: unit.profileReady
              ? "Catalog sync scope is not available for this unit."
              : "Missing active profile.",
          },
        ]
      : [],
  };
}

function catalogSyncBlockers(input: {
  canManage: boolean;
  scopeReady: boolean;
  selectedEligibleUnitCount: number;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!input.canManage) {
    blockers.add("permission-denied");
  }
  if (!input.scopeReady) {
    blockers.add("import-scope-required");
  }
  if (input.selectedEligibleUnitCount === 0) {
    blockers.add("unit-selection-required");
  }
  for (const blocker of input.readinessBlockers) {
    if (blocker === "kill-switch-active" || blocker === "rollout-disabled" || blocker === "read-model-unavailable") {
      blockers.add(blocker);
    }
  }

  return [...blockers];
}

function catalogSyncActionBlockers(
  baseBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
  preview: CatalogSyncProviderParticipationPreview | null | undefined,
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set(baseBlockers);
  if (preview && !preview.startAllowed) {
    blockers.add("import-scope-required");
  }

  return [...blockers];
}

function catalogSyncStatus(
  hasConcreteScope: boolean,
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
  units: readonly CatalogPrimaryWorkbenchCatalogSyncUnitReadModel[],
): CatalogPrimaryWorkbenchCatalogSyncReadModel["status"] {
  if (!hasConcreteScope) {
    return "scope-required";
  }
  if (blockers.length > 0 && units.every((unit) => unit.eligibility === "blocked")) {
    return "blocked";
  }
  if (blockers.length > 0 || units.some((unit) => unit.eligibility === "blocked")) {
    return "degraded";
  }
  return "ready";
}

function catalogSyncStatusFromPreview(input: {
  hasConcreteScope: boolean;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  preview: CatalogSyncProviderParticipationPreview | null | undefined;
  selectedEligibleUnitCount: number;
  units: readonly CatalogPrimaryWorkbenchCatalogSyncUnitReadModel[];
}): CatalogPrimaryWorkbenchCatalogSyncReadModel["status"] {
  if (!input.preview) {
    return catalogSyncStatus(input.hasConcreteScope, input.blockers, input.units);
  }
  if (!input.hasConcreteScope) {
    return "scope-required";
  }
  if (input.selectedEligibleUnitCount === 0 || !input.preview.startAllowed) {
    return "blocked";
  }

  return input.preview.status;
}

function catalogSyncUnitsFromPreview(
  preview: CatalogSyncProviderParticipationPreview,
): readonly CatalogPrimaryWorkbenchCatalogSyncUnitReadModel[] {
  return preview.units.map((unit) => ({
    providerKey: unit.providerKey,
    unitKey: unit.unitKey,
    displayName: unit.displayName,
    profileVersion: unit.profileVersion,
    productDomain: unitKeySegment(unit.unitKey, 1),
    productForm: unitKeySegment(unit.unitKey, 2),
    role: catalogSyncRole(unit),
    requirement: unit.requirement,
    selected: unit.selected,
    eligibility: unit.eligibility === "eligible" ? "eligible" : "blocked",
    childExecutionScope: unit.childExecutionScope ? compactRecord(unit.childExecutionScope) : null,
    estimate: {
      estimateState: unit.estimate.estimateState === "estimated" ? "estimated" : "estimate-unavailable",
      estimatedRequestCount: unit.estimate.estimatedRequestCount,
      estimateReason: unit.estimate.estimateReason,
    },
    blockers: unit.blockers.map((blocker) => ({
      code: blocker.code,
      severity: blocker.severity,
      message: blocker.message,
    })),
  }));
}

function catalogSyncPreviewBlockers(
  preview: CatalogSyncProviderParticipationPreview,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): CatalogPrimaryWorkbenchCatalogSyncReadModel["preview"]["blockers"] {
  return preview.blockers.map((blocker) => catalogSyncPreviewBlocker(blocker, routeContext));
}

function catalogSyncPreviewBlocker(
  blocker: CatalogSyncProviderParticipationBlocker,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): CatalogPrimaryWorkbenchCatalogSyncReadModel["preview"]["blockers"][number] {
  return {
    code: blocker.code,
    severity: blocker.severity,
    message: blocker.message,
    providerKey: routeContext.providerKey ?? "catalog",
    unitKey: routeContext.unitKey,
  };
}

function catalogSyncRole(
  unit: CatalogSyncProviderParticipationUnit,
): CatalogPrimaryWorkbenchCatalogSyncUnitReadModel["role"] {
  if (unit.role === "primary-source-observation") {
    return "primary";
  }
  if (unit.role === "reference-data") {
    return "reference";
  }
  return "supplementary";
}

function unitKeySegment(unitKey: string, index: number): string | null {
  return unitKey.split(":")[index] ?? null;
}

function compactRecord(input: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => Boolean(value))) as Record<string, string>;
}
