import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  ComponentListPage,
  type Component,
} from "@chase-sets/catalog/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createCatalogRequestApiClient } from "../../client";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return api.listComponents<ListResponse<Component>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: "Components | Catalog Admin" }];

export default function ComponentsRoute() {
  const data = useLoaderData<typeof loader>();
  return <ComponentListPage initialData={data} />;
}


