import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { Field } from "../../support/request-support/api-client";
import { FieldListPage } from "../../features/fields/ui/field-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { catalogRealtimeRouteTopics } from "../../support/realtime-support/topics";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";
import { useCatalogRealtimeRevalidation } from "../../support/shell-support/ui/realtime-revalidation";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return loadCatalogListRouteData<Field>(
    request,
    (query) => api.listFields(query),
  );
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.fields.fields.catalog.admin") }];

export default function FieldsRoute() {
  const routeData = useLoaderData<typeof loader>();
  useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.fields());
  return <FieldListPage data={routeData.data} query={routeData.query} />;
}
