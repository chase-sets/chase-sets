import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { ProviderRefreshSchedulePanel } from "../../features/provider-scope-discovery/ui/provider-refresh-schedule-panel";
import { CatalogIntegrationsSurfaceRouteView } from "../../features/source-observations/ui/integrations-surface-route-view";
import { loader } from "../../support/route-support/admin-integrations/providers-loader";

export { providersSurfaceCommandAction as action } from "../../support/route-support/admin-integrations/provider-refresh-command-action";
export { loader } from "../../support/route-support/admin-integrations/providers-loader";

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.integrationsProviders.providers.catalog.admin") },
];

// Provider profiles and readiness surface (/admin/integrations/providers). Thin
// composition root that renders the shared surface view for the "providers"
// audience surface (profile authoring and validation readiness) plus the
// scheduled source-option refresh schedule panel.
export default function IntegrationsProvidersRoute() {
  const routeData = useLoaderData<typeof loader>();
  const requestUrl = new URL(routeData.requestUrl);

  return (
    <>
      <CatalogIntegrationsSurfaceRouteView surface="providers" routeData={routeData} />
      {routeData.providerRefreshSchedules ? (
        <ProviderRefreshSchedulePanel
          items={routeData.providerRefreshSchedules}
          actionHref={`${requestUrl.pathname}${requestUrl.search}`}
          canManageCatalog={routeData.canManageCatalog}
        />
      ) : null}
    </>
  );
}
