import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CatalogIntegrationsSurfaceRouteView } from "../../features/source-observations/ui/integrations-surface-route-view";
import { loader } from "../../support/route-support/admin-integrations/governance-loader";

export { action } from "../../support/route-support/admin-integrations/integrations-action";
export { loader } from "../../support/route-support/admin-integrations/governance-loader";

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.integrationsGovernance.governance.catalog.admin") },
];

// Govern and recover surface (/admin/integrations/governance). Thin composition
// root that renders the shared surface view for the "governance" audience surface
// (conflict resolution, lifecycle recovery, governance controls).
export default function IntegrationsGovernanceRoute() {
  const routeData = useLoaderData<typeof loader>();
  return <CatalogIntegrationsSurfaceRouteView surface="governance" routeData={routeData} />;
}
