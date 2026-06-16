import type {
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchScopeContext,
  CatalogPrimaryWorkbenchSourceOptionPageState,
  CatalogPrimaryWorkbenchSourceOptionsStatus,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogPrimaryWorkbenchScopeQueryKey } from "./primary-workbench-scope-context";
import { sourceOptionDisplayLabel } from "./primary-workbench-source-option-labels";

// Tone vocabulary shared by the guided scope selector and the source-options
// status panel. Kept to the semantic Badge tones the design system exposes so the
// UI never invents a custom color.
export type CatalogPrimaryWorkbenchSourceOptionTone = "success" | "warning" | "danger" | "info" | "neutral";

export type CatalogPrimaryWorkbenchSourceScopeOption = Readonly<{
  value: string;
  label: string;
  description: string | null;
}>;

// One guided source-scope control, derived from a provider source-option page. The
// shell renders these as native selects whose name is the structured route-context
// query field (languageCode, productLineId, seriesId, expansionId), so picking an
// option updates the route the same way the raw importScope text box used to —
// without the operator typing a colon-delimited scope string.
export type CatalogPrimaryWorkbenchGuidedScopeField = Readonly<{
  queryKind: string;
  scope: string;
  // Natural-language label sourced from the provider profile (e.g. "Language",
  // "Series", "Expansion", "Product Line", "Set Name"). Never hard-coded per
  // provider — generic providers contribute their own option-kind display names.
  label: string;
  fieldName: CatalogPrimaryWorkbenchScopeQueryKey;
  options: readonly CatalogPrimaryWorkbenchSourceScopeOption[];
  selectedValue: string;
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
const scopeQueryFieldByProviderScope: Readonly<Record<string, CatalogPrimaryWorkbenchScopeQueryKey>> = {
  language: "languageCode",
  "product-line/category": "productLineId",
  series: "seriesId",
  expansion: "expansionId",
  "set-name": "expansionId",
};

export function guidedSourceScopeFields(
  readModel: CatalogPrimaryWorkbenchReadModel,
): readonly CatalogPrimaryWorkbenchGuidedScopeField[] {
  const scope = readModel.routeContext.scope;
  const optionKindsByQueryKind = new Map(readModel.sourceOptions.optionKinds.map((kind) => [kind.queryKind, kind]));

  return readModel.sourceOptions.pages.flatMap((page) => {
    const fieldName = scopeQueryFieldByProviderScope[page.scope];
    if (!fieldName) {
      return [];
    }

    const parent = optionKindsByQueryKind.get(page.queryKind)?.parent ?? null;
    const parentMissing = parent?.missing ?? page.state === "not-requested";
    const selectedValue = scopeFieldValue(scope, fieldName);

    return [
      {
        queryKind: page.queryKind,
        scope: page.scope,
        label: page.displayName,
        fieldName,
        options: scopeOptions(page, selectedValue),
        selectedValue,
        parentMissing,
        parentScope: parent?.scope ?? null,
        parentDiagnostic: parentMissing ? (parent?.diagnosticText ?? page.cache.diagnostics[0]?.message ?? null) : null,
      },
    ] satisfies readonly CatalogPrimaryWorkbenchGuidedScopeField[];
  });
}

function scopeFieldValue(
  scope: CatalogPrimaryWorkbenchScopeContext | undefined,
  fieldName: CatalogPrimaryWorkbenchScopeQueryKey,
): string {
  return scope?.[fieldName] ?? "";
}

// Turn the loaded option items into select options. When the route already carries
// a selected value the page has not loaded (stale parent, partial read model), keep
// it as the leading option so the current scope stays visible and submittable.
function scopeOptions(
  page: CatalogPrimaryWorkbenchReadModel["sourceOptions"]["pages"][number],
  selectedValue: string,
): readonly CatalogPrimaryWorkbenchSourceScopeOption[] {
  const options = page.items.map((item) => ({
    value: item.value,
    label: item.label,
    description: item.description,
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
      },
      ...options,
    ];
  }

  return options;
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
