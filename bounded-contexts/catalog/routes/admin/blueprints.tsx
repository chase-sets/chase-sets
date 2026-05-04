import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  type Blueprint,
} from "../../client";
import { BlueprintListPage } from "../../features/blueprints/ui/blueprint-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return loadCatalogListRouteData<Blueprint>(
    request,
    (query) => api.listBlueprints(query),
  );
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.blueprints.blueprints.catalog.admin") }];

export default function BlueprintsRoute() {
  const routeData = useLoaderData<typeof loader>();
  return <BlueprintListPage data={routeData.data} query={routeData.query} />;
}

