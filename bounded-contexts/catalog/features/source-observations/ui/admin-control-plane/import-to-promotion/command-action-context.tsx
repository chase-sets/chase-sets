import { createContext, useContext, type ReactNode } from "react";
import type { CatalogPrimaryWorkbenchRouteContext } from "../../../api/primary-workbench-admin-contracts";
import { serializeCatalogPrimaryWorkbenchRouteContext } from "../../primary-workbench-route-context";

const CatalogIntegrationCommandActionPathContext = createContext<string | null>(null);

// The page that owns the shared import-to-promotion controls supplies its own
// action path: Scope Detail, Provider detail, or the daily surface on its fixed
// path. Every form, refresh and link these controls render targets that path.
export function CatalogIntegrationCommandActionProvider({
  actionPath,
  children,
}: Readonly<{ actionPath: string; children: ReactNode }>) {
  return (
    <CatalogIntegrationCommandActionPathContext.Provider value={actionPath}>
      {children}
    </CatalogIntegrationCommandActionPathContext.Provider>
  );
}

// A control rendered without an owning page fails closed: it never falls back to
// another page's action path.
export function useCatalogIntegrationCommandActionPath(): string {
  const actionPath = useContext(CatalogIntegrationCommandActionPathContext);
  if (!actionPath) {
    throw new Error("Catalog integration controls require an owning page action path.");
  }
  return actionPath;
}

// The owning page's command target with the context its forms keep. A page with
// no journey context yet posts to its bare path.
export function useCatalogIntegrationCommandHref(context: CatalogPrimaryWorkbenchRouteContext | null): string {
  const actionPath = useCatalogIntegrationCommandActionPath();
  return context ? ownerHref(actionPath, context, "import-to-promotion") : actionPath;
}

// The read model's links are daily paths. The same query goes to the owning
// page's path, so following a link never leaves that page.
export function useCatalogIntegrationHrefRebase(): (href: string) => string {
  const actionPath = useCatalogIntegrationCommandActionPath();
  return (href) => {
    const query = new URL(href, "https://catalog.invalid").search;
    return query ? `${actionPath}${query}` : actionPath;
  };
}

export function useCatalogIntegrationSurfaceHref(
  context: CatalogPrimaryWorkbenchRouteContext,
  section: NonNullable<CatalogPrimaryWorkbenchRouteContext["section"]>,
): string {
  return ownerHref(useCatalogIntegrationCommandActionPath(), context, section);
}

function ownerHref(
  actionPath: string,
  context: CatalogPrimaryWorkbenchRouteContext,
  section: NonNullable<CatalogPrimaryWorkbenchRouteContext["section"]>,
): string {
  const query = serializeCatalogPrimaryWorkbenchRouteContext({
    ...context,
    section,
  }).toString();
  return query ? `${actionPath}?${query}` : actionPath;
}
