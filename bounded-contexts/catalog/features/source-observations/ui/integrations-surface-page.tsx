import { useMemo, type ReactElement } from "react";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type { CatalogSyncRun, SourceObservationIntegrationImportPreview } from "./contracts";
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
  // Optional alias-review visibility slot supplied by the composition
  // root for the daily surface so operators see proposed alias equivalents while
  // reviewing Source Observations before promotion.
  aliasVisibility?: ReactElement | null;
  // Streamed source-options slice. The daily surface defers the option
  // fan-out, so the shell renders the status panel behind a Suspense boundary
  // around this promise; the other surfaces leave it absent and render no panel.
  deferredSourceOptions?: Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> | null;
  deferredImportPreview?: Promise<SourceObservationIntegrationImportPreview | null> | null;
  deferredCatalogSyncRun?: Promise<CatalogSyncRun | null> | null;
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
  aliasVisibility = null,
  deferredSourceOptions = null,
  deferredImportPreview = null,
  deferredCatalogSyncRun = null,
}: CatalogIntegrationsSurfacePageProps) {
  const surfaceDefinition = useMemo(() => catalogControlPlaneRouteSurface(surface), [surface]);

  return (
    <CatalogWorkbenchShell
      readModel={readModel}
      commandFeedback={commandFeedback}
      surface={surface}
      deferredSourceOptions={deferredSourceOptions}
    >
      {renderCatalogWorkbenchSurfaceWorkspaces(readModel, surfaceDefinition.workspaces, {
        aliasVisibility,
        commandFeedback,
        deferredSourceOptions,
        deferredImportPreview,
        deferredCatalogSyncRun,
      })}
    </CatalogWorkbenchShell>
  );
}
