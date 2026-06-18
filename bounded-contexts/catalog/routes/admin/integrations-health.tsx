import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CatalogIntegrationsSurfaceRouteView } from "../../features/source-observations/ui/integrations-surface-route-view";
import { loader } from "../../support/route-support/admin-integrations/health-loader";

export { surfaceCommandAction as action } from "../../support/route-support/admin-integrations/surface-command-action";
export { loader } from "../../support/route-support/admin-integrations/health-loader";

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.integrationsHealth.health.catalog.admin") }];

// Integration health surface (/admin/integrations/health). Thin composition root
// that renders the shared surface view for the "health" audience surface (health
// triage and the audit timeline).
export default function IntegrationsHealthRoute() {
  const routeData = useLoaderData<typeof loader>();
  return <CatalogIntegrationsSurfaceRouteView surface="health" routeData={routeData} />;
}
