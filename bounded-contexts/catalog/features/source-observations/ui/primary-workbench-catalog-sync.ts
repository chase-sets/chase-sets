import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchCatalogSyncReadModel,
  CatalogPrimaryWorkbenchCatalogSyncUnitReadModel,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import { actionStateForBlockers } from "./primary-workbench-read-model-support";
import { scopeDisplayLabel } from "./primary-workbench-scope-context";

export function catalogSyncFor(input: {
  canManage: boolean;
  generatedAt: string;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceScopeWorkset: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"];
}): CatalogPrimaryWorkbenchCatalogSyncReadModel {
  const scope = catalogSyncScope(input.routeContext, input.sourceScopeWorkset);
  const units = input.sourceScopeWorkset.units.map((unit, index) => catalogSyncUnit(unit, index));
  const selectedEligibleUnits = units.filter((unit) => unit.selected && unit.eligibility === "eligible");
  const blockers = catalogSyncBlockers({
    canManage: input.canManage,
    scopeReady: scope.hasConcreteScope && Boolean(scope.productDomain && scope.productForm && scope.languageCode),
    selectedEligibleUnitCount: selectedEligibleUnits.length,
    readinessBlockers: input.readinessBlockers,
  });
  const status = catalogSyncStatus(scope.hasConcreteScope, blockers, units);

  return {
    status,
    generatedAt: input.generatedAt,
    scope,
    preview: {
      previewVersion: "catalog-sync-provider-participation-preview-v1",
      status: blockers.length > 0 ? "blocked" : "ready",
      startAllowed: blockers.length === 0,
      explanation:
        blockers.length === 0
          ? "Selected provider units can pull Source Observations for this Catalog scope."
          : "Resolve the blocked scope or provider participation before starting the Catalog sync.",
      blockers: blockers.map((blocker) => ({
        code: blocker,
        severity: "error",
        message: blocker,
        providerKey: input.routeContext.providerKey ?? "catalog",
        unitKey: input.routeContext.unitKey,
      })),
      units,
    },
    action: {
      key: "start-catalog-sync",
      state: actionStateForBlockers(blockers, input.canManage ? "available" : "denied"),
      blockers,
      copyKey: blockers.length > 0 ? "catalog.primary.import.blocked" : null,
    },
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

function compactRecord(input: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => Boolean(value))) as Record<string, string>;
}
