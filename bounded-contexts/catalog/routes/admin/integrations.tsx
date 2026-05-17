import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { SourceObservationIntegrationScope } from "../../client";
import { IntegrationManagementPage } from "../../features/source-observations/ui/integration-management-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return loadCatalogListRouteData<SourceObservationIntegrationScope>(
    request,
    (query) => api.listSourceObservationIntegrationScopes(query),
  );
}

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.integrations.catalog.integrations.catalog.admin") },
];

export default function IntegrationsRoute() {
  const routeData = useLoaderData<typeof loader>();
  return <IntegrationManagementPage data={routeData.data} query={routeData.query} />;
}
