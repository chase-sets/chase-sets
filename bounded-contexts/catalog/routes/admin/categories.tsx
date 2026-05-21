import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { type CategoryListItem } from "../../client";
import { CategoryListPage } from "../../features/categories/ui/category-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { catalogRealtimeRouteTopics } from "../../support/realtime-support/topics";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";
import { useCatalogRealtimeRevalidation } from "../../support/shell-support/ui/realtime-revalidation";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return loadCatalogListRouteData<CategoryListItem>(request, (query) => api.listCategories(query));
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.categories.categories.catalog.admin") }];

export default function CategoriesRoute() {
  const routeData = useLoaderData<typeof loader>();
  useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.categories());
  return <CategoryListPage data={routeData.data} query={routeData.query} />;
}
