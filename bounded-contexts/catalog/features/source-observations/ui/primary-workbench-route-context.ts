import type { CatalogPrimaryWorkbenchRouteContext } from "../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchSections } from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import { CATALOG_CONTROL_PLANE_WORKSPACES } from "./admin-control-plane/information-architecture";

const canonicalKeys = new Set([
  "section",
  "providerKey",
  "unitKey",
  "importScope",
  "profileVersion",
  "selectedObservationIds",
  "jobId",
  "promotionPreviewId",
  "returnPath",
]);

const filterPrefix = "filter.";
const catalogPrimaryWorkbenchPath = "/catalog/integrations";
const catalogPrimaryWorkbenchOrigin = "https://admin.example";
const defaultCatalogPrimaryWorkbenchSection = "import-to-promotion";
const retiredRoutePattern = /legacy|compat|raw-json|god-page|provider-profile-review|integrations-page/i;
const workspacesByKey = new Map<string, (typeof CATALOG_CONTROL_PLANE_WORKSPACES)[number]>(
  CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => [workspace.key, workspace]),
);
const workspacesByRouteSegment = new Map<string, (typeof CATALOG_CONTROL_PLANE_WORKSPACES)[number]>(
  CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => [workspace.routeSegment, workspace]),
);
const primarySectionKeys = new Set<string>(catalogPrimaryWorkbenchSections.map((section) => section.key));

export function parseCatalogPrimaryWorkbenchRouteContext(url: string | URL): CatalogPrimaryWorkbenchRouteContext {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;

  return routeContextFromSearchParams(parsedUrl.searchParams, true);
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

function routeContextFromSearchParams(
  searchParams: URLSearchParams,
  includeReturnPath: boolean,
): CatalogPrimaryWorkbenchRouteContext {
  return {
    section: normalizeCatalogPrimaryWorkbenchSection(searchParams.get("section")),
    providerKey: nullableParam(searchParams, "providerKey"),
    unitKey: nullableParam(searchParams, "unitKey") as CatalogIntegrationUnitKey | null,
    importScope: nullableParam(searchParams, "importScope"),
    profileVersion: nullableParam(searchParams, "profileVersion"),
    sourceObservationFilters: parseSourceObservationFilters(searchParams),
    selectedObservationIds: parseCsvParam(searchParams, "selectedObservationIds"),
    jobId: nullableParam(searchParams, "jobId"),
    promotionPreviewId: nullableParam(searchParams, "promotionPreviewId"),
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
  setNullable(searchParams, "importScope", context.importScope);
  setNullable(searchParams, "profileVersion", context.profileVersion);
  if (context.selectedObservationIds.length > 0) {
    searchParams.set("selectedObservationIds", context.selectedObservationIds.join(","));
  }
  setNullable(searchParams, "jobId", context.jobId);
  setNullable(searchParams, "promotionPreviewId", context.promotionPreviewId);
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
  const searchParams = serializeCatalogPrimaryWorkbenchRouteContext({
    ...context,
    section: normalizeCatalogPrimaryWorkbenchSection(section ?? context.section),
  });
  if (section) {
    searchParams.set("section", catalogPrimaryWorkbenchSectionRouteValue(section));
  }
  const query = searchParams.toString();

  return query ? `${catalogPrimaryWorkbenchPath}?${query}` : catalogPrimaryWorkbenchPath;
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
    if (parsedUrl.origin !== catalogPrimaryWorkbenchOrigin || parsedUrl.pathname !== catalogPrimaryWorkbenchPath) {
      return null;
    }

    const hadSection = parsedUrl.searchParams.has("section");
    parsedUrl.searchParams.delete("returnPath");
    const returnContext = routeContextFromSearchParams(parsedUrl.searchParams, false);

    return catalogPrimaryWorkbenchHref(returnContext, hadSection ? returnContext.section : undefined);
  } catch {
    return null;
  }
}
