import { t } from "@chase-sets/localization";
import type { ListResponse } from "@chase-sets/http/responses";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ReferenceRecord, SourceObservationListItem } from "../../client";
import { SourceObservationListPage } from "../../features/source-observations/ui/source-observation-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const [routeData, expansionReferences] = await Promise.all([
    loadCatalogListRouteData<SourceObservationListItem>(
      request,
      (query) => api.listSourceObservations(query),
    ),
    api.listReferenceRecords<ListResponse<ReferenceRecord>>(
      "limit=500&status=active&typeKey=expansion",
    ),
  ]);

  return {
    ...routeData,
    expansionReferences: expansionReferences.items,
  };
}

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.sourceObservations.source.observations.catalog.admin") },
];

export default function SourceObservationsRoute() {
  const routeData = useLoaderData<typeof loader>();
  return (
    <SourceObservationListPage
      data={routeData.data}
      query={routeData.query}
      expansionReferences={routeData.expansionReferences}
    />
  );
}
