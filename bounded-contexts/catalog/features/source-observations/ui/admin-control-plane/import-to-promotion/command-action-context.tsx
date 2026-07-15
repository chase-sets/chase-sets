import { createContext, useContext, type ReactNode } from "react";
import type { CatalogPrimaryWorkbenchRouteContext } from "../../../api/primary-workbench-admin-contracts";
import {
  catalogPrimaryWorkbenchHref,
  serializeCatalogPrimaryWorkbenchRouteContext,
} from "../../primary-workbench-route-context";

const CatalogIntegrationCommandActionPathContext = createContext<string | null>(null);

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

// Daily integrations remains the default command owner. Scope Detail supplies
// its own action path and gets the same URL-backed job/preview/filter context,
// allowing the shared workflow modules to execute without a page detour.
export function useCatalogIntegrationCommandHref(context: CatalogPrimaryWorkbenchRouteContext): string {
  return useCatalogIntegrationSurfaceHref(context, "import-to-promotion");
}

export function useCatalogIntegrationSurfaceHref(
  context: CatalogPrimaryWorkbenchRouteContext,
  section: NonNullable<CatalogPrimaryWorkbenchRouteContext["section"]>,
): string {
  const actionPath = useContext(CatalogIntegrationCommandActionPathContext);
  if (!actionPath) {
    return catalogPrimaryWorkbenchHref(context, section);
  }

  const query = serializeCatalogPrimaryWorkbenchRouteContext({
    ...context,
    section,
  }).toString();
  return query ? `${actionPath}?${query}` : actionPath;
}
