import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { type CatalogItemListItem } from "../../client";
import { CatalogItemListPage } from "../../features/catalog-items/ui/catalog-item-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { catalogRealtimeRouteTopics } from "../../support/realtime-support/topics";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";
import { useCatalogRealtimeRevalidation } from "../../support/shell-support/ui/realtime-revalidation";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return loadCatalogListRouteData<CatalogItemListItem>(request, (query) => api.listCatalogItems(query));
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.catalogItems.catalog.items.catalog.admin") }];

export default function CatalogItemsRoute() {
  const routeData = useLoaderData<typeof loader>();
  useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.catalogItems());
  return <CatalogItemListPage data={routeData.data} query={routeData.query} />;
}
