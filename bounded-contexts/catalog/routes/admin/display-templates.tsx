import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { type DisplayTemplate } from "../../client";
import { DisplayTemplateListPage } from "../../features/display-templates/ui/display-template-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { catalogRealtimeRouteTopics } from "../../support/realtime-support/topics";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";
import { useCatalogRealtimeRevalidation } from "../../support/shell-support/ui/realtime-revalidation";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return loadCatalogListRouteData<DisplayTemplate>(request, (query) => api.listDisplayTemplates(query));
}

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.displayTemplates.display.templates.catalog.admin") },
];

export default function DisplayTemplatesRoute() {
  const routeData = useLoaderData<typeof loader>();
  useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.displayTemplates());
  return <DisplayTemplateListPage data={routeData.data} query={routeData.query} />;
}
