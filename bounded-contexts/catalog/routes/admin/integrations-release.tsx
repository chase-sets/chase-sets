import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CatalogIntegrationsSurfaceRouteView } from "../../features/source-observations/ui/integrations-surface-route-view";
import { loader } from "../../support/route-support/admin-integrations/release-loader";

export { surfaceCommandAction as action } from "../../support/route-support/admin-integrations/surface-command-action";
export { loader } from "../../support/route-support/admin-integrations/release-loader";

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.integrationsRelease.release.catalog.admin") },
];

// Release evidence and health surface (/admin/integrations/release). Thin
// composition root that renders the shared surface view for the "release"
// audience surface (clean reset release, audit evidence, health triage).
export default function IntegrationsReleaseRoute() {
  const routeData = useLoaderData<typeof loader>();
  return <CatalogIntegrationsSurfaceRouteView surface="release" routeData={routeData} />;
}
