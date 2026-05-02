import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  type Blueprint,
} from "../../client";
import type { ListResponse } from "@chase-sets/http/responses";
import { BlueprintListPage } from "../../features/blueprints/ui/blueprint-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return api.listBlueprints<ListResponse<Blueprint>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.blueprints.blueprints.catalog.admin") }];

export default function BlueprintsRoute() {
  const data = useLoaderData<typeof loader>();
  return <BlueprintListPage initialData={data} />;
}


