import type { CatalogPrimaryWorkbenchRouteContext } from "../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchHref } from "./primary-workbench-route-context";

// Operator-facing reload / force-refresh / refresh-all intents for the synced
// provider source-option groups. The status panel never links operators at the
// raw provider-options API hrefs (those stay on the read model for the loader and
// API). Instead each control navigates back to the Catalog Integrations workbench
// — the same surface, same route context — with one of these intents in the query
// string. The workbench loader reads the intent and re-fetches the option pages
// cache-only (reload) or force-refresh (per group or all), so the operator never
// leaves the workbench for JSON/API output.
export type CatalogPrimaryWorkbenchSourceOptionAction = "reload" | "force-refresh" | "force-refresh-all";

export type CatalogPrimaryWorkbenchSourceOptionIntent = Readonly<{
  action: CatalogPrimaryWorkbenchSourceOptionAction;
  // The option group the intent targets (e.g. "languages", "expansions"). Null for
  // refresh-all, which fans the force-refresh across every declared group.
  queryKind: string | null;
}>;

export const CATALOG_SOURCE_OPTION_ACTION_PARAM = "sourceOptionAction";
export const CATALOG_SOURCE_OPTION_QUERY_KIND_PARAM = "sourceOptionQueryKind";

const sourceOptionActions: readonly CatalogPrimaryWorkbenchSourceOptionAction[] = [
  "reload",
  "force-refresh",
  "force-refresh-all",
];

// Build the workbench href a source-option control links to. It reuses the
// canonical workbench URL builder so providerKey, unitKey, profile version, and the
// structured scope (carried as importScope) are all preserved, then layers the
// source-option intent params on top.
export function catalogPrimaryWorkbenchSourceOptionHref(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  intent: CatalogPrimaryWorkbenchSourceOptionIntent,
): string {
  const [path, existingQuery = ""] = catalogPrimaryWorkbenchHref(routeContext).split("?");
  const params = new URLSearchParams(existingQuery);
  params.set(CATALOG_SOURCE_OPTION_ACTION_PARAM, intent.action);
  if (intent.action === "force-refresh-all" || !intent.queryKind) {
    params.delete(CATALOG_SOURCE_OPTION_QUERY_KIND_PARAM);
  } else {
    params.set(CATALOG_SOURCE_OPTION_QUERY_KIND_PARAM, intent.queryKind);
  }

  return `${path}?${params.toString()}`;
}

// Parse a workbench source-option intent from a request URL, or null when no intent
// param is present (the default workbench load stays cache-only).
export function parseCatalogPrimaryWorkbenchSourceOptionIntent(
  url: string | URL,
): CatalogPrimaryWorkbenchSourceOptionIntent | null {
  const searchParams = typeof url === "string" ? new URL(url).searchParams : url.searchParams;
  const action = searchParams.get(CATALOG_SOURCE_OPTION_ACTION_PARAM);
  if (!action || !sourceOptionActions.includes(action as CatalogPrimaryWorkbenchSourceOptionAction)) {
    return null;
  }

  const queryKind = searchParams.get(CATALOG_SOURCE_OPTION_QUERY_KIND_PARAM)?.trim() || null;
  return { action: action as CatalogPrimaryWorkbenchSourceOptionAction, queryKind };
}

// Whether the given option group should be force-refreshed for this intent:
// refresh-all forces every group; a per-group force-refresh forces only its match;
// a reload (or no intent) stays cache-only.
export function catalogPrimaryWorkbenchSourceOptionForcesRefresh(
  intent: CatalogPrimaryWorkbenchSourceOptionIntent | null,
  queryKind: string,
): boolean {
  if (!intent) {
    return false;
  }
  if (intent.action === "force-refresh-all") {
    return true;
  }
  if (intent.action === "force-refresh") {
    return intent.queryKind === queryKind;
  }
  return false;
}
