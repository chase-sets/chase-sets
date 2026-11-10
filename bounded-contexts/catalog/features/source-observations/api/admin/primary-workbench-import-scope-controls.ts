import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchGuidedScopeField,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchSourceOptionsReadModel,
} from "./primary-workbench-selection-contracts";
import type { CatalogPrimaryWorkbenchScopeQueryKey } from "../../ui/primary-workbench-scope-context";
import { scopeContextFromRouteContext } from "../../ui/primary-workbench-scope-context";
import { sourceOptionDisplayLabel } from "../../ui/primary-workbench-source-option-labels";

const scopeQueryFields: Readonly<
  Record<
    string,
    Readonly<{
      fieldName: CatalogPrimaryWorkbenchScopeQueryKey;
      labelFieldName: CatalogPrimaryWorkbenchScopeQueryKey | null;
    }>
  >
> = {
  product: { fieldName: "productId", labelFieldName: null },
  language: { fieldName: "languageCode", labelFieldName: null },
  "product-line/category": { fieldName: "productLineId", labelFieldName: "productLineName" },
  series: { fieldName: "seriesId", labelFieldName: "seriesName" },
  expansion: { fieldName: "expansionId", labelFieldName: "expansionName" },
  "set-name": { fieldName: "expansionId", labelFieldName: "expansionName" },
};

// Both daily reads answer the import controls from one owner.
export function buildCatalogPrimaryWorkbenchImportScopeControls(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  sourceOptions: Pick<CatalogPrimaryWorkbenchSourceOptionsReadModel, "optionKinds" | "pages">,
): Pick<CatalogPrimaryWorkbenchSourceOptionsReadModel, "guidedFields" | "freeTextApplicable" | "contextSummary"> {
  const selected = selectedScopeValues(routeContext, sourceOptions);
  const kinds = new Map(sourceOptions.optionKinds.map((kind) => [kind.queryKind, kind]));
  const guidedFields = sourceOptions.pages.flatMap((page): readonly CatalogPrimaryWorkbenchGuidedScopeField[] => {
    const mapping = scopeQueryFields[page.scope];
    if (!mapping) return [];
    const parent = kinds.get(page.queryKind)?.parent ?? null;
    const parentMissing = parent?.missing ?? page.state === "not-requested";
    const selection = selected.get(page.scope) ?? { value: "", label: "" };
    const parentValue = parent?.scope ? (selected.get(parent.scope)?.value ?? null) : null;
    const options = narrowedOptions(page, selection.value, parentValue);
    const loadedExpansionLabel =
      mapping.fieldName === "expansionId" && selection.value !== selection.label
        ? page.items.find(
            (item) =>
              item.value === selection.value && matchesParent(page.request.providerKey, item.parentValue, parentValue),
          )?.label
        : undefined;
    return [
      {
        queryKind: page.queryKind,
        scope: page.scope,
        label: page.displayName,
        ...mapping,
        options,
        selectedValue: selection.value,
        selectedLabel:
          loadedExpansionLabel ||
          selection.label ||
          options.find((option) => option.value === selection.value)?.label ||
          selection.value,
        parentMissing,
        parentScope: parent?.scope ?? null,
        parentDiagnostic: parentMissing ? (parent?.diagnosticText ?? page.cache.diagnostics[0]?.message ?? null) : null,
      },
    ];
  });
  return { guidedFields, freeTextApplicable: guidedFields.length === 0, contextSummary: contextSummary(routeContext) };
}

function selectedScopeValues(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  sourceOptions: Pick<CatalogPrimaryWorkbenchSourceOptionsReadModel, "optionKinds">,
): ReadonlyMap<string, Readonly<{ value: string; label: string }>> {
  const selected = new Map<string, Readonly<{ value: string; label: string }>>();
  const explicitScopes = new Set<string>();
  const parents = new Map(sourceOptions.optionKinds.map((kind) => [kind.scope, kind.parentScope]));
  const scope = scopeContextFromRouteContext(routeContext);
  for (const [name, mapping] of Object.entries(scopeQueryFields)) {
    const label = mapping.labelFieldName ? (scope[mapping.labelFieldName] ?? "") : "";
    const value = scope[mapping.fieldName] || label;
    if (value) {
      selected.set(name, { value, label });
      explicitScopes.add(name);
    }
  }
  for (const kind of sourceOptions.optionKinds) {
    const parentScope = kind.parent.scope;
    if (
      parentScope &&
      kind.parent.selectedValue &&
      !selected.has(parentScope) &&
      hasSelectedDescendant(parents, explicitScopes, parentScope)
    ) {
      selected.set(parentScope, { value: kind.parent.selectedValue, label: "" });
    }
  }
  return selected;
}

function hasSelectedDescendant(
  parents: ReadonlyMap<string, string | null>,
  selected: ReadonlySet<string>,
  ancestor: string,
): boolean {
  for (const scope of selected) {
    const visited = new Set<string>();
    let parent = parents.get(scope) ?? null;
    while (parent && !visited.has(parent)) {
      if (parent === ancestor) return true;
      visited.add(parent);
      parent = parents.get(parent) ?? null;
    }
  }
  return false;
}

function narrowedOptions(
  page: CatalogPrimaryWorkbenchSourceOptionsReadModel["pages"][number],
  selectedValue: string,
  parentValue: string | null,
): CatalogPrimaryWorkbenchGuidedScopeField["options"] {
  const options = page.items
    .filter((item) => matchesParent(page.request.providerKey, item.parentValue, parentValue))
    .map(({ value, label, description, parentValue }) => ({ value, label, description, parentValue }));
  if (!selectedValue || options.some((option) => option.value === selectedValue)) return options;
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

function matchesParent(providerKey: string, itemParent: string | null, selectedParent: string | null): boolean {
  if (!itemParent || !selectedParent) return true;
  const comparable = (value: string) => (providerKey === "tcgdex" ? value.trim().toLowerCase() : value.trim());
  return comparable(itemParent) === comparable(selectedParent);
}

function contextSummary(context: CatalogPrimaryWorkbenchRouteContext): string | null {
  const { providerKey, unitKey, profileVersion, importScope, scope } = context;
  const levels = [
    scope?.languageCode,
    scope?.productLineId,
    scope?.seriesId,
    scope?.expansionId ?? scope?.expansionName,
    scope?.productId,
  ].filter((level): level is string => Boolean(level));
  const label = levels.length > 0 ? levels.join("/") : importScope;
  if (!label) return null;
  return [
    providerKey,
    unitKey,
    label,
    profileVersion
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.step.profile", { profileVersion })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
