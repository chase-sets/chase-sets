import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  type Dimension,
} from "../../client";
import { DimensionListPage } from "../../features/dimensions/ui/dimension-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { catalogRealtimeRouteTopics } from "../../support/realtime-support/topics";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";
import { useCatalogRealtimeRevalidation } from "../../support/shell-support/ui/realtime-revalidation";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return loadCatalogListRouteData<Dimension>(
    request,
    (query) => api.listDimensions(query),
  );
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.dimensions.dimensions.catalog.admin") }];

export default function DimensionsRoute() {
  const routeData = useLoaderData<typeof loader>();
  useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.dimensions());
  return <DimensionListPage data={routeData.data} query={routeData.query} />;
}
