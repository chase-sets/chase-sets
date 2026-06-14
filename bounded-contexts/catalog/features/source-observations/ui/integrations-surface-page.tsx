import { useMemo } from "react";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import {
  catalogControlPlaneRouteSurface,
  type CatalogControlPlaneRouteSurfaceKey,
} from "./admin-control-plane/information-architecture";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
import { CatalogWorkbenchShell } from "./workbench-shell";
import { renderCatalogWorkbenchSurfaceWorkspaces } from "./workbench-workspace-renderers";

export interface CatalogIntegrationsSurfacePageProps {
  surface: CatalogControlPlaneRouteSurfaceKey;
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
}

// One audience surface route body: composes the shared workbench shell around the
// workspaces that belong to this surface. The daily surface renders only the
// primary import-to-promotion workspace; the others render their grouped
// workspaces. The active nav workspace comes from the route context section,
// constrained to a workspace that actually lives on this surface.
export function CatalogIntegrationsSurfacePage({
  surface,
  readModel,
  commandFeedback = null,
}: CatalogIntegrationsSurfacePageProps) {
  const surfaceDefinition = useMemo(() => catalogControlPlaneRouteSurface(surface), [surface]);
  const activeSection = surfaceDefinition.workspaces.includes(
    readModel.routeContext.section as (typeof surfaceDefinition.workspaces)[number],
  )
    ? readModel.routeContext.section
    : surfaceDefinition.workspaces[0];

  return (
    <CatalogWorkbenchShell readModel={readModel} commandFeedback={commandFeedback} activeSection={activeSection}>
      {renderCatalogWorkbenchSurfaceWorkspaces(readModel, surfaceDefinition.workspaces)}
    </CatalogWorkbenchShell>
  );
}
