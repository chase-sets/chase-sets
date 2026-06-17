import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type { CatalogAliasReviewReadModel } from "../../alias-equivalence/api/alias-review-admin-contracts";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
import { CatalogIntegrationsSurfacePage } from "./integrations-surface-page";
import { CatalogIntegrationAliasReviewWorkspace } from "./admin-control-plane/alias-review/alias-review-workspace";
import { catalogPrimaryWorkbenchHref } from "./primary-workbench-route-context";

// The data every integrations surface loader returns. The server owns read-model
// composition; keeping the raw backing inputs out of the browser prevents large
// integration snapshots from being serialized twice and freezing hydration.
export type CatalogIntegrationsRouteData = Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  requestUrl: string;
  // Optional alias-review read model (#1908). The daily surface loader fetches it
  // so the composition root can render the alias-review workspace inline before
  // promotion; the other surfaces leave it absent.
  aliasReview?: CatalogAliasReviewReadModel | null;
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
  // The alias-review workspace POSTs its accept/reject/revoke forms to the daily
  // integrations route action (the composition root supplies this href), which
  // dispatches the #1905 aggregate commands. Only render it when the loader
  // attached the alias read model (the daily surface).
  const aliasVisibility = routeData.aliasReview ? (
    <CatalogIntegrationAliasReviewWorkspace
      readModel={routeData.aliasReview}
      actionHref={catalogPrimaryWorkbenchHref(routeData.readModel.routeContext, "import-to-promotion")}
      canManageAliases={routeData.readModel.readiness.rbacAllowed}
    />
  ) : null;

  return (
    <CatalogIntegrationsSurfacePage
      surface={surface}
      readModel={routeData.readModel}
      commandFeedback={commandFeedback ?? routeData.commandFeedback}
      aliasVisibility={aliasVisibility}
    />
  );
}
