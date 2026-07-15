import type { CatalogPrimaryWorkbenchRouteContext } from "../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchSections } from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import {
  CATALOG_CONTROL_PLANE_ROUTE_SURFACES,
  CATALOG_CONTROL_PLANE_WORKSPACES,
} from "./admin-control-plane/information-architecture";
import {
  catalogPrimaryWorkbenchScopeQueryKeys,
  importScopeFromScopeContext,
  scopeContextFromSearchParams,
} from "./primary-workbench-scope-context";

const canonicalKeys = new Set([
  "section",
  "providerKey",
  "unitKey",
  "importScope",
  ...catalogPrimaryWorkbenchScopeQueryKeys,
  "profileVersion",
  "selectedObservationIds",
  "selectedObservationCount",
  "reviewOffset",
  "reviewLimit",
  "jobId",
  "promotionPreviewId",
  "scopeRecordId",
  "returnPath",
]);

const filterPrefix = "filter.";
// Selection is durable page state (sessionStorage-backed, see
// `primary-workbench-selection-store.ts`), not a URL detour. A small selection
// still round-trips through the URL for shareable links and the post-command
// redirect; above this bound the URL carries only the count, never the row ids,
// so a bulk (e.g. 500-row) selection never inflates the address bar or any
// server-side query-string/header limit. The durable store and the POST body
// hidden inputs a command actually submits are unaffected by this cap.
const MAX_URL_SELECTED_OBSERVATION_IDS = 50;
// The daily surface is the base integrations route; the other three audience
// surfaces are real nested routes. The route path is the screen router; ?section=
// only names the precise workspace within a multi-workspace surface (active-nav +
// detour telemetry), so it is never the screen router.
const catalogPrimaryWorkbenchBasePath = "/catalog/integrations";
const catalogPrimaryWorkbenchOrigin = "https://admin.example";
const defaultCatalogPrimaryWorkbenchSection = "import-to-promotion";
const retiredRoutePattern = /legacy|compat|raw-json/i;
const workspacesByKey = new Map<string, (typeof CATALOG_CONTROL_PLANE_WORKSPACES)[number]>(
  CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => [workspace.key, workspace]),
);
const workspacesByRouteSegment = new Map<string, (typeof CATALOG_CONTROL_PLANE_WORKSPACES)[number]>(
  CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => [workspace.routeSegment, workspace]),
);
const primarySectionKeys = new Set<string>(catalogPrimaryWorkbenchSections.map((section) => section.key));
const surfacePathByKey = new Map<string, string>(
  CATALOG_CONTROL_PLANE_ROUTE_SURFACES.map((surface) => [surface.key, surfacePath(surface.pathSegment)]),
);
const surfaceDefaultSectionByPath = new Map<string, string>(
  CATALOG_CONTROL_PLANE_ROUTE_SURFACES.map((surface) => [surfacePath(surface.pathSegment), surface.workspaces[0]]),
);
const surfacePaths = [...surfaceDefaultSectionByPath.keys()];

function surfacePath(pathSegment: string): string {
  return pathSegment ? `${catalogPrimaryWorkbenchBasePath}/${pathSegment}` : catalogPrimaryWorkbenchBasePath;
}

// Resolve the canonical surface route path that renders the given section. The
// section is normalized to a workspace key; read-model section keys that are not
// workspaces (e.g. source-observation-review, promotion-preview) belong to the
// daily import-to-promotion job and therefore resolve to the base route.
export function catalogPrimaryWorkbenchSurfacePathForSection(section: string): string {
  const normalized = normalizeCatalogPrimaryWorkbenchSection(section);
  const workspace = workspacesByKey.get(normalized);
  if (!workspace) {
    return catalogPrimaryWorkbenchBasePath;
  }
  return surfacePathByKey.get(workspace.routeSurface) ?? catalogPrimaryWorkbenchBasePath;
}

// The exact surface route a pathname resolves to, or null when the pathname is
// not one of the four integrations surfaces (e.g. action POSTs to the base path).
function surfaceDefaultSectionForPathname(pathname: string | null | undefined): string | null {
  if (!pathname) {
    return null;
  }
  const normalizedPathname = pathname.replace(/\/+$/, "") || catalogPrimaryWorkbenchBasePath;
  const match = surfacePaths.find((path) => normalizedPathname === path);

  return match ? (surfaceDefaultSectionByPath.get(match) ?? defaultCatalogPrimaryWorkbenchSection) : null;
}

// Resolve the precise workspace for a request. ?section= (set by the action and
// by deep links) names the exact workspace; otherwise the route path determines
// the surface default. Direct visits to /integrations/providers therefore open
// profile authoring without any query state.
function resolveSectionFromLocation(searchParams: URLSearchParams, pathname: string | null | undefined): string {
  const explicitSection = searchParams.get("section");
  if (explicitSection?.trim()) {
    return normalizeCatalogPrimaryWorkbenchSection(explicitSection);
  }

  return surfaceDefaultSectionForPathname(pathname) ?? defaultCatalogPrimaryWorkbenchSection;
}

export function parseCatalogPrimaryWorkbenchRouteContext(url: string | URL): CatalogPrimaryWorkbenchRouteContext {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;

  return routeContextFromLocation(parsedUrl.searchParams, parsedUrl.pathname, true);
}

export function normalizeCatalogPrimaryWorkbenchSection(section: string | null | undefined): string {
  const trimmed = section?.trim();
  if (!trimmed || retiredRoutePattern.test(trimmed)) {
    return defaultCatalogPrimaryWorkbenchSection;
  }

  const workspace = workspacesByKey.get(trimmed) ?? workspacesByRouteSegment.get(trimmed);
  if (workspace) {
    return workspace.key;
  }
  if (primarySectionKeys.has(trimmed)) {
    return trimmed;
  }

  return defaultCatalogPrimaryWorkbenchSection;
}

export function catalogPrimaryWorkbenchSectionRouteValue(section: string): string {
  const normalized = normalizeCatalogPrimaryWorkbenchSection(section);
  return workspacesByKey.get(normalized)?.routeSegment ?? normalized;
}

export function catalogPrimaryWorkbenchReturnPath(context: CatalogPrimaryWorkbenchRouteContext): string {
  return catalogPrimaryWorkbenchHref(
    {
      ...context,
      section: defaultCatalogPrimaryWorkbenchSection,
      returnPath: null,
    },
    defaultCatalogPrimaryWorkbenchSection,
  );
}

export function catalogPrimaryWorkbenchSupportingHref(
  context: CatalogPrimaryWorkbenchRouteContext,
  section: string,
): string {
  const normalizedSection = normalizeCatalogPrimaryWorkbenchSection(section);

  return catalogPrimaryWorkbenchHref(
    {
      ...context,
      section: normalizedSection,
      returnPath: catalogPrimaryWorkbenchReturnPath(context),
    },
    normalizedSection,
  );
}

function routeContextFromLocation(
  searchParams: URLSearchParams,
  pathname: string | null | undefined,
  includeReturnPath: boolean,
): CatalogPrimaryWorkbenchRouteContext {
  const providerKey = nullableParam(searchParams, "providerKey");
  const importScope = nullableParam(searchParams, "importScope");
  const sourceObservationFilters = parseSourceObservationFilters(searchParams);
  const scope = scopeContextFromSearchParams({
    searchParams,
    providerKey,
    importScope,
    sourceObservationFilters,
  });

  return {
    section: resolveSectionFromLocation(searchParams, pathname),
    providerKey,
    unitKey: nullableParam(searchParams, "unitKey") as CatalogIntegrationUnitKey | null,
    scope,
    importScope: importScope ?? importScopeFromScopeContext(scope),
    profileVersion: nullableParam(searchParams, "profileVersion"),
    sourceObservationFilters,
    selectedObservationIds: parseCsvParam(searchParams, "selectedObservationIds"),
    reviewOffset: nonNegativeIntParam(searchParams, "reviewOffset"),
    reviewLimit: positiveIntParam(searchParams, "reviewLimit"),
    jobId: nullableParam(searchParams, "jobId"),
    promotionPreviewId: nullableParam(searchParams, "promotionPreviewId"),
    scopeRecordId: nullableParam(searchParams, "scopeRecordId"),
    returnPath: includeReturnPath ? sanitizeReturnPath(nullableParam(searchParams, "returnPath")) : null,
  };
}

export function serializeCatalogPrimaryWorkbenchRouteContext(
  context: CatalogPrimaryWorkbenchRouteContext,
): URLSearchParams {
  const searchParams = new URLSearchParams();
  const normalizedSection = normalizeCatalogPrimaryWorkbenchSection(context.section);
  if (normalizedSection !== defaultCatalogPrimaryWorkbenchSection) {
    searchParams.set("section", catalogPrimaryWorkbenchSectionRouteValue(normalizedSection));
  }
  setNullable(searchParams, "providerKey", context.providerKey);
  setNullable(searchParams, "unitKey", context.unitKey);
  setNullable(searchParams, "importScope", context.importScope ?? importScopeFromScopeContext(context.scope));
  setNullable(searchParams, "languageCode", context.scope?.languageCode ?? null);
  setNullable(searchParams, "productLineId", context.scope?.productLineId ?? null);
  setNullable(searchParams, "productLineName", context.scope?.productLineName ?? null);
  setNullable(searchParams, "seriesId", context.scope?.seriesId ?? null);
  setNullable(searchParams, "seriesName", context.scope?.seriesName ?? null);
  setNullable(searchParams, "expansionId", context.scope?.expansionId ?? null);
  setNullable(searchParams, "expansionName", context.scope?.expansionName ?? null);
  setNullable(searchParams, "profileVersion", context.profileVersion);
  if (
    context.selectedObservationIds.length > 0 &&
    context.selectedObservationIds.length <= MAX_URL_SELECTED_OBSERVATION_IDS
  ) {
    searchParams.set("selectedObservationIds", context.selectedObservationIds.join(","));
  } else if (context.selectedObservationIds.length > MAX_URL_SELECTED_OBSERVATION_IDS) {
    // Bulk selection: carry only the count so the URL stays bounded. The durable
    // working set (sessionStorage) and the command's own POST body are the
    // source of truth for which observations are actually selected.
    searchParams.set("selectedObservationCount", String(context.selectedObservationIds.length));
  }
  // The first page is the canonical default, so only a positive offset is emitted;
  // reviewLimit only when an explicit non-default page size is in play.
  if (typeof context.reviewOffset === "number" && context.reviewOffset > 0) {
    searchParams.set("reviewOffset", String(context.reviewOffset));
  }
  if (typeof context.reviewLimit === "number" && context.reviewLimit > 0) {
    searchParams.set("reviewLimit", String(context.reviewLimit));
  }
  setNullable(searchParams, "jobId", context.jobId);
  setNullable(searchParams, "promotionPreviewId", context.promotionPreviewId);
  setNullable(searchParams, "scopeRecordId", context.scopeRecordId ?? null);
  setNullable(searchParams, "returnPath", sanitizeReturnPath(context.returnPath));

  for (const [key, value] of Object.entries(context.sourceObservationFilters).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (value) {
      searchParams.set(`${filterPrefix}${key}`, value);
    }
  }

  return searchParams;
}

export function catalogPrimaryWorkbenchHref(context: CatalogPrimaryWorkbenchRouteContext, section?: string): string {
  const normalizedSection = normalizeCatalogPrimaryWorkbenchSection(section ?? context.section);
  const path = catalogPrimaryWorkbenchSurfacePathForSection(normalizedSection);
  const searchParams = serializeCatalogPrimaryWorkbenchRouteContext({
    ...context,
    section: normalizedSection,
  });
  // The route path is the surface router. Keep ?section= only to disambiguate the
  // precise workspace inside a multi-workspace surface (active-nav + telemetry);
  // drop it when it is the surface default so canonical URLs stay clean.
  if (normalizedSection !== (surfaceDefaultSectionByPath.get(path) ?? defaultCatalogPrimaryWorkbenchSection)) {
    searchParams.set("section", catalogPrimaryWorkbenchSectionRouteValue(normalizedSection));
  } else {
    searchParams.delete("section");
  }
  const query = searchParams.toString();

  return query ? `${path}?${query}` : path;
}

export function catalogPrimaryWorkbenchContextKeysFromUrl(url: string | URL): readonly string[] {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const keys = new Set<string>();
  for (const key of parsedUrl.searchParams.keys()) {
    if (canonicalKeys.has(key)) {
      keys.add(key);
    }
    if (key.startsWith(filterPrefix) && key.length > filterPrefix.length) {
      keys.add("sourceObservationFilters");
    }
  }

  return [...keys].sort();
}

function nullableParam(searchParams: URLSearchParams, key: string): string | null {
  const value = searchParams.get(key);
  return value && value.trim() ? value : null;
}

function parseCsvParam(searchParams: URLSearchParams, key: string): readonly string[] {
  return (searchParams.get(key) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function nonNegativeIntParam(searchParams: URLSearchParams, key: string): number | null {
  const raw = searchParams.get(key)?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveIntParam(searchParams: URLSearchParams, key: string): number | null {
  const value = nonNegativeIntParam(searchParams, key);
  return value !== null && value > 0 ? value : null;
}

function parseSourceObservationFilters(searchParams: URLSearchParams): Readonly<Record<string, string>> {
  const filters: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    const filterKey = key.slice(filterPrefix.length);
    const filterValue = value.trim();
    if (
      key.startsWith(filterPrefix) &&
      filterKey &&
      !retiredRoutePattern.test(filterKey) &&
      !filterKey.includes("=") &&
      !filterKey.includes("&") &&
      filterValue &&
      !filterValue.includes("\n")
    ) {
      filters[filterKey] = filterValue;
    }
  }

  return filters;
}

function setNullable(searchParams: URLSearchParams, key: string, value: string | null): void {
  if (value) {
    searchParams.set(key, value);
  }
}

function sanitizeReturnPath(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("//") || retiredRoutePattern.test(trimmed)) {
    return null;
  }

  try {
    const parsedUrl = new URL(trimmed, catalogPrimaryWorkbenchOrigin);
    const normalizedReturnPathname = parsedUrl.pathname.replace(/\/+$/, "") || catalogPrimaryWorkbenchBasePath;
    if (parsedUrl.origin !== catalogPrimaryWorkbenchOrigin || !surfacePaths.includes(normalizedReturnPathname)) {
      return null;
    }

    parsedUrl.searchParams.delete("returnPath");
    const returnContext = routeContextFromLocation(parsedUrl.searchParams, normalizedReturnPathname, false);

    return catalogPrimaryWorkbenchHref(returnContext, returnContext.section);
  } catch {
    return null;
  }
}
