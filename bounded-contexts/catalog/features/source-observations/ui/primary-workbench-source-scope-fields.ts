import type {
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchScopeContext,
  CatalogPrimaryWorkbenchSourceOptionPageState,
  CatalogPrimaryWorkbenchSourceOptionsStatus,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogPrimaryWorkbenchScopeQueryKey } from "./primary-workbench-scope-context";
import { scopeContextFromRouteContext } from "./primary-workbench-scope-context";
import { sourceOptionDisplayLabel } from "./primary-workbench-source-option-labels";

// Tone vocabulary shared by the guided scope selector and the source-options
// status panel. Kept to the semantic Badge tones the design system exposes so the
// UI never invents a custom color.
export type CatalogPrimaryWorkbenchSourceOptionTone = "success" | "warning" | "danger" | "info" | "neutral";

export type CatalogPrimaryWorkbenchSourceScopeOption = Readonly<{
  value: string;
  label: string;
  description: string | null;
  parentValue: string | null;
}>;

// One guided source-scope control, derived from a provider source-option page. The
// shell renders these as native selects whose name is the structured route-context
// query field (languageCode, productLineId, seriesId, expansionId, expansionName),
// so picking an option updates the route without the operator typing a
// colon-delimited scope string.
export type CatalogPrimaryWorkbenchGuidedScopeField = Readonly<{
  queryKind: string;
  scope: string;
  // Natural-language label sourced from the provider profile (e.g. "Language",
  // "Series", "Expansion", "Product Line", "Set Name"). Never hard-coded per
  // provider — generic providers contribute their own option-kind display names.
  label: string;
  fieldName: CatalogPrimaryWorkbenchScopeQueryKey;
  labelFieldName: CatalogPrimaryWorkbenchScopeQueryKey | null;
  options: readonly CatalogPrimaryWorkbenchSourceScopeOption[];
  selectedValue: string;
  selectedLabel: string;
  // True when the option page could not be requested because its parent scope is
  // not selected yet (e.g. choosing a series before a language). The select is
  // disabled and the diagnostic explains which parent to pick first.
  parentMissing: boolean;
  parentScope: string | null;
  parentDiagnostic: string | null;
}>;

// Maps a provider option-kind scope to the structured route-context query field it
// drives. Provider-agnostic: any provider whose option kinds declare these scopes
// gets guided controls. Finer grains (product/card, product, sku) intentionally map
// to no field — they are below the import-scope grain the daily surface selects.
const scopeQueryFieldsByProviderScope: Readonly<
  Record<
    string,
    Readonly<{
      fieldName: CatalogPrimaryWorkbenchScopeQueryKey;
      labelFieldName: CatalogPrimaryWorkbenchScopeQueryKey | null;
    }>
  >
> = {
  language: { fieldName: "languageCode", labelFieldName: null },
  "product-line/category": { fieldName: "productLineId", labelFieldName: "productLineName" },
  series: { fieldName: "seriesId", labelFieldName: "seriesName" },
  expansion: { fieldName: "expansionId", labelFieldName: "expansionName" },
  "set-name": { fieldName: "expansionId", labelFieldName: "expansionName" },
};

export function guidedSourceScopeFields(
  readModel: CatalogPrimaryWorkbenchReadModel,
): readonly CatalogPrimaryWorkbenchGuidedScopeField[] {
  const selectedScopeValues = selectedSourceScopeValues(readModel);
  const optionKindsByQueryKind = new Map(readModel.sourceOptions.optionKinds.map((kind) => [kind.queryKind, kind]));

  return readModel.sourceOptions.pages.flatMap((page) => {
    const fieldMapping = scopeQueryFieldsByProviderScope[page.scope];
    if (!fieldMapping) {
      return [];
    }

    const parent = optionKindsByQueryKind.get(page.queryKind)?.parent ?? null;
    const parentMissing = parent?.missing ?? page.state === "not-requested";
    const selectedScopeValue = selectedScopeValues.get(page.scope) ?? { value: "", label: "" };
    const selectedValue = selectedScopeValue.value;
    const parentSelectedValue = parent?.scope ? (selectedScopeValues.get(parent.scope)?.value ?? null) : null;
    const options = scopeOptions(page, selectedValue, parentSelectedValue);
    const selectedLabel =
      selectedScopeValue.label || options.find((option) => option.value === selectedValue)?.label || selectedValue;

    return [
      {
        queryKind: page.queryKind,
        scope: page.scope,
        label: page.displayName,
        fieldName: fieldMapping.fieldName,
        labelFieldName: fieldMapping.labelFieldName,
        options,
        selectedValue,
        selectedLabel,
        parentMissing,
        parentScope: parent?.scope ?? null,
        parentDiagnostic: parentMissing ? (parent?.diagnosticText ?? page.cache.diagnostics[0]?.message ?? null) : null,
      },
    ] satisfies readonly CatalogPrimaryWorkbenchGuidedScopeField[];
  });
}

function selectedSourceScopeValues(
  readModel: CatalogPrimaryWorkbenchReadModel,
): ReadonlyMap<string, Readonly<{ value: string; label: string }>> {
  const selections = new Map<string, Readonly<{ value: string; label: string }>>();
  const explicitScopes = new Set<string>();
  const parentScopeByScope = new Map(readModel.sourceOptions.optionKinds.map((kind) => [kind.scope, kind.parentScope]));
  const selectedScope = scopeContextFromRouteContext(readModel.routeContext);

  for (const [scopeName, fieldMapping] of Object.entries(scopeQueryFieldsByProviderScope)) {
    const label = fieldMapping.labelFieldName ? scopeFieldValue(selectedScope, fieldMapping.labelFieldName) : "";
    const value = scopeFieldValue(selectedScope, fieldMapping.fieldName) || label;
    if (value) {
      selections.set(scopeName, { value, label });
      explicitScopes.add(scopeName);
    }
  }

  for (const kind of readModel.sourceOptions.optionKinds) {
    const parentScope = kind.parent.scope;
    if (
      parentScope &&
      kind.parent.selectedValue &&
      !selections.has(parentScope) &&
      hasExplicitDescendantSelection(parentScopeByScope, explicitScopes, parentScope)
    ) {
      selections.set(parentScope, { value: kind.parent.selectedValue, label: "" });
    }
  }

  return selections;
}

function scopeFieldValue(
  scope: CatalogPrimaryWorkbenchScopeContext | undefined,
  fieldName: CatalogPrimaryWorkbenchScopeQueryKey,
): string {
  return scope?.[fieldName] ?? "";
}

function hasExplicitDescendantSelection(
  parentScopeByScope: ReadonlyMap<string, string | null>,
  explicitScopes: ReadonlySet<string>,
  ancestorScope: string,
): boolean {
  for (const explicitScope of explicitScopes) {
    let current = parentScopeByScope.get(explicitScope) ?? null;
    while (current) {
      if (current === ancestorScope) {
        return true;
      }
      current = parentScopeByScope.get(current) ?? null;
    }
  }

  return false;
}

// Turn the loaded option items into select options. Parent-scoped items are
// narrowed before the fallback selected value is restored for stale/partial pages.
function scopeOptions(
  page: CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number],
  selectedValue: string,
  parentSelectedValue: string | null,
): readonly CatalogPrimaryWorkbenchSourceScopeOption[] {
  const options = page.items
    .filter((item) => optionParentMatches(page.request.providerKey, item.parentValue, parentSelectedValue))
    .map((item) => ({
      value: item.value,
      label: item.label,
      description: item.description,
      parentValue: item.parentValue,
    }));
  if (selectedValue && !options.some((option) => option.value === selectedValue)) {
    return [
      {
        value: selectedValue,
        label: sourceOptionDisplayLabel({
          queryKind: page.queryKind,
          scope: page.scope,
          value: selectedValue,
          label: selectedValue,
        }),
        description: null,
        parentValue: null,
      },
      ...options,
    ];
  }

  return options;
}

function optionParentMatches(
  providerKey: string,
  itemParentValue: string | null,
  selectedParentValue: string | null,
): boolean {
  if (!selectedParentValue || !itemParentValue) {
    return true;
  }
  return (
    comparableOptionValue(itemParentValue, providerKey) === comparableOptionValue(selectedParentValue, providerKey)
  );
}

function comparableOptionValue(value: string, providerKey: string): string {
  const trimmed = value.trim();
  return providerKey === "tcgdex" ? trimmed.toLowerCase() : trimmed;
}

export function sourceOptionsStatusTone(
  status: CatalogPrimaryWorkbenchSourceOptionsStatus,
): CatalogPrimaryWorkbenchSourceOptionTone {
  switch (status) {
    case "ready":
      return "success";
    case "degraded":
      return "warning";
    case "blocked":
      return "danger";
    case "unavailable":
      return "neutral";
  }
}

export function sourceOptionPageStateTone(
  state: CatalogPrimaryWorkbenchSourceOptionPageState,
): CatalogPrimaryWorkbenchSourceOptionTone {
  switch (state) {
    case "live":
      return "success";
    case "cached":
      return "info";
    case "stale":
      return "warning";
    case "unavailable":
    case "rollout-blocked":
      return "danger";
    case "not-requested":
      return "neutral";
  }
}
