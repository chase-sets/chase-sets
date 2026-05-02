import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  type Component,
} from "../../client";
import type { ListResponse } from "@chase-sets/http/responses";
import { ComponentListPage } from "../../features/components/ui/component-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return api.listComponents<ListResponse<Component>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.components.components.catalog.admin") }];

export default function ComponentsRoute() {
  const data = useLoaderData<typeof loader>();
  return <ComponentListPage initialData={data} />;
}


