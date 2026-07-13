import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CatalogIntegrationsSurfaceRouteView } from "../../features/source-observations/ui/integrations-surface-route-view";
import { loader } from "../../support/route-support/admin-integrations/governance-loader";

export { surfaceCommandAction as action } from "../../support/route-support/admin-integrations/surface-command-action";
export { loader } from "../../support/route-support/admin-integrations/governance-loader";

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.integrationsSettings.settings.catalog.admin") },
];

// Settings page (/catalog/integrations/settings). Governance becomes Settings:
// this is the same "governance" audience surface as integrations-governance.tsx
// (RBAC, rollout mode, kill switches, observability, and — pending its move to
// provider-detail — lifecycle recovery), reachable at the canonical Settings
// path the nav now advertises. The old /catalog/integrations/governance route
// stays registered so existing evidence links and bookmarks keep resolving.
export default function IntegrationsSettingsRoute() {
  const routeData = useLoaderData<typeof loader>();
  return <CatalogIntegrationsSurfaceRouteView surface="governance" routeData={routeData} />;
}
