import { t } from "@chase-sets/localization";
import { useEffect } from "react";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigate } from "react-router";
import { CatalogIntegrationsSurfaceRouteView } from "../../features/source-observations/ui/integrations-surface-route-view";
import { loader } from "../../support/route-support/admin-integrations/integrations-loader";
import type { action as integrationsAction } from "../../support/route-support/admin-integrations/integrations-action";
import {
  commandRedirectHref,
  commandResultNeedsRoutableHandoff,
} from "../../support/route-support/admin-integrations/integrations-command-result";

export { action } from "../../support/route-support/admin-integrations/integrations-action";
export { loader } from "../../support/route-support/admin-integrations/integrations-loader";

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.integrations.catalog.integrations.catalog.admin") },
];

// Daily import-to-promotion surface — the default integrations route. Thin
// composition root: it re-exports the loader/action and renders the shared
// surface view for the "daily" audience surface. Most run-sync / promote actions
// stay on this route and return their result as data, so the banner reads the
// action result (when present). Preview-ready and queued-promotion action data are
// routable checkpoints, so the route replaces the URL with the same redirect href
// the server action uses. The queued job id lets the loader recover and render the
// durable promotion outcome on subsequent refreshes.
export default function IntegrationsRoute() {
  const routeData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof integrationsAction>();
  const navigate = useNavigate();
  const commandFeedback = actionData && "feedback" in actionData ? actionData.feedback : undefined;

  useEffect(() => {
    if (actionData && "feedback" in actionData && commandResultNeedsRoutableHandoff(actionData)) {
      navigate(commandRedirectHref(actionData), { replace: true });
    }
  }, [actionData, navigate]);

  return (
    <CatalogIntegrationsSurfaceRouteView surface="daily" routeData={routeData} commandFeedback={commandFeedback} />
  );
}
