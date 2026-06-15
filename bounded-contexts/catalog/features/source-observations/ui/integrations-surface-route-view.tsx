import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
import { CatalogIntegrationsSurfacePage } from "./integrations-surface-page";

// The data every integrations surface loader returns. The server owns read-model
// composition; keeping the raw backing inputs out of the browser prevents large
// integration snapshots from being serialized twice and freezing hydration.
export type CatalogIntegrationsRouteData = Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  requestUrl: string;
}>;

// Shared thin view for the four integrations surface routes. The route loaders
// already slice the read model per audience surface, so this component only
// composes the page chrome around the server-produced model.
export function CatalogIntegrationsSurfaceRouteView({
  surface,
  routeData,
  commandFeedback,
}: Readonly<{
  surface: CatalogControlPlaneRouteSurfaceKey;
  routeData: CatalogIntegrationsRouteData;
  // Optional command-feedback override. The daily surface stays put after a
  // run-sync / promote command and supplies the action result here so the banner
  // renders in place; the other surfaces leave it undefined and read the feedback
  // their loader parsed from the post-command redirect query.
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
}>) {
  return (
    <CatalogIntegrationsSurfacePage
      surface={surface}
      readModel={routeData.readModel}
      commandFeedback={commandFeedback ?? routeData.commandFeedback}
    />
  );
}
