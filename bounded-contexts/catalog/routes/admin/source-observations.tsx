import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { SourceObservationListItem } from "../../client";
import { SourceObservationListPage } from "../../features/source-observations/ui/source-observation-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return loadCatalogListRouteData<SourceObservationListItem>(
    request,
    (query) => api.listSourceObservations(query),
  );
}

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.sourceObservations.source.observations.catalog.admin") },
];

export default function SourceObservationsRoute() {
  const routeData = useLoaderData<typeof loader>();
  return <SourceObservationListPage data={routeData.data} query={routeData.query} />;
}
