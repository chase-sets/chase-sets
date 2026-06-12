import type { CatalogProviderProfileEditableSectionKey } from "../api/provider-profile-section-registry";
import type {
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogProviderProfileVersionReview, SourceObservationIntegrationScope } from "./contracts";
import { catalogPrimaryWorkbenchHref } from "./primary-workbench-route-context";
import { scopeKey, sum } from "./primary-workbench-read-model-support";

export type ProfileImportScopeControl =
  CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionWorkspaces"][number]["importScopeControls"][number];

export function profileSectionImportScopeControls(input: {
  profile: CatalogProviderProfileVersionReview;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  scopes: readonly SourceObservationIntegrationScope[];
  section: CatalogProviderProfileEditableSectionKey;
}): readonly ProfileImportScopeControl[] {
  if (input.section !== "basics") {
    return [];
  }

  const providerRows = input.scopes.filter((scope) => scope.provider_key === input.profile.providerKey);

  return input.profile.supportedScopes.map((scope) => {
    const rows = providerRows.filter((row) => scopeRowMatchesProviderScope(scope, row));
    const selectedRows = rows.filter((row) => providerScopeImportKey(scope, row) === input.routeContext.importScope);
    const representative = selectedRows[0] ?? rows[0] ?? null;
    const representativeScopeKey = representative ? providerScopeImportKey(scope, representative) : null;
    const state = selectedRows.length > 0 ? "selected" : representativeScopeKey ? "available" : "unavailable";

    return {
      scope,
      label: providerScopeLabel(scope),
      state,
      reason:
        state === "unavailable"
          ? `No current provider scope rows expose a selectable ${providerScopeLabel(scope)} control.`
          : null,
      href: representativeScopeKey
        ? catalogPrimaryWorkbenchHref(
            {
              ...input.routeContext,
              providerKey: input.profile.providerKey,
              importScope: representativeScopeKey,
              promotionPreviewId: null,
              sourceObservationFilters: {
                ...input.routeContext.sourceObservationFilters,
                providerKey: input.profile.providerKey,
              },
            },
            "import-to-promotion",
          )
        : null,
      importScope: representativeScopeKey,
      expectedObservationCount: sum(rows, (row) => row.total_observations),
      observedCount: sum(rows, (row) => row.observed_observations),
      changedCount: sum(rows, (row) => row.changed_observations),
      promotedCount: sum(rows, (row) => row.promoted_observations),
      rejectedCount: sum(rows, (row) => row.rejected_observations),
    };
  });
}

function providerScopeImportKey(scope: string, row: SourceObservationIntegrationScope): string | null {
  const normalizedScope = normalizeProviderScope(scope);
  switch (normalizedScope) {
    case "language":
      return row.language_code || null;
    case "series":
      return [row.language_code, row.series_id].filter(Boolean).join(":") || null;
    case "product-line/category":
      return [row.language_code, row.product_line_id].filter(Boolean).join(":") || null;
    case "expansion":
    case "set-name":
    case "product/card":
      return scopeKey(row) || null;
    default:
      return null;
  }
}

function scopeRowMatchesProviderScope(scope: string, row: SourceObservationIntegrationScope): boolean {
  const normalizedScope = normalizeProviderScope(scope);
  switch (normalizedScope) {
    case "language":
      return Boolean(row.language_code);
    case "series":
      return Boolean(row.series_id);
    case "expansion":
    case "set-name":
    case "product/card":
      return Boolean(row.expansion_id || row.expansion_name);
    case "product-line/category":
      return Boolean(row.product_line_id || row.product_line_name);
    default:
      return false;
  }
}

function normalizeProviderScope(scope: string): string {
  if (scope === "pokemon/card") {
    return "product/card";
  }

  return scope;
}

function providerScopeLabel(scope: string): string {
  return scope
    .split("/")
    .map((part) =>
      part
        .split("-")
        .map((segment) => segment.replace(/^\w/, (char) => char.toUpperCase()))
        .join(" "),
    )
    .join(" / ");
}
