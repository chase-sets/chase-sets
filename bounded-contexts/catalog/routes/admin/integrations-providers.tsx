import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CatalogIntegrationsSurfaceRouteView } from "../../features/source-observations/ui/integrations-surface-route-view";
import { loader } from "../../support/route-support/admin-integrations/providers-loader";

export { surfaceCommandAction as action } from "../../support/route-support/admin-integrations/surface-command-action";
export { loader } from "../../support/route-support/admin-integrations/providers-loader";

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.integrationsProviders.providers.catalog.admin") },
];

// Provider profiles and readiness surface (/admin/integrations/providers). Thin
// composition root that renders the shared surface view for the "providers"
// audience surface (profile authoring and validation readiness).
export default function IntegrationsProvidersRoute() {
  const routeData = useLoaderData<typeof loader>();
  return <CatalogIntegrationsSurfaceRouteView surface="providers" routeData={routeData} />;
}
