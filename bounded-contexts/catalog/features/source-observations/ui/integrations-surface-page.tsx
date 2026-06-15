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
// workspaces. Cross-surface navigation lives in the admin shell side nav, so this
// body owns no nav state.
export function CatalogIntegrationsSurfacePage({
  surface,
  readModel,
  commandFeedback = null,
}: CatalogIntegrationsSurfacePageProps) {
  const surfaceDefinition = useMemo(() => catalogControlPlaneRouteSurface(surface), [surface]);

  return (
    <CatalogWorkbenchShell readModel={readModel} commandFeedback={commandFeedback} surface={surface}>
      {renderCatalogWorkbenchSurfaceWorkspaces(readModel, surfaceDefinition.workspaces)}
    </CatalogWorkbenchShell>
  );
}
