import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ReferenceType } from "../../support/request-support/api-client";
import { ReferenceTypeListPage } from "../../features/reference-data/ui/reference-type-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { catalogRealtimeRouteTopics } from "../../support/realtime-support/topics";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";
import { useCatalogRealtimeRevalidation } from "../../support/shell-support/ui/realtime-revalidation";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return loadCatalogListRouteData<ReferenceType>(
    request,
    (query) => api.listReferenceTypes(query),
  );
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.referenceTypes.reference.types.catalog.admin") }];

export default function ReferenceTypesRoute() {
  const routeData = useLoaderData<typeof loader>();
  useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.referenceTypes());
  return <ReferenceTypeListPage data={routeData.data} query={routeData.query} />;
}
