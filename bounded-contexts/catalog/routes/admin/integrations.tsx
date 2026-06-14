import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { CatalogIntegrationsSurfaceRouteView } from "../../features/source-observations/ui/integrations-surface-route-view";
import { loader } from "../../support/route-support/admin-integrations/integrations-loader";
import type { action as integrationsAction } from "../../support/route-support/admin-integrations/integrations-action";

export { action } from "../../support/route-support/admin-integrations/integrations-action";
export { loader } from "../../support/route-support/admin-integrations/integrations-loader";

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.integrations.catalog.integrations.catalog.admin") },
];

// Daily import-to-promotion surface — the default integrations route. Thin
// composition root: it re-exports the loader/action and renders the shared
// surface view for the "daily" audience surface. The run-sync / promote action
// stays on this route and returns its result as data, so the banner reads the
// action result (when present) instead of a post-redirect query.
export default function IntegrationsRoute() {
  const routeData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof integrationsAction>();
  const commandFeedback = actionData && "feedback" in actionData ? actionData.feedback : undefined;
  return (
    <CatalogIntegrationsSurfaceRouteView surface="daily" routeData={routeData} commandFeedback={commandFeedback} />
  );
}
